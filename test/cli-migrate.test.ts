// ============================================================
// Tests: src/cli/migrate.ts
// ============================================================

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { migrateCommand } from '../src/cli/migrate.js';
import { installMocks, runAndCaptureExit, resetCapture } from './helpers.js';

const TEST_DIR = join(import.meta.dir, 'tmp-cli-migrate');

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

function writeJson(file: string, content: unknown): void {
  writeFileSync(testPath(file), JSON.stringify(content));
}

/**
 * Create a fresh SQLite database at the given path with the given SQL.
 */
function createDb(dbPath: string, sql: string): void {
  if (existsSync(dbPath)) unlinkSync(dbPath);
  const db = new Database(dbPath, { create: true });
  db.exec(sql);
  db.close();
}

/**
 * Create a DBML file at the given path.
 */
function createDbml(dbmlPath: string, content: string): void {
  const dir = join(dbmlPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(dbmlPath, content);
}

/**
 * Strip ANSI escape sequences from a string for test assertions.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ============================================================
// Fixtures
// ============================================================

/** Base schema: simple table with no FKs to keep real execution clean. */
const SIMPLE_SCHEMA_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL
  );
`;

/** DBML that adds a new column 'age' to 'users' and a new table 'comments'. */
const ADD_COLUMN_DBML = `
Table users {
  id INTEGER [pk, increment]
  name TEXT [not null]
  email TEXT [not null]
  age INTEGER
}

Table posts {
  id INTEGER [pk, increment]
  title TEXT [not null]
}

Table comments {
  id INTEGER [pk, increment]
  body TEXT [not null]
}
`;

/** DBML identical to the initial schema — should produce no operations. */
const NOOP_DBML = `
Table users {
  id INTEGER [pk, increment]
  name TEXT [not null]
  email TEXT [not null]
}

Table posts {
  id INTEGER [pk, increment]
  title TEXT [not null]
}
`;

/** DBML that drops a column and adds an index. */
const DROP_ADD_INDEX_DBML = `
Table users {
  id INTEGER [pk, increment]
  name TEXT [not null]

  Indexes {
    (name) [name: idx_users_name]
  }
}

Table posts {
  id INTEGER [pk, increment]
  title TEXT [not null]
}
`;

/** DBML with bad syntax. */
const BAD_DBML = `Table { broken!!! }`;

// ============================================================
// Tests
// ============================================================

describe('migrateCommand', () => {
  let uninstall: () => void;
  let dbs: Database[];

  beforeEach(() => {
    uninstall = installMocks();
    resetCapture();
    dbs = [];
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    uninstall();
    // Close any open DB handles first
    for (const db of dbs) {
      try { db.close(); } catch { /* ignore */ }
    }
    // Clean up files
    try {
      for (const f of readdirSync(TEST_DIR)) {
        try { unlinkSync(join(TEST_DIR, f)); } catch { /* ignore */ }
      }
      rmdirSync(TEST_DIR);
    } catch {
      // ignore
    }

  });

  // ==========================================================
  // DRY-RUN: colored SQL output
  // ==========================================================

  it('should run dry-run migration and show colored SQL', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, ADD_COLUMN_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dry-run',
      ])
    );

    expect(captured.code).toBe(0);

    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('EXIT OK [dry-run:');
    expect(stdout).toContain('🧪 DRY RUN');

    // Strip ANSI and check content
    const plain = stripAnsi(stdout);
    expect(plain).toContain('CREATE TABLE');
    expect(plain).toContain('ADD COLUMN');
    expect(plain).toContain('comments');
  });

  it('should produce ANSI-colored output in dry-run mode', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, ADD_COLUMN_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dry-run',
      ])
    );

    const stdout = captured.stdout.join('\n');

    // ANSI escape sequences must be present
    expect(stdout).toContain('\x1b[32m'); // green for CREATE
    expect(stdout).toContain('\x1b[34m'); // blue for ADD
    expect(stdout).toContain('\x1b[1m');  // bold for keywords

    // Keywords like CREATE should appear bold (before ANSI reset)
    expect(stdout).toMatch(/\x1b\[1mCREATE\x1b\[0m/);
  });

  it('should handle DROP COLUMN and CREATE INDEX in dry-run', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, DROP_ADD_INDEX_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dry-run',
      ])
    );

    expect(captured.code).toBe(0);
    const plain = stripAnsi(captured.stdout.join('\n'));
    expect(plain).toContain('EXIT OK [dry-run:');
    expect(plain).toContain('DROP COLUMN');
    expect(plain).toContain('email');
    expect(plain).toContain('CREATE INDEX');
    expect(plain).toContain('idx_users_name');
  });

  // ==========================================================
  // REAL EXECUTION (dryRun = false)
  // ==========================================================

  it('should execute migration and add column + table', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, ADD_COLUMN_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK [');
    expect(captured.stdout.join('\n')).toContain('operations applied');
    expect(captured.stdout.join('\n')).toContain('🚀');

    // Verify the migration actually happened
    const db = new Database(dbPath);
    dbs.push(db);
    const cols = db.prepare("PRAGMA table_info('users')").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('age');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('comments');
  });

  it('should execute migration and drop column + add index', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, DROP_ADD_INDEX_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('operations applied');

    // Verify email column was dropped
    const db = new Database(dbPath);
    dbs.push(db);
    const cols = db.prepare("PRAGMA table_info('users')").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('email');
    expect(colNames).toContain('name');
    expect(colNames).toContain('id');

    // Verify index was created
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_name'").all() as { name: string }[];
    expect(indexes.length).toBe(1);
  });

  it('should produce colored checkmarks in real execution mode', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, ADD_COLUMN_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    const stdout = captured.stdout.join('\n');
    // Colored output with checkmarks and SQL
    expect(stdout).toContain('✓');
    const plain = stripAnsi(stdout);
    expect(plain).toContain('CREATE TABLE');
    expect(stdout).toContain('\x1b[');  // ANSI escape codes present
    expect(plain).toContain('Миграция завершена');
  });

  // ==========================================================
  // NO-OP (schema unchanged)
  // ==========================================================

  it('should report no changes when schema is identical (dry-run)', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, NOOP_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dry-run',
      ])
    );

    expect(captured.code).toBe(0);
    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('No changes required');
    expect(stdout).toContain('0 operations');
  });

  it('should report no changes when schema is identical (real)', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, NOOP_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(0);
    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('No changes required');
    expect(stdout).toContain('EXIT OK [0 operations applied]');
  });

  // ==========================================================
  // DSN + ENGINE mode
  // ==========================================================

  it('should run dry-run via --dsn --engine', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, ADD_COLUMN_DBML);

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--dsn', dbPath,
        '--engine', 'sqlite',
        '--file', dbmlPath,
        '--dry-run',
      ])
    );

    expect(captured.code).toBe(0);
    const plain = stripAnsi(captured.stdout.join('\n'));
    expect(plain).toContain('EXIT OK [dry-run:');
  });

  it('should run real migration via --dsn --engine', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, ADD_COLUMN_DBML);

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--dsn', dbPath,
        '--engine', 'sqlite',
        '--file', dbmlPath,
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('operations applied');
  });

  // ==========================================================
  // ERROR handling
  // ==========================================================

  it('should try interactive mode when no args provided', async () => {
    // With no flags, migrateCommand should attempt interactive flow.
    // The function returns a Promise (it's async), so it runs without immediately crashing.
    // In a non-TTY environment it will hang on @clack/prompts, so we just verify
    // the function is callable and returns a Promise.
    const result = migrateCommand([]);
    expect(result).toBeInstanceOf(Promise);
    // Don't await — it would hang in non-TTY env
  });

  it('should try interactive mode with --engine only (no --dsn)', async () => {
    const result = migrateCommand(['--engine', 'sqlite']);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should error on unsupported engine', async () => {
    const captured = await runAndCaptureExit(() =>
      migrateCommand(['--dsn', 'x', '--engine', 'couchdb'])
    );

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [ENGINE]');
    expect(stderr).toContain('Unsupported engine');
  });

  it('should error on unimplemented engine', async () => {
    const captured = await runAndCaptureExit(() =>
      migrateCommand(['--dsn', 'x', '--engine', 'mysql'])
    );

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [ENGINE]');
    expect(stderr).toContain('not yet implemented');
  });

  it('should error when DBML file does not exist', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('nonexistent.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(3); // DBML_PARSE exit code
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [DBML_PARSE]');
    expect(stderr).toContain('Cannot read DBML file');
  });

  it('should error on broken DBML syntax', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, BAD_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(3); // DBML_PARSE exit code
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [DBML_PARSE]');
  });

  // ==========================================================
  // --records flag
  // ==========================================================

  it('should pass --records all flag and complete', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, NOOP_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--records', 'all',
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK');
  });

  it('should combine --dry-run and --records all', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, NOOP_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dry-run',
        '--records', 'all',
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK [dry-run:');
  });

  it('should create database file if it does not exist', async () => {
    const dbPath = testPath('new-empty.db');
    const dbmlPath = testPath('schema.dbml');

    // Ensure DB does NOT exist before the test
    if (existsSync(dbPath)) unlinkSync(dbPath);
    createDbml(dbmlPath, NOOP_DBML);

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--dsn', dbPath,
        '--engine', 'sqlite',
        '--file', dbmlPath,
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK');
    // Database file should now exist
    expect(existsSync(dbPath)).toBe(true);

    // Verify it has tables from the DBML
    const db = new Database(dbPath);
    dbs.push(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('posts');
  });

  // ---- PROFILE priority

  it('should prefer --profile over --dsn+engine', async () => {
    const dbPath = testPath('test.db');
    const dbmlPath = testPath('schema.dbml');

    createDb(dbPath, SIMPLE_SCHEMA_SQL);
    createDbml(dbmlPath, NOOP_DBML);

    writeJson('profiles.json', {
      prod: { dsn: dbPath, engine: 'sqlite', file: dbmlPath },
    });

    const captured = await runAndCaptureExit(() =>
      migrateCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dsn', 'other.db',
        '--engine', 'mysql',
      ])
    );

    expect(captured.code).toBe(0);
    // Profile was used (sqlite), not mysql (which would fail)
    expect(captured.stdout.join('\n')).toContain('EXIT OK');
  });
});
