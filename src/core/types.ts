// ============================================================
// Core schema types for db-sync
// ============================================================

// --- Column definition ---

export interface ColumnDef {
  name: string;
  type: string; // 'INTEGER', 'VARCHAR(255)', 'TEXT', etc.
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue?: string; // 'now()', '0', 'NULL'
  comment?: string;
  enumValues?: string[]; // For MySQL ENUM types
}

// --- Index definition ---

export interface IndexDef {
  name: string;
  columns: string[]; // ['col1', 'col2']
  unique: boolean;
  type?: string; // 'btree', 'hash'
}

// --- Foreign key definition ---

export interface FKDef {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action';
  onUpdate?: 'cascade' | 'set null' | 'restrict' | 'no action';
}

// --- Trigger definition ---

export interface TriggerDef {
  name: string;
  timing: 'before' | 'after' | 'instead of';
  event: 'insert' | 'update' | 'delete';
  body: string;
}

// --- View definition ---

export interface ViewDef {
  name: string;
  definition: string; // CREATE VIEW ... AS SELECT ...
}

// --- Stored procedure definition ---

export interface ProcedureDef {
  name: string;
  body: string;
}

// --- Enum type definition (MySQL) ---

export interface EnumDef {
  name: string;
  values: string[];
}

// --- Full table definition (columns + indexes + foreign keys + triggers) ---

export interface TableDefinition {
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: FKDef[];
  triggers: TriggerDef[];
}

// --- DbsExtension: parsed @dbs comments ---
// Used in Phase 3 (DBML parser) and Phase 5 (DBML generator)

export type DbsExtension =
  | DbsTriggerExtension
  | DbsViewExtension
  | DbsProcedureExtension
  | DbsCheckExtension
  | DbsEngineExtension
  | DbsCharsetExtension
  | DbsCollationExtension
  | DbsRawExtension;

export interface DbsTriggerExtension {
  type: 'trigger';
  name: string;
  tableName: string;
  timing: string;
  event: string;
  body: string;
}

export interface DbsViewExtension {
  type: 'view';
  name: string;
  definition: string;
}

export interface DbsProcedureExtension {
  type: 'procedure';
  name: string;
  body: string;
}

export interface DbsCheckExtension {
  type: 'check';
  tableName: string;
  name: string;
  condition: string;
}

export interface DbsEngineExtension {
  type: 'engine';
  tableName: string;
  engine: string;
}

export interface DbsCharsetExtension {
  type: 'charset';
  tableName: string;
  charset: string;
}

export interface DbsCollationExtension {
  type: 'collation';
  tableName: string;
  collation: string;
}

export interface DbsRawExtension {
  type: 'raw';
  sql: string;
}

// --- SchemaIR: intermediate representation of a full database schema ---

export interface SchemaIR {
  tables: TableDefinition[];
  views: ViewDef[];
  procedures: ProcedureDef[];
  enums: EnumDef[];
  extensions: DbsExtension[];
}

// --- Migration plan types ---
// These describe WHAT was done (or would be done in dry-run mode).
// The adapter generates them from migrateToSchema().

export type MigrationOpType =
  | 'create_table'
  | 'add_column'
  | 'drop_column'
  | 'modify_column'
  | 'create_index'
  | 'drop_index'
  | 'add_fk'
  | 'drop_fk'
  | 'rebuild';

export interface MigrationOp {
  type: MigrationOpType;
  table: string;
  column?: string;
  index?: string;
  fk?: string;
  sql: string;  // Engine-specific SQL (already executed or previewed)
}

export type MigrationPlan = MigrationOp[];

/** Options passed to adapter.migrateToSchema(). */
export interface MigrateOptions {
  /** Do not execute — just compare schemas and return the plan. */
  dryRun?: boolean;
  /** If true, the adapter should also insert Records from DBML that don't exist. */
  insertRecords?: boolean;
}
