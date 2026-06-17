// ============================================================
// Profile loading and resolution for .dbs.json
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbsProfiles, DbsConfig } from './config.types.js';
import { exitError } from '../utils/output.js';
import type { DatabaseAdapter } from '../adapters/adapter.interface.js';
import { SqliteAdapter } from '../adapters/sqlite.js';

/**
 * Supported database engines.
 */
const VALID_ENGINES = new Set(['sqlite', 'mysql', 'postgres']);

/**
 * Load and parse a .dbs.json profiles file.
 *
 * Exits with CONFIG error if:
 * - File does not exist
 * - File cannot be read
 * - File is not valid JSON
 * - File is not a JSON object
 */
export function loadProfilesFile(profilesFile: string): DbsProfiles {
  const resolvedPath = resolve(profilesFile);

  if (!existsSync(resolvedPath)) {
    exitError('CONFIG', `Profiles file not found: ${profilesFile}`, {
      file: resolvedPath,
      hint: 'Create a .dbs.json file in your project root, or use --profiles-file to specify a path',
    });
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    exitError('CONFIG', `Cannot read profiles file: ${profilesFile}`, {
      file: resolvedPath,
      cause: (err as Error).message,
      hint: 'Check file permissions',
    });
  }

  // Handle empty file
  if (raw.trim() === '') {
    exitError('CONFIG', `Profiles file is empty: ${profilesFile}`, {
      file: resolvedPath,
      hint: 'Example: { "prod": { "dsn": "./db.sqlite", "engine": "sqlite" } }',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    exitError('CONFIG', `Invalid JSON in profiles file: ${profilesFile}`, {
      file: resolvedPath,
      cause: (err as Error).message,
      hint: 'Check that the file contains valid JSON',
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    exitError('CONFIG', `Profiles file must contain a JSON object: ${profilesFile}`, {
      file: resolvedPath,
      hint: 'Example: { "prod": { "dsn": "./db.sqlite", "engine": "sqlite" } }',
    });
  }

  return parsed as DbsProfiles;
}

/**
 * Resolve a named profile into a fully populated DbsConfig.
 *
 * Exits with CONFIG error if:
 * - Profile not found in the profiles file
 * - Profile is missing required fields (dsn, engine)
 * - Engine is not supported
 */
export function resolveProfile(
  profileName: string,
  profilesFile: string
): DbsConfig {
  const profiles = loadProfilesFile(profilesFile);
  const profile = profiles[profileName];

  if (!profile) {
    const available = Object.keys(profiles);
    exitError('CONFIG', `Profile "${profileName}" not found in ${profilesFile}`, {
      file: profilesFile,
      hint:
        available.length > 0
          ? `Available profiles: ${available.join(', ')}`
          : 'No profiles defined in the file',
    });
  }

  if (!profile.dsn) {
    exitError('CONFIG', `Profile "${profileName}" is missing required field: dsn`, {
      file: profilesFile,
      hint: 'Each profile must have a "dsn" field',
    });
  }

  if (!profile.engine) {
    exitError('CONFIG', `Profile "${profileName}" is missing required field: engine`, {
      file: profilesFile,
      hint: 'Each profile must have an "engine" field (sqlite, mysql, or postgres)',
    });
  }

  const engine = profile.engine.toLowerCase();
  if (!VALID_ENGINES.has(engine)) {
    exitError('ENGINE', `Unsupported engine "${profile.engine}" in profile "${profileName}"`, {
      file: profilesFile,
      engine: profile.engine,
      hint: `Supported engines: ${[...VALID_ENGINES].join(', ')}`,
    });
  }

  // Resolve file: explicit in profile > derive from DSN
  const file = profile.file ?? defaultDbmlPath(profile.dsn, engine);

  return {
    engine,
    dsn: profile.dsn,
    prefix: profile.prefix ?? '',
    file,
    profile: profileName,
    profilesFile,
    dryRun: false,
    insert: false,
  };
}

// ============================================================
// DSN → DBML file path derivation
// ============================================================

/**
 * Adapter factory — creates an unconnected adapter instance for a given engine.
 * Used for DSN parsing (no database connection required).
 * Returns null if no adapter is registered for the engine.
 */
function createAdapterForEngine(engine: string): DatabaseAdapter | null {
  switch (engine.toLowerCase()) {
    case 'sqlite':
      return new SqliteAdapter();
    // TODO: add mysql / postgres adapters in future phases
    default:
      return null;
  }
}

/**
 * Derive the default DBML file path from a DSN string.
 *
 * Rules per SPEC §4.4:
 *   - SQLite: DSN is a file path → filename without extension
 *   - MySQL/PostgreSQL: DSN is a URL → last path segment (database name)
 *
 * Returns path like `./migration/<dbname>.dbml`.
 */
export function defaultDbmlPath(dsn: string, engine: string): string {
  const dbName = extractDbName(dsn, engine);
  return `./migration/${dbName}.dbml`;
}

/**
 * Extract a human-readable database name from a DSN string.
 *
 * Primary path: delegates to engine-specific DatabaseAdapter.extractDbName()
 * for engines that have an adapter (SQLite).
 *
 * Fallback path (for MySQL/PostgreSQL until adapters exist):
 * treats the DSN as a URL and extracts the last path segment.
 */
export function extractDbName(dsn: string, engine: string): string {
  const adapter = createAdapterForEngine(engine);
  if (adapter) {
    return adapter.extractDbName(dsn);
  }

  // Fallback: URL-based DSN parsing for engines not yet having an adapter
  // Format: protocol://user:pass@host:port/dbname
  if (dsn.includes('://')) {
    try {
      const urlPart = dsn.split('?')[0]!;
      const parts = urlPart.split('/');
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i] && parts[i] !== '') {
          return parts[i]!;
        }
      }
    } catch {
      // fall through
    }
  }

  return 'database';
}
