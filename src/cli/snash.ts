// ============================================================
// CLI: dbs snash — snapshot database schema to DBML
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
 * parseArgs types string options as `string | true` because
 * --flag without value sets it to true.
 */
function strVal(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Handle the `dbs snash` subcommand.
 *
 * Flag resolution order:
 * 1. --profile <name> → resolve from .dbs.json
 * 2. --dsn + --engine → use directly
 * 3. Neither → CONFIG error
 */
export function snashCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      dsn: { type: 'string' },
      engine: { type: 'string' },
      prefix: { type: 'string' },
      file: { type: 'string' },
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
  const profilesFile = strVal(values['profiles-file']);

  if (profile) {
    const config: DbsConfig = resolveProfile(profile, profilesFile ?? '.dbs.json');
    if (file) config.file = file;
    exitOk(`profile resolved: ${profile}`);
  }

  if (dsn && engine) {
    const validEngine = validateEngine(engine);
    exitOk(`snapshot: engine=${validEngine} dsn=${dsn}`);
  }

  // Neither profile nor dsn+engine provided
  exitError('CONFIG', 'No profile or --dsn provided', {
    hint: 'Use --profile <name> or --dsn <string> --engine <engine>',
  });
}
