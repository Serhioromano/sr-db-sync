// ============================================================
// Tests for the public programmatic API (src/api.ts)
// ============================================================

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import {
  snash,
  migrate,
  createAdapter,
  parseDbml,
  generateDbml,
  parseRecordsFilter,
  type SnashOptions,
  type MigrateOptions,
} from '../src/api.js';

import type { SchemaIR } from '../src/core/types.js';

// ------------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------------

const DB_DIR = 'test/';
function dbPath(name: string) { return resolve(`${DB_DIR}api-${name}.db`); }
function dbmlPath(name: string) { return resolve(`${DB_DIR}api-${name}.dbml`); }

/**
 * Clean up test artifacts.
 */
function cleanup(...names: string[]) {
  for (const name of names) {
    try { unlinkSync(dbPath(name)); } catch {}
    try { unlinkSync(dbmlPath(name)); } catch {}
  }
}

/**
 * Seed a SQLite database with a simple schema (no tricky defaults).
 */
function seedSimple(db: Database): void {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT
    );
    CREATE INDEX idx_posts_user_id ON posts(user_id);
    INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');
    INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com');
    INSERT INTO posts (user_id, title, body) VALUES (1, 'Hello', 'World');
  `);
}

// ------------------------------------------------------------------
// snash()
// ------------------------------------------------------------------

describe('snash()', () => {
  afterAll(() => cleanup('snash-simple', 'snash-prefix', 'snash-records-all', 'snash-records-specific'));

  it('should snapshot a database to a DBML file', async () => {
    const name = 'snash-simple';

    const db = new Database(dbPath(name));
    seedSimple(db);
    db.close();

    const result = await snash({
      engine: 'sqlite',
      dsn: dbPath(name),
      file: dbmlPath(name),
    });

    expect(result.file).toEndWith(`${name}.dbml`);
    expect(result.dbml).toInclude('Table users');
    expect(result.dbml).toInclude('Table posts');
    expect(result.dbml).toInclude('email text');
    expect(result.dbml).toInclude('Ref: posts.user_id > users.id');
    expect(existsSync(dbmlPath(name))).toBe(true);

    // The returned DBML should be parseable
    const parsed = parseDbml(result.dbml);
    expect(parsed.tables).toHaveLength(2);
  });

  it('should strip prefix from table names', async () => {
    const name = 'snash-prefix';
    const db = new Database(dbPath(name));
    db.exec(`
      CREATE TABLE wp_users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE wp_posts (id INTEGER PRIMARY KEY, title TEXT);
    `);
    db.close();

    const result = await snash({
      engine: 'sqlite',
      dsn: dbPath(name),
      file: dbmlPath(name),
      prefix: 'wp_',
    });

    expect(result.dbml).toInclude('Table users');
    expect(result.dbml).toInclude('Table posts');
    expect(result.dbml).not.toInclude('wp_users');
    expect(result.dbml).not.toInclude('wp_posts');
  });

  it('should snapshot records when recordsFilter is "all"', async () => {
    const name = 'snash-records-all';

    const db = new Database(dbPath(name));
    seedSimple(db);
    db.close();

    const result = await snash({
      engine: 'sqlite',
      dsn: dbPath(name),
      file: dbmlPath(name),
      recordsFilter: 'all',
    });

    expect(result.dbml).toInclude('alice@example.com');
    expect(result.dbml).toInclude('Alice');
  });

  it('should snapshot records for specific tables only', async () => {
    const name = 'snash-records-specific';

    const db = new Database(dbPath(name));
    seedSimple(db);
    db.close();

    const result = await snash({
      engine: 'sqlite',
      dsn: dbPath(name),
      file: dbmlPath(name),
      recordsFilter: 'users',
    });

    expect(result.dbml).toInclude('alice@example.com');
    // Posts should not have records — the seed inserts posts but we only asked for users
    expect(result.dbml).not.toInclude("'Hello'");
  });

  it('should throw DbsError on invalid DSN (directory as DSN)', async () => {
    await expect(
      snash({
        engine: 'sqlite',
        dsn: '/tmp',
        file: '/tmp/nope.dbml',
      })
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------------------
// migrate()
// ------------------------------------------------------------------

describe('migrate()', () => {
  afterAll(() => cleanup('migrate-source', 'migrate-fresh', 'migrate-exec', 'migrate-noup', 'migrate-nofile'));

  it('should dry-run migrate onto an empty database', async () => {
    // Step 1: Create a seeded DB and snapshot it (with records so the DBML includes data)
    const srcDb = new Database(dbPath('migrate-source'));
    seedSimple(srcDb);
    srcDb.close();

    await snash({
      engine: 'sqlite',
      dsn: dbPath('migrate-source'),
      file: dbmlPath('migrate-source'),
      recordsFilter: 'all',
    });

    // Step 2: Create a fresh empty DB
    const fresh = new Database(dbPath('migrate-fresh'));
    fresh.close();

    // Step 3: Dry-run migrate the snapshot onto the empty DB
    const result = await migrate({
      engine: 'sqlite',
      dsn: dbPath('migrate-fresh'),
      file: dbmlPath('migrate-source'),
      dryRun: true,
    });

    expect(result.totalOps).toBeGreaterThan(0);
    expect(result.summary.create_table).toBeGreaterThanOrEqual(2); // users, posts
    expect(result.sql.length).toBeGreaterThan(0);

    // Verify the fresh DB is still empty (dry-run didn't execute)
    const checkDb = new Database(dbPath('migrate-fresh'));
    const tables = checkDb
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables.length).toBe(0);
    checkDb.close();
  });

  it('should actually execute migration (non-dry-run)', async () => {
    const result = await migrate({
      engine: 'sqlite',
      dsn: dbPath('migrate-exec'),
      file: dbmlPath('migrate-source'),
      dryRun: false,
      recordsFilter: 'all',
    });

    expect(result.totalOps).toBeGreaterThan(0);

    // Verify tables were created
    const checkDb = new Database(dbPath('migrate-exec'));
    const tables = checkDb
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThanOrEqual(2);

    // Verify data migration worked (records from DBML should be inserted)
    const rows = checkDb.query('SELECT name FROM users').all() as { name: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);

    checkDb.close();
  });

  it('should return zero real operations when schema is already up to date', async () => {
    // Snapshot the DB we just migrated (it should now match the DBML)
    // then migrate again — should be no real changes.
    const result = await migrate({
      engine: 'sqlite',
      dsn: dbPath('migrate-exec'),
      file: dbmlPath('migrate-source'),
    });

    // Schema should be up to date — only comment-only no-ops
    const realOps = result.plan.filter(
      (op) => !op.sql.trimStart().startsWith('--')
    );
    expect(realOps.length).toBe(0);
  });

  it('should throw when DBML file does not exist', async () => {
    const db = new Database(dbPath('migrate-nofile'));
    seedSimple(db);
    db.close();

    await expect(
      migrate({
        engine: 'sqlite',
        dsn: dbPath('migrate-nofile'),
        file: '/nonexistent/path/file.dbml',
      })
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------------------
// createAdapter()
// ------------------------------------------------------------------

describe('createAdapter()', () => {
  it('should create a SqliteAdapter for "sqlite"', () => {
    const adapter = createAdapter('sqlite');
    expect(adapter).toBeDefined();
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
    expect(typeof adapter.migrateToSchema).toBe('function');
  });

  it('should create a MysqlAdapter for "mysql"', () => {
    const adapter = createAdapter('mysql');
    expect(adapter).toBeDefined();
    expect(typeof adapter.connect).toBe('function');
  });

  it('should throw for unsupported engines', () => {
    expect(() => createAdapter('postgres')).toThrow();
    expect(() => createAdapter('mongodb')).toThrow();
  });
});

// ------------------------------------------------------------------
// parseDbml / generateDbml / parseRecordsFilter
// ------------------------------------------------------------------

describe('re-exported utilities', () => {
  it('parseDbml should parse DBML string into SchemaIR', () => {
    const schema = parseDbml(`
      Table users {
        id INTEGER [pk, increment]
        name TEXT [not null]
      }
    `);
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0]!.name).toBe('users');
    expect(schema.tables[0]!.columns).toHaveLength(2);
  });

  it('generateDbml should convert SchemaIR to DBML string', () => {
    const schema: SchemaIR = {
      tables: [
        {
          name: 'items',
          columns: [
            {
              name: 'id',
              type: 'INTEGER',
              nullable: false,
              primaryKey: true,
              unique: false,
              autoIncrement: true,
            },
            {
              name: 'label',
              type: 'TEXT',
              nullable: false,
              primaryKey: false,
              unique: false,
              autoIncrement: false,
            },
          ],
          indexes: [],
          foreignKeys: [],
          triggers: [],
        },
      ],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [],
    };
    const dbml = generateDbml(schema);
    expect(dbml).toInclude('Table items');
    // DBML writer lowercases type names
    expect(dbml).toInclude('id integer');
    expect(dbml).toInclude('label text');
  });

  it('parseRecordsFilter should parse correctly', () => {
    expect(parseRecordsFilter(undefined)).toBeUndefined();
    expect(parseRecordsFilter('')).toBeUndefined();
    expect(parseRecordsFilter('all')).toEqual(['*']);
    expect(parseRecordsFilter('users,posts')).toEqual(['users', 'posts']);
  });
});
