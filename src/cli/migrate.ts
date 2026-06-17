// ============================================================
// CLI: dbs migrate — apply DBML schema to database
// ============================================================

import { parseArgs } from 'node:util';
import { resolveProfile } from '../config/profiles.js';
import type { DbsConfig } from '../config/config.types.js';
import { exitOk, exitError } from '../utils/output.js';

/**
 * Valid database engines.
 */
const VALID_ENGINES = new Set(['sqlite', 'mysql', 'postgres']);

/**
 * Validate and normalise an engine string.
 * Exits with ENGINE error if unsupported.
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
 * Extract a string value from parseArgs result.
 */
function strVal(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Extract a boolean value from parseArgs result.
 */
function boolVal(v: string | boolean | undefined): boolean {
  return v === true;
}

/**
 * Handle the `dbs migrate` subcommand.
 *
 * Flag resolution order:
 * 1. --profile <name> → resolve from .dbs.json
 * 2. --dsn + --engine → use directly
 * 3. Neither → CONFIG error
 *
 * Extra flags:
 * - --dry-run   → preview SQL without executing
 * - --insert    → also check and insert Records from DBML
 * - --input     → path to input DBML file (default: ./schema.dbml)
 */
export function migrateCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      dsn: { type: 'string' },
      engine: { type: 'string' },
      prefix: { type: 'string' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean' },
      insert: { type: 'boolean' },
      profile: { type: 'string' },
      'profiles-file': { type: 'string' },
    },
    strict: false,
    allowPositionals: false,
  });

  const profile = strVal(values.profile);
  const dsn = strVal(values.dsn);
  const engine = strVal(values.engine);
  const prefix = strVal(values.prefix);
  const file = strVal(values.file);
  const dryRun = boolVal(values['dry-run']);
  const insert = boolVal(values.insert);
  const profilesFile = strVal(values['profiles-file']);

  if (profile) {
    const config: DbsConfig = resolveProfile(profile, profilesFile ?? '.dbs.json');
    if (file) config.file = file;
    config.dryRun = dryRun;
    config.insert = insert;

    const mode = config.dryRun ? 'dry-run' : 'migrate';
    const extras: string[] = [];
    if (config.insert) extras.push('with-insert');

    const details = extras.length > 0 ? `${mode} [${extras.join(', ')}]` : mode;
    exitOk(details);
  }

  if (dsn && engine) {
    const validEngine = validateEngine(engine);
    const mode = dryRun ? 'dry-run' : 'migrate';
    exitOk(`${mode}: engine=${validEngine} dsn=${dsn}`);
  }

  // Neither profile nor dsn+engine provided
  exitError('CONFIG', 'No profile or --dsn provided', {
    hint: 'Use --profile <name> or --dsn <string> --engine <engine>',
  });
}
