// ============================================================
// Migrator — business logic for dbs migrate command
// ============================================================

import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/dbml-parser.js';
import type { DatabaseAdapter } from '../adapters/adapter.interface.js';
import type { DbsConfig } from '../config/config.types.js';
import type { MigrationPlan, MigrateOptions, SchemaIR } from './types.js';
import { DbsError } from '../utils/errors.js';

/**
 * Parse a records filter string into a string array for MigrateOptions.
 *
 * - `undefined` / `''` → `undefined` (no records processing)
 * - `'all'` → `['*']`
 * - `'users,posts'` → `['users', 'posts']`
 */
export function parseRecordsFilter(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (trimmed === 'all') return ['*'];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Run the full migration pipeline:
 *   1. Read and parse the DBML file → SchemaIR
 *   2. Connect to the database via the adapter
 *   3. Call adapter.migrateToSchema(targetSchemaIR, options)
 *   4. Return the MigrationPlan
 *
 * On error, wraps the underlying exception into a DbsError with the
 * appropriate code (DBML_PARSE, CONNECT, or MIGRATE) and re-throws.
 */
export async function runMigration(
  adapter: DatabaseAdapter,
  config: DbsConfig,
): Promise<MigrationPlan> {
  // ---- 1. Read DBML file ----
  let source: string;
  try {
    source = readFileSync(config.file, 'utf-8');
  } catch (err) {
    throw new DbsError({
      code: 'DBML_PARSE',
      message: `Cannot read DBML file: ${config.file}`,
      cause: err instanceof Error ? err.message : String(err),
      file: config.file,
      hint: 'Make sure the DBML file exists and is readable. Run "dbs snash" to generate one.',
    });
  }

  // ---- 2. Parse DBML → target SchemaIR ----
  let targetIR;
  try {
    targetIR = parseDbml(source);
  } catch (err) {
    if (err instanceof DbsError) throw err;
    throw new DbsError({
      code: 'DBML_PARSE',
      message: 'Failed to parse DBML file',
      cause: err instanceof Error ? err.message : String(err),
      file: config.file,
    });
  }

  // ---- 2.5. Apply prefix to all table names in targetIR ----
  if (config.prefix) {
    targetIR = applyPrefix(targetIR, config.prefix);
  }

  // ---- 3. Connect ----
  try {
    await adapter.connect(config.dsn, { createIfNotExists: true });
  } catch (err) {
    if (err instanceof DbsError) throw err;
    throw new DbsError({
      code: 'CONNECT',
      message: 'Failed to connect to database',
      cause: err instanceof Error ? err.message : String(err),
      engine: config.engine,
      dsn: config.dsn,
      hint: 'Check that the database is running and the DSN is correct.',
    });
  }

  // ---- 4. Migrate via adapter ----
  let recordsFilter = parseRecordsFilter(config.records);
  if (config.prefix && recordsFilter) {
    recordsFilter = recordsFilter.map((f) =>
      f === '*' ? '*' : config.prefix + f
    );
  }
  const options: MigrateOptions = {
    dryRun: config.dryRun,
    recordsFilter,
  };

  try {
    return await adapter.migrateToSchema(targetIR, options);
  } catch (err) {
    if (err instanceof DbsError) throw err;
    throw new DbsError({
      code: 'MIGRATE',
      message: 'Migration failed',
      cause: err instanceof Error ? err.message : String(err),
      engine: config.engine,
      dsn: config.dsn,
    });
  }
}

// ============================================================
// Prefix application for migration
// ============================================================

/**
 * Prepend a prefix to all table names and table references in a SchemaIR.
 *
 * This is used during migration when --prefix is set: the DBML file
 * contains unprefixed table names, and we need to match them against
 * a database that uses the given prefix.
 */
function applyPrefix(ir: SchemaIR, prefix: string): SchemaIR {
  const prepend = (name: string) => prefix + name;

  return {
    tables: ir.tables.map((t) => ({
      ...t,
      name: prepend(t.name),
      foreignKeys: t.foreignKeys.map((fk) => ({
        ...fk,
        refTable: prepend(fk.refTable),
      })),
    })),
    views: ir.views.map((v) => ({ ...v, name: prepend(v.name) })),
    procedures: ir.procedures.map((p) => ({ ...p, name: prepend(p.name) })),
    enums: ir.enums.map((e) => ({ ...e, name: prepend(e.name) })),
    extensions: ir.extensions.map((ext) => {
      if (ext.type === 'trigger' || ext.type === 'check' ||
          ext.type === 'engine' || ext.type === 'charset' ||
          ext.type === 'collation') {
        return { ...ext, tableName: prepend(ext.tableName) };
      }
      return ext;
    }),
    records: ir.records.map((r) => ({ ...r, tableName: prepend(r.tableName) })),
  };
}
