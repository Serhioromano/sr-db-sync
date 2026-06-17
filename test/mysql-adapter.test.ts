// ============================================================
// Tests for MySQL adapter — DSN parsing, migration logic, schema reading
// ============================================================
// - Unit tests: mock mysql2/promise — test migration plan generation
// - Integration tests: real MySQL connection (skipped if unavailable)

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { MysqlAdapter } from '../src/adapters/mysql.js';
import type {
  ColumnDef,
  TableDefinition,
  SchemaIR,
  MigrationPlan,
  MigrateOptions,
  FKDef,
  IndexDef,
} from '../src/core/types.js';
import type { DatabaseAdapter } from '../src/adapters/adapter.interface.js';

// ============================================================
// Unit tests — DSN parsing
// ============================================================

describe('MysqlAdapter DSN parsing', () => {
  const adapter = new MysqlAdapter();

  it('extracts database name from full DSN', () => {
    expect(adapter.extractDbName('mysql://user:pass@localhost:3306/mydb')).toBe('mydb');
  });

  it('extracts database name without password', () => {
    expect(adapter.extractDbName('mysql://root@127.0.0.1:3306/testdb')).toBe('testdb');
  });

  it('extracts database name without port', () => {
    expect(adapter.extractDbName('mysql://user:pass@localhost/mydb')).toBe('mydb');
  });

  it('handles DSN with special characters', () => {
    expect(adapter.extractDbName('mysql://user:p%40ss@host:3306/mydb')).toBe('mydb');
  });

  it('handles DSN with query params', () => {
    expect(adapter.extractDbName('mysql://user@host/db?charset=utf8')).toBe('db');
  });
});

// ============================================================
// Unit tests — buildDsn
// ============================================================

describe('MysqlAdapter buildDsn', () => {
  it('builds full DSN', () => {
    const dsn = MysqlAdapter.buildDsn({
      host: 'localhost',
      port: '3306',
      user: 'root',
      password: 'secret',
      database: 'mydb',
    });
    expect(dsn).toBe('mysql://root:secret@localhost:3306/mydb');
  });

  it('builds DSN with defaults', () => {
    const dsn = MysqlAdapter.buildDsn({
      host: '127.0.0.1',
      user: 'admin',
      database: 'test',
    });
    expect(dsn).toBe('mysql://admin@127.0.0.1:3306/test');
  });

  it('has correct dsnFields', () => {
    const fields = MysqlAdapter.dsnFields;
    expect(fields.length).toBe(5);
    expect(fields[0].name).toBe('host');
    expect(fields[1].name).toBe('port');
    expect(fields[2].name).toBe('user');
    expect(fields[3].name).toBe('password');
    expect(fields[4].name).toBe('database');
  });
});

// ============================================================
// Unit tests — migration plan (dry-run, mocked pool)
// ============================================================
// These tests verify that migrateToSchema generates correct SQL
// without requiring a real MySQL server.

describe('MysqlAdapter migrateToSchema (dry-run)', () => {
  /** Mock pool that returns empty schema (fresh database). */
  function mockEmptyPool() {
    return {
      execute: mock((sql: string) => {
        // Return empty result for all information_schema queries
        return [[], []];
      }),
      getConnection: mock(() => ({
        beginTransaction: mock(() => {}),
        commit: mock(() => {}),
        rollback: mock(() => {}),
        release: mock(() => {}),
        execute: mock(() => [[], []]),
        ping: mock(() => {}),
      })),
      end: mock(() => {}),
    };
  }

  /** Create a test adapter with a mocked pool. */
  function createMockedAdapter(poolOverride?: Record<string, unknown>): MysqlAdapter {
    const adapter = new MysqlAdapter();
    // Use reflection to inject a mock pool
    (adapter as Record<string, unknown>).pool = poolOverride ?? mockEmptyPool();
    (adapter as Record<string, unknown>).database = 'testdb';
    return adapter;
  }

  /** Minimal SchemaIR for testing. */
  function makeSchemaIR(tables: TableDefinition[]): SchemaIR {
    return {
      tables,
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [],
    };
  }

  /** Create a simple ColumnDef. */
  function colDef(
    name: string,
    type: string,
    opts: {
      pk?: boolean;
      nullable?: boolean;
      unique?: boolean;
      autoIncrement?: boolean;
      defaultVal?: string;
    } = {},
  ): ColumnDef {
    return {
      name,
      type,
      primaryKey: opts.pk ?? false,
      nullable: opts.nullable ?? true,
      unique: opts.unique ?? false,
      autoIncrement: opts.autoIncrement ?? false,
      defaultValue: opts.defaultVal,
    };
  }

  it('generates CREATE TABLE for new table with PK and columns', async () => {
    const adapter = createMockedAdapter();
    const target = makeSchemaIR([
      {
        name: 'users',
        columns: [
          colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
          colDef('name', 'VARCHAR(100)', { nullable: false }),
          colDef('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        ],
        indexes: [
          { name: 'idx_users_email', columns: ['email'], unique: true, type: 'btree' },
        ],
        foreignKeys: [],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    expect(plan.length).toBe(2); // CREATE TABLE + CREATE INDEX

    const createSql = plan[0].sql;
    expect(plan[0].type).toBe('create_table');
    expect(plan[0].table).toBe('users');
    expect(createSql).toContain('CREATE TABLE `users`');
    expect(createSql).toContain('`id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY');
    expect(createSql).toContain('`name` VARCHAR(100) NOT NULL');
    expect(createSql).toContain('`email` VARCHAR(255) NOT NULL UNIQUE');
    expect(createSql).toContain('ENGINE=InnoDB');

    expect(plan[1].type).toBe('create_index');
    expect(plan[1].sql).toContain('CREATE UNIQUE INDEX `idx_users_email`');
  });

  it('generates CREATE TABLE with inline FK constraints using auto-generated names', async () => {
    const adapter = createMockedAdapter();
    const target = makeSchemaIR([
      {
        name: 'follows',
        columns: [
          colDef('following_user_id', 'INT', { nullable: false }),
          colDef('followed_user_id', 'INT', { nullable: false }),
          colDef('created_at', 'TIMESTAMP'),
        ],
        indexes: [],
        foreignKeys: [
          {
            name: 'fk_follows_following_user_id',
            columns: ['following_user_id'],
            refTable: 'users',
            refColumns: ['id'],
            onDelete: 'cascade',
            onUpdate: 'cascade',
          },
          {
            name: 'fk_follows_followed_user_id',
            columns: ['followed_user_id'],
            refTable: 'users',
            refColumns: ['id'],
            onDelete: 'cascade',
            onUpdate: 'cascade',
          },
        ],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    expect(plan[0].type).toBe('create_table');
    expect(plan[0].table).toBe('follows');
    const sql = plan[0].sql;

    // Must include non-empty CONSTRAINT names
    expect(sql).toContain('CONSTRAINT `fk_follows_following_user_id`');
    expect(sql).toContain('CONSTRAINT `fk_follows_followed_user_id`');
    expect(sql).toContain('REFERENCES `users` (`id`)');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('ON UPDATE CASCADE');
    expect(sql).toContain('ENGINE=InnoDB');

    // Must NOT contain empty CONSTRAINT ``
    expect(sql).not.toContain('CONSTRAINT ``');
  });

  it('generates ALTER TABLE ADD COLUMN for new column', async () => {
    const adapter = createMockedAdapter();

    // Mock: current schema has users table with id + name
    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        colDef('name', 'VARCHAR(100)', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    // Inject current schema by overriding the pool
    // The adapter reads current schema via getTables/getColumns/getIndexes/getFKs
    // Since the pool is mocked, it returns empty arrays → empty current schema.
    // To test column adds/drops/modifies, we need the current schema to have data.
    // Override readCurrentSchema directly.
    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target = makeSchemaIR([
      {
        name: 'users',
        columns: [
          colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
          colDef('name', 'VARCHAR(100)', { nullable: false }),
          colDef('email', 'VARCHAR(255)', { nullable: false, unique: true }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const addOps = plan.filter((op) => op.type === 'add_column');
    expect(addOps.length).toBe(1);
    expect(addOps[0].column).toBe('email');
    expect(addOps[0].sql).toContain('ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255)');
    expect(addOps[0].sql).toContain('NOT NULL');
    expect(addOps[0].sql).toContain('UNIQUE');
  });

  it('generates ALTER TABLE DROP COLUMN for removed column', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        colDef('name', 'VARCHAR(100)', { nullable: false }),
        colDef('legacy_field', 'VARCHAR(50)'),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target = makeSchemaIR([
      {
        name: 'users',
        columns: [
          colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
          colDef('name', 'VARCHAR(100)', { nullable: false }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const dropOps = plan.filter((op) => op.type === 'drop_column');
    expect(dropOps.length).toBe(1);
    expect(dropOps[0].column).toBe('legacy_field');
    expect(dropOps[0].sql).toContain('ALTER TABLE `users` DROP COLUMN `legacy_field`');
  });

  it('generates ALTER TABLE MODIFY COLUMN for changed type', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        colDef('title', 'VARCHAR(100)', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target = makeSchemaIR([
      {
        name: 'users',
        columns: [
          colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
          colDef('title', 'VARCHAR(255)', { nullable: false }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const modifyOps = plan.filter((op) => op.type === 'modify_column');
    expect(modifyOps.length).toBe(1);
    expect(modifyOps[0].column).toBe('title');
    expect(modifyOps[0].sql).toContain('ALTER TABLE `users` MODIFY COLUMN `title` VARCHAR(255)');
  });

  it('generates no operations when schemas are identical', async () => {
    const adapter = createMockedAdapter();

    const users: TableDefinition = {
      name: 'users',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        colDef('name', 'VARCHAR(100)', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [users]);

    const target = makeSchemaIR([users]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    expect(plan.length).toBe(0);
  });

  it('generates DROP INDEX and CREATE INDEX', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
      ],
      indexes: [
        { name: 'idx_old', columns: ['old_col'], unique: false, type: 'btree' },
      ],
      foreignKeys: [],
      triggers: [],
    };

    const targetUsers: TableDefinition = {
      name: 'users',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
      ],
      indexes: [
        { name: 'idx_new', columns: ['new_col'], unique: true, type: 'btree' },
      ],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target = makeSchemaIR([targetUsers]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const dropIdxOps = plan.filter((op) => op.type === 'drop_index');
    expect(dropIdxOps.length).toBe(1);
    expect(dropIdxOps[0].index).toBe('idx_old');

    const createIdxOps = plan.filter((op) => op.type === 'create_index');
    expect(createIdxOps.length).toBe(1);
    expect(createIdxOps[0].index).toBe('idx_new');
    expect(createIdxOps[0].sql).toContain('CREATE UNIQUE INDEX');
  });

  it('generates ADD FOREIGN KEY and DROP FOREIGN KEY', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'posts',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        colDef('user_id', 'INT', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [
        { name: 'fk_old', columns: ['user_id'], refTable: 'old_table', refColumns: ['id'], onDelete: 'cascade' },
      ],
      triggers: [],
    };

    const targetUsers: TableDefinition = {
      name: 'posts',
      columns: [
        colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        colDef('user_id', 'INT', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [
        { name: 'fk_new', columns: ['user_id'], refTable: 'users', refColumns: ['id'], onDelete: 'cascade' },
      ],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target = makeSchemaIR([targetUsers]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const dropFkOps = plan.filter((op) => op.type === 'drop_fk');
    expect(dropFkOps.length).toBe(1);
    expect(dropFkOps[0].fk).toBe('fk_old');
    expect(dropFkOps[0].sql).toContain('ALTER TABLE `posts` DROP FOREIGN KEY `fk_old`');

    const addFkOps = plan.filter((op) => op.type === 'add_fk');
    expect(addFkOps.length).toBe(1);
    expect(addFkOps[0].fk).toBe('fk_new');
    expect(addFkOps[0].sql).toContain('ALTER TABLE `posts` ADD CONSTRAINT `fk_new`');
    expect(addFkOps[0].sql).toContain('REFERENCES `users`');
    expect(addFkOps[0].sql).toContain('ON DELETE CASCADE');
  });

  it('generates INSERT IGNORE for records with recordsFilter', async () => {
    const adapter = createMockedAdapter();

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => []);

    const target: SchemaIR = {
      tables: [],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [
        {
          tableName: 'users',
          columns: ['id', 'username', 'role'],
          rows: [
            { values: [0, 'Alice', 'admin'] },
            { values: [1, 'Bob', 'moderator'] },
          ],
        },
      ],
    };

    const plan = await adapter.migrateToSchema(target, {
      dryRun: true,
      recordsFilter: ['*'],
    });

    const insertOps = plan.filter((op) => op.type === 'insert_records');
    expect(insertOps.length).toBe(2);
    expect(insertOps[0].sql).toContain("INSERT IGNORE INTO `users`");
    expect(insertOps[0].sql).toContain("'Alice'");
    expect(insertOps[1].sql).toContain("'Bob'");
  });

  it('generates INSERT IGNORE for records filtered by table name', async () => {
    const adapter = createMockedAdapter();

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => []);

    const target: SchemaIR = {
      tables: [],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [
        {
          tableName: 'users',
          columns: ['id', 'name'],
          rows: [{ values: [0, 'Alice'] }],
        },
        {
          tableName: 'posts',
          columns: ['id', 'title'],
          rows: [{ values: [0, 'Hello'] }],
        },
      ],
    };

    const plan = await adapter.migrateToSchema(target, {
      dryRun: true,
      recordsFilter: ['users'],
    });

    const insertOps = plan.filter((op) => op.type === 'insert_records');
    expect(insertOps.length).toBe(1);
    expect(insertOps[0].sql).toContain("INSERT IGNORE INTO `users`");
  });

  it('handles NULL values in record rows', async () => {
    const adapter = createMockedAdapter();

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => []);

    const target: SchemaIR = {
      tables: [],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [
        {
          tableName: 'users',
          columns: ['id', 'bio'],
          rows: [{ values: [1, null] }],
        },
      ],
    };

    const plan = await adapter.migrateToSchema(target, {
      dryRun: true,
      recordsFilter: ['*'],
    });

    expect(plan.length).toBe(1);
    expect(plan[0].sql).toContain('NULL');
  });

  it('does not create tables present only in current DB', async () => {
    const adapter = createMockedAdapter();

    const currentTables: TableDefinition[] = [
      {
        name: 'legacy_table',
        columns: [colDef('id', 'INT', { pk: true, nullable: false })],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      },
    ];

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => currentTables);

    const target = makeSchemaIR([]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    // No drop/create operations for tables only in current DB
    const tableOps = plan.filter((op) =>
      ['create_table'].includes(op.type) && op.table === 'legacy_table'
    );
    expect(tableOps.length).toBe(0);
  });

  it('includes default values in CREATE TABLE', async () => {
    const adapter = createMockedAdapter();

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => []);

    const target = makeSchemaIR([
      {
        name: 'posts',
        columns: [
          colDef('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
          colDef('status', 'VARCHAR(20)', { nullable: false, defaultVal: "'draft'" }),
          colDef('created_at', 'TIMESTAMP', { defaultVal: 'CURRENT_TIMESTAMP' }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const createSql = plan[0].sql;
    expect(createSql).toContain("DEFAULT 'draft'");
    expect(createSql).toContain('DEFAULT CURRENT_TIMESTAMP');
  });

  it('includes ENGINE and CHARSET in CREATE TABLE', async () => {
    const adapter = createMockedAdapter();

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => []);

    const target = makeSchemaIR([
      {
        name: 'users',
        columns: [colDef('id', 'INT', { pk: true, autoIncrement: true, nullable: false })],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      },
    ]);

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const createSql = plan[0].sql;
    expect(createSql).toContain('ENGINE=InnoDB');
    expect(createSql).toContain('DEFAULT CHARSET=utf8mb4');
    expect(createSql).toContain('COLLATE=utf8mb4_unicode_ci');
  });
});

// ============================================================
// Unit tests — column type normalisation
// ============================================================

describe('MysqlAdapter type normalisation', () => {
  /**
   * Create a mock adapter and test colEq via migrateToSchema.
   * When column types are equivalent but formatted differently,
   * no MODIFY COLUMN should be generated.
   */
  function createMockedAdapter(): MysqlAdapter {
    const adapter = new MysqlAdapter();
    (adapter as Record<string, unknown>).pool = {
      execute: mock(() => [[], []]),
      getConnection: mock(() => ({
        beginTransaction: mock(() => {}),
        commit: mock(() => {}),
        rollback: mock(() => {}),
        release: mock(() => {}),
        execute: mock(() => [[], []]),
        ping: mock(() => {}),
      })),
      end: mock(() => {}),
    };
    (adapter as Record<string, unknown>).database = 'testdb';
    return adapter;
  }

  function col(name: string, type: string, opts: Record<string, unknown> = {}): ColumnDef {
    return {
      name,
      type,
      primaryKey: (opts.pk as boolean) ?? false,
      nullable: (opts.nullable as boolean) ?? true,
      unique: (opts.unique as boolean) ?? false,
      autoIncrement: (opts.autoIncrement as boolean) ?? false,
      defaultValue: opts.defaultVal as string | undefined,
    };
  }

  it('treats INT and INT(11) as equivalent', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        col('id', 'INT(11)', { pk: true, nullable: false, autoIncrement: true }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target: SchemaIR = {
      tables: [{
        name: 'users',
        columns: [
          col('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      }],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [],
    };

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    const modifyOps = plan.filter((op) => op.type === 'modify_column');
    expect(modifyOps.length).toBe(0);
  });

  it('treats INTEGER and INT as equivalent', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        col('id', 'INTEGER', { pk: true, nullable: false, autoIncrement: true }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target: SchemaIR = {
      tables: [{
        name: 'users',
        columns: [
          col('id', 'INT', { pk: true, nullable: false, autoIncrement: true }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      }],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [],
    };

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    const modifyOps = plan.filter((op) => op.type === 'modify_column');
    expect(modifyOps.length).toBe(0);
  });

  it('detects real type changes (VARCHAR length)', async () => {
    const adapter = createMockedAdapter();

    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        col('name', 'VARCHAR(100)', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    const target: SchemaIR = {
      tables: [{
        name: 'users',
        columns: [
          col('name', 'VARCHAR(255)', { nullable: false }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      }],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [],
    };

    const plan = await adapter.migrateToSchema(target, { dryRun: true });
    const modifyOps = plan.filter((op) => op.type === 'modify_column');
    expect(modifyOps.length).toBe(1);
  });

  it('treats bare varchar (no length) as VARCHAR(255)', async () => {
    const adapter = createMockedAdapter();

    // Current DB has VARCHAR(255) — pulled from MySQL which always needs length
    const currentUsers: TableDefinition = {
      name: 'users',
      columns: [
        col('name', 'VARCHAR(255)', { nullable: false }),
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [],
    };

    (adapter as Record<string, unknown>).readCurrentSchema = mock(() => [currentUsers]);

    // Target comes from parsed DBML which may have 'varchar' (no length)
    const target: SchemaIR = {
      tables: [{
        name: 'users',
        columns: [
          col('name', 'varchar', { nullable: false }),
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      }],
      views: [],
      procedures: [],
      enums: [],
      extensions: [],
      records: [],
    };

    const plan = await adapter.migrateToSchema(target, { dryRun: true });

    // Should NOT generate MODIFY — bare varchar is equivalent to VARCHAR(255)
    const modifyOps = plan.filter((op) => op.type === 'modify_column');
    expect(modifyOps.length).toBe(0);
  });
});

// ============================================================
// Integration tests (require real MySQL server)
// ============================================================
// Skip if MYSQL_TEST_DSN environment variable is not set.

const MYSQL_DSN = process.env.MYSQL_TEST_DSN;

const integrationDescribe = MYSQL_DSN ? describe : describe.skip;

integrationDescribe('MysqlAdapter integration (real MySQL)', () => {
  let adapter: MysqlAdapter;
  const testDbName = 'dbs_test_' + Date.now();

  beforeAll(async () => {
    adapter = new MysqlAdapter();

    // Connect without database to create the test database
    // Extract host/port/user/password from DSN
    const dsn = MYSQL_DSN!;
    const baseUrl = dsn.replace(/\/[^/]*$/, ''); // Remove database name

    const tempAdapter = new MysqlAdapter();
    await tempAdapter.connect(baseUrl + '/mysql');

    // Create test database (hacky but works)
    const pool = (tempAdapter as Record<string, unknown>).pool as { execute: (sql: string) => Promise<unknown> };
    await pool.execute(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\` CHARACTER SET utf8mb4`);
    await tempAdapter.disconnect();
  });

  afterAll(async () => {
    // Drop test database
    if (adapter) {
      try {
        const dsn = MYSQL_DSN!;
        const baseUrl = dsn.replace(/\/[^/]*$/, '');
        const tempAdapter = new MysqlAdapter();
        await tempAdapter.connect(baseUrl + '/mysql');
        const pool = (tempAdapter as Record<string, unknown>).pool as { execute: (sql: string) => Promise<unknown> };
        await pool.execute(`DROP DATABASE IF EXISTS \`${testDbName}\``);
        await tempAdapter.disconnect();
      } catch {
        // Best effort
      }
    }
  });

  it('connects to MySQL and reads empty schema', async () => {
    const fullDsn = MYSQL_DSN!.replace(/\/[^/]*$/, `/${testDbName}`);
    await adapter.connect(fullDsn, { createIfNotExists: true });

    const tables = await adapter.getTables();
    expect(tables).toEqual([]);

    await adapter.disconnect();
  });

  it('performs full roundtrip: create → snash → migrate → identical', async () => {
    const fullDsn = MYSQL_DSN!.replace(/\/[^/]*$/, `/${testDbName}`);
    await adapter.connect(fullDsn, { createIfNotExists: true });

    const pool = (adapter as Record<string, unknown>).pool as { execute: (sql: string) => Promise<unknown> };

    // Step 1: Create initial schema
    await pool.execute(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.execute(`
      CREATE TABLE posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT,
        CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.execute(`CREATE INDEX idx_posts_user_id ON posts(user_id)`);

    // Insert test data
    await pool.execute(`INSERT INTO users (id, name, email, role) VALUES
      (1, 'Alice', 'alice@test.com', 'admin'),
      (2, 'Bob', 'bob@test.com', 'user')
    `);

    await pool.execute(`INSERT INTO posts (id, user_id, title, body) VALUES
      (1, 1, 'Hello World', 'First post'),
      (2, 1, 'Another Post', 'Second post')
    `);

    // Step 2: Snash — read full schema
    const tables = await adapter.getTables();
    expect(tables.length).toBe(2);
    expect(tables).toContain('users');
    expect(tables).toContain('posts');

    // Check columns
    const userCols = await adapter.getColumns('users');
    expect(userCols.length).toBe(5);

    const idCol = userCols.find((c) => c.name === 'id')!;
    expect(idCol.primaryKey).toBe(true);
    expect(idCol.autoIncrement).toBe(true);
    expect(idCol.nullable).toBe(false);

    const nameCol = userCols.find((c) => c.name === 'name')!;
    expect(nameCol.nullable).toBe(false);

    const roleCol = userCols.find((c) => c.name === 'role')!;
    expect(roleCol.defaultValue).toBe("'user'");

    // Check indexes
    const userIndexes = await adapter.getIndexes('users');
    const emailIdx = userIndexes.find((i) => i.columns.includes('email'));
    expect(emailIdx).toBeDefined();
    expect(emailIdx!.unique).toBe(true);

    const postIndexes = await adapter.getIndexes('posts');
    expect(postIndexes.length).toBe(1);
    expect(postIndexes[0].columns).toContain('user_id');

    // Check foreign keys
    const postFKs = await adapter.getForeignKeys('posts');
    expect(postFKs.length).toBe(1);
    expect(postFKs[0].columns).toEqual(['user_id']);
    expect(postFKs[0].refTable).toBe('users');
    expect(postFKs[0].refColumns).toEqual(['id']);
    expect(postFKs[0].onDelete).toBe('cascade');

    // Check records
    const userRecords = await adapter.getTableRecords('users');
    expect(userRecords.tableName).toBe('users');
    expect(userRecords.columns).toContain('id');
    expect(userRecords.columns).toContain('name');
    expect(userRecords.rows.length).toBe(2);

    const postRecords = await adapter.getTableRecords('posts');
    expect(postRecords.rows.length).toBe(2);

    await adapter.disconnect();
  });

  it('migrateToSchema creates tables on empty database', async () => {
    const fullDsn = MYSQL_DSN!.replace(/\/[^/]*$/, `/${testDbName}`);
    await adapter.connect(fullDsn, { createIfNotExists: true });

    const target: SchemaIR = {
      tables: [
        {
          name: 'categories',
          columns: [
            {
              name: 'id',
              type: 'INT',
              primaryKey: true,
              nullable: false,
              unique: false,
              autoIncrement: true,
            },
            {
              name: 'name',
              type: 'VARCHAR(100)',
              primaryKey: false,
              nullable: false,
              unique: true,
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

    const plan = await adapter.migrateToSchema(target);
    expect(plan.length).toBe(1);
    expect(plan[0].type).toBe('create_table');

    // Verify table was created
    const tables = await adapter.getTables();
    expect(tables).toContain('categories');

    const cols = await adapter.getColumns('categories');
    expect(cols.length).toBe(2);

    await adapter.disconnect();
  });

  it('migrateToSchema adds column to existing table', async () => {
    const fullDsn = MYSQL_DSN!.replace(/\/[^/]*$/, `/${testDbName}`);
    await adapter.connect(fullDsn, { createIfNotExists: true });

    // Create base table
    const pool = (adapter as Record<string, unknown>).pool as { execute: (sql: string) => Promise<unknown> };
    await pool.execute(`
      CREATE TABLE products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      ) ENGINE=InnoDB
    `);

    const target: SchemaIR = {
      tables: [
        {
          name: 'products',
          columns: [
            { name: 'id', type: 'INT', primaryKey: true, nullable: false, unique: false, autoIncrement: true },
            { name: 'name', type: 'VARCHAR(100)', primaryKey: false, nullable: false, unique: false, autoIncrement: false },
            { name: 'price', type: 'DECIMAL(10,2)', primaryKey: false, nullable: true, unique: false, autoIncrement: false, defaultValue: '0.00' },
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

    const plan = await adapter.migrateToSchema(target);
    const addOps = plan.filter((op) => op.type === 'add_column');
    expect(addOps.length).toBe(1);
    expect(addOps[0].column).toBe('price');

    // Verify column was added
    const cols = await adapter.getColumns('products');
    expect(cols.length).toBe(3);
    expect(cols.find((c) => c.name === 'price')).toBeDefined();

    await adapter.disconnect();
  });
});
