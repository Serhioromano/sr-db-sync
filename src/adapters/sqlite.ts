// ============================================================
// SQLite adapter — schema reading (Snash) + schema writing (Migrate)
// ============================================================
//
// Uses bun:sqlite (built-in) when running under Bun.
// Throws a clear error when running under plain Node.js.

import { basename, extname } from 'node:path';
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
// Helpers
// ============================================================

/**
 * Map SQLite affinity type names to canonical uppercase form.
 * e.g. "varchar(255)" stays "VARCHAR(255)", "INT" → "INTEGER".
 */
function normaliseColumnType(raw: string): string {
  const upper = raw.trim().toUpperCase();

  // SQLite type affinity mapping — canonicalise common aliases
  if (upper === 'INT' || upper === 'INTEGER') return 'INTEGER';
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BOOLEAN';
  if (upper === 'FLOAT' || upper === 'DOUBLE') return 'REAL';
  if (upper === 'DATETIME' || upper === 'TIMESTAMP') return 'TIMESTAMP';

  // Return as-is for parameterised types like VARCHAR(255), DECIMAL(10,2)
  return raw.trim().toUpperCase();
}

/**
 * Extract column names from a SQLite CREATE TABLE statement.
 * Used to resolve index column names from PRAGMA index_info (which gives cid).
 */
function parseCreateTableColumns(sql: string): string[] {
  // Match the column definitions inside parentheses
  // Find the first '(' after CREATE TABLE ... and match column names
  const match = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:".*?"|`.*?`|\[.*?\]|\w+)\s*\((.+)\)\s*$/is);
  if (!match) return [];

  const body = match[1];
  const columns: string[] = [];

  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inString) {
      current += ch;
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth < 0) break;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      // Extract the first word (column name)
      const colMatch = trimmed.match(/^(?:"(.*?)"|`(.*?)`|\[(.*?)\]|(\w+))/);
      if (colMatch) {
        columns.push(colMatch[1] ?? colMatch[2] ?? colMatch[3] ?? colMatch[4] ?? '');
      }
      current = '';
      continue;
    }

    current += ch;
  }

  // Handle the last column
  const trimmed = current.trim();
  const colMatch = trimmed.match(/^(?:"(.*?)"|`(.*?)`|\[(.*?)\]|(\w+))/);
  if (colMatch) {
    columns.push(colMatch[1] ?? colMatch[2] ?? colMatch[3] ?? colMatch[4] ?? '');
  }

  return columns;
}

/**
 * Map ON DELETE / ON UPDATE action string to standard form.
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
 * Parse timing and event from a trigger SQL statement.
 * e.g. "CREATE TRIGGER ... AFTER INSERT ON ..." → { timing: 'after', event: 'insert' }
 */
function parseTriggerTimingEvent(sql: string): { timing: TriggerDef['timing']; event: TriggerDef['event'] } {
  const match = sql.match(/(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)/i);
  if (match) {
    return {
      timing: match[1].toLowerCase() as TriggerDef['timing'],
      event: match[2].toLowerCase() as TriggerDef['event'],
    };
  }
  return { timing: 'after', event: 'insert' };
}

// ============================================================
// SQLite Adapter
// ============================================================

export class SqliteAdapter implements DatabaseAdapter {
  // ---- DSN contract (static) ----

  static readonly dsnFields: DsnField[] = [
    {
      name: 'path',
      label: 'Путь к файлу базы данных',
      type: 'text',
      default: './db.sqlite',
      placeholder: './data/myapp.db',
      required: true,
    },
  ];

  static buildDsn(values: Record<string, string>): string {
    return values.path;
  }

  // ---- DSN parsing (instance method, no connection required) ----

  /**
   * Extract a human-readable database name from a SQLite DSN (file path).
   *
   * Examples:
   *   './data/myapp.db'    → 'myapp'
   *   '/var/db/prod.sqlite' → 'prod'
   *   'local/db.sqlite3'    → 'db'
   *   './data/custom.ext'   → 'custom'
   *   './data/rawfile'      → 'rawfile'
   */
  extractDbName(dsn: string): string {
    const base = basename(dsn);
    const ext = extname(base);
    // Strip well-known SQLite extensions
    const knownExts = ['.db', '.sqlite', '.sqlite3'];
    if (knownExts.includes(ext.toLowerCase())) {
      return base.slice(0, -ext.length);
    }
    // Strip any other extension
    if (ext) return base.slice(0, -ext.length);
    return base;
  }

  // ---- Instance state ----

  private db: any = null;
  private dsn = '';

  // ==========================================================
  // Connection management
  // ==========================================================

  async connect(dsn: string, options?: ConnectOptions): Promise<void> {
    // bun:sqlite is only available in the Bun runtime
    if (typeof globalThis.Bun === 'undefined') {
      throw new DbsError({
        code: 'ENGINE',
        message: 'SQLite adapter requires Bun runtime. Install Bun: https://bun.sh',
        engine: 'sqlite',
        hint: 'MySQL adapter works on any Node.js runtime without Bun.',
      });
    }
    const { Database } = await import('bun:sqlite');
    const createIfNotExists = options?.createIfNotExists ?? false;
    try {
      this.dsn = dsn;
      this.db = new Database(dsn, { create: createIfNotExists, readwrite: true });
      // Enable foreign key enforcement
      this.db.exec('PRAGMA foreign_keys = ON');
    } catch (err) {
      throw new DbsError({
        code: 'CONNECT',
        message: `Failed to connect to SQLite database`,
        cause: err instanceof Error ? err.message : String(err),
        engine: 'sqlite',
        dsn,
        hint: createIfNotExists
          ? 'Check that the path is writable and valid.'
          : 'Check that the file exists and is a valid SQLite database.',
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Ensure the database is connected. */
  private ensureDb(): Database {
    if (!this.db) {
      throw new DbsError({
        code: 'CONNECT',
        message: 'Not connected to database',
        cause: 'Database connection not established',
        engine: 'sqlite',
        hint: 'Call connect(dsn) before reading the schema.',
      });
    }
    return this.db;
  }

  // ==========================================================
  // Schema reading (Snash)
  // ==========================================================

  async getTables(): Promise<string[]> {
    const db = this.ensureDb();
    const rows = db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();
    return rows.map((r) => r.name);
  }

  async getColumns(tableName: string): Promise<ColumnDef[]> {
    const db = this.ensureDb();

    // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
    const rows = db
      .query<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(
        `PRAGMA table_info('${tableName}')`
      )
      .all();

    // Get CREATE TABLE SQL to check for AUTOINCREMENT
    const createSql = db
      .query<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(tableName);

    const autoIncrementColumns = new Set<string>();
    if (createSql?.sql) {
      // Look for AUTOINCREMENT keyword in CREATE TABLE statement
      const autoIncMatch = createSql.sql.match(
        /(["`\[]?\w+["`\]\]]?)\s+(?:INT|INTEGER)\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi
      );
      if (autoIncMatch) {
        for (const m of autoIncMatch) {
          const nameMatch = m.match(/^(["`\[]?)(\w+)\1/);
          if (nameMatch) {
            autoIncrementColumns.add(nameMatch[2]);
          }
        }
      }
    }

    return rows.map((row) => ({
      name: row.name,
      type: normaliseColumnType(row.type || ''),
      // PRIMARY KEY columns are implicitly NOT NULL in SQLite,
      // even when PRAGMA table_info reports notnull=0.
      nullable: row.notnull === 0 && row.pk === 0,
      primaryKey: row.pk > 0,
      unique: false, // Set later from index info
      autoIncrement: autoIncrementColumns.has(row.name),
      defaultValue: row.dflt_value ?? undefined,
    }));
  }

  async getIndexes(tableName: string): Promise<IndexDef[]> {
    const db = this.ensureDb();

    // PRAGMA index_list returns: seq, name, unique, origin, partial
    const indexList = db
      .query<{
        seq: number;
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>(
        `PRAGMA index_list('${tableName}')`
      )
      .all();

    // Get column order from CREATE TABLE sql (needed because PRAGMA index_info gives cid)
    const createSql = db
      .query<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(tableName);

    const tableColumns = createSql?.sql
      ? parseCreateTableColumns(createSql.sql)
      : [];

    const indexes: IndexDef[] = [];

    for (const idx of indexList) {
      // PRAGMA index_info returns: seqno, cid, name
      const info = db
        .query<{ seqno: number; cid: number; name: string }>(
          `PRAGMA index_info('${idx.name}')`
        )
        .all();

      // Resolve column names — prefer the name from index_info, fall back to cid
      const columns = info.map((col) => {
        // Col name from PRAGMA index_info is usually the column name
        return col.name || tableColumns[col.cid] || `column_${col.cid}`;
      });

      // Skip internal auto-indexes (sqlite_autoindex_*)
      if (idx.name.startsWith('sqlite_autoindex_')) {
        continue;
      }

      indexes.push({
        name: idx.name,
        columns,
        unique: idx.unique === 1,
        type: 'btree', // SQLite only supports btree
      });
    }

    return indexes;
  }

  async getForeignKeys(tableName: string): Promise<FKDef[]> {
    const db = this.ensureDb();

    // PRAGMA foreign_key_list returns: id, seq, table, from, to, on_update, on_delete, match
    const rows = db
      .query<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>(
        `PRAGMA foreign_key_list('${tableName}')`
      )
      .all();

    // Group by id (foreign key constraint)
    const grouped = new Map<
      number,
      { columns: string[]; refColumns: string[]; refTable: string; onUpdate: string; onDelete: string }
    >();

    for (const row of rows) {
      let group = grouped.get(row.id);
      if (!group) {
        group = {
          columns: [],
          refColumns: [],
          refTable: row.table,
          onUpdate: row.on_update,
          onDelete: row.on_delete,
        };
        grouped.set(row.id, group);
      }
      group.columns.push(row.from);
      group.refColumns.push(row.to);
    }

    const fks: FKDef[] = [];
    for (const [id, g] of grouped) {
      fks.push({
        name: `fk_${tableName}_${g.refTable}_${id}`,
        columns: g.columns,
        refTable: g.refTable,
        refColumns: g.refColumns,
        onDelete: normaliseFKAction(g.onDelete),
        onUpdate: normaliseFKAction(g.onUpdate),
      });
    }

    return fks;
  }

  async getTriggers(tableName: string): Promise<TriggerDef[]> {
    const db = this.ensureDb();

    const rows = db
      .query<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
      )
      .all(tableName);

    return rows.map((row) => {
      const { timing, event } = parseTriggerTimingEvent(row.sql || '');
      return {
        name: row.name,
        timing,
        event,
        body: row.sql || '',
      };
    });
  }

  async getViews(): Promise<ViewDef[]> {
    const db = this.ensureDb();

    const rows = db
      .query<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name",
      )
      .all();

    return rows.map((row) => ({
      name: row.name,
      definition: row.sql || '',
    }));
  }

  async getProcedures(): Promise<ProcedureDef[]> {
    // SQLite does not support stored procedures
    return [];
  }

  async getEnums(): Promise<EnumDef[]> {
    // SQLite does not support ENUM types natively
    return [];
  }

  // ==========================================================
  // Records reading — reads all rows from a table
  // ==========================================================

  async getTableRecords(tableName: string): Promise<RecordData> {
    const db = this.ensureDb();

    // Get column names from PRAGMA table_info
    const cols = db
      .query<{ name: string }>(`PRAGMA table_info('${tableName}')`)
      .all();
    const columns = cols.map((c) => c.name);

    // Read all rows
    const rows = db
      .query(`SELECT * FROM "${tableName}"`)
      .all() as Record<string, unknown>[];

    const recordRows = rows.map((row) => ({
      values: columns.map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return null;
        return val as string | number;
      }),
    }));

    return { tableName, columns, rows: recordRows };
  }

  // ==========================================================
  // Schema migration
  // ==========================================================
  // The adapter reads the current schema, compares it with the
  // target SchemaIR, generates SQLite-specific SQL, executes it
  // (unless dryRun), and returns a MigrationPlan.

  async migrateToSchema(target: SchemaIR, options?: MigrateOptions): Promise<MigrationPlan> {
    const dryRun = options?.dryRun ?? false;
    const plan: MigrationPlan = [];

    // 1. Read current schema from the live database
    const currentTables = await this.readCurrentSchema();
    const currentTableMap = new Map<string, TableDefinition>();
    for (const t of currentTables) {
      currentTableMap.set(t.name.toLowerCase(), t);
    }

    // 2. Compare and plan operations in correct order.
    //    For tables with FK changes: table rebuild (SQLite cannot ALTER FK).
    //    For tables without FK changes: individual ALTER + CREATE/DROP INDEX.
    //    For new tables: CREATE TABLE with inline FKs + CREATE INDEX.

    for (const targetTable of target.tables) {
      const currentTable = currentTableMap.get(targetTable.name.toLowerCase());

      if (!currentTable) {
        // New table — CREATE TABLE with inline FK constraints
        plan.push(...this.planCreateTable(targetTable));
        plan.push(...this.planIndexChanges(targetTable.name, [], targetTable.indexes));
        // FKs are already included inline in CREATE TABLE — skip planFKChanges
      } else if (this.hasFKChanges(currentTable.foreignKeys, targetTable.foreignKeys)) {
        // FK changes detected → table rebuild (handles columns + FKs atomically)
        plan.push(...this.planTableRebuild(targetTable, currentTable));
        // After rebuild, recreate all indexes from target
        plan.push(...this.planIndexChanges(targetTable.name, [], targetTable.indexes));
      } else {
        // No FK changes — individual column/index operations
        plan.push(...this.planColumnChanges(targetTable.name, currentTable.columns, targetTable.columns));
        plan.push(...this.planIndexChanges(targetTable.name, currentTable.indexes, targetTable.indexes));
        // No FK diff — skip planFKChanges
      }
    }

    // Tables in current but NOT in target → intentionally skipped (SPEC §6.3)

    // 2.5. Insert Records if recordsFilter is set
    const filter = options?.recordsFilter;
    if (filter && target.records && target.records.length > 0) {
      const filtered = filter.includes('*')
        ? target.records
        : target.records.filter((r) => filter.includes(r.tableName));
      if (filtered.length > 0) {
        plan.push(...this.planInsertRecords(filtered));
      }
    }

    // 3. Execute SQL (unless dry-run)
    if (!dryRun) {
      const db = this.ensureDb();
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        for (const op of plan) {
          // Skip comment-only operations (FK changes on SQLite — not supported via ALTER)
          if (!op.sql.trim() || op.sql.trimStart().startsWith('--')) continue;
          try {
            db.run(op.sql);
          } catch (err) {
            throw new DbsError({
              code: 'MIGRATE',
              message: `Migration operation failed on table "${op.table}"`,
              cause: err instanceof Error ? err.message : String(err),
              engine: 'sqlite',
              operation: op.type,
              table: op.table,
              column: op.column,
            });
          }
        }
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }

    return plan;
  }

  // ---- Internal: read the current schema from DB ----

  private async readCurrentSchema(): Promise<TableDefinition[]> {
    const tableNames = await this.getTables();
    const tables: TableDefinition[] = [];

    for (const name of tableNames) {
      const [columns, indexes, foreignKeys] = await Promise.all([
        this.getColumns(name),
        this.getIndexes(name),
        this.getForeignKeys(name),
      ]);

      tables.push({ name, columns, indexes, foreignKeys, triggers: [] });
    }

    return tables;
  }

  // ---- Internal: plan CREATE TABLE operation ----

  private planCreateTable(table: TableDefinition): MigrationOp[] {
    const lines: string[] = [];
    lines.push(`CREATE TABLE ${this.q(table.name)} (`);

    const colDefs: string[] = [];
    for (const col of table.columns) {
      const parts: string[] = [];
      parts.push(this.q(col.name));
      parts.push(col.type.toUpperCase());

      if (col.primaryKey) {
        parts.push('PRIMARY KEY');
        if (col.autoIncrement) parts.push('AUTOINCREMENT');
      }
      if (!col.nullable && !col.primaryKey) parts.push('NOT NULL');
      if (col.unique && !col.primaryKey) parts.push('UNIQUE');
      if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);

      colDefs.push('  ' + parts.join(' '));
    }

    // FK constraints inline (SQLite requires them in CREATE TABLE)
    for (const fk of table.foreignKeys) {
      const srcCols = fk.columns.map((c) => this.q(c)).join(', ');
      const refCols = fk.refColumns.map((c) => this.q(c)).join(', ');
      let fkDef = `  FOREIGN KEY (${srcCols}) REFERENCES ${this.q(fk.refTable)} (${refCols})`;
      if (fk.onDelete && fk.onDelete !== 'no action') {
        fkDef += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      }
      if (fk.onUpdate && fk.onUpdate !== 'no action') {
        fkDef += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
      }
      colDefs.push(fkDef);
    }

    lines.push(colDefs.join(',\n'));
    lines.push(')');

    return [{
      type: 'create_table',
      table: table.name,
      sql: lines.join('\n'),
    }];
  }

  // ---- Internal: diff columns between current and target ----

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
          sql: `DROP INDEX ${this.q(idx.name)}`,
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
          sql: `DROP INDEX ${this.q(cur.name)}`,
        });
        ops.push(this.opCreateIndex(tableName, idx));
      }
    }

    return ops;
  }

  // ---- Internal: diff foreign keys ----

  /** Build a structural key for FK comparison (ignores name). */
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

    // Match by structural key (columns + refTable + refColumns + onDelete + onUpdate),
    // NOT by name. SQLite auto-generates FK names that differ from DBML-parsed names.
    const curByKey = new Map<string, FKDef>();
    for (const fk of current) {
      curByKey.set(this.fkKey(fk), fk);
    }
    const tgtByKey = new Map<string, FKDef>();
    for (const fk of target) {
      tgtByKey.set(this.fkKey(fk), fk);
    }

    // DROP: FKs in current but not in target (structurally)
    for (const [key, fk] of curByKey) {
      if (!tgtByKey.has(key)) {
        ops.push(this.opDropFK(tableName, fk));
      }
    }

    // ADD: FKs in target but not in current (structurally)
    for (const [key, fk] of tgtByKey) {
      if (!curByKey.has(key)) {
        ops.push(this.opAddFK(tableName, fk));
      }
    }

    return ops;
  }

  /** Check if any FK changed structurally between current and target. */
  private hasFKChanges(current: FKDef[], target: FKDef[]): boolean {
    const curKeys = new Set(current.map((fk) => this.fkKey(fk)));
    const tgtKeys = new Set(target.map((fk) => this.fkKey(fk)));
    if (curKeys.size !== tgtKeys.size) return true;
    for (const k of curKeys) {
      if (!tgtKeys.has(k)) return true;
    }
    return false;
  }

  /**
   * Generate table rebuild operations for SQLite.
   *
   * SQLite does not support ALTER TABLE ADD/DROP FOREIGN KEY,
   * so FK changes require rebuilding the table:
   *   1. CREATE TABLE _dbs_rebuild_X (target columns + FKs inline)
   *   2. INSERT INTO _dbs_rebuild_X SELECT target_columns FROM original
   *   3. DROP TABLE original
   *   4. ALTER TABLE _dbs_rebuild_X RENAME TO original
   *
   * Returns multiple MigrationOps (one per SQL statement).
   */
  private planTableRebuild(
    target: TableDefinition,
    current: TableDefinition,
  ): MigrationOp[] {
    const tableName = target.name;
    const tempName = `_dbs_rebuild_${tableName}`;
    const ops: MigrationOp[] = [];

    // ---- 1. CREATE TABLE _new with target columns + FKs ----
    const createLines: string[] = [];
    createLines.push(`CREATE TABLE ${this.q(tempName)} (`);

    const colDefs: string[] = [];
    for (const col of target.columns) {
      const parts: string[] = [];
      parts.push(this.q(col.name));
      parts.push(col.type.toUpperCase());

      if (col.primaryKey) {
        parts.push('PRIMARY KEY');
        if (col.autoIncrement) parts.push('AUTOINCREMENT');
      }
      if (!col.nullable && !col.primaryKey) parts.push('NOT NULL');
      if (col.unique && !col.primaryKey) parts.push('UNIQUE');
      if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);

      colDefs.push('  ' + parts.join(' '));
    }

    // FK constraints inline
    for (const fk of target.foreignKeys) {
      const srcCols = fk.columns.map((c) => this.q(c)).join(', ');
      const refCols = fk.refColumns.map((c) => this.q(c)).join(', ');
      let fkDef = `  FOREIGN KEY (${srcCols}) REFERENCES ${this.q(fk.refTable)} (${refCols})`;
      if (fk.onDelete && fk.onDelete !== 'no action') {
        fkDef += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      }
      if (fk.onUpdate && fk.onUpdate !== 'no action') {
        fkDef += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
      }
      colDefs.push(fkDef);
    }

    createLines.push(colDefs.join(',\n'));
    createLines.push(')');

    ops.push({
      type: 'rebuild' as const,
      table: tableName,
      sql: `/* Rebuilding "${tableName}" for FK changes */\n${createLines.join('\n')}`,
    });

    // ---- 2. Copy data (matching columns by name) ----
    const targetCols = target.columns;
    const commonCols = current.columns.filter((c) =>
      targetCols.some((tc) => tc.name.toLowerCase() === c.name.toLowerCase())
    );
    const colNames = commonCols.map((c) => this.q(c.name)).join(', ');

    ops.push({
      type: 'rebuild' as const,
      table: tableName,
      sql: `INSERT INTO ${this.q(tempName)} (${colNames})\nSELECT ${colNames}\nFROM ${this.q(tableName)}`,
    });

    // ---- 3. Drop original ----
    ops.push({
      type: 'rebuild' as const,
      table: tableName,
      sql: `DROP TABLE ${this.q(tableName)}`,
    });

    // ---- 4. Rename temp to original ----
    ops.push({
      type: 'rebuild' as const,
      table: tableName,
      sql: `ALTER TABLE ${this.q(tempName)} RENAME TO ${this.q(tableName)}`,
    });

    return ops;
  }

  // ==========================================================
  // Records insertion
  // ==========================================================

  /**
   * Generate INSERT OR IGNORE statements for Records parsed from DBML.
   * Uses INSERT OR IGNORE to avoid duplicate-key errors.
   */
  private planInsertRecords(records: RecordData[]): MigrationOp[] {
    const ops: MigrationOp[] = [];

    for (const rec of records) {
      if (rec.rows.length === 0) continue;

      const tableName = rec.tableName;
      const colNames = rec.columns.map((c) => this.q(c)).join(', ');
      const placeholders = rec.columns.map(() => '?').join(', ');

      for (const row of rec.rows) {
        // Build SQL with inline values for display and execution
        const values = row.values.map((v) => {
          if (v === null) return 'NULL';
          if (typeof v === 'number') return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        });

        const sql = `INSERT OR IGNORE INTO ${this.q(tableName)} (${colNames}) VALUES (${values.join(', ')})`;

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
  // SQL generators (SQLite-specific)
  // ==========================================================

  private sqlAddColumn(tableName: string, col: ColumnDef): string {
    const parts: string[] = [];
    parts.push(`ALTER TABLE ${this.q(tableName)}`);
    parts.push(`ADD COLUMN ${this.q(col.name)} ${col.type.toUpperCase()}`);
    if (!col.nullable) parts.push('NOT NULL');
    if (col.unique) parts.push('UNIQUE');
    if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);
    return parts.join(' ');
  }

  private sqlModifyColumn(tableName: string, col: ColumnDef): string {
    // SQLite doesn't support ALTER TABLE MODIFY COLUMN.
    // We emit a comment and a representative SQL; the caller must
    // handle the table-rebuild workaround (future phase).
    const parts: string[] = [];
    parts.push(`ALTER TABLE ${this.q(tableName)}`);
    parts.push(`MODIFY COLUMN ${this.q(col.name)} ${col.type.toUpperCase()}`);
    if (!col.nullable) parts.push('NOT NULL');
    if (col.unique) parts.push('UNIQUE');
    if (col.defaultValue !== undefined) parts.push(`DEFAULT ${col.defaultValue}`);
    return `-- Note: SQLite requires table rebuild for MODIFY COLUMN\n${parts.join(' ')}`;
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

  private opAddFK(tableName: string, fk: FKDef): MigrationOp {
    const srcCols = fk.columns.map((c) => this.q(c)).join(', ');
    const refCols = fk.refColumns.map((c) => this.q(c)).join(', ');
    const cName = fk.name ? `CONSTRAINT ${this.q(fk.name)} ` : '';
    let sql = `ALTER TABLE ${this.q(tableName)} ADD ${cName}FOREIGN KEY (${srcCols}) REFERENCES ${this.q(fk.refTable)} (${refCols})`;
    if (fk.onDelete && fk.onDelete !== 'no action') {
      sql += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
    }
    if (fk.onUpdate && fk.onUpdate !== 'no action') {
      sql += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
    }
    return {
      type: 'add_fk',
      table: tableName,
      fk: fk.name,
      sql: `-- Note: SQLite requires table rebuild for FK changes\n${sql}`,
    };
  }

  private opDropFK(tableName: string, fk: FKDef): MigrationOp {
    return {
      type: 'drop_fk',
      table: tableName,
      fk: fk.name,
      sql: `-- Note: SQLite requires table rebuild for FK changes\nALTER TABLE ${this.q(tableName)} DROP FOREIGN KEY ${this.q(fk.name)}`,
    };
  }

  // ==========================================================
  // Comparison helpers
  // ==========================================================

  private q(name: string): string {
    if ((name.startsWith('"') && name.endsWith('"')) ||
        (name.startsWith('`') && name.endsWith('`')) ||
        (name.startsWith('[') && name.endsWith(']'))) {
      return name;
    }
    return `"${name}"`;
  }

  private colMap(cols: ColumnDef[]): Map<string, ColumnDef> {
    const m = new Map<string, ColumnDef>();
    for (const c of cols) m.set(c.name.toLowerCase(), c);
    return m;
  }

  private colEq(a: ColumnDef, b: ColumnDef): boolean {
    return (
      a.name.toLowerCase() === b.name.toLowerCase() &&
      a.type.toUpperCase() === b.type.toUpperCase() &&
      a.nullable === b.nullable &&
      a.primaryKey === b.primaryKey &&
      a.unique === b.unique &&
      a.autoIncrement === b.autoIncrement &&
      a.defaultValue === b.defaultValue
    );
  }

  private idxEq(a: IndexDef, b: IndexDef): boolean {
    if (a.unique !== b.unique) return false;
    if (a.columns.length !== b.columns.length) return false;
    for (let i = 0; i < a.columns.length; i++) {
      if (a.columns[i].toLowerCase() !== b.columns[i].toLowerCase()) return false;
    }
    return true;
  }

  private fkEq(a: FKDef, b: FKDef): boolean {
    if (a.columns.length !== b.columns.length) return false;
    for (let i = 0; i < a.columns.length; i++) {
      if (a.columns[i].toLowerCase() !== b.columns[i].toLowerCase()) return false;
    }
    if (a.refTable.toLowerCase() !== b.refTable.toLowerCase()) return false;
    if (a.refColumns.length !== b.refColumns.length) return false;
    for (let i = 0; i < a.refColumns.length; i++) {
      if (a.refColumns[i].toLowerCase() !== b.refColumns[i].toLowerCase()) return false;
    }
    if ((a.onDelete ?? 'no action') !== (b.onDelete ?? 'no action')) return false;
    if ((a.onUpdate ?? 'no action') !== (b.onUpdate ?? 'no action')) return false;
    return true;
  }
}
