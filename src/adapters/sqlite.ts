// ============================================================
// SQLite adapter — schema reading (Snash) + schema writing (Migrate)
// ============================================================
//
// Uses bun:sqlite (built-in) — no external dependencies.
// Migrate methods throw "not implemented" until Phase 8.

import { Database } from 'bun:sqlite';
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
} from '../core/types.js';
import type {
  DatabaseAdapter,
  DsnField,
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

  private db: Database | null = null;
  private dsn = '';

  // ==========================================================
  // Connection management
  // ==========================================================

  async connect(dsn: string): Promise<void> {
    try {
      this.dsn = dsn;
      this.db = new Database(dsn, { create: false, readwrite: true });
      // Enable foreign key enforcement
      this.db.exec('PRAGMA foreign_keys = ON');
    } catch (err) {
      throw new DbsError({
        code: 'CONNECT',
        message: `Failed to connect to SQLite database`,
        cause: err instanceof Error ? err.message : String(err),
        engine: 'sqlite',
        dsn,
        hint: 'Check that the file exists and is a valid SQLite database.',
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

    // 2. Compare and plan operations in correct order:
    //    CREATE TABLE → DROP/ADD/MODIFY COLUMN → indexes → FKs

    for (const targetTable of target.tables) {
      const currentTable = currentTableMap.get(targetTable.name.toLowerCase());

      if (!currentTable) {
        // New table — CREATE TABLE (columns only; indexes + FKs come after)
        plan.push(...this.planCreateTable(targetTable));
      } else {
        // Table exists — diff columns, indexes, FKs
        plan.push(...this.planColumnChanges(targetTable.name, currentTable.columns, targetTable.columns));
        plan.push(...this.planIndexChanges(targetTable.name, currentTable.indexes, targetTable.indexes));
        plan.push(...this.planFKChanges(targetTable.name, currentTable.foreignKeys, targetTable.foreignKeys));
      }
    }

    // Tables in current but NOT in target → intentionally skipped (SPEC §6.3)

    // 3. Execute SQL (unless dry-run)
    if (!dryRun) {
      const db = this.ensureDb();
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        for (const op of plan) {
          db.run(op.sql);
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

  private planFKChanges(
    tableName: string,
    current: FKDef[],
    target: FKDef[],
  ): MigrationOp[] {
    const ops: MigrationOp[] = [];
    const curMap = new Map<string, FKDef>();
    for (const fk of current) curMap.set(fk.name.toLowerCase(), fk);
    const tgtMap = new Map<string, FKDef>();
    for (const fk of target) tgtMap.set(fk.name.toLowerCase(), fk);

    // DROP: FKs in current but not in target
    for (const [name, fk] of curMap) {
      if (!tgtMap.has(name)) {
        ops.push(this.opDropFK(tableName, fk));
      }
    }

    // ADD: FKs in target but not in current (or definition changed)
    for (const [name, fk] of tgtMap) {
      const cur = curMap.get(name);
      if (!cur) {
        ops.push(this.opAddFK(tableName, fk));
      } else if (!this.fkEq(cur, fk)) {
        ops.push(this.opDropFK(tableName, cur));
        ops.push(this.opAddFK(tableName, fk));
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
