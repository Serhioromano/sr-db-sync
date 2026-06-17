// ============================================================
// Tests: src/cli/snash.ts
// ============================================================

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { snashCommand } from '../src/cli/snash.js';
import { installMocks, runAndCaptureExit, resetCapture } from './helpers.js';

const TEST_DIR = join(import.meta.dir, 'tmp-cli-snash');
const TEST_DB = join(TEST_DIR, 'test.db');
const OUT_DIR = join(TEST_DIR, 'output');

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

function outPath(name: string): string {
  return join(OUT_DIR, name);
}

function writeJson(file: string, content: unknown): void {
  writeFileSync(testPath(file), JSON.stringify(content));
}

/** Create a simple SQLite database for testing. */
function createTestDb(path: string): void {
  if (existsSync(path)) unlinkSync(path);
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.run("CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, user_id INTEGER REFERENCES users(id))");
  db.run('CREATE INDEX idx_posts_user ON posts(user_id)');
  db.close();
}

describe('snashCommand', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMocks();
    resetCapture();
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    if (!existsSync(OUT_DIR)) {
      mkdirSync(OUT_DIR, { recursive: true });
    }
    createTestDb(TEST_DB);
  });

  afterEach(() => {
    uninstall();
    try {
      for (const f of readdirSync(TEST_DIR)) {
        const full = join(TEST_DIR, f);
        if (existsSync(full)) {
          try { unlinkSync(full); } catch { /* ignore */ }
        }
      }
      // Clean up output dir
      for (const f of readdirSync(OUT_DIR)) {
        unlinkSync(join(OUT_DIR, f));
      }
      rmdirSync(OUT_DIR);
      rmdirSync(TEST_DIR);
    } catch {
      // ignore
    }
  });

  // ---- NO ARGS → interactive mode (not tested — requires TTY) ----

  // Test that partial flags still work as before

  it('should take snapshot with --dsn and --engine', async () => {
    const outputFile = outPath('snap1.dbml');

    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--dsn', TEST_DB,
        '--engine', 'sqlite',
        '--file', outputFile,
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK');
    expect(captured.stdout.join('\n')).toContain(outputFile);

    // Verify the output file exists and contains valid DBML
    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, 'utf-8');
    expect(content).toContain('Table users');
    expect(content).toContain('Table posts');
  });

  it('should take snapshot without --file (use default derived from DSN)', async () => {
    // Create the migration directory for auto-generated output
    const migrationDir = './migration';
    if (!existsSync(migrationDir)) mkdirSync(migrationDir, { recursive: true });

    // Use a DSN that produces a known db name
    const customDbPath = join(TEST_DIR, 'myapp.db');
    if (existsSync(customDbPath)) unlinkSync(customDbPath);
    const db = new Database(customDbPath, { create: true });
    db.run('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    db.close();

    // The default path will be ./migration/myapp.dbml (relative to CWD)
    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--dsn', customDbPath,
        '--engine', 'sqlite',
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK');

    // Cleanup auto-created migration dir
    try {
      unlinkSync('./migration/myapp.dbml');
      rmdirSync('./migration');
    } catch { /* ignore */ }
  });

  // ---- PROFILE (success) ----

  it('should resolve --profile and take snapshot', async () => {
    const outputFile = outPath('snap2.dbml');

    writeJson('profiles.json', {
      prod: { dsn: TEST_DB, engine: 'sqlite', file: outputFile },
    });

    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK');
    expect(existsSync(outputFile)).toBe(true);
  });

  // ---- CONNECT error ----

  it('should error when database does not exist', async () => {
    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--dsn', join(TEST_DIR, 'nonexistent.db'),
        '--engine', 'sqlite',
      ])
    );

    expect(captured.code).toBe(2);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [CONNECT]');
  });

  // ---- ENGINE errors ----

  it('should error on unsupported engine with --dsn', async () => {
    const captured = await runAndCaptureExit(() =>
      snashCommand(['--dsn', TEST_DB, '--engine', 'mongodb'])
    );

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [ENGINE]');
    expect(stderr).toContain('Unsupported engine');
  });

  it('should attempt MySQL connection and fail with CONNECT error', async () => {
    // MySQL adapter is now implemented — it will try to connect and fail
    // because there is no MySQL server running at localhost
    const captured = await runAndCaptureExit(() =>
      snashCommand(['--dsn', 'mysql://root@localhost:3306/db', '--engine', 'mysql'])
    );

    // CONNECT error — exit code 2
    expect(captured.code).toBe(2);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [CONNECT]');
  });

  it('should error for unimplemented postgres adapter', async () => {
    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--dsn',
        'postgresql://localhost/db',
        '--engine',
        'postgres',
      ])
    );

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [ENGINE]');
    expect(stderr).toContain('not yet implemented');
  });

  // ---- PROFILE error cases ----

  it('should error when profile not found', async () => {
    writeJson('profiles.json', {
      prod: { dsn: TEST_DB, engine: 'sqlite' },
    });

    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--profile',
        'staging',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [CONFIG]');
    expect(stderr).toContain('not found');
  });

  // ---- PROFILE takes priority ----

  it('should prefer --profile over --dsn+engine', async () => {
    const outputFile = outPath('snap3.dbml');

    writeJson('profiles.json', {
      prod: { dsn: TEST_DB, engine: 'sqlite', file: outputFile },
    });

    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--dsn',
        'other.db',
        '--engine',
        'mysql',
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout.join('\n')).toContain('EXIT OK');
    expect(existsSync(outputFile)).toBe(true);
  });

  // ---- --file override ----

  it('should override profile file with --file flag', async () => {
    const profileOutput = outPath('profile-default.dbml');
    const overrideOutput = outPath('override.dbml');

    writeJson('profiles.json', {
      prod: { dsn: TEST_DB, engine: 'sqlite', file: profileOutput },
    });

    const captured = await runAndCaptureExit(() =>
      snashCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--file',
        overrideOutput,
      ])
    );

    expect(captured.code).toBe(0);
    expect(existsSync(overrideOutput)).toBe(true);
    // Profile default should NOT have been created
    expect(existsSync(profileOutput)).toBe(false);
  });
});
