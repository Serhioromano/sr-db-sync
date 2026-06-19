# sr-db-sync

> Database state is the single source of truth. Always.

[![npm version](https://img.shields.io/npm/v/sr-db-sync)](https://www.npmjs.com/package/sr-db-sync)
[![Bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun)](https://bun.sh)
[![license](https://img.shields.io/npm/l/sr-db-sync)](LICENSE)

**sr-db-sync** is a CLI utility for bidirectional conversion between a database and [DBML](https://dbml.dbdiagram.io/) (Database Markup Language). Snapshot your schema to a version-controlled text file. Apply it back — smart, minimally destructive, data-preserving.

---

## Problem

The classic approach to database migrations is fragile and accumulates technical debt:

1. **Migration files pile up.** Every schema change is a new migration file. Six months in, you have 50+ files and no single place to see the current schema.

2. **Sequential steps are brittle.** `CREATE TABLE` → `ALTER TABLE ADD COLUMN` → `ALTER TABLE MODIFY`. One failure mid-chain and the database is in an inconsistent state.

3. **Failed migration = lost bearings.** If a migration crashes halfway, you don't know what was applied and what wasn't. Recovery requires manual analysis.

4. **Sync with code is painful.** A developer changed the schema locally but forgot to write a migration. Production starts throwing "column not found" errors.

**sr-db-sync** takes a different approach.

---

## Solution

**sr-db-sync** doesn't store migration history. It works with the **final state**:

```
Current DB  →  dbs snash   →  schema.dbml   (capture state)
schema.dbml →  dbs migrate  →  DB           (bring to target)
```

### Two commands, one truth

| Command | Direction | What it does |
|---------|-----------|--------------|
| `dbs snash` | **DB → DBML** | Connects to a database, extracts the full schema (tables, columns, types, defaults, indexes, foreign keys, triggers, views, procedures) and saves it as a DBML file. |
| `dbs migrate` | **DBML → DB** | Reads a DBML file and applies the schema to a database with minimal disruption: creates missing tables, adds/drops/modifies columns, syncs indexes and foreign keys — without dropping and recreating tables. Data is preserved. |

### How migrate works

`dbs migrate` compares the current database schema against the DBML target and applies **only the differences**:

- Tables in DBML but not in DB → **CREATE TABLE**
- Tables in DB but not in DBML → left untouched (no destructive drops)
- Columns in DBML but not in DB → **ADD COLUMN**
- Columns in DB but not in DBML → **DROP COLUMN**
- Columns with changed type/settings → **ALTER MODIFY**
- Indexes and foreign keys → synced (create missing, drop extras)

No direction matters — forward, backward, cross-environment. The tool calculates the diff and executes only what's needed. The database always converges to the state described in DBML.

---

## Why DBML?

- **Visualize your schema.** Open a `.dbml` file in [dbdiagram.io](https://dbdiagram.io) or one of the few VS Code extensions and see your entire database structure as a diagram, with relationships and tables. And even Edit it that way.
- **Git for database structure.** DBML is plain text. Diff, blame, pull requests, code review — it all works. Your team can collaborate on database structure the same way they collaborate on code.
- **Single source of truth.** One DBML file = the complete database schema. No need to read 50 migration files to understand the current structure.

---

## Quick Start

> **Bun is required.** `sr-db-sync` is a **Bun-native** package — it runs on the Bun runtime. No Node.js fallback. If you don't have Bun yet, install it from [bun.sh](https://bun.sh).

### Installation

**Global install** (use `dbs` from anywhere):

```bash
bun add -g sr-db-sync
```

> **⚠️ nvm users:** Bun installs global binaries to `~/.bun/bin/`, not nvm's `~/.nvm/…/bin/`.
> Add this to your `~/.bashrc` (or `~/.zshrc`):
>
> ```bash
> export PATH="$HOME/.bun/bin:$PATH"
> ```
>
> Then `source ~/.bashrc` (or restart your terminal). `dbs` will work.

**Local install** (per-project, use via `bunx`):

```bash
bun add sr-db-sync
bunx dbs          # runs from ./node_modules/.bin/dbs
# or: npx dbs
```

### Create a profile file

Place a `.dbs.json` in your project root (or `migration/.dbs.json`):

```json
{
  "dev": {
    "dsn": "./dev.db",
    "engine": "sqlite",
    "file": "./migration/schema.dbml",
  },
  "prod": {
    "dsn": "mysql://root:root@127.0.0.1:3306/test",
    "engine": "mysql",
    "file": "./migration/schema.dbml",
    "records": "users,follows,posts"
  }
}
```

### Snapshot your database

```bash
dbs snash --profile dev
```

This creates `./migration/schema.dbml` — your schema as a readable, version-controllable text file.

### Apply schema to another database

```bash
# Preview what will change (safe, no modifications):
dbs migrate --profile prod --dry-run

# Apply the migration:
dbs migrate --profile prod
```

### Interactive mode

Just run `dbs` without a subcommand for a guided interactive experience:

```bash
dbs
```

It will ask you which command to run, let you pick a profile or configure a DSN, select tables for data snapshots, and confirm before executing. Also save as profile before run.

---

## Configuration

### `.dbs.json` profile file

Profiles can be stored in `.dbs.json` (project root) or `migration/.dbs.json` (preferred). Each profile defines a connection:

```json
{
  "profile-name": {
    "dsn": "<connection-string>",
    "engine": "sqlite | mysql",
    "prefix": "<optional-table-prefix>",
    "file": "<optional-dbml-path>",
    "records": "<optional-all-or-comma-separated-tables>"
  }
}
```

### DSN formats

| Engine | DSN format |
|--------|------------|
| SQLite | `./path/to/database.db` |
| MySQL | `mysql://user:password@host:port/database` |

### DBML file path resolution

The `--file` flag is resolved in this order of priority:
1. Explicit `--file <path>` flag
2. `file` field in the profile
3. Auto-derived from DSN → `./migration/<dbname>.dbml`

---

## Usage Reference

```
sr-db-sync v1.0.0 — Database ↔ DBML bidirectional converter

Usage:
  dbs snash    Make a snapshot of a database → DBML file
  dbs migrate  Apply DBML schema to a database (smart migration)
  dbs          Interactive mode

Common flags:
  --dsn <string>             Data Source Name (connection string)
  --engine <string>          Database engine: sqlite | mysql
  --prefix <string>          Table name prefix (optional)
  --file <path>              DBML file path: snash writes to it, migrate reads from it
                             (default: ./migration/<dbname>.dbml — derived from DSN)

Profiles:
  --profile <name>           Use a named profile from .dbs.json
  --profiles-file <path>     Path to profiles JSON file (default: .dbs.json)

Migrate flags:
  --dry-run                  Preview SQL commands without executing them
  --records <filter>          Insert Records from DBML: 'all' | 'table1,table2'

Snash flags:
  --records <filter>          Also snapshot records: 'all' | 'table1,table2'
```

---

## Programmatic API

> [!TIP]
> You can use `sr-db-sync` programmatically in your own TypeScript/JavaScript code — full API with `snash()` and `migrate()` functions, structured error handling, and type-safe SchemaIR.
>
> Need an AI agent (Copilot, Cursor, Claude Code, etc.) to do the integration for you? Just point it at **[AI.md](https://raw.githubusercontent.com/Serhioromano/sr-db-sync/refs/heads/main/AI.md)** and say: *«Read _https://raw.githubusercontent.com/Serhioromano/sr-db-sync/refs/heads/main/AI.md and help me integrate sr-db-sync into my project.»*

In addition to the CLI, you can use `sr-db-sync` as a TypeScript/JavaScript library in your own scripts, CI/CD pipelines, build systems, or custom tooling.

### Import

```typescript
import { snash, migrate, createAdapter, parseDbml, generateDbml, parseRecordsFilter } from 'sr-db-sync/api';
import type { SchemaIR, MigrationPlan, TableDefinition, ColumnDef } from 'sr-db-sync/api';
```

### `snash(options)` — Snapshot database → DBML

Extracts the full database schema and writes it to a DBML file. Returns the file path and the generated DBML content.

```typescript
import { snash } from 'sr-db-sync/api';

const { file, dbml } = await snash({
  engine: 'sqlite',          // 'sqlite' | 'mysql'
  dsn: './data/app.db',      // connection string
  file: './schema.dbml',     // output file path
  prefix: 'wp_',             // optional: strip this prefix from table names
  recordsFilter: 'all',      // optional: also snapshot data — 'all' | 'users,posts'
});

console.log(`DBML written to: ${file}`);
console.log(dbml);  // full DBML content as string
```

**Return type:**
```typescript
{ file: string; dbml: string }
```

---

### `migrate(options)` — Apply DBML → database

Reads a DBML file, compares it with the live database, and applies only the differences. In dry-run mode, returns the plan without executing SQL.

```typescript
import { migrate } from 'sr-db-sync/api';

// Always dry-run first to preview changes
const preview = await migrate({
  engine: 'sqlite',
  dsn: './data/prod.db',
  file: './schema.dbml',
  dryRun: true,              // preview only, no changes made
});

console.log(`${preview.totalOps} operations would be applied`);
console.log(preview.summary);
// → { create_table: 2, drop_column: 1, add_fk: 1 }

for (const stmt of preview.sql) {
  console.log(stmt);  // each SQL statement
}

// Then actually run it
const result = await migrate({
  engine: 'sqlite',
  dsn: './data/prod.db',
  file: './schema.dbml',
  dryRun: false,
  recordsFilter: 'all',      // optional: insert Records from DBML
});
```

**Return type:**
```typescript
{
  plan: MigrationPlan;              // full list of operations with metadata
  sql: string[];                    // SQL statements (excluding comment-only no-ops)
  summary: Record<string, number>;  // count by operation type
  totalOps: number;                 // total number of operations
}
```

Each operation in `plan` has this shape:
```typescript
{
  type: 'create_table' | 'add_column' | 'drop_column' | 'modify_column'
      | 'create_index' | 'drop_index' | 'add_fk' | 'drop_fk'
      | 'rebuild' | 'insert_records';
  sql: string;         // the SQL statement
  table?: string;      // affected table
  column?: string;     // affected column (for column operations)
}
```

---

### Error handling

All API functions throw `DbsError` on failure — they **never** call `process.exit()`. You decide how to handle errors:

```typescript
import { snash, migrate, DbsError } from 'sr-db-sync/api';

try {
  await migrate({ engine: 'sqlite', dsn: './prod.db', file: './schema.dbml' });
  console.log('Migration successful');
} catch (err) {
  if (err instanceof DbsError) {
    console.error(`[${err.code}] ${err.message}`);
    console.error(`  cause: ${err.cause}`);
    if (err.hint)  console.error(`  hint: ${err.hint}`);
    if (err.table) console.error(`  table: ${err.table}`);
    if (err.column) console.error(`  column: ${err.column}`);
    // exit code available via err.exitCode (1–5)
    process.exit(err.exitCode);
  }
  throw err;  // unexpected error — rethrow
}
```

| Error code | Exit code | When it happens |
|-----------|-----------|-----------------|
| `ENGINE` | 1 | Unsupported database engine |
| `CONNECT` | 2 | Cannot reach the database |
| `SCHEMA_READ` | 3 | Cannot read schema from database |
| `DBML_PARSE` | 3 | Invalid DBML syntax |
| `MIGRATE` | 4 | SQL execution failed |
| `DBML_WRITE` | 5 | Cannot write output file |

---

### Utility functions

```typescript
import { createAdapter, parseDbml, generateDbml, parseRecordsFilter } from 'sr-db-sync/api';

// Create an adapter for manual lifecycle control
const adapter = createAdapter('sqlite');
await adapter.connect('./app.db');
const tables = await adapter.getTables();
await adapter.disconnect();

// Parse a DBML string into structured SchemaIR
const schema: SchemaIR = parseDbml(`
  Table users {
    id INTEGER [pk, increment]
    name TEXT [not null]
  }
`);

// Convert SchemaIR back to DBML string
const dbmlStr = generateDbml(schema);

// Parse CLI-style records filter
parseRecordsFilter('all');           // → ['*']
parseRecordsFilter('users,posts');   // → ['users', 'posts']
parseRecordsFilter(undefined);       // → undefined
```

---

### Real-world example: CI pipeline

```typescript
// ci/migrate-staging.ts
import { snash, migrate } from 'sr-db-sync/api';

async function syncStaging() {
  // Step 1: Snapshot production schema
  const { file, dbml } = await snash({
    engine: 'mysql',
    dsn: process.env.PROD_DSN!,
    file: './migration/schema.dbml',
  });
  console.log(`Snapshot captured: ${file}`);

  // Step 2: Dry-run against staging
  const preview = await migrate({
    engine: 'mysql',
    dsn: process.env.STAGING_DSN!,
    file: './migration/schema.dbml',
    dryRun: true,
  });
  console.log(`Preview: ${preview.totalOps} operations`);
  console.log(preview.summary);

  // Step 3: Apply if safe
  if (preview.totalOps > 0) {
    const result = await migrate({
      engine: 'mysql',
      dsn: process.env.STAGING_DSN!,
      file: './migration/schema.dbml',
      dryRun: false,
    });
    console.log(`Applied: ${result.totalOps} operations`);
  } else {
    console.log('Staging is up to date with production.');
  }
}

syncStaging().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
```

---

### Complete export list

| Export | Kind | Description |
|--------|------|-------------|
| `snash(options)` | async function | DB → DBML file. Returns `{ file, dbml }`. |
| `migrate(options)` | async function | DBML → DB. Returns `{ plan, sql, summary, totalOps }`. |
| `createAdapter(engine)` | sync function | Creates `DatabaseAdapter` instance (`'sqlite'` or `'mysql'`). |
| `parseDbml(source)` | sync function | Parses DBML string → `SchemaIR`. |
| `generateDbml(schema, opts?)` | sync function | `SchemaIR` → DBML string. |
| `parseRecordsFilter(raw)` | sync function | Parses `'all'` / `'t1,t2'` → `string[] \| undefined`. |
| `DbsError` | class | Structured error with `code`, `cause`, `hint`, `table`, `column`, `exitCode`. |
| `SchemaIR` | type | Full schema intermediate representation. |
| `MigrationPlan` | type | `MigrationOp[]` — list of operations with SQL and metadata. |
| `TableDefinition` | type | Table schema: `{ name, columns, indexes, foreignKeys, triggers }`. |
| `ColumnDef` | type | Column: `{ name, type, nullable, primaryKey, unique, autoIncrement, defaultValue?, comment? }`. |
| `IndexDef` | type | Index: `{ name, columns, unique, type? }`. |
| `FKDef` | type | Foreign key: `{ name, columns, refTable, refColumns, onDelete?, onUpdate? }`. |
| `DatabaseAdapter` | type | Adapter interface: `connect`, `disconnect`, `migrateToSchema`, etc. |

---

## Examples

### Snapshot a database

```bash
# SQLite — simplest case
dbs snash --dsn ./my.db --engine sqlite

# With table prefix stripping (prefix won't appear in DBML)
dbs snash --dsn ./my.db --engine sqlite --prefix wp_

# MySQL
dbs snash --dsn "mysql://root:secret@localhost:3306/myapp" --engine mysql

# Using a profile
dbs snash --profile prod

# Custom output path
dbs snash --profile prod --file ./docs/schema.dbml

# Snapshot schema AND data from specific tables
dbs snash --profile dev --records "users,settings"
dbs snash --profile dev --records all
```

### Apply a migration

```bash
# Preview changes — no modifications made
dbs migrate --profile prod --dry-run

# Apply migration
dbs migrate --profile prod

# With a specific DBML file
dbs migrate --dsn "mysql://..." --engine mysql --file ./docs/schema.dbml

# Include record data from DBML
dbs migrate --profile prod --records all --dry-run
```

### Dry-run output example

When you run `dbs migrate --profile prod --dry-run`, you'll see a color-coded preview:

```
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(100)
  );

  ADD COLUMN age INTEGER DEFAULT 0       → posts

  MODIFY COLUMN email VARCHAR(320)        → users

  DROP COLUMN legacy_field                → settings

  CREATE INDEX idx_email ON users
```

---

## Supported Databases

| Engine | Snash (DB → DBML) | Migrate (DBML → DB) | Records (data) |
|--------|:-----------------:|:-------------------:|:--------------:|
| SQLite | ✅ | ✅ | ✅ |
| MySQL | ✅ | ✅ | ✅ |
| PostgreSQL | 🔮 planned | 🔮 planned | 🔮 planned |

---

## Features

- **Bidirectional sync** — snapshot schema from any supported database, apply schema to any supported database.
- **Minimally destructive migrations** — adds missing, drops extras, modifies changed columns. No table rebuilds.
- **Cross-engine portability** — snapshot from SQLite, apply to MySQL. The DBML intermediate format abstracts engine differences.
- **Data preservation** — schema changes don't touch your data. Migrations use `ALTER TABLE`, not `DROP` + `CREATE`.
- **Dry-run mode** — preview every SQL command before execution. Color-coded: green for CREATE, blue for ADD, yellow for MODIFY, red for DROP.
- **Record snapshots** — snapshot not just schema but also table data into DBML `Records` blocks. Perfect for seed data and lookup tables.
- **Interactive mode** — guided prompts for command selection, profile configuration, and confirmation.
- **Profile-based configuration** — define database connections once, reference them by name.
- **Table prefix handling** — automatically strip or add table prefixes when crossing environments.
- **DBML extensions** — database-specific features (triggers, views, procedures, engine settings, charset, collation) preserved via `// @dbs:` comments.
- **AI-friendly output** — structured error messages with codes and machine-parseable format.
- **Programmatic API** — use `snash()` and `migrate()` in TypeScript/JavaScript code. Full type safety, rich return values, structured error handling.
- **Proper exit codes** — shell-friendly: 0 = OK, 1 = config error, 2 = connection error, 3 = schema error, 4 = migration error, 5 = write error.

---

## AI.md — Documentation for AI Agents

See [AI.md](AI.md) for a comprehensive guide written specifically for AI agents (LLMs, coding assistants, CI bots). It covers all commands, flags, error codes, ANSI color scheme, output parsing strategies, and typical workflows.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick setup for development:

```bash
git clone https://github.com/Serhioromano/sr-db-sync.git
cd sr-db-sync
bun install
bun test
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
