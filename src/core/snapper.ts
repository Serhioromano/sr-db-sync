// ============================================================
// Snapper — business logic: Database → SchemaIR → DBML file
// ============================================================

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseAdapter } from '../adapters/adapter.interface.js';
import type { SchemaIR, TableDefinition } from './types.js';
import { generateDbml, type DbmlWriterOptions } from '../generator/dbml-writer.js';
import { DbsError } from '../utils/errors.js';

/**
 * Options for the snash operation.
 */
export interface SnashOptions {
  /** Path to the output DBML file */
  file: string;
  /** Table name prefix (empty string if none) */
  prefix: string;
  /** Optional project metadata for the DBML header */
  projectName?: string;
  /** Database engine name (used as database_type in Project block) */
  engine?: string;
  /** Records filter: if set, read records from these tables. ['*'] = all. */
  recordsFilter?: string[];
}

/**
 * Take a snapshot of a database schema and write it to a DBML file.
 *
 * Algorithm (per SPEC §5.2):
 *   1. Connect to the database via the adapter
 *   2. Extract all tables
 *   3. For each table: columns, indexes, foreign keys, triggers
 *   4. Extract global objects: views, procedures, enums
 *   5. Build SchemaIR (intermediate representation)
 *   6. Generate DBML string via dbml-writer
 *   7. Write to file
 *
 * Returns the absolute path of the written DBML file.
 *
 * @throws {DbsError} on schema read or file write errors
 */
export async function snashSnapshot(
  adapter: DatabaseAdapter,
  options: SnashOptions,
): Promise<string> {
  const { file, prefix, engine } = options;

  // 1. Connect (adapter is already connected by the caller, but we ensure it)
  // The caller is responsible for connect/disconnect.

  // 2. Extract all tables
  let allTableNames: string[];
  try {
    allTableNames = await adapter.getTables();
  } catch (err) {
    throw new DbsError({
      code: 'SCHEMA_READ',
      message: 'Failed to read table list from database',
      cause: err instanceof Error ? err.message : String(err),
      engine,
      hint: 'Check that the database is accessible and not corrupted.',
    });
  }

  // 2.5. Filter by prefix if configured
  const tableNames = prefix
    ? allTableNames.filter((t) => t.startsWith(prefix))
    : allTableNames;

  // 3. For each table: extract columns, indexes, foreign keys, triggers
  const tables: TableDefinition[] = [];

  for (const rawName of tableNames) {
    // Strip prefix from table name if configured
    const name = prefix ? rawName.slice(prefix.length) : rawName;

    try {
      const [columns, indexes, foreignKeys, triggers] = await Promise.all([
        adapter.getColumns(rawName),
        adapter.getIndexes(rawName),
        adapter.getForeignKeys(rawName),
        adapter.getTriggers(rawName),
      ]);

      // Strip prefix from FK refTable if configured
      const strippedFKs = prefix
        ? foreignKeys.map((fk) => ({
            ...fk,
            refTable: fk.refTable.startsWith(prefix)
              ? fk.refTable.slice(prefix.length)
              : fk.refTable,
          }))
        : foreignKeys;

      tables.push({ name, columns, indexes, foreignKeys: strippedFKs, triggers });
    } catch (err) {
      throw new DbsError({
        code: 'SCHEMA_READ',
        message: `Failed to read schema for table "${rawName}"`,
        cause: err instanceof Error ? err.message : String(err),
        engine,
        table: rawName,
        hint: 'The table might be corrupted or inaccessible.',
      });
    }
  }

  // 4. Extract global objects
  let views, procedures, enums;
  try {
    [views, procedures, enums] = await Promise.all([
      adapter.getViews(),
      adapter.getProcedures(),
      adapter.getEnums(),
    ]);
  } catch (err) {
    throw new DbsError({
      code: 'SCHEMA_READ',
      message: 'Failed to read global schema objects (views/procedures/enums)',
      cause: err instanceof Error ? err.message : String(err),
      engine,
      hint: 'The database might have objects that cannot be introspected.',
    });
  }

  // 4.5. Extract records if recordsFilter is set
  const { recordsFilter } = options;
  let records: import('./types.js').RecordData[] = [];

  if (recordsFilter && recordsFilter.length > 0) {
    // Determine which tables to read records from.
    // The recordsFilter matches against STRIPPED names (the DBML view),
    // so we build a lookup from stripped→raw name.
    const nameMap = new Map<string, string>();
    for (const rawName of tableNames) {
      const stripped = prefix ? rawName.slice(prefix.length) : rawName;
      nameMap.set(stripped, rawName);
    }

    const filterAll = recordsFilter.includes('*');
    const targetStripped = filterAll
      ? [...nameMap.keys()]
      : recordsFilter.filter((f) => nameMap.has(f));

    for (const strippedName of targetStripped) {
      const rawName = nameMap.get(strippedName)!;
      try {
        const rec = await adapter.getTableRecords(rawName);
        if (rec.rows.length > 0) {
          // Strip prefix from record's tableName
          records.push({ ...rec, tableName: strippedName });
        }
      } catch (err) {
        // Non-fatal: skip tables that can't be read
        // (e.g., virtual tables, views listed as tables, etc.)
      }
    }
  }

  // 5. Build SchemaIR
  const schema: SchemaIR = {
    tables,
    views,
    procedures,
    enums,
    extensions: [], // No @dbs extensions generated by snash itself; they come from parser roundtrip
    records,        // Records read from DB (if --records flag was set)
  };

  // 6. Generate DBML
  const dbmlOptions: DbmlWriterOptions = {};
  if (options.engine) {
    // Capitalise first letter for database_type display (e.g. "sqlite" → "Sqlite")
    dbmlOptions.databaseType = options.engine.charAt(0).toUpperCase() + options.engine.slice(1);
  }
  if (options.projectName) {
    dbmlOptions.projectName = options.projectName;
  }

  const dbml = generateDbml(schema, dbmlOptions);

  // 7. Write to file
  const resolvedPath = resolve(file);
  try {
    writeFileSync(resolvedPath, dbml, 'utf-8');
  } catch (err) {
    throw new DbsError({
      code: 'DBML_WRITE',
      message: `Failed to write DBML to file: ${file}`,
      cause: err instanceof Error ? err.message : String(err),
      file: resolvedPath,
      engine,
      hint: 'Check that the directory exists and is writable.',
    });
  }

  return resolvedPath;
}
