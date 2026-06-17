// ============================================================
// Public programmatic API for sr-db-sync
//
// Usage:
//   import { snash, migrate } from 'sr-db-sync/api';
//
//   const result = await snash({
//     engine: 'sqlite',
//     dsn: './my.db',
//     file: './schema.dbml',
//   });
//
//   const plan = await migrate({
//     engine: 'sqlite',
//     dsn: './my.db',
//     file: './schema.dbml',
//     dryRun: true,
//   });
// ============================================================

import { readFileSync } from 'node:fs';
import { snashSnapshot } from './core/snapper.js';
import { runMigration, parseRecordsFilter } from './core/migrator.js';
import { SqliteAdapter } from './adapters/sqlite.js';
import { MysqlAdapter } from './adapters/mysql.js';
import { DbsError } from './utils/errors.js';
import type { DatabaseAdapter } from './adapters/adapter.interface.js';
import type { DbsConfig } from './config/config.types.js';
import type {
  SchemaIR,
  MigrationPlan,
  MigrationOp,
  MigrateOptions,
  TableDefinition,
  ColumnDef,
  IndexDef,
  FKDef,
  TriggerDef,
  ViewDef,
  ProcedureDef,
  EnumDef,
  RecordData,
  DbsExtension,
} from './core/types.js';

// ============================================================
// Re-export types (so consumers don't need deep imports)
// ============================================================

export type {
  SchemaIR,
  MigrationPlan,
  MigrationOp,
  MigrateOptions,
  TableDefinition,
  ColumnDef,
  IndexDef,
  FKDef,
  TriggerDef,
  ViewDef,
  ProcedureDef,
  EnumDef,
  RecordData,
  DbsExtension,
};

export type { DatabaseAdapter };

// ============================================================
// Re-export utilities
// ============================================================

export { DbsError } from './utils/errors.js';
export { parseDbml } from './parser/dbml-parser.js';
export {
  generateDbml,
  type DbmlWriterOptions,
} from './generator/dbml-writer.js';
export { parseRecordsFilter } from './core/migrator.js';

// ============================================================
// API-specific option types (mirrors CLI flags)
// ============================================================

/**
 * Options for the `snash()` API function.
 * Mirrors the CLI flags: dbs snash --dsn ... --engine ... --file ...
 */
export interface SnashOptions {
  /** Database engine: 'sqlite' | 'mysql' */
  engine: 'sqlite' | 'mysql';
  /** Data Source Name (connection string) */
  dsn: string;
  /** Path to write the output DBML file */
  file: string;
  /** Table name prefix to strip from table names (default: none) */
  prefix?: string;
  /** Records filter: 'all' | 'table1,table2' (default: no records) */
  recordsFilter?: string;
}

/**
 * Result returned by `snash()`.
 */
export interface SnashResult {
  /** Absolute path to the written DBML file */
  file: string;
  /** Generated DBML content */
  dbml: string;
}

/**
 * Options for the `migrate()` API function.
 * Mirrors the CLI flags: dbs migrate --dsn ... --engine ... --file ...
 */
export interface MigrateOptions {
  /** Database engine: 'sqlite' | 'mysql' */
  engine: 'sqlite' | 'mysql';
  /** Data Source Name (connection string) */
  dsn: string;
  /** Path to the DBML file to read */
  file: string;
  /** Table name prefix to prepend to table names from DBML (default: none) */
  prefix?: string;
  /** Preview SQL without executing (default: false) */
  dryRun?: boolean;
  /** Records filter: 'all' | 'table1,table2' (default: no records) */
  recordsFilter?: string;
}

/**
 * Result returned by `migrate()`.
 */
export interface MigrateResult {
  /** Full list of migration operations */
  plan: MigrationPlan;
  /** Per-operation SQL statements (excluding comment-only no-ops) */
  sql: string[];
  /** Operation counts by type (e.g. { create_table: 2, add_column: 1 }) */
  summary: Record<string, number>;
  /** Total number of operations in the plan */
  totalOps: number;
}

// ============================================================
// Adapter factory
// ============================================================

/**
 * Create a database adapter instance for the given engine.
 *
 * Consumers can use this to manage the adapter lifecycle themselves,
 * then pass the adapter to low-level functions like `snashSnapshot`
 * or `runMigration`.
 */
export function createAdapter(engine: string): DatabaseAdapter {
  switch (engine) {
    case 'sqlite':
      return new SqliteAdapter();
    case 'mysql':
      return new MysqlAdapter();
    default:
      throw new DbsError({
        code: 'ENGINE',
        message: `Unsupported engine: ${engine}`,
        cause: `Adapter for "${engine}" is not implemented`,
        engine,
        hint: 'Supported engines: sqlite, mysql',
      });
  }
}

// ============================================================
// snash — snapshot database schema → DBML file
// ============================================================

/**
 * Take a snapshot of a database schema and write it to a DBML file.
 *
 * Handles adapter creation, connection, and disconnection internally.
 * Throws `DbsError` on failure (never calls `process.exit()`).
 *
 * @example
 *   const { file, dbml } = await snash({
 *     engine: 'sqlite',
 *     dsn: './app.db',
 *     file: './schema.dbml',
 *   });
 */
export async function snash(options: SnashOptions): Promise<SnashResult> {
  const adapter = createAdapter(options.engine);

  try {
    await adapter.connect(options.dsn);
  } catch (err) {
    throw wrapConnectError(err, options.engine, options.dsn);
  }

  let file: string;
  try {
    file = await snashSnapshot(adapter, {
      file: options.file,
      prefix: options.prefix ?? '',
      engine: options.engine,
      recordsFilter:
        options.recordsFilter !== undefined
          ? parseRecordsFilter(options.recordsFilter)
          : undefined,
    });
  } catch (err) {
    try {
      await adapter.disconnect();
    } catch {
      /* best effort */
    }
    throw err; // snashSnapshot already wraps in DbsError
  }

  // Best-effort disconnect — non-fatal
  try {
    await adapter.disconnect();
  } catch {
    /* best effort */
  }

  // Read back the generated DBML so the caller can inspect it
  const dbml = readFileSync(file, 'utf-8');

  return { file, dbml };
}

// ============================================================
// migrate — apply DBML schema to database
// ============================================================

/**
 * Apply a DBML schema to a database (smart migration).
 *
 * Reads the DBML file, compares with the live database, and applies
 * only the necessary changes.  In dry-run mode, the plan is returned
 * without executing any SQL.
 *
 * Handles adapter creation, connection, and disconnection internally.
 * Throws `DbsError` on failure (never calls `process.exit()`).
 *
 * @example
 *   const result = await migrate({
 *     engine: 'sqlite',
 *     dsn: './app.db',
 *     file: './schema.dbml',
 *     dryRun: true,
 *   });
 */
export async function migrate(
  options: MigrateOptions,
): Promise<MigrateResult> {
  const adapter = createAdapter(options.engine);

  const config: DbsConfig = {
    engine: options.engine,
    dsn: options.dsn,
    prefix: options.prefix ?? '',
    file: options.file,
    dryRun: options.dryRun ?? false,
    records: options.recordsFilter,
    // profilesFile is not used in programmatic mode — the caller
    // passes everything directly, no profile resolution needed.
    profilesFile: '',
  };

  let plan: MigrationPlan;
  try {
    plan = await runMigration(adapter, config);
  } catch (err) {
    try {
      await adapter.disconnect();
    } catch {
      /* best effort */
    }
    throw err; // runMigration already wraps in DbsError
  }

  // Clean disconnect
  try {
    await adapter.disconnect();
  } catch {
    /* best effort */
  }

  // Build result from MigrationPlan
  return buildMigrateResult(plan);
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Wrap a raw connection error into a DbsError so the caller always
 * gets a typed, structured error.
 */
function wrapConnectError(
  err: unknown,
  engine: string,
  dsn: string,
): DbsError {
  if (err instanceof DbsError) return err;
  return new DbsError({
    code: 'CONNECT',
    message: 'Failed to connect to database',
    cause: err instanceof Error ? err.message : String(err),
    engine,
    dsn,
    hint: 'Check that the database is running and the DSN is correct.',
  });
}

/**
 * Extract SQL, summary, and counts from a MigrationPlan.
 */
function buildMigrateResult(plan: MigrationPlan): MigrateResult {
  // Filter out comment-only operations (e.g. FK operations on SQLite
  // that are emitted as -- comments because ALTER TABLE ADD CONSTRAINT
  // is not supported).
  const sql = plan
    .filter((op) => !op.sql.trimStart().startsWith('--'))
    .map((op) => op.sql);

  const summary: Record<string, number> = {};
  for (const op of plan) {
    summary[op.type] = (summary[op.type] ?? 0) + 1;
  }

  return {
    plan,
    sql,
    summary,
    totalOps: plan.length,
  };
}
