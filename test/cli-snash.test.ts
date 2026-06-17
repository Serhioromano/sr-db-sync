// ============================================================
// Tests: src/cli/snash.ts
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
import { snashCommand } from '../src/cli/snash.js';
import { installMocks, runAndCaptureExit, resetCapture } from './helpers.js';

const TEST_DIR = join(import.meta.dir, 'tmp-cli-snash');

function testPath(name: string): string {
  return join(TEST_DIR, name);
}

function writeJson(file: string, content: unknown): void {
  writeFileSync(testPath(file), JSON.stringify(content));
}

describe('snashCommand', () => {
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
    try {
      for (const f of readdirSync(TEST_DIR)) {
        unlinkSync(join(TEST_DIR, f));
      }
      rmdirSync(TEST_DIR);
    } catch {
      // ignore
    }
  });

  // ---- NO ARGS → ERROR ----

  it('should error when no args provided', () => {
    const captured = runAndCaptureExit(() => snashCommand([]));

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [CONFIG]');
    expect(stderr).toContain('No profile or --dsn provided');
  });

  // ---- PROFILE ----

  it('should resolve --profile and exit OK', () => {
    writeJson('profiles.json', {
      prod: { dsn: './my.db', engine: 'sqlite' },
    });

    const captured = runAndCaptureExit(() =>
      snashCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout[0]).toBe('EXIT OK [profile resolved: prod]');
  });

  it('should error when profile not found', () => {
    writeJson('profiles.json', {
      prod: { dsn: './my.db', engine: 'sqlite' },
    });

    const captured = runAndCaptureExit(() =>
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

  // ---- DSN + ENGINE ----

  it('should accept --dsn and --engine directly', () => {
    const captured = runAndCaptureExit(() =>
      snashCommand(['--dsn', './test.db', '--engine', 'sqlite'])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout[0]).toBe(
      'EXIT OK [snapshot: engine=sqlite dsn=./test.db]'
    );
  });

  it('should normalise engine to lowercase', () => {
    const captured = runAndCaptureExit(() =>
      snashCommand(['--dsn', './test.db', '--engine', 'SQLITE'])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout[0]).toContain('engine=sqlite');
  });

  it('should error on unsupported engine with --dsn', () => {
    const captured = runAndCaptureExit(() =>
      snashCommand(['--dsn', './test.db', '--engine', 'mongodb'])
    );

    expect(captured.code).toBe(1);
    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('ERROR [ENGINE]');
    expect(stderr).toContain('Unsupported engine');
  });

  it('should accept MySQL engine', () => {
    const captured = runAndCaptureExit(() =>
      snashCommand(['--dsn', 'mysql://localhost/db', '--engine', 'mysql'])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout[0]).toContain('engine=mysql');
  });

  it('should accept postgres engine', () => {
    const captured = runAndCaptureExit(() =>
      snashCommand([
        '--dsn',
        'postgresql://localhost/db',
        '--engine',
        'postgres',
      ])
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout[0]).toContain('engine=postgres');
  });

  // ---- PROFILE takes priority ----

  it('should prefer --profile over --dsn+engine', () => {
    writeJson('profiles.json', {
      prod: { dsn: './my.db', engine: 'sqlite' },
    });

    const captured = runAndCaptureExit(() =>
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
    expect(captured.stdout[0]).toBe('EXIT OK [profile resolved: prod]');
  });

  // ---- --prefix and --file are accepted silently ----

  it('should accept --prefix flag with profile', () => {
    writeJson('profiles.json', {
      prod: { dsn: './my.db', engine: 'sqlite' },
    });

    const captured = runAndCaptureExit(() =>
      snashCommand([
        '--profile',
        'prod',
        '--profiles-file',
        testPath('profiles.json'),
        '--prefix',
        'mypref_',
        '--file',
        'custom.dbml',
      ])
    );

    expect(captured.code).toBe(0);
  });
});
