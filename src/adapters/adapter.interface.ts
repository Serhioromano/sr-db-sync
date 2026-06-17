// ============================================================
// Database adapter interface
// ============================================================

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

// --- DSN field for interactive input ---

export interface DsnField {
  name: string; // Key in values (e.g. 'host', 'password')
  label: string; // Human-readable label
  type: 'text' | 'password'; // Field type (password = hidden input)
  default?: string; // Default value
  placeholder?: string; // Placeholder text in empty field
  required?: boolean; // Required field (default: true)
  validate?: (value: string) => string | undefined;
  // Returns an error string, or undefined if OK
}

// --- Database adapter interface ---

export interface DatabaseAdapter {
  // Connection management
  connect(dsn: string): Promise<void>;
  disconnect(): Promise<void>;

  // --- DSN parsing (no connection required) ---
  extractDbName(dsn: string): string;

  // --- Schema reading (Snash) ---
  getTables(): Promise<string[]>;
  getColumns(tableName: string): Promise<ColumnDef[]>;
  getIndexes(tableName: string): Promise<IndexDef[]>;
  getForeignKeys(tableName: string): Promise<FKDef[]>;
  getTriggers(tableName: string): Promise<TriggerDef[]>;
  getViews(): Promise<ViewDef[]>;
  getProcedures(): Promise<ProcedureDef[]>;
  getEnums(): Promise<EnumDef[]>;

  // --- Schema writing (Migrate) ---
  createTable(table: TableDefinition): Promise<void>;
  addColumn(tableName: string, column: ColumnDef): Promise<void>;
  dropColumn(tableName: string, columnName: string): Promise<void>;
  modifyColumn(tableName: string, column: ColumnDef): Promise<void>;
  createIndex(tableName: string, index: IndexDef): Promise<void>;
  dropIndex(tableName: string, indexName: string): Promise<void>;
  addForeignKey(tableName: string, fk: FKDef): Promise<void>;
  dropForeignKey(tableName: string, fkName: string): Promise<void>;

  // --- Transactions ---
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

// --- Adapter constructor interface ---
// Each adapter class must have static dsnFields and buildDsn

export interface DatabaseAdapterConstructor {
  readonly dsnFields: DsnField[];
  buildDsn(values: Record<string, string>): string;
  new (): DatabaseAdapter;
}
