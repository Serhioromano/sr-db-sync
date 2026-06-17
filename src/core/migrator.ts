// ============================================================
// Migrator — business logic for dbs migrate command
// ============================================================

import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/dbml-parser.js';
import type { DatabaseAdapter } from '../adapters/adapter.interface.js';
import type { DbsConfig } from '../config/config.types.js';
import type { MigrationPlan, MigrateOptions } from './types.js';
import { DbsError } from '../utils/errors.js';

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
  const options: MigrateOptions = {
    dryRun: config.dryRun,
    insertRecords: config.insert,
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
