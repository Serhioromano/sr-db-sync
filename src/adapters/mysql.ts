// ============================================================
// MySQL adapter — schema reading (Snash) + schema writing (Migrate)
// ============================================================
//
// Uses mysql2/promise for async connection pool.
// Schema reading via information_schema.
// Native MySQL ALTER TABLE support — no table rebuilds needed.

import type {
  ColumnDef,
  IndexDef,
  FKDef,
  TriggerDef,
  ViewDef,
  ProcedureDef,
  EnumDef,
  SchemaIR,
  TableDefinition,
  MigrationPlan,
  MigrationOp,
  MigrateOptions,
  RecordData,
} from '../core/types.js';
import type {
  DatabaseAdapter,
  DsnField,
  ConnectOptions,
} from './adapter.interface.js';
import { DbsError } from '../utils/errors.js';

// ============================================================
// Types
// ============================================================

/** Parsed MySQL DSN components. */
interface MysqlDsn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Row shape from information_schema.COLUMNS */
interface InformationSchemaColumn {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
  EXTRA: string;
  COLUMN_COMMENT: string;
}

/** Row shape from information_schema.STATISTICS */
interface InformationSchemaIndex {
  INDEX_NAME: string;
  COLUMN_NAME: string;
  NON_UNIQUE: number;
  INDEX_TYPE: string;
  SEQ_IN_INDEX: number;
}

/** Row shape from information_schema.KEY_COLUMN_USAGE (FKs) */
interface InformationSchemaFK {
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  ORDINAL_POSITION: number;
}

/** Row shape from information_schema.REFERENTIAL_CONSTRAINTS (FK actions) */
interface InformationSchemaRefConstraint {
  CONSTRAINT_NAME: string;
  DELETE_RULE: string;
  UPDATE_RULE: string;
}

/** Row shape from information_schema.TRIGGERS */
interface InformationSchemaTrigger {
  TRIGGER_NAME: string;
  ACTION_TIMING: string;
  EVENT_MANIPULATION: string;
  ACTION_STATEMENT: string;
}

/** Row shape from information_schema.VIEWS */
interface InformationSchemaView {
  TABLE_NAME: string;
  VIEW_DEFINITION: string;
}

/** Row shape from information_schema.ROUTINES */
interface InformationSchemaRoutine {
  ROUTINE_NAME: string;
  ROUTINE_DEFINITION: string;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Parse a MySQL DSN URL into its components.
 *
 * Formats:
 *   mysql://user:password@host:port/database
 *   mysql://user:password@host/database
 *   mysql://user@host:port/database
 *   mysql://user@host/database
 */
function parseMysqlDsn(dsn: string): MysqlDsn {
  // Remove protocol prefix
  let remaining = dsn;
  if (remaining.startsWith('mysql://')) {
    remaining = remaining.slice('mysql://'.length);
  }

  // Split credentials from rest
  const atIndex = remaining.lastIndexOf('@');
  let user = 'root';
  let password = '';

  if (atIndex >= 0) {
    const creds = remaining.slice(0, atIndex);
    remaining = remaining.slice(atIndex + 1);

    const colonIndex = creds.indexOf(':');
    if (colonIndex >= 0) {
      user = decodeURIComponent(creds.slice(0, colonIndex));
      password = decodeURIComponent(creds.slice(colonIndex + 1));
    } else {
      user = decodeURIComponent(creds);
    }
  }

  // Split host:port from database
  const slashIndex = remaining.indexOf('/');
  let hostPort: string;
  let database = '';

  if (slashIndex >= 0) {
    hostPort = remaining.slice(0, slashIndex);
    // Database name — strip query params
    const dbPart = remaining.slice(slashIndex + 1);
    const qIdx = dbPart.indexOf('?');
    database = qIdx >= 0 ? dbPart.slice(0, qIdx) : dbPart;
  } else {
    hostPort = remaining;
  }

  // Split host and port
  let host = '127.0.0.1';
  let port = 3306;

  if (hostPort) {
    // Handle IPv6 addresses like [::1]:3306
    if (hostPort.startsWith('[')) {
      const closeBracket = hostPort.indexOf(']');
      if (closeBracket >= 0) {
        host = hostPort.slice(1, closeBracket);
        const afterBracket = hostPort.slice(closeBracket + 1);
        if (afterBracket.startsWith(':')) {
          port = parseInt(afterBracket.slice(1), 10) || 3306;
        }
      }
    } else {
      const colonIdx = hostPort.lastIndexOf(':');
      if (colonIdx >= 0) {
        host = hostPort.slice(0, colonIdx);
        port = parseInt(hostPort.slice(colonIdx + 1), 10) || 3306;
      } else {
        host = hostPort;
      }
    }
  }

  return { host, port, user, password, database };
}

/**
 * Map MySQL ON DELETE / ON UPDATE action string to standard form.
 */
function normaliseFKAction(action: string): 'cascade' | 'set null' | 'restrict' | 'no action' | undefined {
  if (!action) return undefined;
  const lower = action.toLowerCase().trim();
  switch (lower) {
    case 'cascade': return 'cascade';
    case 'set null': return 'set null';
    case 'restrict': return 'restrict';
    case 'no action': return 'no action';
    default: return undefined;
  }
}

/**
 * Map MySQL TIMING string to standard form.
 */
function normaliseTriggerTiming(raw: string): TriggerDef['timing'] {
  const lower = raw.toLowerCase().trim();
  if (lower === 'before') return 'before';
  if (lower === 'after') return 'after';
  if (lower === 'instead of') return 'instead of';
  return 'after';
}

/**
 * Map MySQL EVENT string to standard form.
 */
function normaliseTriggerEvent(raw: string): TriggerDef['event'] {
  const lower = raw.toLowerCase().trim();
  if (lower === 'insert') return 'insert';
  if (lower === 'update') return 'update';
  if (lower === 'delete') return 'delete';
  return 'insert';
}

/**
 * Format a MySQL default value for display.
 */
function formatDefaultValue(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  // MySQL returns CURRENT_TIMESTAMP without parens
  const upper = raw.toUpperCase().trim();
  if (upper === 'CURRENT_TIMESTAMP') return 'CURRENT_TIMESTAMP';
  if (upper === 'NULL') return undefined;
  if (upper.startsWith('CURRENT_TIMESTAMP')) return raw; // e.g. CURRENT_TIMESTAMP(3)
  return raw;
}

/**
 * Check if a column has an ON UPDATE CURRENT_TIMESTAMP clause.
 */
function hasOnUpdate(extra: string): boolean {
  return extra.toUpperCase().includes('ON UPDATE CURRENT_TIMESTAMP');
}

// ============================================================
// MySQL Adapter
// ============================================================

export class MysqlAdapter implements DatabaseAdapter {
  // ---- DSN contract (static) ----

  static readonly dsnFields: DsnField[] = [
    {
      name: 'host',
      label: 'Хост',
      type: 'text',
      default: '127.0.0.1',
      placeholder: 'db.example.com',
      required: true,
    },
    {
      name: 'port',
      label: 'Порт',
      type: 'text',
      default: '3306',
      required: true,
      validate: (v: string) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535)
          return 'Порт должен быть числом 1–65535';
        return undefined;
      },
    },
    {
      name: 'user',
      label: 'Пользователь',
      type: 'text',
      default: 'root',
      required: true,
    },
    {
      name: 'password',
      label: 'Пароль',
      type: 'password',
      required: false,
    },
    {
      name: 'database',
      label: 'Имя базы данных',
      type: 'text',
      required: true,
      placeholder: 'myapp_production',
    },
  ];

  static buildDsn(values: Record<string, string>): string {
    const host = values.host || '127.0.0.1';
    const port = values.port || '3306';
    const user = values.user || 'root';
    const pass = values.password ? `:${encodeURIComponent(values.password)}` : '';
    const db = values.database;
    return `mysql://${user}${pass}@${host}:${port}/${db}`;
  }

  // ---- DSN parsing (instance method, no connection required) ----

  extractDbName(dsn: string): string {
    const parsed = parseMysqlDsn(dsn);
    return parsed.database || 'database';
  }

  // ---- Instance state ----

  private pool: import('mysql2/promise').Pool | null = null;
  private database = '';
  private dsn = '';

  // ==========================================================
  // Connection management
  // ==========================================================

  async connect(dsn: string, options?: ConnectOptions): Promise<void> {
    const createIfNotExists = options?.createIfNotExists ?? false;
    this.dsn = dsn;

    try {
      const parsed = parseMysqlDsn(dsn);
      this.database = parsed.database;

      // Dynamic import of mysql2/promise
      const mysql2 = await import('mysql2/promise');

      if (createIfNotExists && parsed.database) {
        // Create database if it doesn't exist (connect without database first)
        const adminPool = mysql2.createPool({
          host: parsed.host,
          port: parsed.port,
          user: parsed.user,
          password: parsed.password,
          waitForConnections: true,
          connectionLimit: 1,
        });
        try {
          await adminPool.execute(
            `CREATE DATABASE IF NOT EXISTS \`${parsed.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
          );
        } finally {
          await adminPool.end();
        }
      }

      this.pool = mysql2.createPool({
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
        waitForConnections: true,
        connectionLimit: 5,
        timezone: '+00:00',
      });

      // Test connection
      const conn = await this.pool.getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }
    } catch (err) {
      throw new DbsError({
        code: 'CONNECT',
        message: `Failed to connect to MySQL database`,
        cause: err instanceof Error ? err.message : String(err),
        engine: 'mysql',
        dsn,
        hint: 'Check that MySQL is running and the credentials/host/port are correct.',
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /** Ensure the pool is connected. */
  private ensurePool(): import('mysql2/promise').Pool {
    if (!this.pool) {
      throw new DbsError({
        code: 'CONNECT',
        message: 'Not connected to database',
        cause: 'Database connection not established',
        engine: 'mysql',
        hint: 'Call connect(dsn) before reading the schema.',
      });
    }
    return this.pool;
  }

  /** Execute a query and return rows. */
  private async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const pool = this.ensurePool();
    const [rows] = await pool.execute(sql, params);
    return rows as T[];
  }

  // ==========================================================
  // Schema reading (Snash)
  // ==========================================================

  async getTables(): Promise<string[]> {
    const rows = await this.query<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [this.database]
    );
    return rows.map((r) => r.TABLE_NAME);
  }

  async getColumns(tableName: string): Promise<ColumnDef[]> {
    const rows = await this.query<InformationSchemaColumn>(
      `SELECT
         COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE,
         COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [this.database, tableName]
    );

    return rows.map((row) => {
      const type = row.COLUMN_TYPE.toUpperCase();
      const isPk = row.COLUMN_KEY === 'PRI';
      const nullable = row.IS_NULLABLE === 'YES';
      const autoIncrement = row.EXTRA.toLowerCase().includes('auto_increment');
      const onUpdateCurrentTimestamp = hasOnUpdate(row.EXTRA);

      // Build a type string that includes ON UPDATE if present
      let resolvedType = type;
      if (onUpdateCurrentTimestamp && !resolvedType.includes('ON UPDATE')) {
        resolvedType = `${resolvedType} ON UPDATE CURRENT_TIMESTAMP`;
      }

      return {
        name: row.COLUMN_NAME,
        type: resolvedType,
        nullable: nullable && !isPk,
        primaryKey: isPk,
        unique: row.COLUMN_KEY === 'UNI',
        autoIncrement,
        defaultValue: formatDefaultValue(row.COLUMN_DEFAULT),
        comment: row.COLUMN_COMMENT || undefined,
        enumValues: row.DATA_TYPE === 'enum' ? extractEnumValues(row.COLUMN_TYPE) : undefined,
      };
    });
  }

  async getIndexes(tableName: string): Promise<IndexDef[]> {
    const rows = await this.query<InformationSchemaIndex>(
      `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME != 'PRIMARY'
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [this.database, tableName]
    );

    // Get FK constraint names — MySQL auto-creates indexes for FKs with
    // the same name as the constraint. We exclude those from the index list.
    const fkNames = new Set<string>();
    const fkRows = await this.query<{ CONSTRAINT_NAME: string }>(
      `SELECT DISTINCT CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [this.database, tableName]
    );
    for (const r of fkRows) fkNames.add(r.CONSTRAINT_NAME);

    // Group by index name
    const grouped = new Map<string, { columns: string[]; unique: boolean; type: string }>();
    for (const row of rows) {
      // Skip indexes that are actually FK constraint indexes
      if (fkNames.has(row.INDEX_NAME)) continue;

      let group = grouped.get(row.INDEX_NAME);
      if (!group) {
        group = {
          columns: [],
          unique: row.NON_UNIQUE === 0,
          type: row.INDEX_TYPE.toLowerCase(),
        };
        grouped.set(row.INDEX_NAME, group);
      }
      group.columns.push(row.COLUMN_NAME);
    }

    return [...grouped.entries()].map(([name, g]) => ({
      name,
      columns: g.columns,
      unique: g.unique,
      type: g.type,
    }));
  }

  async getForeignKeys(tableName: string): Promise<FKDef[]> {
    // Get FK columns from KEY_COLUMN_USAGE
    const fkRows = await this.query<InformationSchemaFK>(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME,
              REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [this.database, tableName]
    );

    if (fkRows.length === 0) return [];

    // Get referential actions
    const constraintNames = [...new Set(fkRows.map((r) => r.CONSTRAINT_NAME))];
    const placeholders = constraintNames.map(() => '?').join(',');

    const refRows = await this.query<InformationSchemaRefConstraint>(
      `SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
       FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME IN (${placeholders})`,
      [this.database, ...constraintNames]
    );

    const refMap = new Map<string, InformationSchemaRefConstraint>();
    for (const r of refRows) {
      refMap.set(r.CONSTRAINT_NAME, r);
    }

    // Group by constraint name
    const grouped = new Map<string, {
      columns: string[];
      refTable: string;
      refColumns: string[];
      onDelete?: string;
      onUpdate?: string;
    }>();

    for (const row of fkRows) {
      let group = grouped.get(row.CONSTRAINT_NAME);
      if (!group) {
        const ref = refMap.get(row.CONSTRAINT_NAME);
        group = {
          columns: [],
          refTable: row.REFERENCED_TABLE_NAME,
          refColumns: [],
          onDelete: ref?.DELETE_RULE,
          onUpdate: ref?.UPDATE_RULE,
        };
        grouped.set(row.CONSTRAINT_NAME, group);
      }
      group.columns.push(row.COLUMN_NAME);
      group.refColumns.push(row.REFERENCED_COLUMN_NAME);
    }

    return [...grouped.entries()].map(([, g]) => {
      // Generate a clean fk_ name from table + columns, ignoring MySQL's
      // internal CONSTRAINT_NAME (which may be auto-generated like posts_ibfk_1)
      const name = `fk_${tableName}_${g.columns.join('_')}`;
      return {
        name,
        columns: g.columns,
        refTable: g.refTable,
        refColumns: g.refColumns,
        onDelete: normaliseFKAction(g.onDelete ?? ''),
        onUpdate: normaliseFKAction(g.onUpdate ?? ''),
      };
    });
  }

  async getTriggers(tableName: string): Promise<TriggerDef[]> {
    const rows = await this.query<InformationSchemaTrigger>(
      `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
       ORDER BY TRIGGER_NAME`,
      [this.database, tableName]
    );

    return rows.map((row) => ({
      name: row.TRIGGER_NAME,
      timing: normaliseTriggerTiming(row.ACTION_TIMING),
      event: normaliseTriggerEvent(row.EVENT_MANIPULATION),
      body: row.ACTION_STATEMENT || '',
    }));
  }

  async getViews(): Promise<ViewDef[]> {
    const rows = await this.query<InformationSchemaView>(
      `SELECT TABLE_NAME, VIEW_DEFINITION
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [this.database]
    );

    return rows.map((row) => ({
      name: row.TABLE_NAME,
      definition: row.VIEW_DEFINITION || '',
    }));
  }

  async getProcedures(): Promise<ProcedureDef[]> {
    const rows = await this.query<InformationSchemaRoutine>(
      `SELECT ROUTINE_NAME, ROUTINE_DEFINITION
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
       ORDER BY ROUTINE_NAME`,
      [this.database]
    );

    return rows.map((row) => ({
      name: row.ROUTINE_NAME,
      body: row.ROUTINE_DEFINITION || '',
    }));
  }

  async getEnums(): Promise<EnumDef[]> {
    // MySQL ENUM types are embedded in column definitions.
    // We extract them from information_schema.COLUMNS where DATA_TYPE = 'enum'.
    const rows = await this.query<{ COLUMN_TYPE: string; COLUMN_NAME: string; TABLE_NAME: string }>(
      `SELECT COLUMN_TYPE, COLUMN_NAME, TABLE_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND DATA_TYPE = 'enum'
       ORDER BY TABLE_NAME, COLUMN_NAME`,
      [this.database]
    );

    // Collect unique enum types
    const enumMap = new Map<string, string[]>();

    for (const row of rows) {
      const values = extractEnumValues(row.COLUMN_TYPE);
      if (values.length > 0) {
        // Use column name as enum name since MySQL doesn't have named enums
        const enumName = `${row.TABLE_NAME}_${row.COLUMN_NAME}`;
        if (!enumMap.has(enumName)) {
          enumMap.set(enumName, values);
        }
      }
    }

    return [...enumMap.entries()].map(([name, values]) => ({ name, values }));
  }

  // ==========================================================
  // Records reading
  // ==========================================================

  async getTableRecords(tableName: string): Promise<RecordData> {
    const pool = this.ensurePool();

    // Get column names
    const colRows = await this.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [this.database, tableName]
    );
    const columns = colRows.map((c) => c.COLUMN_NAME);

    // Read all rows
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM \`${tableName}\``
    );

    const recordRows = rows.map((row) => ({
      values: columns.map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return null;
        if (val instanceof Date) return val.toISOString();
        return val as string | number;
      }),
    }));

    return { tableName, columns, rows: recordRows };
  }

  // ==========================================================
  // Schema migration
  // ==========================================================

  async migrateToSchema(target: SchemaIR, options?: MigrateOptions): Promise<MigrationPlan> {
    const dryRun = options?.dryRun ?? false;
    const plan: MigrationPlan = [];

    // 1. Read current schema from the live database
    const currentTables = await this.readCurrentSchema();
    const currentTableMap = new Map<string, TableDefinition>();
    for (const t of currentTables) {
      currentTableMap.set(t.name.toLowerCase(), t);
    }

    // 2. Compare and plan operations.
    // MySQL supports native ALTER TABLE ADD/DROP FOREIGN KEY and
    // ALTER TABLE MODIFY COLUMN — no table rebuilds needed.

    for (const targetTable of target.tables) {
      const currentTable = currentTableMap.get(targetTable.name.toLowerCase());

      if (!currentTable) {
        // New table — CREATE TABLE with inline FKs
        plan.push(...this.planCreateTable(targetTable));
      } else {
        // Existing table — column, index, and FK changes
        plan.push(...this.planColumnChanges(targetTable.name, currentTable.columns, targetTable.columns));
        plan.push(...this.planIndexChanges(targetTable.name, currentTable.indexes, targetTable.indexes));
        plan.push(...this.planFKChanges(targetTable.name, currentTable.foreignKeys, targetTable.foreignKeys));
      }
    }

    // Tables in current but NOT in target → intentionally skipped (SPEC §6.3)

    // 3. Insert Records if recordsFilter is set
    const filter = options?.recordsFilter;
    if (filter && target.records && target.records.length > 0) {
      const filtered = filter.includes('*')
        ? target.records
        : target.records.filter((r) => filter.includes(r.tableName));
      if (filtered.length > 0) {
        plan.push(...this.planInsertRecords(filtered));
      }
    }

    // 4. Execute SQL (unless dry-run)
    if (!dryRun) {
      const pool = this.ensurePool();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        try {
          for (const op of plan) {
            if (!op.sql.trim() || op.sql.trimStart().startsWith('--')) continue;
            try {
              await conn.execute(op.sql);
            } catch (err) {
              throw new DbsError({
                code: 'MIGRATE',
                message: `Migration operation failed on table "${op.table}"`,
                cause: err instanceof Error ? err.message : String(err),
                engine: 'mysql',
                operation: op.type,
                table: op.table,
                column: op.column,
              });
            }
          }
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          if (err instanceof DbsError) throw err;
          throw new DbsError({
            code: 'TRANSACTION',
            message: 'Migration transaction failed — rolled back',
            cause: err instanceof Error ? err.message : String(err),
            engine: 'mysql',
          });
        }
      } finally {
        conn.release();
      }
    }

    return plan;
  }

  // ---- Internal: read current schema ----

  private async readCurrentSchema(): Promise<TableDefinition[]> {
    const tableNames = await this.getTables();
    const tables: TableDefinition[] = [];

    for (const name of tableNames) {
      const [columns, indexes, foreignKeys, triggers] = await Promise.all([
        this.getColumns(name),
        this.getIndexes(name),
        this.getForeignKeys(name),
        this.getTriggers(name),
      ]);

      tables.push({ name, columns, indexes, foreignKeys, triggers });
    }

    return tables;
  }

  // ---- Internal: plan CREATE TABLE ----

  /**
   * Normalize a MySQL column type so it's always valid.
   *
   * - VARCHAR without length → VARCHAR(255)
   * - CHAR without length → CHAR(1)
   * - VARBINARY without length → VARBINARY(255)
   * - Lowercase types → UPPERCASE
   */
  private normType(type: string): string {
    let t = type.toUpperCase().trim();

    // VARCHAR without length → VARCHAR(255)
    if (t === 'VARCHAR' || t === 'CHARACTER VARYING') return 'VARCHAR(255)';

    // CHAR without length → CHAR(1)
    if (t === 'CHAR' || t === 'CHARACTER') return 'CHAR(1)';

    // VARBINARY without length → VARBINARY(255)
    if (t === 'VARBINARY') return 'VARBINARY(255)';

    // BINARY without length → BINARY(1)
    if (t === 'BINARY') return 'BINARY(1)';

    return t;
  }

  private planCreateTable(table: TableDefinition): MigrationOp[] {
    const lines: string[] = [];
    lines.push(`CREATE TABLE ${this.q(table.name)} (`);

    const colDefs: string[] = [];
    for (const col of table.columns) {
      const parts: string[] = [];
      parts.push(this.q(col.name));
      parts.push(this.normType(col.type));

      if (!col.nullable) parts.push('NOT NULL');
      if (col.autoIncrement) parts.push('AUTO_INCREMENT');
      if (col.primaryKey) parts.push('PRIMARY KEY');
      if (col.unique && !col.primaryKey) parts.push('UNIQUE');
      if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);

      colDefs.push('  ' + parts.join(' '));
    }

    // FK constraints inline
    for (const fk of table.foreignKeys) {
      const srcCols = fk.columns.map((c) => this.q(c)).join(', ');
      const refCols = fk.refColumns.map((c) => this.q(c)).join(', ');
      const constraintPrefix = fk.name ? `CONSTRAINT ${this.q(fk.name)} ` : '';
      let fkDef = `  ${constraintPrefix}FOREIGN KEY (${srcCols}) REFERENCES ${this.q(fk.refTable)} (${refCols})`;
      if (fk.onDelete && fk.onDelete !== 'no action') {
        fkDef += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      }
      if (fk.onUpdate && fk.onUpdate !== 'no action') {
        fkDef += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
      }
      colDefs.push(fkDef);
    }

    lines.push(colDefs.join(',\n'));
    lines.push(`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Add separate CREATE INDEX statements for indexes
    const ops: MigrationOp[] = [{
      type: 'create_table',
      table: table.name,
      sql: lines.join('\n'),
    }];

    // After CREATE TABLE, create indexes
    for (const idx of table.indexes) {
      ops.push(this.opCreateIndex(table.name, idx));
    }

    return ops;
  }

  // ---- Internal: diff columns ----

  private planColumnChanges(
    tableName: string,
    current: ColumnDef[],
    target: ColumnDef[],
  ): MigrationOp[] {
    const ops: MigrationOp[] = [];
    const curMap = this.colMap(current);
    const tgtMap = this.colMap(target);

    // DROP: columns in current but not in target
    for (const [name, col] of curMap) {
      if (!tgtMap.has(name)) {
        ops.push({
          type: 'drop_column',
          table: tableName,
          column: col.name,
          sql: `ALTER TABLE ${this.q(tableName)} DROP COLUMN ${this.q(col.name)}`,
        });
      }
    }

    // ADD: columns in target but not in current
    for (const [name, col] of tgtMap) {
      if (!curMap.has(name)) {
        ops.push({
          type: 'add_column',
          table: tableName,
          column: col.name,
          sql: this.sqlAddColumn(tableName, col),
        });
      }
    }

    // MODIFY: columns in both but definition changed
    for (const [name, tgtCol] of tgtMap) {
      const curCol = curMap.get(name);
      if (curCol && !this.colEq(curCol, tgtCol)) {
        ops.push({
          type: 'modify_column',
          table: tableName,
          column: tgtCol.name,
          sql: this.sqlModifyColumn(tableName, tgtCol),
        });
      }
    }

    return ops;
  }

  // ---- Internal: diff indexes ----

  private planIndexChanges(
    tableName: string,
    current: IndexDef[],
    target: IndexDef[],
  ): MigrationOp[] {
    const ops: MigrationOp[] = [];
    const curMap = new Map<string, IndexDef>();
    for (const idx of current) curMap.set(idx.name.toLowerCase(), idx);
    const tgtMap = new Map<string, IndexDef>();
    for (const idx of target) tgtMap.set(idx.name.toLowerCase(), idx);

    // DROP: indexes in current but not in target
    for (const [name, idx] of curMap) {
      if (!tgtMap.has(name)) {
        ops.push({
          type: 'drop_index',
          table: tableName,
          index: idx.name,
          sql: `ALTER TABLE ${this.q(tableName)} DROP INDEX ${this.q(idx.name)}`,
        });
      }
    }

    // CREATE: indexes in target but not in current (or definition changed)
    for (const [name, idx] of tgtMap) {
      const cur = curMap.get(name);
      if (!cur) {
        ops.push(this.opCreateIndex(tableName, idx));
      } else if (!this.idxEq(cur, idx)) {
        // Drop old, create new
        ops.push({
          type: 'drop_index',
          table: tableName,
          index: cur.name,
          sql: `ALTER TABLE ${this.q(tableName)} DROP INDEX ${this.q(cur.name)}`,
        });
        ops.push(this.opCreateIndex(tableName, idx));
      }
    }

    return ops;
  }

  // ---- Internal: diff foreign keys ----

  private fkKey(fk: FKDef): string {
    const cols = fk.columns.map((c) => c.toLowerCase()).join(',');
    const refCols = fk.refColumns.map((c) => c.toLowerCase()).join(',');
    const onDel = (fk.onDelete ?? 'no action').toLowerCase();
    const onUpd = (fk.onUpdate ?? 'no action').toLowerCase();
    return `${cols}|${fk.refTable.toLowerCase()}|${refCols}|${onDel}|${onUpd}`;
  }

  private planFKChanges(
    tableName: string,
    current: FKDef[],
    target: FKDef[],
  ): MigrationOp[] {
    const ops: MigrationOp[] = [];
    const curByKey = new Map<string, FKDef>();
    for (const fk of current) {
      curByKey.set(this.fkKey(fk), fk);
    }
    const tgtByKey = new Map<string, FKDef>();
    for (const fk of target) {
      tgtByKey.set(this.fkKey(fk), fk);
    }

    // DROP: FKs in current but not in target
    for (const [key, fk] of curByKey) {
      if (!tgtByKey.has(key)) {
        ops.push({
          type: 'drop_fk',
          table: tableName,
          fk: fk.name,
          sql: `ALTER TABLE ${this.q(tableName)} DROP FOREIGN KEY ${this.q(fk.name)}`,
        });
      }
    }

    // ADD: FKs in target but not in current
    for (const [key, fk] of tgtByKey) {
      if (!curByKey.has(key)) {
        ops.push({
          type: 'add_fk',
          table: tableName,
          fk: fk.name,
          sql: `ALTER TABLE ${this.q(tableName)} ADD CONSTRAINT ${this.q(fk.name)} FOREIGN KEY (${fk.columns.map((c) => this.q(c)).join(', ')}) REFERENCES ${this.q(fk.refTable)} (${fk.refColumns.map((c) => this.q(c)).join(', ')})${fk.onDelete && fk.onDelete !== 'no action' ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : ''}${fk.onUpdate && fk.onUpdate !== 'no action' ? ` ON UPDATE ${fk.onUpdate.toUpperCase()}` : ''}`,
        });
      }
    }

    return ops;
  }

  // ==========================================================
  // Records insertion
  // ==========================================================

  private planInsertRecords(records: RecordData[]): MigrationOp[] {
    const ops: MigrationOp[] = [];

    for (const rec of records) {
      if (rec.rows.length === 0) continue;

      const tableName = rec.tableName;
      const colNames = rec.columns.map((c) => this.q(c)).join(', ');

      for (const row of rec.rows) {
        const values = row.values.map((v) => {
          if (v === null) return 'NULL';
          if (typeof v === 'number') return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        });

        const sql = `INSERT IGNORE INTO ${this.q(tableName)} (${colNames}) VALUES (${values.join(', ')})`;

        ops.push({
          type: 'insert_records' as const,
          table: tableName,
          sql,
        });
      }
    }

    return ops;
  }

  // ==========================================================
  // SQL generators (MySQL-specific)
  // ==========================================================

  private sqlAddColumn(tableName: string, col: ColumnDef): string {
    const parts: string[] = [];
    parts.push(`ALTER TABLE ${this.q(tableName)}`);
    parts.push(`ADD COLUMN ${this.q(col.name)} ${this.normType(col.type)}`);
    if (!col.nullable) parts.push('NOT NULL');
    if (col.unique) parts.push('UNIQUE');
    if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);
    if (col.autoIncrement) parts.push('AUTO_INCREMENT');
    return parts.join(' ');
  }

  private sqlModifyColumn(tableName: string, col: ColumnDef): string {
    const parts: string[] = [];
    parts.push(`ALTER TABLE ${this.q(tableName)}`);
    parts.push(`MODIFY COLUMN ${this.q(col.name)} ${this.normType(col.type)}`);
    if (!col.nullable) parts.push('NOT NULL');
    if (col.autoIncrement) parts.push('AUTO_INCREMENT');
    if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);
    return parts.join(' ');
  }

  private opCreateIndex(tableName: string, idx: IndexDef): MigrationOp {
    const unique = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.columns.map((c) => this.q(c)).join(', ');
    return {
      type: 'create_index',
      table: tableName,
      index: idx.name,
      sql: `CREATE ${unique}INDEX ${this.q(idx.name)} ON ${this.q(tableName)} (${cols})`,
    };
  }

  // ==========================================================
  // Comparison helpers
  // ==========================================================

  private q(name: string): string {
    if (name.startsWith('`') && name.endsWith('`')) return name;
    if ((name.startsWith('"') && name.endsWith('"')) ||
        (name.startsWith('[') && name.endsWith(']'))) {
      // Strip non-MySQL quotes and wrap in backticks
      const inner = name.slice(1, -1);
      return `\`${inner}\``;
    }
    return `\`${name}\``;
  }

  private colMap(cols: ColumnDef[]): Map<string, ColumnDef> {
    const m = new Map<string, ColumnDef>();
    for (const c of cols) m.set(c.name.toLowerCase(), c);
    return m;
  }

  private colEq(a: ColumnDef, b: ColumnDef): boolean {
    return (
      a.name.toLowerCase() === b.name.toLowerCase() &&
      this.normaliseColType(a.type) === this.normaliseColType(b.type) &&
      a.nullable === b.nullable &&
      a.primaryKey === b.primaryKey &&
      a.unique === b.unique &&
      a.autoIncrement === b.autoIncrement &&
      a.defaultValue === b.defaultValue
    );
  }

  /**
   * Normalise a MySQL column type for comparison.
   * e.g. "INT(11)" and "INT" are equivalent in MySQL.
   * "VARCHAR(255)" and "varchar(255)" are the same.
   */
  private normaliseColType(type: string): string {
    let t = type.toUpperCase().trim();

    // Strip display width for integer types: INT(11) → INT, BIGINT(20) → BIGINT
    t = t.replace(/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\(\d+\)/, '$1');

    // Strip ON UPDATE CURRENT_TIMESTAMP for comparison
    t = t.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\d+\))?/i, '');

    // Normalise INTEGER → INT
    if (t === 'INTEGER') t = 'INT';

    // Normalise BOOLEAN/BOOL → TINYINT(1)
    if (t === 'BOOLEAN' || t === 'BOOL') t = 'TINYINT(1)';

    // Normalise lengthless types (match normType behavior)
    if (t === 'VARCHAR' || t === 'CHARACTER VARYING') t = 'VARCHAR(255)';
    if (t === 'CHAR' || t === 'CHARACTER') t = 'CHAR(1)';
    if (t === 'VARBINARY') t = 'VARBINARY(255)';
    if (t === 'BINARY') t = 'BINARY(1)';

    // Strip character set and collation suffixes
    t = t.replace(/\s+CHARACTER\s+SET\s+\w+/gi, '');
    t = t.replace(/\s+COLLATE\s+\w+/gi, '');

    return t.trim();
  }

  private idxEq(a: IndexDef, b: IndexDef): boolean {
    if (a.unique !== b.unique) return false;
    if (a.columns.length !== b.columns.length) return false;
    for (let i = 0; i < a.columns.length; i++) {
      if (a.columns[i].toLowerCase() !== b.columns[i].toLowerCase()) return false;
    }
    return true;
  }
}

// ============================================================
// Utility: extract ENUM values from MySQL column type string
// ============================================================

/**
 * Extract ENUM values from a MySQL column type string.
 *
 * Input:  "enum('admin','editor','viewer')"
 * Output: ["admin", "editor", "viewer"]
 */
function extractEnumValues(columnType: string): string[] {
  const match = columnType.match(/^enum\((.*)\)$/i);
  if (!match) return [];

  const values: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of match[1]) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
        values.push(current);
        current = '';
      } else if (ch === '\\') {
        // Handle escaped characters
        current += ch;
      } else {
        current += ch;
      }
    } else if (ch === "'" || ch === '"') {
      inQuote = true;
      quoteChar = ch;
    }
  }

  return values;
}
