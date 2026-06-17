// ============================================================
// Profile loading and resolution for .dbs.json
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { DbsProfiles, DbsConfig } from './config.types.js';
import { exitError } from '../utils/output.js';
import type { DatabaseAdapter } from '../adapters/adapter.interface.js';
import { SqliteAdapter } from '../adapters/sqlite.js';
import { MysqlAdapter } from '../adapters/mysql.js';

/**
 * Supported database engines.
 */
const VALID_ENGINES = new Set(['sqlite', 'mysql', 'postgres']);

/**
 * Discover the .dbs.json profiles file.
 *
 * Search order:
 *   1. If explicitPath is provided → use it directly (fail if missing)
 *   2. migration/.dbs.json (relative to CWD)
 *   3. .dbs.json (relative to CWD)
 *
 * Returns the discovered path (the same relative string that was matched).
 * Exits with CONFIG error if no file found at any location.
 */
export function discoverProfilesFile(explicitPath?: string): string {
  if (explicitPath) {
    // Explicit path — fail if it doesn't exist (loadProfilesFile handles the error)
    return explicitPath;
  }

  const candidates = ['migration/.dbs.json', '.dbs.json'];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate))) {
      return candidate;
    }
  }

  exitError('CONFIG', 'Profiles file not found', {
    hint: 'Create migration/.dbs.json or .dbs.json in your project root, or use --profiles-file to specify a path',
  });
}

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
      hint: 'Create migration/.dbs.json or .dbs.json in your project root, or use --profiles-file to specify a path',
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
    records: profile.records, // may be undefined
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
    case 'mysql':
      return new MysqlAdapter();
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

// ============================================================
// Profile persistence
// ============================================================

/**
 * Add or update a profile in a .dbs.json file.
 *
 * Creates the file (and parent directories) if they don't exist.
 * Existing profiles in the file are preserved.
 */
export function saveProfile(
  profilesFile: string,
  profileName: string,
  profile: { dsn: string; engine: string; prefix?: string; file?: string; records?: string },
): void {
  const resolvedPath = resolve(profilesFile);

  // Load existing profiles (or start fresh if file doesn't exist)
  let profiles: DbsProfiles = {};
  if (existsSync(resolvedPath)) {
    try {
      const raw = readFileSync(resolvedPath, 'utf-8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          profiles = parsed as DbsProfiles;
        }
      }
    } catch {
      // Invalid JSON or unreadable — start fresh
    }
  }

  // Merge the new profile
  profiles[profileName] = {
    dsn: profile.dsn,
    engine: profile.engine,
    ...(profile.prefix ? { prefix: profile.prefix } : {}),
    ...(profile.file ? { file: profile.file } : {}),
    ...(profile.records ? { records: profile.records } : {}),
  };

  // Ensure parent directory exists
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write
  writeFileSync(resolvedPath, JSON.stringify(profiles, null, 2) + '\n', 'utf-8');
}
