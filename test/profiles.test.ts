// ============================================================
// Tests: src/config/profiles.ts
// ============================================================

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { unlinkSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProfilesFile, resolveProfile, extractDbName, defaultDbmlPath } from '../src/config/profiles.js';
import { installMocks, runAndCaptureExit, resetCapture } from './helpers.js';

const TEST_DIR = join(import.meta.dir, 'tmp-profiles');

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

function writeJson(file: string, content: unknown): void {
  writeFileSync(testPath(file), JSON.stringify(content));
}

describe('profiles', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMocks();
    resetCapture();
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    uninstall();
    // Clean up test files
    try {
      for (const f of readdirSync(TEST_DIR)) {
        unlinkSync(join(TEST_DIR, f));
      }
      rmdirSync(TEST_DIR);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadProfilesFile', () => {
    it('should exit with CONFIG error if file does not exist', () => {
      const captured = runAndCaptureExit(() =>
        loadProfilesFile(testPath('nonexistent.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('ERROR [CONFIG]');
      expect(stderr).toContain('not found');
    });

    it('should exit with CONFIG error if file is empty', () => {
      writeFileSync(testPath('empty.json'), '');
      const captured = runAndCaptureExit(() =>
        loadProfilesFile(testPath('empty.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('is empty');
    });

    it('should exit with CONFIG error if file is not valid JSON', () => {
      writeFileSync(testPath('invalid.json'), '{bad json');
      const captured = runAndCaptureExit(() =>
        loadProfilesFile(testPath('invalid.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('Invalid JSON');
    });

    it('should exit with CONFIG error if JSON is an array', () => {
      writeFileSync(testPath('array.json'), '[1,2,3]');
      const captured = runAndCaptureExit(() =>
        loadProfilesFile(testPath('array.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('must contain a JSON object');
    });

    it('should load a valid profiles file', () => {
      // loadProfilesFile doesn't call exit on success
      writeJson('valid.json', {
        prod: { dsn: './db.sqlite', engine: 'sqlite' },
      });
      // This should NOT throw CapturedExit
      const profiles = loadProfilesFile(testPath('valid.json'));
      expect(profiles.prod.dsn).toBe('./db.sqlite');
      expect(profiles.prod.engine).toBe('sqlite');
    });
  });

  describe('resolveProfile', () => {
    it('should exit with CONFIG if profile not found', () => {
      writeJson('profiles.json', {
        prod: { dsn: './db.sqlite', engine: 'sqlite' },
      });
      const captured = runAndCaptureExit(() =>
        resolveProfile('staging', testPath('profiles.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('Profile "staging" not found');
      expect(stderr).toContain('Available profiles: prod');
    });

    it('should exit with CONFIG if profile missing dsn', () => {
      writeJson('profiles.json', {
        bad: { engine: 'sqlite' },
      });
      const captured = runAndCaptureExit(() =>
        resolveProfile('bad', testPath('profiles.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('missing required field: dsn');
    });

    it('should exit with CONFIG if profile missing engine', () => {
      writeJson('profiles.json', {
        bad: { dsn: './db.sqlite' },
      });
      const captured = runAndCaptureExit(() =>
        resolveProfile('bad', testPath('profiles.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('missing required field: engine');
    });

    it('should exit with ENGINE if unsupported engine', () => {
      writeJson('profiles.json', {
        bad: { dsn: 'xxx', engine: 'oracle' },
      });
      const captured = runAndCaptureExit(() =>
        resolveProfile('bad', testPath('profiles.json'))
      );
      expect(captured.code).toBe(1);
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('ERROR [ENGINE]');
      expect(stderr).toContain('Unsupported engine');
    });

    it('should resolve a valid profile into DbsConfig', () => {
      writeJson('profiles.json', {
        prod: { dsn: './my.db', engine: 'SQLITE', prefix: 'app_' },
      });
      // Should not exit
      const config = resolveProfile('prod', testPath('profiles.json'));
      expect(config.engine).toBe('sqlite');
      expect(config.dsn).toBe('./my.db');
      expect(config.prefix).toBe('app_');
      expect(config.file).toBe('./migration/my.dbml'); // derived from DSN
      expect(config.profile).toBe('prod');
      expect(config.profilesFile).toContain('profiles.json');
    });

    it('should default prefix to empty string', () => {
      writeJson('profiles.json', {
        prod: { dsn: './db.sqlite', engine: 'sqlite' },
      });
      const config = resolveProfile('prod', testPath('profiles.json'));
      expect(config.prefix).toBe('');
    });

    it('should say "No profiles defined" when file has no profiles', () => {
      writeJson('profiles.json', {});
      const captured = runAndCaptureExit(() =>
        resolveProfile('any', testPath('profiles.json'))
      );
      const stderr = captured.stderr.join('\n');
      expect(stderr).toContain('No profiles defined');
    });

    // ---- file resolution ----

    it('should use explicit file from profile', () => {
      writeJson('profiles.json', {
        prod: { dsn: './my.db', engine: 'sqlite', file: './custom/schema.dbml' },
      });
      const config = resolveProfile('prod', testPath('profiles.json'));
      expect(config.file).toBe('./custom/schema.dbml');
    });

    it('should derive file from SQLite DSN when not specified', () => {
      writeJson('profiles.json', {
        prod: { dsn: './data/myapp.db', engine: 'sqlite' },
      });
      const config = resolveProfile('prod', testPath('profiles.json'));
      expect(config.file).toBe('./migration/myapp.dbml');
    });
  });
});

// ============================================================
// Tests: extractDbName and defaultDbmlPath
// ============================================================

describe('extractDbName', () => {
  // --- SQLite ---

  it('should extract name from .db file', () => {
    expect(extractDbName('./data/myapp.db', 'sqlite')).toBe('myapp');
  });

  it('should extract name from .sqlite file', () => {
    expect(extractDbName('/var/db/production.sqlite', 'sqlite')).toBe('production');
  });

  it('should extract name from .sqlite3 file', () => {
    expect(extractDbName('local/db.sqlite3', 'sqlite')).toBe('db');
  });

  it('should extract name from path without known extension', () => {
    expect(extractDbName('./data/custom.ext', 'sqlite')).toBe('custom');
  });

  it('should handle path with no extension', () => {
    expect(extractDbName('./data/rawfile', 'sqlite')).toBe('rawfile');
  });

  it('should handle just a filename', () => {
    expect(extractDbName('mydb.sqlite', 'sqlite')).toBe('mydb');
  });

  // --- MySQL / PostgreSQL ---

  it('should extract name from MySQL DSN', () => {
    expect(extractDbName('mysql://user:pass@host:3306/mydb', 'mysql')).toBe('mydb');
  });

  it('should extract name from PostgreSQL DSN', () => {
    expect(extractDbName('postgresql://user:pass@host:5432/myapp', 'postgres')).toBe('myapp');
  });

  it('should handle DSN without port', () => {
    expect(extractDbName('mysql://user@host/mydb', 'mysql')).toBe('mydb');
  });

  it('should strip query parameters from DSN', () => {
    expect(extractDbName('mysql://user:pass@host:3306/mydb?ssl=true', 'mysql')).toBe('mydb');
  });

  it('should return fallback for unparseable DSN', () => {
    expect(extractDbName('weird-string', 'mysql')).toBe('database');
  });
});

describe('defaultDbmlPath', () => {
  it('should build path from SQLite DSN', () => {
    expect(defaultDbmlPath('./data/myapp.db', 'sqlite')).toBe('./migration/myapp.dbml');
  });

  it('should build path from MySQL DSN', () => {
    expect(defaultDbmlPath('mysql://user@host/mydb', 'mysql')).toBe('./migration/mydb.dbml');
  });
});
