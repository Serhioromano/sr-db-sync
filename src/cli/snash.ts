// ============================================================
// CLI: dbs snash — snapshot database schema to DBML
// ============================================================

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfilesFile, resolveProfile, defaultDbmlPath, discoverProfilesFile, saveProfile } from '../config/profiles.js';
import type { DbsConfig } from '../config/config.types.js';
import { exitOk, exitError } from '../utils/output.js';
import { SqliteAdapter } from '../adapters/sqlite.js';
import { MysqlAdapter } from '../adapters/mysql.js';
import type { DatabaseAdapter } from '../adapters/adapter.interface.js';
import type { DsnField } from '../adapters/adapter.interface.js';
import { snashSnapshot } from '../core/snapper.js';
import { parseRecordsFilter } from '../core/migrator.js';
import { DbsError } from '../utils/errors.js';

/**
 * Valid database engines.
 */
const VALID_ENGINES = new Set(['sqlite', 'mysql', 'postgres']);

/**
 * Engines that have a working adapter implementation.
 */
const IMPLEMENTED_ENGINES = new Set(['sqlite', 'mysql']);

/**
 * Validate an engine string. Returns the normalised lowercase version.
 */
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

/**
 * Get static dsnFields from an adapter class by engine name.
 * Returns null if the adapter is not yet implemented.
 */
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

/**
 * Build DSN from interactive field values for a given engine.
 */
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

/**
 * Create an adapter instance for a given engine.
 */
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

/**
 * Extract a string value from parseArgs result.
 */
function strVal(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Build a DbsConfig from explicit CLI flags (no profile).
 */
function buildConfigFromFlags(
  dsn: string,
  engine: string,
  prefix: string | undefined,
  file: string | undefined,
  records: string | undefined,
): DbsConfig {
  const resolvedFile = file ?? defaultDbmlPath(dsn, engine);
  return {
    engine,
    dsn,
    prefix: prefix ?? '',
    file: resolvedFile,
    profilesFile: '.dbs.json',
    dryRun: false,
    records,
  };
}

// ============================================================
// Interactive snash flow
// ============================================================

/**
 * Launch interactive prompts for snash when user didn't provide
 * --profile or --dsn+--engine via flags.
 *
 * Flow:
 *   1. Try to discover existing profiles → offer to pick one
 *   2. If no profile picked → choose engine + fill DSN fields
 *   3. Output file
 *   4. Confirm → optional save-as-profile → execute
 */
async function interactiveSnash(
  initialEngine: string | undefined,
  initialPrefix: string | undefined,
  initialFile: string | undefined,
  initialRecords: string | undefined,
): Promise<void> {
  const prompts = await import('@clack/prompts');

  console.log('');

  // ------------------------------------------------------------------
  // Step 1: Try to offer existing profiles
  // ------------------------------------------------------------------
  let dsn: string | undefined;
  let engine: string | undefined;
  let file: string | undefined;

  const profilePath = findExistingProfilesFile();

  if (profilePath) {
    const profiles = loadProfilesFile(profilePath);
    const profileNames = Object.keys(profiles);
    const matching = profileNames;

    if (matching.length > 0) {
      const options = matching.map((name) => {
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
        // Use the selected profile
        const config = resolveProfile(choice as string, profilePath);
        engine = config.engine;
        dsn = config.dsn;
        file = initialFile || config.file;
        let records = initialRecords ?? config.records;

        // Ask about records if not already set
        if (records === undefined) {
          const recChoice = await askSnashRecords(prompts, engine, dsn);
          if (recChoice === undefined) { console.log('Cancelled.'); process.exit(0); }
          records = recChoice || undefined;
        }

        // Skip DSN config — go straight to confirm
        await confirmAndRun(prompts, engine, dsn, file, initialPrefix || config.prefix, records, true);
        return;
      }
      // User chose manual — fall through to DSN config below
    }
  }

  // ------------------------------------------------------------------
  // Step 2: Choose engine (if not already determined)
  // ------------------------------------------------------------------
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
          { value: 'mysql', label: 'MySQL', hint: 'Coming soon — not yet implemented' },
          { value: 'postgres', label: 'PostgreSQL', hint: 'Coming soon — not yet implemented' },
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

  // ------------------------------------------------------------------
  // Step 3: Fill DSN fields for the chosen adapter
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Step 3.5: Table prefix (optional)
  // ------------------------------------------------------------------
  let prefix = initialPrefix ?? '';
  if (!initialPrefix) {
    const prefixChoice = await prompts.text({
      message: 'Table prefix (optional, press Enter to skip):',
      placeholder: 'e.g. wp_',
      defaultValue: '',
    });

    if (prompts.isCancel(prefixChoice)) {
      console.log('Cancelled.');
      process.exit(0);
    }

    prefix = (prefixChoice as string) || '';
  }

  // ------------------------------------------------------------------
  // Step 4: Output file
  // ------------------------------------------------------------------
  const defaultFile = defaultDbmlPath(dsn, engine);
  const fileChoice = await prompts.text({
    message: 'Output DBML file (press Enter for default):',
    placeholder: defaultFile,
    defaultValue: initialFile ?? defaultFile,
  });

  if (prompts.isCancel(fileChoice)) {
    console.log('Cancelled.');
    process.exit(0);
  }

  file = (fileChoice as string) || defaultFile;

  // ------------------------------------------------------------------
  // Step 5: Records selection
  // ------------------------------------------------------------------
  let records = initialRecords;
  if (records === undefined) {
    const recChoice = await askSnashRecords(prompts, engine, dsn);
    if (recChoice === undefined) { console.log('Cancelled.'); process.exit(0); }
    records = recChoice || undefined;
  }

  // ------------------------------------------------------------------
  // Step 6: Confirm + save-as-profile + execute
  // ------------------------------------------------------------------
  await confirmAndRun(prompts, engine, dsn, file, prefix, records);
}

// ============================================================
// Shared helpers
// ============================================================

/**
 * Interactive records selection for snash.
 * Temporarily connects to the DB to get table names, then shows a multiselect.
 * Returns: undefined (none), 'all', or 'table1,table2,...'
 */
async function askSnashRecords(
  prompts: any,
  engine: string,
  dsn: string,
): Promise<string | undefined> {
  let adapter: DatabaseAdapter | null = null;
  try {
    adapter = createAdapter(engine);
    await adapter.connect(dsn);
    const tableNames = await adapter.getTables();
    await adapter.disconnect();
    adapter = null;

    if (tableNames.length === 0) {
      console.log('  ℹ️  No tables found in database.');
      return undefined;
    }

    const options = [
      { value: '__none__', label: 'None', hint: 'Skip records' },
      { value: '__all__', label: 'All', hint: `Snapshot records for all ${tableNames.length} tables` },
      ...tableNames.map((t) => ({ value: t, label: t })),
    ];

    const selected = await prompts.multiselect({
      message: 'Select tables for records snapshot  (--records):',
      options,
      required: false,
    });

    if (prompts.isCancel(selected)) return undefined;

    const sel = selected as string[];
    if (sel.includes('__none__')) return undefined;
    if (sel.includes('__all__')) return 'all';

    const tables = sel.filter((s) => s !== '__none__' && s !== '__all__');
    if (tables.length === 0) return undefined;
    return tables.join(',');
  } catch {
    return undefined;
  } finally {
    if (adapter) {
      try { await adapter.disconnect(); } catch { /* ignore */ }
    }
  }
}

/**
 * Find an existing .dbs.json file in the standard locations.
 * Returns the path if found, or undefined if none exists.
 */
function findExistingProfilesFile(): string | undefined {
  const candidates = ['migration/.dbs.json', '.dbs.json'];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Print summary, ask for confirmation, optional save-as-profile, then execute.
 */
async function confirmAndRun(
  prompts: any,
  engine: string,
  dsn: string,
  file: string,
  prefix: string,
  records: string | undefined,
  fromProfile = false,
): Promise<void> {
  console.log('');
  console.log(`  Engine:  ${engine}`);
  console.log(`  DSN:     ${dsn}`);
  console.log(`  Output:  ${file}`);
  if (prefix) console.log(`  Prefix:  ${prefix}`);
  if (records) console.log(`  Records: ${records}`);
  console.log('');

  const confirmed = await prompts.confirm({
    message: 'Take a snapshot with these settings?',
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
        saveProfile(profilesFile, profileName as string, { dsn, engine, prefix: prefix || undefined, file, ...(records ? { records } : {}) });
        console.log(`  ✓ Profile "${profileName}" saved to ${profilesFile}`);
      }
    }
  }

  // Execute
  await executeSnash({
    engine,
    dsn,
    prefix,
    file,
    profilesFile: '.dbs.json',
    dryRun: false,
    records,
  });
}

// ============================================================
// Main command handler
// ============================================================

/**
 * Handle the `dbs snash` subcommand.
 *
 * Resolution order:
 * 1. --profile <name> → resolve from .dbs.json
 * 2. --dsn + --engine → use directly
 * 3. Neither → interactive mode
 */
export async function snashCommand(args: string[]): Promise<void> {
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
  const records = strVal(values.records);
  const profilesFile = strVal(values['profiles-file']);

  // Path 1: Profile mode
  if (profileName) {
    const discoveredFile = discoverProfilesFile(profilesFile);
    const config = resolveProfile(profileName, discoveredFile);
    if (file) config.file = file;
    if (prefix) config.prefix = prefix;
    if (records !== undefined) config.records = records;
    await executeSnash(config);
    return;
  }

  // Path 2: Direct flags mode (both --dsn and --engine present)
  if (dsn && engine) {
    const validEngine = validateEngine(engine);
    const config = buildConfigFromFlags(dsn, validEngine, prefix, file, records);
    await executeSnash(config);
    return;
  }

  // Path 3: Partial flags or no flags → interactive mode
  let resolvedEngine: string | undefined;
  if (engine) {
    try {
      resolvedEngine = validateEngine(engine);
    } catch {
      resolvedEngine = engine.toLowerCase();
    }
  }

  await interactiveSnash(resolvedEngine, prefix, file, records);
}

// ============================================================
// Shared execution
// ============================================================

async function executeSnash(config: DbsConfig): Promise<void> {
  const adapter = createAdapter(config.engine);

  try {
    await adapter.connect(config.dsn);
  } catch (err) {
    if (err instanceof DbsError) err.exit();
    exitError('CONNECT', 'Failed to connect to database', {
      cause: err instanceof Error ? err.message : String(err),
      engine: config.engine,
      dsn: config.dsn,
      hint: 'Check that the database is running and the DSN is correct.',
    });
  }

  let writtenPath: string;
  try {
    writtenPath = await snashSnapshot(adapter, {
      file: config.file,
      prefix: config.prefix,
      engine: config.engine,
      recordsFilter: parseRecordsFilter(config.records),
    });
  } catch (err) {
    try { await adapter.disconnect(); } catch { /* ignore */ }
    if (err instanceof DbsError) err.exit();
    exitError('SCHEMA_READ', 'Failed to take database snapshot', {
      cause: err instanceof Error ? err.message : String(err),
      engine: config.engine,
      dsn: config.dsn,
      file: config.file,
    });
  }

  try {
    await adapter.disconnect();
  } catch (err) {
    console.error(
      `WARN [DISCONNECT] Failed to disconnect cleanly: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  exitOk(`schema written to ${writtenPath}`);
}
