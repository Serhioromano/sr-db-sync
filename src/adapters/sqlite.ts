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
  TableDefinition,
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
  // Schema writing (Migrate) — stubbed until Phase 8
  // ==========================================================

  async createTable(_table: TableDefinition): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'createTable not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async addColumn(_tableName: string, _column: ColumnDef): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'addColumn not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async dropColumn(_tableName: string, _columnName: string): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'dropColumn not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async modifyColumn(_tableName: string, _column: ColumnDef): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'modifyColumn not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async createIndex(_tableName: string, _index: IndexDef): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'createIndex not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async dropIndex(_tableName: string, _indexName: string): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'dropIndex not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async addForeignKey(_tableName: string, _fk: FKDef): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'addForeignKey not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async dropForeignKey(_tableName: string, _fkName: string): Promise<void> {
    throw new DbsError({
      code: 'MIGRATE',
      message: 'dropForeignKey not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  // ==========================================================
  // Transactions — stubbed until Phase 8
  // ==========================================================

  async beginTransaction(): Promise<void> {
    throw new DbsError({
      code: 'TRANSACTION',
      message: 'beginTransaction not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async commit(): Promise<void> {
    throw new DbsError({
      code: 'TRANSACTION',
      message: 'commit not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }

  async rollback(): Promise<void> {
    throw new DbsError({
      code: 'TRANSACTION',
      message: 'rollback not yet implemented for SQLite',
      cause: 'Phase 8 not reached',
    });
  }
}
