// ============================================================
// CLI: dbs migrate — apply DBML schema to database
// ============================================================

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveProfile,
  discoverProfilesFile,
  loadProfilesFile,
  defaultDbmlPath,
  saveProfile,
} from '../config/profiles.js';
import type { DbsConfig } from '../config/config.types.js';
import { exitOk, exitError, warn } from '../utils/output.js';
import { SqliteAdapter } from '../adapters/sqlite.js';
import { MysqlAdapter } from '../adapters/mysql.js';
import type { DatabaseAdapter, DsnField } from '../adapters/adapter.interface.js';
import { runMigration } from '../core/migrator.js';
import { DbsError } from '../utils/errors.js';
import type { MigrationPlan } from '../core/types.js';

// ============================================================
// ANSI color constants (per SPEC §6.4)
// ============================================================

const ANSI_GREEN  = '\x1b[32m';
const ANSI_BLUE   = '\x1b[34m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED    = '\x1b[31m';
const ANSI_GRAY   = '\x1b[90m';
const ANSI_BOLD   = '\x1b[1m';
const ANSI_RESET  = '\x1b[0m';

/**
 * Map a migration operation type to its ANSI color function.
 */
function opColor(type: string): string {
  switch (type) {
    case 'create_table':
    case 'create_index':
      return ANSI_GREEN;
    case 'add_column':
    case 'add_fk':
      return ANSI_BLUE;
    case 'modify_column':
      return ANSI_YELLOW;
    case 'insert_records':
      return ANSI_BLUE;
    case 'drop_column':
    case 'drop_index':
    case 'drop_fk':
      return ANSI_RED;
    case 'rebuild':
      return ANSI_YELLOW;
    default:
      return ANSI_RESET;
  }
}

/**
 * Per-op label matching the operation type.
 */
function opLabel(type: string): string {
  switch (type) {
    case 'create_table':   return 'CREATE TABLE';
    case 'add_column':     return 'ADD COLUMN';
    case 'drop_column':    return 'DROP COLUMN';
    case 'modify_column':  return 'MODIFY COLUMN';
    case 'create_index':   return 'CREATE INDEX';
    case 'drop_index':     return 'DROP INDEX';
    case 'add_fk':         return 'ADD FOREIGN KEY';
    case 'drop_fk':        return 'DROP FOREIGN KEY';
    case 'rebuild':        return '↻ REBUILD';
    case 'insert_records':  return 'INSERT RECORDS';
    default:               return type;
  }
}

/**
 * Apply ANSI coloring to SQL text.
 *
 * Rules (SPEC §6.4):
 *   - Whole statement gets the operation color
 *   - SQL keywords are bold
 *   - `--` comments are gray
 *
 * Keywords that get bold treatment (case-insensitive match):
 *   CREATE, TABLE, ALTER, ADD, DROP, COLUMN, MODIFY, INDEX,
 *   FOREIGN, KEY, CONSTRAINT, REFERENCES, ON, DELETE, UPDATE,
 *   SET, NULL, NOT, DEFAULT, PRIMARY, UNIQUE, AUTOINCREMENT,
 *   INTEGER, TEXT, VARCHAR, BOOLEAN, FLOAT, TIMESTAMP, DATE,
 *   BLOB, REAL, NUMERIC, CASCADE, RESTRICT, ACTION, NO, CHECK,
 *   IF, EXISTS, SELECT, FROM, WHERE, INSERT, INTO, VALUES,
 *   BEGIN, COMMIT, ROLLBACK, TRANSACTION, VIEW, TRIGGER, AS
 */
function colorSql(sql: string, opType: string): string {
  const color = opColor(opType);

  // Match SQL keywords (whole words, case-insensitive)
  const KEYWORDS = new Set([
    'CREATE', 'TABLE', 'ALTER', 'ADD', 'DROP', 'COLUMN', 'MODIFY', 'INDEX',
    'FOREIGN', 'KEY', 'CONSTRAINT', 'REFERENCES', 'ON', 'DELETE', 'UPDATE',
    'SET', 'NULL', 'NOT', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'AUTOINCREMENT',
    'INTEGER', 'TEXT', 'VARCHAR', 'BOOLEAN', 'FLOAT', 'TIMESTAMP', 'DATE',
    'BLOB', 'REAL', 'NUMERIC', 'CASCADE', 'RESTRICT', 'ACTION', 'NO', 'CHECK',
    'IF', 'EXISTS', 'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES',
    'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'VIEW', 'TRIGGER', 'AS',
    'IN',
  ]);

  // Split into lines
  const lines = sql.split('\n');

  const coloredLines = lines.map((line) => {
    const trimmed = line.trimStart();

    // If the line looks like a SQL comment
    if (/^\s*--/.test(trimmed)) {
      return `${ANSI_GRAY}${ANSI_BOLD}${line}${ANSI_RESET}`;
    }

    // Boldify keywords within the line
    const bolded = line.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (word) => {
      if (KEYWORDS.has(word.toUpperCase())) {
        return `${ANSI_BOLD}${word}${ANSI_RESET}`;
      }
      return word;
    });

    return `${color}${bolded}${ANSI_RESET}`;
  });

  return coloredLines.join('\n');
}

/**
 * Count operations by type for summary.
 */
function countByType(plan: MigrationPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const op of plan) {
    counts[op.type] = (counts[op.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Create a human-readable operation category string.
 */
function opCategory(type: string): string {
  switch (type) {
    case 'create_table':   return 'CREATE';
    case 'add_column':     return 'ADD';
    case 'drop_column':    return 'DROP';
    case 'modify_column':  return 'MODIFY';
    case 'create_index':   return 'CREATE';
    case 'drop_index':     return 'DROP';
    case 'add_fk':         return 'ADD';
    case 'drop_fk':        return 'DROP';
    case 'rebuild':        return 'REBUILD';
    case 'insert_records':  return 'INSERT';
    default:               return type.toUpperCase();
  }
}

/**
 * Build a summary like "2 CREATE, 1 ADD, 1 MODIFY, 1 DROP".
 */
function buildSummary(plan: MigrationPlan): string {
  const categories: Record<string, number> = {};
  for (const op of plan) {
    const cat = opCategory(op.type);
    categories[cat] = (categories[cat] ?? 0) + 1;
  }

  const parts: string[] = [];
  for (const cat of ['CREATE', 'ADD', 'MODIFY', 'DROP']) {
    if (categories[cat]) {
      parts.push(`${categories[cat]} ${cat}`);
    }
  }
  // Catch any remaining categories
  for (const cat of Object.keys(categories)) {
    if (!['CREATE', 'ADD', 'MODIFY', 'DROP'].includes(cat)) {
      parts.push(`${categories[cat]} ${cat}`);
    }
  }

  return parts.join(', ');
}

/**
 * Print colored SQL output for dry-run mode.
 */
function printDryRun(plan: MigrationPlan): void {
  console.log('');
  console.log('🧪 DRY RUN — SQL-команды НЕ будут выполнены:');
  console.log('');

  if (plan.length === 0) {
    console.log('  ✅ No changes required — schema is up to date.');
    return;
  }

  for (const op of plan) {
    console.log(colorSql(op.sql, op.type));
    console.log('');
  }

  const summary = buildSummary(plan);
  const counts = countByType(plan);
  const totalOps = plan.length;

  // Mention tables that didn't change — we can't easily determine them here
  // without the full schema context, so just show the summary
  console.log(`ℹ️  Всего операций: ${totalOps} (${summary})`);
}

/**
 * Print full SQL per operation for real execution mode.
 */
function printExecute(plan: MigrationPlan): void {
  console.log('');
  console.log('🚀 Выполняю миграцию...');
  console.log('');

  if (plan.length === 0) {
    console.log('  ✅ No changes required — schema is up to date.');
    return;
  }

  for (const op of plan) {
    const color = opColor(op.type);
    const lines = op.sql.split('\n');
    if (lines.length === 1) {
      console.log(`  ${color}✓${ANSI_RESET} ${colorSql(op.sql, op.type)}`);
    } else {
      // Multi-line SQL: first line after ✓, rest indented
      const colored = colorSql(op.sql, op.type);
      const sqlLines = colored.split('\n');
      console.log(`  ${color}✓${ANSI_RESET} ${sqlLines[0]}`);
      for (let i = 1; i < sqlLines.length; i++) {
        console.log(`    ${sqlLines[i]}`);
      }
    }
    console.log('');
  }

  console.log(`✅ Миграция завершена: ${plan.length} операций выполнено успешно`);
}

// ============================================================
// Helpers
// ============================================================

const VALID_ENGINES = new Set(['sqlite', 'mysql', 'postgres']);
const IMPLEMENTED_ENGINES = new Set(['sqlite', 'mysql']);

function validateEngine(raw: string): string {
  const engine = raw.toLowerCase();
  if (!VALID_ENGINES.has(engine)) {
    exitError('ENGINE', `Unsupported engine: ${raw}`, {
      engine: raw,
      hint: `Supported engines: ${[...VALID_ENGINES].join(', ')}`,
    });
  }
  return engine;
}

function strVal(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function boolVal(v: string | boolean | undefined): boolean {
  return v === true;
}

function createAdapter(engine: string): DatabaseAdapter {
  switch (engine) {
    case 'sqlite':
      return new SqliteAdapter();
    case 'mysql':
      return new MysqlAdapter();
    case 'postgres':
      exitError('ENGINE', `Adapter for "${engine}" is not yet implemented`, {
        engine,
        hint: `The ${engine} adapter will be available in a future version. Currently SQLite and MySQL are supported.`,
      });
      break;
    default:
      exitError('ENGINE', `Unsupported engine: ${engine}`, {
        engine,
        hint: `Supported engines: ${[...VALID_ENGINES].join(', ')}`,
      });
  }
}

function getAdapterDsnFields(engine: string): DsnField[] | null {
  switch (engine) {
    case 'sqlite':
      return SqliteAdapter.dsnFields;
    case 'mysql':
      return MysqlAdapter.dsnFields;
    default:
      return null;
  }
}

function buildAdapterDsn(engine: string, values: Record<string, string>): string {
  switch (engine) {
    case 'sqlite':
      return SqliteAdapter.buildDsn(values);
    case 'mysql':
      return MysqlAdapter.buildDsn(values);
    default:
      throw new Error(`Cannot build DSN for unimplemented engine: ${engine}`);
  }
}

function findExistingProfilesFile(): string | undefined {
  const candidates = ['migration/.dbs.json', '.dbs.json'];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

// ============================================================
// Main command handler
// ============================================================

// ============================================================
// Interactive migrate flow
// ============================================================

/**
 * Interactive records selection via multiselect checkboxes.
 *
 * For 'migrate' mode: parses the DBML file to find tables with Records blocks.
 * For 'snash' mode: adapter must already be connected and table names passed.
 *
 * Returns:
 *   - `undefined` → no records processing
 *   - `'all'`     → process records for all tables
 *   - `'t1,t2'`   → process records for specific tables
 */
async function askRecordsSelection(
  prompts: any,
  mode: 'migrate' | 'snash',
  fileOrAdapter: string | DatabaseAdapter,
): Promise<string | undefined> {
  let tableNames: string[];

  if (mode === 'migrate') {
    // Parse DBML to find Records blocks
    const dbmlPath = fileOrAdapter as string;
    try {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(dbmlPath, 'utf-8');
      const { parseDbml } = await import('../parser/dbml-parser.js');
      const ir = parseDbml(source);
      tableNames = ir.records.map((r) => r.tableName);
    } catch {
      tableNames = [];
    }
  } else {
    // Snash: adapter is already connected, get tables from it
    const adapter = fileOrAdapter as DatabaseAdapter;
    try {
      tableNames = await adapter.getTables();
    } catch {
      tableNames = [];
    }
  }

  if (tableNames.length === 0) {
    console.log('  ℹ️  No tables with record data available.');
    return undefined;
  }

  const options = [
    { value: '__none__', label: 'None', hint: 'Skip records' },
    { value: '__all__', label: 'All', hint: `Process records for all ${tableNames.length} tables` },
    ...tableNames.map((t) => ({ value: t, label: t })),
  ];

  const selected = await prompts.multiselect({
    message: `Select tables for ${mode === 'migrate' ? 'record insertion' : 'records snapshot'}  (--records):`,
    options,
    required: false,
  });

  if (prompts.isCancel(selected)) return undefined;

  const sel = selected as string[];

  // If "None" is selected, return undefined
  if (sel.includes('__none__')) return undefined;

  // If "All" is selected, return 'all'
  if (sel.includes('__all__')) return 'all';

  // Filter out special values
  const tables = sel.filter((s) => s !== '__none__' && s !== '__all__');
  if (tables.length === 0) return undefined;

  return tables.join(',');
}

async function interactiveMigrate(
  initialEngine: string | undefined,
  initialPrefix: string | undefined,
  initialFile: string | undefined,
  initialDryRun: boolean,
  initialRecords: string | undefined,
): Promise<void> {
  const prompts = await import('@clack/prompts');

  console.log('');

  // Step 1: Try to offer existing profiles
  let dsn: string | undefined;
  let engine: string | undefined;
  let file: string | undefined;
  let dryRun = initialDryRun;
  let records = initialRecords;

  const profilePath = findExistingProfilesFile();

  if (profilePath) {
    const profiles = loadProfilesFile(profilePath);
    const profileNames = Object.keys(profiles);

    if (profileNames.length > 0) {
      const options = profileNames.map((name) => {
        const p = profiles[name]!;
        return {
          value: name,
          label: name,
          hint: `${p.dsn}  (${p.engine})`,
        };
      });

      options.push({
        value: '__manual__',
        label: '⟶  Configure manually',
        hint: 'Enter DSN settings from scratch',
      });

      const choice = await prompts.select({
        message: 'Choose a profile or configure manually:',
        options,
      });

      if (prompts.isCancel(choice)) {
        console.log('Cancelled.');
        process.exit(0);
      }

      if (choice !== '__manual__') {
        const config = resolveProfile(choice as string, profilePath);
        engine = config.engine;
        dsn = config.dsn;
        file = initialFile || config.file;

        // Ask about dry-run (only if not already set via CLI flags)
        if (!dryRun) {
          const dryChoice = await prompts.confirm({
            message: 'Preview SQL only (dry-run)?',
            initialValue: false,
          });
          if (prompts.isCancel(dryChoice)) { console.log('Cancelled.'); process.exit(0); }
          dryRun = dryChoice as boolean;
        }

        // Ask about --records (only if not already set via CLI flags or profile)
        if (records === undefined) {
          records = config.records; // fall back to profile's records value
        }
        if (records === undefined) {
          // Parse DBML to find Records tables
          const recChoice = await askRecordsSelection(prompts, 'migrate', file, undefined);
          if (recChoice === undefined) { console.log('Cancelled.'); process.exit(0); }
          records = recChoice || undefined;
        }

        await confirmAndRunMigrate(prompts, engine, dsn, file, initialPrefix ?? '', dryRun, records, true);
        return;
      }
    }
  }

  // Step 2: Choose engine
  if (!engine) {
    if (initialEngine) {
      engine = initialEngine;
      if (!IMPLEMENTED_ENGINES.has(engine)) {
        exitError('ENGINE', `Adapter for "${engine}" is not yet implemented`, {
          engine,
          hint: `The ${engine} adapter will be available in a future version. Currently only SQLite is supported.`,
        });
      }
    } else {
      const chosen = await prompts.select({
        message: 'Which database engine?',
        options: [
          { value: 'sqlite', label: 'SQLite', hint: 'File-based, zero-config' },
          { value: 'mysql', label: 'MySQL', hint: 'Coming soon' },
          { value: 'postgres', label: 'PostgreSQL', hint: 'Coming soon' },
        ],
      });

      if (prompts.isCancel(chosen)) {
        console.log('Cancelled.');
        process.exit(0);
      }

      engine = chosen as string;

      if (!IMPLEMENTED_ENGINES.has(engine)) {
        exitError('ENGINE', `Adapter for "${engine}" is not yet implemented`, {
          engine,
          hint: `The ${engine} adapter will be available in a future version. Currently only SQLite is supported.`,
        });
      }
    }
  }

  // Step 3: Fill DSN fields
  const dsnFields = getAdapterDsnFields(engine);
  if (!dsnFields) {
    exitError('ENGINE', `No DSN fields defined for "${engine}"`, { engine });
  }

  const fieldValues: Record<string, string> = {};

  for (const field of dsnFields) {
    const value = await prompts.text({
      message: field.label,
      placeholder: field.placeholder,
      defaultValue: field.default ?? '',
      validate: field.validate
        ? (v: string) => {
            if (field.required && !v.trim()) return `${field.label} is required`;
            return field.validate!(v);
          }
        : field.required
          ? (v: string) => (!v.trim() ? `${field.label} is required` : undefined)
          : undefined,
    });

    if (prompts.isCancel(value)) {
      console.log('Cancelled.');
      process.exit(0);
    }

    fieldValues[field.name] = (value as string) || field.default || '';
  }

  dsn = buildAdapterDsn(engine, fieldValues);

  // Step 4: Input DBML file
  const defaultFile = defaultDbmlPath(dsn, engine);
  const fileChoice = await prompts.text({
    message: 'Input DBML file (press Enter for default):',
    placeholder: defaultFile,
    defaultValue: initialFile ?? defaultFile,
  });

  if (prompts.isCancel(fileChoice)) {
    console.log('Cancelled.');
    process.exit(0);
  }

  file = (fileChoice as string) || defaultFile;

  // Step 5: Dry-run?
  if (!dryRun) {
    const dryChoice = await prompts.confirm({
      message: 'Preview SQL only (dry-run)?',
      initialValue: false,
    });

    if (prompts.isCancel(dryChoice)) {
      console.log('Cancelled.');
      process.exit(0);
    }

    dryRun = dryChoice as boolean;
  }

  // Step 6: Records?
  if (records === undefined) {
    const recChoice = await askRecordsSelection(prompts, 'migrate', file, undefined);
    if (recChoice === undefined) { console.log('Cancelled.'); process.exit(0); }
    records = recChoice;
  }

  // Step 7: Confirm + save-as-profile + execute
  await confirmAndRunMigrate(prompts, engine, dsn, file, initialPrefix ?? '', dryRun, records);
}

async function confirmAndRunMigrate(
  prompts: any,
  engine: string,
  dsn: string,
  file: string,
  prefix: string,
  dryRun: boolean,
  records: string | undefined,
  fromProfile = false,
): Promise<void> {
  const mode = dryRun ? '🧪 DRY RUN' : '🚀 MIGRATE';
  console.log('');
  console.log(`  Mode:    ${mode}`);
  console.log(`  Engine:  ${engine}`);
  console.log(`  DSN:     ${dsn}`);
  console.log(`  Input:   ${file}`);
  if (records) console.log(`  Records: ${records}`);
  console.log('');

  const confirmed = await prompts.confirm({
    message: 'Apply migration with these settings?',
  });

  if (prompts.isCancel(confirmed) || !confirmed) {
    console.log('Cancelled.');
    process.exit(0);
  }

  // Save as profile (only when NOT coming from an existing profile)
  if (!fromProfile) {
    const saveChoice = await prompts.confirm({
      message: 'Save these settings as a profile for future use?',
      initialValue: false,
    });

    if (!prompts.isCancel(saveChoice) && saveChoice) {
      const profileName = await prompts.text({
        message: 'Profile name:',
        placeholder: 'prod',
        validate: (v: string) => {
          if (!v.trim()) return 'Profile name is required';
          if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(v))
            return 'Only letters, digits, hyphens, and underscores';
          return undefined;
        },
      });

      if (!prompts.isCancel(profileName)) {
        const profilesFile = 'migration/.dbs.json';
        saveProfile(profilesFile, profileName as string, { dsn, engine, file, ...(records ? { records } : {}) });
        console.log(`  ✓ Profile "${profileName}" saved to ${profilesFile}`);
      }
    }
  }

  // Execute
  await executeMigrate({
    engine,
    dsn,
    prefix,
    file,
    profilesFile: '.dbs.json',
    dryRun,
    records,
  });
}

// ============================================================
// Main command handler
// ============================================================

/**
 * Handle the `dbs migrate` subcommand.
 *
 * Resolution order:
 * 1. --profile <name> → resolve from .dbs.json
 * 2. --dsn + --engine → use directly
 * 3. Neither → interactive mode
 *
 * Extra flags:
 * - --dry-run   → preview SQL without executing
 * - --records <filter>   Insert Records from DBML: 'all' | 'table1,table2'
 * - --file      → path to input DBML file (default: ./migration/<dbname>.dbml)
 */
export async function migrateCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dsn: { type: 'string' },
      engine: { type: 'string' },
      prefix: { type: 'string' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean' },
      records: { type: 'string' },
      profile: { type: 'string' },
      'profiles-file': { type: 'string' },
    },
    strict: false,
    allowPositionals: false,
  });

  const profileName = strVal(values.profile);
  const dsn = strVal(values.dsn);
  const engine = strVal(values.engine);
  const prefix = strVal(values.prefix);
  const file = strVal(values.file);
  const dryRun = boolVal(values['dry-run']);
  const records = strVal(values.records);
  const profilesFile = strVal(values['profiles-file']);

  // Path 1: Profile mode
  if (profileName) {
    const discoveredFile = discoverProfilesFile(profilesFile);
    const config = resolveProfile(profileName, discoveredFile);
    if (file) config.file = file;
    if (prefix) config.prefix = prefix;
    config.dryRun = dryRun;
    if (records !== undefined) config.records = records;
    await executeMigrate(config);
    return;
  }

  // Path 2: Direct flags mode
  if (dsn && engine) {
    const validEngine = validateEngine(engine);

    if (!IMPLEMENTED_ENGINES.has(validEngine)) {
      exitError('ENGINE', `Adapter for "${validEngine}" is not yet implemented`, {
        engine: validEngine,
        hint: `The ${validEngine} adapter will be available in a future version. Currently only SQLite is supported.`,
      });
    }

    const resolvedFile = file ?? defaultDbmlPath(dsn, validEngine);

    await executeMigrate({
      engine: validEngine,
      dsn,
      prefix: prefix ?? '',
      file: resolvedFile,
      profilesFile: profilesFile ?? '.dbs.json',
      dryRun,
      records,
    });
    return;
  }

  // Path 3: No required flags → interactive mode
  let resolvedEngine: string | undefined;
  if (engine) {
    try {
      resolvedEngine = validateEngine(engine);
    } catch {
      resolvedEngine = engine.toLowerCase();
    }
  }

  await interactiveMigrate(resolvedEngine, prefix, file, dryRun, records);
}

// ============================================================
// Shared execution
// ============================================================

async function executeMigrate(config: DbsConfig): Promise<void> {
  const adapter = createAdapter(config.engine);

  let plan: MigrationPlan;
  try {
    plan = await runMigration(adapter, config);
  } catch (err) {
    try { await adapter.disconnect(); } catch { /* ignore */ }
    if (err instanceof DbsError) err.exit();
    exitError('MIGRATE', 'Unexpected migration error', {
      cause: err instanceof Error ? err.message : String(err),
      engine: config.engine,
      dsn: config.dsn,
    });
  }

  try {
    await adapter.disconnect();
  } catch (err) {
    warn('DISCONNECT', `Failed to disconnect cleanly: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (config.dryRun) {
    printDryRun(plan);
    const totalOps = plan.length;
    console.log('');
    exitOk(`dry-run: ${totalOps} operations previewed`);
  } else {
    // Filter out comment-only operations (e.g. FK ops on SQLite — not supported via ALTER)
    const executed = plan.filter((op) => !op.sql.trimStart().startsWith('--'));
    if (executed.length > 0) {
      printExecute(executed);
      console.log('');
      exitOk(`${executed.length} operations applied`);
    } else {
      console.log('');
      console.log('  ✅ No changes required — schema is up to date.');
      console.log('');
      exitOk('0 operations applied');
    }
  }
}
