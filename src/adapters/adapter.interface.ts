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
  SchemaIR,
  MigrationPlan,
  MigrateOptions,
  RecordData,
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

// --- Connection options ---

export interface ConnectOptions {
  /** If true, create the database if it doesn't exist (SQLite-only). */
  createIfNotExists?: boolean;
}

// --- Database adapter interface ---

export interface DatabaseAdapter {
  // Connection management
  connect(dsn: string, options?: ConnectOptions): Promise<void>;
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

  // --- Schema migration ---
  // The adapter reads the current schema, compares it with the target,
  // generates engine-specific SQL, executes it (unless dryRun), and
  // returns a MigrationPlan describing what was done/would be done.
  migrateToSchema(target: SchemaIR, options?: MigrateOptions): Promise<MigrationPlan>;

  // --- Records reading (Snash + Migrate) ---
  // Reads all rows from the specified table.
  getTableRecords(tableName: string): Promise<RecordData>;
}

// --- Adapter constructor interface ---
// Each adapter class must have static dsnFields and buildDsn

export interface DatabaseAdapterConstructor {
  readonly dsnFields: DsnField[];
  buildDsn(values: Record<string, string>): string;
  new (): DatabaseAdapter;
}
