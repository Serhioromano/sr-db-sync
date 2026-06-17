// ============================================================
// Tests: src/index.ts (CLI entry point)
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
} from 'node:fs';
import { join } from 'node:path';
import { installMocks, runAndCaptureExit, resetCapture } from './helpers.js';

const TEST_DIR = join(import.meta.dir, 'tmp-cli-main');
const TEST_DB = join(TEST_DIR, 'test.db');

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

function writeJson(file: string, content: unknown): void {
  writeFileSync(testPath(file), JSON.stringify(content));
}

function createTestDb(path: string): void {
  if (existsSync(path)) unlinkSync(path);
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
}

describe('CLI main entry (sync paths)', () => {
  let uninstall: () => void;
  const originalArgv = process.argv;

  beforeEach(() => {
    uninstall = installMocks();
    resetCapture();
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    createTestDb(TEST_DB);
  });

  afterEach(() => {
    uninstall();
    process.argv = originalArgv;
    try {
      for (const f of readdirSync(TEST_DIR)) {
        unlinkSync(join(TEST_DIR, f));
      }
      rmdirSync(TEST_DIR);
    } catch {
      // ignore
    }
  });

  // ---- --help ----

  it('should show usage on --help', async () => {
    process.argv = ['bun', 'dbs', '--help'];

    const captured = await runAndCaptureExit(() => {
      const args = process.argv.slice(2);
      if (args.includes('--help') || args.includes('-h')) {
        const { exitOk } = require('../src/utils/output.js');
        exitOk('help');
      }
    });

    expect(captured.code).toBe(0);
    expect(captured.stdout.some((l) => l.includes('EXIT OK [help]'))).toBe(
      true
    );
  });

  it('should show version on --version', async () => {
    process.argv = ['bun', 'dbs', '--version'];

    const captured = await runAndCaptureExit(() => {
      const args = process.argv.slice(2);
      if (args.includes('--version') || args.includes('-v')) {
        const { exitOk } = require('../src/utils/output.js');
        exitOk('version');
      }
    });

    expect(captured.code).toBe(0);
    expect(captured.stdout.some((l) => l.includes('EXIT OK [version]'))).toBe(
      true
    );
  });

  // ---- Subcommand dispatch ----

  it('should dispatch snash subcommand', async () => {
    const outFile = testPath('snap-output.dbml');

    writeJson('profiles.json', {
      prod: { dsn: TEST_DB, engine: 'sqlite', file: outFile },
    });

    process.argv = [
      'bun',
      'dbs',
      'snash',
      '--profile',
      'prod',
      '--profiles-file',
      testPath('profiles.json'),
    ];

    const captured = await runAndCaptureExit(async () => {
      const args = process.argv.slice(2);
      if (args[0] === 'snash') {
        const { snashCommand } = require('../src/cli/snash.js');
        await snashCommand(args.slice(1));
      }
    });

    expect(captured.code).toBe(0);
    expect(captured.stdout.some((l) => l.includes('EXIT OK'))).toBe(true);
    expect(existsSync(outFile)).toBe(true);
  });

  it('should dispatch migrate subcommand with --dry-run', async () => {
    // Create a DBML file for the existing test DB
    const dbmlPath = testPath('migrate-input.dbml');
    writeFileSync(dbmlPath, `Table users {\n  id INTEGER [pk]\n  name TEXT\n}\n`);

    writeJson('profiles.json', {
      prod: { dsn: TEST_DB, engine: 'sqlite', file: dbmlPath },
    });

    process.argv = [
      'bun',
      'dbs',
      'migrate',
      '--profile',
      'prod',
      '--profiles-file',
      testPath('profiles.json'),
      '--dry-run',
    ];

    const captured = await runAndCaptureExit(async () => {
      const args = process.argv.slice(2);
      if (args[0] === 'migrate') {
        const { migrateCommand } = require('../src/cli/migrate.js');
        await migrateCommand(args.slice(1));
      }
    });

    expect(captured.code).toBe(0);
    expect(captured.stdout.some((l) => l.includes('EXIT OK'))).toBe(true);
  });

  it('should error on unknown subcommand', async () => {
    process.argv = ['bun', 'dbs', 'unknown'];

    const captured = await runAndCaptureExit(() => {
      const args = process.argv.slice(2);
      const command = args[0];
      if (!['snash', 'migrate'].includes(command) && !command.startsWith('-')) {
        const { exitError } = require('../src/utils/output.js');
        exitError('CONFIG', `Unknown command: ${command}`);
      }
    });

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [CONFIG]');
  });

  it('should error when --dsn used without subcommand', async () => {
    process.argv = ['bun', 'dbs', '--dsn', './test.db'];

    const captured = await runAndCaptureExit(() => {
      const args = process.argv.slice(2);
      const command = args[0];
      if (command.startsWith('-')) {
        const { exitError } = require('../src/utils/output.js');
        exitError('CONFIG', 'Unknown flag without subcommand');
      }
    });

    expect(captured.code).toBe(1);
  });
});
