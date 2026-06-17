// ============================================================
// Tests for SQLite adapter — schema reading (Phase 4)
// ============================================================

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteAdapter } from '../src/adapters/sqlite.js';
import { unlinkSync, existsSync } from 'node:fs';

// ============================================================
// Helper: create a file-based SQLite database with a rich schema
// ============================================================

const TMP_DB_PATH = '/tmp/db-sync-test-adapter.sqlite';

function createFileDb(path: string): void {
  // Remove if exists
  if (existsSync(path)) unlinkSync(path);

  const db = new Database(path, { create: true });

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      bio TEXT,
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL
    );

    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT,
      status VARCHAR(20) DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE
    );
  `);

  db.run(`
    CREATE INDEX idx_posts_user_id ON posts(user_id);
    CREATE UNIQUE INDEX idx_posts_title ON posts(title);
    CREATE INDEX idx_posts_user_status ON posts(user_id, status);
    CREATE INDEX idx_comments_post_id ON comments(post_id);
  `);

  db.run(`
    CREATE TRIGGER after_insert_posts
    AFTER INSERT ON posts
    BEGIN
      UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.user_id;
    END;
  `);

  db.run(`
    CREATE TRIGGER before_delete_user
    BEFORE DELETE ON users
    BEGIN
      DELETE FROM posts WHERE user_id = OLD.id;
    END;
  `);

  db.run(`
    CREATE VIEW active_users AS
    SELECT u.id, u.name, COUNT(p.id) as post_count
    FROM users u
    LEFT JOIN posts p ON p.user_id = u.id
    WHERE u.bio IS NOT NULL
    GROUP BY u.id, u.name;
  `);

  db.close();
}

function cleanup() {
  if (existsSync(TMP_DB_PATH)) unlinkSync(TMP_DB_PATH);
}

// ============================================================
// Tests
// ============================================================

describe('SqliteAdapter — static DSN contract', () => {
  it('should define dsnFields with path field', () => {
    expect(SqliteAdapter.dsnFields).toBeArray();
    expect(SqliteAdapter.dsnFields.length).toBe(1);
    expect(SqliteAdapter.dsnFields[0].name).toBe('path');
    expect(SqliteAdapter.dsnFields[0].type).toBe('text');
  });

  it('buildDsn should return the path value', () => {
    expect(SqliteAdapter.buildDsn({ path: './test.db' })).toBe('./test.db');
    expect(SqliteAdapter.buildDsn({ path: '/absolute/path/db.sqlite' })).toBe('/absolute/path/db.sqlite');
  });
});

describe('SqliteAdapter — extractDbName', () => {
  const adapter = new SqliteAdapter();

  it('should extract name from .db file', () => {
    expect(adapter.extractDbName('./data/myapp.db')).toBe('myapp');
  });

  it('should extract name from .sqlite file', () => {
    expect(adapter.extractDbName('/var/db/production.sqlite')).toBe('production');
  });

  it('should extract name from .sqlite3 file', () => {
    expect(adapter.extractDbName('local/db.sqlite3')).toBe('db');
  });

  it('should extract name from path without known extension', () => {
    expect(adapter.extractDbName('./data/custom.ext')).toBe('custom');
  });

  it('should handle path with no extension', () => {
    expect(adapter.extractDbName('./data/rawfile')).toBe('rawfile');
  });

  it('should handle just a filename', () => {
    expect(adapter.extractDbName('mydb.sqlite')).toBe('mydb');
  });
});

describe('SqliteAdapter — connect / disconnect', () => {
  afterAll(cleanup);

  it('should connect to in-memory database', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(':memory:');
    await adapter.disconnect();
  });

  it('should connect to file database', async () => {
    createFileDb(TMP_DB_PATH);

    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    await adapter.disconnect();
  });

  it('should fail to connect to nonexistent file', async () => {
    const adapter = new SqliteAdapter();
    try {
      await adapter.connect('/tmp/nonexistent-db-sync-test-file-that-does-not-exist-12345.sqlite');
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect(err).toBeDefined();
      const e = err as { code: string; engine: string };
      expect(e.code).toBe('CONNECT');
      expect(e.engine).toBe('sqlite');
    }
  });

  it('should disconnect cleanly when not connected', async () => {
    const adapter = new SqliteAdapter();
    await adapter.disconnect();
  });

  it('should throw when getTables called without connect', async () => {
    const adapter = new SqliteAdapter();
    try {
      await adapter.getTables();
      expect(true).toBe(false);
    } catch (err: unknown) {
      const e = err as { code: string };
      expect(e.code).toBe('CONNECT');
    }
  });
});

describe('SqliteAdapter — getTables', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should list all user tables', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const tables = await adapter.getTables();
    await adapter.disconnect();

    expect(tables).toBeArray();
    expect(tables).toContain('users');
    expect(tables).toContain('posts');
    expect(tables).toContain('comments');
    expect(tables).toContain('tags');
    expect(tables.length).toBeGreaterThanOrEqual(4);
  });

  it('should not include sqlite internal tables', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const tables = await adapter.getTables();
    await adapter.disconnect();

    for (const t of tables) {
      expect(t.startsWith('sqlite_')).toBe(false);
    }
  });
});

describe('SqliteAdapter — getColumns', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should read columns for users table', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const columns = await adapter.getColumns('users');
    await adapter.disconnect();

    expect(columns).toBeArray();
    expect(columns.length).toBeGreaterThanOrEqual(7);

    // id column
    const idCol = columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.primaryKey).toBe(true);
    expect(idCol!.autoIncrement).toBe(true);
    expect(idCol!.nullable).toBe(false);

    // email column
    const emailCol = columns.find((c) => c.name === 'email');
    expect(emailCol).toBeDefined();
    expect(emailCol!.nullable).toBe(false);

    // bio column
    const bioCol = columns.find((c) => c.name === 'bio');
    expect(bioCol).toBeDefined();
    expect(bioCol!.nullable).toBe(true);

    // role column with default
    const roleCol = columns.find((c) => c.name === 'role');
    expect(roleCol).toBeDefined();
    expect(roleCol!.defaultValue).toContain('user');
  });

  it('should read columns for a table without PK AUTOINCREMENT', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const columns = await adapter.getColumns('tags');
    await adapter.disconnect();

    const idCol = columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.primaryKey).toBe(true);
    // INTEGER PRIMARY KEY without AUTOINCREMENT still auto-increments in SQLite,
    // but we don't tag it as autoIncrement because the keyword is absent
    expect(idCol!.autoIncrement).toBe(false);
  });
});

describe('SqliteAdapter — getIndexes', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should read user-created indexes for posts table', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const indexes = await adapter.getIndexes('posts');
    await adapter.disconnect();

    expect(indexes).toBeArray();
    expect(indexes.length).toBeGreaterThanOrEqual(3);

    // idx_posts_user_id
    const idxUserId = indexes.find((i) => i.name === 'idx_posts_user_id');
    expect(idxUserId).toBeDefined();
    expect(idxUserId!.columns).toContain('user_id');
    expect(idxUserId!.unique).toBe(false);
    expect(idxUserId!.type).toBe('btree');

    // idx_posts_title (unique)
    const idxTitle = indexes.find((i) => i.name === 'idx_posts_title');
    expect(idxTitle).toBeDefined();
    expect(idxTitle!.unique).toBe(true);

    // multi-column index
    const idxMulti = indexes.find((i) => i.name === 'idx_posts_user_status');
    expect(idxMulti).toBeDefined();
    expect(idxMulti!.columns.length).toBe(2);
  });

  it('should exclude sqlite_autoindex internal indexes', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const indexes = await adapter.getIndexes('users');
    await adapter.disconnect();

    for (const idx of indexes) {
      expect(idx.name.startsWith('sqlite_autoindex_')).toBe(false);
    }
  });
});

describe('SqliteAdapter — getForeignKeys', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should read FK for posts table', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const fks = await adapter.getForeignKeys('posts');
    await adapter.disconnect();

    expect(fks).toBeArray();
    expect(fks.length).toBe(1);

    const fk = fks[0];
    expect(fk.columns).toContain('user_id');
    expect(fk.refTable).toBe('users');
    expect(fk.refColumns).toContain('id');
    expect(fk.onDelete).toBe('cascade');
    expect(fk.onUpdate).toBe('cascade');
  });

  it('should read FKs for comments table (two FKs)', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const fks = await adapter.getForeignKeys('comments');
    await adapter.disconnect();

    expect(fks).toBeArray();
    expect(fks.length).toBe(2);

    const userFk = fks.find((f) => f.refTable === 'users');
    expect(userFk).toBeDefined();
    expect(userFk!.columns).toContain('user_id');

    const postFk = fks.find((f) => f.refTable === 'posts');
    expect(postFk).toBeDefined();
    expect(postFk!.columns).toContain('post_id');
  });

  it('should return empty array for table without FKs', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const fks = await adapter.getForeignKeys('tags');
    await adapter.disconnect();

    expect(fks).toBeArray();
    expect(fks.length).toBe(0);
  });
});

describe('SqliteAdapter — getTriggers', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should read triggers for posts table', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const triggers = await adapter.getTriggers('posts');
    await adapter.disconnect();

    expect(triggers).toBeArray();
    expect(triggers.length).toBe(1);

    const t = triggers[0];
    expect(t.name).toBe('after_insert_posts');
    expect(t.timing).toBe('after');
    expect(t.event).toBe('insert');
    expect(t.body).toContain('CREATE TRIGGER');
  });

  it('should read triggers for users table', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const triggers = await adapter.getTriggers('users');
    await adapter.disconnect();

    expect(triggers).toBeArray();
    expect(triggers.length).toBe(1);

    const t = triggers[0];
    expect(t.name).toBe('before_delete_user');
    expect(t.timing).toBe('before');
    expect(t.event).toBe('delete');
  });

  it('should return empty array for table without triggers', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const triggers = await adapter.getTriggers('tags');
    await adapter.disconnect();

    expect(triggers).toBeArray();
    expect(triggers.length).toBe(0);
  });
});

describe('SqliteAdapter — getViews', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should read views', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const views = await adapter.getViews();
    await adapter.disconnect();

    expect(views).toBeArray();
    expect(views.length).toBe(1);

    const v = views[0];
    expect(v.name).toBe('active_users');
    expect(v.definition).toContain('CREATE VIEW');
    expect(v.definition).toContain('active_users');
  });
});

describe('SqliteAdapter — getProcedures and getEnums', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('getProcedures should return empty (SQLite does not support)', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const procs = await adapter.getProcedures();
    await adapter.disconnect();

    expect(procs).toBeArray();
    expect(procs.length).toBe(0);
  });

  it('getEnums should return empty (SQLite does not support)', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);
    const enums = await adapter.getEnums();
    await adapter.disconnect();

    expect(enums).toBeArray();
    expect(enums.length).toBe(0);
  });
});

describe('SqliteAdapter — full schema extraction roundtrip', () => {
  beforeAll(() => createFileDb(TMP_DB_PATH));
  afterAll(cleanup);

  it('should extract all schema elements consistently', async () => {
    const adapter = new SqliteAdapter();
    await adapter.connect(TMP_DB_PATH);

    const tables = await adapter.getTables();
    expect(tables.length).toBeGreaterThanOrEqual(4);

    for (const tableName of tables) {
      const columns = await adapter.getColumns(tableName);
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.every((c) => typeof c.name === 'string')).toBe(true);
      expect(columns.every((c) => typeof c.type === 'string')).toBe(true);
      expect(columns.every((c) => typeof c.nullable === 'boolean')).toBe(true);
      expect(columns.every((c) => typeof c.primaryKey === 'boolean')).toBe(true);

      const indexes = await adapter.getIndexes(tableName);
      for (const idx of indexes) {
        expect(idx.columns.length).toBeGreaterThan(0);
        expect(typeof idx.name).toBe('string');
        expect(typeof idx.unique).toBe('boolean');
      }

      const fks = await adapter.getForeignKeys(tableName);
      for (const fk of fks) {
        expect(fk.columns.length).toBeGreaterThan(0);
        expect(fk.refColumns.length).toBeGreaterThan(0);
        expect(typeof fk.refTable).toBe('string');
      }

      const triggers = await adapter.getTriggers(tableName);
      for (const t of triggers) {
        expect(typeof t.name).toBe('string');
        expect(['before', 'after', 'instead of']).toContain(t.timing);
        expect(['insert', 'update', 'delete']).toContain(t.event);
      }
    }

    const views = await adapter.getViews();
    expect(views.length).toBe(1);

    const procedures = await adapter.getProcedures();
    expect(procedures.length).toBe(0);

    const enums = await adapter.getEnums();
    expect(enums.length).toBe(0);

    await adapter.disconnect();
  });
});

describe('SqliteAdapter — edge cases', () => {
  afterEach(cleanup);

  it('should handle table with minimal columns', async () => {
    const path = '/tmp/db-sync-test-edge.sqlite';
    if (existsSync(path)) unlinkSync(path);
    const db = new Database(path, { create: true });
    db.run('CREATE TABLE edge (id INTEGER PRIMARY KEY);');
    db.close();

    const adapter = new SqliteAdapter();
    await adapter.connect(path);
    const columns = await adapter.getColumns('edge');
    await adapter.disconnect();

    expect(columns).toBeArray();
    expect(columns.length).toBe(1);
    expect(columns[0].name).toBe('id');

    unlinkSync(path);
  });

  it('should handle table with composite PK', async () => {
    const path = '/tmp/db-sync-test-comp-pk.sqlite';
    if (existsSync(path)) unlinkSync(path);
    const db = new Database(path, { create: true });
    db.run('CREATE TABLE composite_pk (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));');
    db.close();

    const adapter = new SqliteAdapter();
    await adapter.connect(path);
    const columns = await adapter.getColumns('composite_pk');
    await adapter.disconnect();

    const pkCols = columns.filter((c) => c.primaryKey);
    expect(pkCols.length).toBe(2);
    expect(columns.length).toBe(2);

    unlinkSync(path);
  });

  it('should handle multiple disconnect calls', async () => {
    const adapter = new SqliteAdapter();
    await adapter.disconnect();
    await adapter.disconnect();
  });

  it('should handle foreign key with SET NULL action', async () => {
    const path = '/tmp/db-sync-test-fk-null.sqlite';
    if (existsSync(path)) unlinkSync(path);
    const db = new Database(path, { create: true });
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE SET NULL ON UPDATE SET NULL
      );
    `);
    db.close();

    const adapter = new SqliteAdapter();
    await adapter.connect(path);
    const fks = await adapter.getForeignKeys('child');
    await adapter.disconnect();

    expect(fks.length).toBe(1);
    expect(fks[0].onDelete).toBe('set null');
    expect(fks[0].onUpdate).toBe('set null');

    unlinkSync(path);
  });

  it('should handle foreign key with RESTRICT action', async () => {
    const path = '/tmp/db-sync-test-fk-restrict.sqlite';
    if (existsSync(path)) unlinkSync(path);
    const db = new Database(path, { create: true });
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE RESTRICT ON UPDATE RESTRICT
      );
    `);
    db.close();

    const adapter = new SqliteAdapter();
    await adapter.connect(path);
    const fks = await adapter.getForeignKeys('child');
    await adapter.disconnect();

    expect(fks.length).toBe(1);
    expect(fks[0].onDelete).toBe('restrict');
    expect(fks[0].onUpdate).toBe('restrict');

    unlinkSync(path);
  });

  it('should handle INSTEAD OF trigger via parsing', async () => {
    // SQLite doesn't support INSTEAD OF triggers on tables (only views),
    // but our parser handles the keyword
    const path = '/tmp/db-sync-test-instead.sqlite';
    if (existsSync(path)) unlinkSync(path);
    const db = new Database(path, { create: true });
    db.run(`
      CREATE TABLE t (id INTEGER PRIMARY KEY);
      CREATE VIEW v AS SELECT id FROM t;
      CREATE TRIGGER instead_of_insert
      INSTEAD OF INSERT ON v
      BEGIN
        INSERT INTO t (id) VALUES (NEW.id);
      END;
    `);
    db.close();

    const adapter = new SqliteAdapter();
    await adapter.connect(path);
    const triggers = await adapter.getTriggers('v');
    await adapter.disconnect();

    expect(triggers.length).toBe(1);
    expect(triggers[0].name).toBe('instead_of_insert');
    expect(triggers[0].timing).toBe('instead of');

    unlinkSync(path);
  });
});

// ============================================================
// migrateToSchema tests
// ============================================================

import type {
  SchemaIR,
  TableDefinition,
  ColumnDef,
  IndexDef,
  FKDef,
  MigrationPlan,
} from '../src/core/types.js';

function col(name: string, type: string, opts?: Partial<ColumnDef>): ColumnDef {
  return { name, type, nullable: true, primaryKey: false, unique: false, autoIncrement: false, ...opts };
}
function idx(name: string, columns: string[], opts?: Partial<IndexDef>): IndexDef {
  return { name, columns, unique: false, ...opts };
}
function fk(name: string, columns: string[], refTable: string, refColumns: string[], opts?: Partial<FKDef>): FKDef {
  return { name, columns, refTable, refColumns, ...opts };
}
function table(name: string, cols: ColumnDef[], idxs?: IndexDef[], fks?: FKDef[]): TableDefinition {
  return { name, columns: cols, indexes: idxs ?? [], foreignKeys: fks ?? [], triggers: [] };
}
function schema(tables: TableDefinition[]): SchemaIR {
  return { tables, views: [], procedures: [], enums: [], extensions: [] };
}

const MIG_TMP_DB = '/tmp/db-sync-test-migrate.sqlite';

function createMigDb(path: string): void {
  if (existsSync(path)) unlinkSync(path);
  const db = new Database(path, { create: true });
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL)`);
  db.run(`CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title VARCHAR(255), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  db.run(`CREATE INDEX idx_posts_user ON posts(user_id)`);
  db.close();
}

describe('SqliteAdapter — migrateToSchema', () => {
  it('returns empty plan when target matches current schema', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Note: SQLite cannot detect column-level UNIQUE (it creates sqlite_autoindex_*),
    // so the target must not set unique=true on email to match what getColumns() returns.
    const target = schema([
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false }),
        col('name', 'VARCHAR(100)', { nullable: false }),
      ]),
      table('posts', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('user_id', 'INTEGER', { nullable: true }),
        col('title', 'VARCHAR(255)', { nullable: true }),
      ], [
        idx('idx_posts_user', ['user_id']),
      ], [
        fk('fk_posts_users_0', ['user_id'], 'users', ['id'], { onDelete: 'cascade' }),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    expect(plan).toEqual([]);
  });

  it('generates CREATE TABLE for new tables', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    const target = schema([
      table('comments', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('body', 'TEXT', { nullable: true }),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const creates = plan.filter((op) => op.type === 'create_table');
    expect(creates.length).toBe(1);
    expect(creates[0].table).toBe('comments');
    expect(creates[0].sql).toContain('CREATE TABLE "comments"');
    expect(creates[0].sql).toContain('"body" TEXT');
  });

  it('does NOT drop tables present in current but missing from target', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Target only has 'users' — 'posts' is missing but should NOT be dropped
    const target = schema([
      table('users', [col('id', 'INTEGER', { primaryKey: true, nullable: false })]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const drops = plan.filter((op) => op.sql?.toLowerCase().includes('drop table'));
    expect(drops).toEqual([]);
  });

  it('generates ADD COLUMN for new columns', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    const target = schema([
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        col('name', 'VARCHAR(100)', { nullable: false }),
        col('bio', 'TEXT', { nullable: true }),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const adds = plan.filter((op) => op.type === 'add_column');
    expect(adds.length).toBe(1);
    expect(adds[0].column).toBe('bio');
    expect(adds[0].sql).toContain('ADD COLUMN "bio" TEXT');
  });

  it('generates DROP COLUMN for removed columns', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Target has 'users' without 'name'
    const target = schema([
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false, unique: true }),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const drops = plan.filter((op) => op.type === 'drop_column');
    expect(drops.length).toBe(1);
    expect(drops[0].column).toBe('name');
    expect(drops[0].sql).toContain('DROP COLUMN "name"');
  });

  it('generates MODIFY COLUMN for changed column types', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // name changed from VARCHAR(100) to VARCHAR(255)
    const target = schema([
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false }),
        col('name', 'VARCHAR(255)', { nullable: false }),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const mods = plan.filter((op) => op.type === 'modify_column');
    expect(mods.length).toBe(1);
    expect(mods[0].column).toBe('name');
    expect(mods[0].sql).toContain('MODIFY');
    expect(mods[0].sql).toContain('VARCHAR(255)');
  });

  it('generates CREATE INDEX for new indexes', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    const target = schema([
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        col('name', 'VARCHAR(100)', { nullable: false }),
      ], [
        idx('idx_users_name', ['name']),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const creates = plan.filter((op) => op.type === 'create_index');
    expect(creates.length).toBe(1);
    expect(creates[0].index).toBe('idx_users_name');
    expect(creates[0].sql).toContain('CREATE INDEX "idx_users_name"');
  });

  it('generates DROP INDEX for removed indexes', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Target has posts without idx_posts_user (removed).
    // Since posts has FK changes too, this triggers a table rebuild.
    // Indexes not in target are simply not recreated after rebuild.
    const target = schema([
      table('posts', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('user_id', 'INTEGER'),
        col('title', 'VARCHAR(255)'),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    // Each rebuild produces 4 ops (all type 'rebuild')
    const allTableOps = plan.filter((op) => op.table === 'posts');
    expect(allTableOps.length).toBe(4);
    expect(allTableOps[0]!.type).toBe('rebuild');
    expect(allTableOps[0]!.sql).toContain('CREATE TABLE');
    expect(allTableOps[1]!.sql).toContain('INSERT INTO');
    expect(allTableOps[2]!.sql).toContain('DROP TABLE');
    expect(allTableOps[3]!.sql).toContain('RENAME TO');
  });

  it('generates table rebuild for new foreign keys', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Add FK to users table (doesn't exist in current)
    // SQLite does not support ALTER TABLE ADD FOREIGN KEY → table rebuild
    const target = schema([
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        col('name', 'VARCHAR(100)', { nullable: false }),
      ], [], [
        fk('fk_users_self', ['id'], 'users', ['id']),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    // Should produce a table rebuild (4 ops for users table)
    const allTableOps = plan.filter((op) => op.table === 'users');
    expect(allTableOps.length).toBe(4);
    expect(allTableOps[0]!.sql).toContain('FOREIGN KEY');
  });

  it('generates table rebuild for removed foreign keys', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Target has posts without FK
    // SQLite does not support ALTER TABLE DROP FOREIGN KEY → table rebuild
    const target = schema([
      table('posts', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('user_id', 'INTEGER'),
        col('title', 'VARCHAR(255)'),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    // Should produce a table rebuild (4 ops for posts table)
    const allTableOps = plan.filter((op) => op.table === 'posts');
    expect(allTableOps.length).toBe(4);
    // The CREATE TABLE op should NOT contain FOREIGN KEY (FK was removed)
    expect(allTableOps[0]!.sql).not.toContain('FOREIGN KEY');
  });

  it('orders operations: columns before indexes within same table', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    const target = schema([
      table('posts', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('user_id', 'INTEGER'),
        col('title', 'VARCHAR(255)'),
        col('status', 'VARCHAR(20)', { defaultValue: "'draft'" }),
      ], [
        idx('idx_posts_status', ['status']),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    const colIdx = plan.findIndex((op) => op.type === 'add_column');
    const idxIdx = plan.findIndex((op) => op.type === 'create_index');
    expect(colIdx).toBeLessThan(idxIdx);
  });

  it('executes SQL when dryRun is false', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    const target = schema([
      table('comments', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('body', 'TEXT', { nullable: true }),
      ]),
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false }),
        col('name', 'VARCHAR(100)', { nullable: false }),
      ]),
    ]);

    // Execute for real
    const plan = await adapter.migrateToSchema(target, { dryRun: false });
    await adapter.disconnect();

    // Verify the table was created
    const db = new Database(MIG_TMP_DB, { readwrite: true });
    const tables = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    db.close();
    unlinkSync(MIG_TMP_DB);

    const tableNames = tables.map((r) => r.name);
    expect(tableNames.includes('comments')).toBe(true);
    expect(plan.length).toBeGreaterThanOrEqual(1);
    expect(plan[0].type).toBe('create_table');
  });

  it('handles case-insensitive table name matching', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Target uses 'Users' (capital U) — should match current 'users'
    const target = schema([
      table('Users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        col('name', 'VARCHAR(100)', { nullable: false }),
        col('bio', 'TEXT'),
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    // Should NOT create a new table
    const creates = plan.filter((op) => op.type === 'create_table');
    expect(creates).toEqual([]);

    // Should ADD bio column
    const adds = plan.filter((op) => op.type === 'add_column');
    expect(adds.length).toBe(1);
    expect(adds[0].column).toBe('bio');
  });

  it('returns all operations with non-empty SQL strings', async () => {
    createMigDb(MIG_TMP_DB);
    const adapter = new SqliteAdapter();
    await adapter.connect(MIG_TMP_DB);

    // Target adds a table, modifies a column, drops an index
    const target = schema([
      table('comments', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('body', 'TEXT'),
      ]),
      table('users', [
        col('id', 'INTEGER', { primaryKey: true, autoIncrement: true, nullable: false }),
        col('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        col('name', 'VARCHAR(255)', { nullable: false }),  // type changed
        col('bio', 'TEXT'),  // new column
      ]),
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    await adapter.disconnect();
    unlinkSync(MIG_TMP_DB);

    expect(plan.length).toBeGreaterThan(0);
    for (const op of plan) {
      expect(op.sql).toBeTruthy();
      expect(op.sql.length).toBeGreaterThan(0);
      expect(op.table).toBeTruthy();
    }
  });
});
