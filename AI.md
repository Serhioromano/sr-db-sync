# AI Guide: sr-db-sync

> Read this to use `sr-db-sync` effectively as an AI agent.
> The CLI binary is `dbs`. Every command prints an `EXIT OK` or `EXIT ERROR` line — always scan for these.

---

## Overview

`sr-db-sync` is a CLI utility for **bidirectional sync** between databases and DBML (Database Markup Language).

```
dbs snash    →  Database  →  DBML file   (export schema + optional data)
dbs migrate  →  DBML file  →  Database   (smart diff + apply minimal DDL)
dbs          →  Interactive guided mode
```

## Quick Install

```bash
npm install -g sr-db-sync
```

Requires: **Bun** runtime (or Node 18+). The package bundles a compiled binary at `dist/index.js`.

---

## Commands

### `dbs snash` — Export database to DBML

```
dbs snash --dsn <string> --engine <sqlite|mysql> [--prefix <string>] [--file <path>] [--records <filter>]
dbs snash --profile <name> [--profiles-file <path>] [--file <path>] [--records <filter>]
```

| Flag | Type | Description |
|------|------|-------------|
| `--dsn` | string | Data Source Name (connection string) |
| `--engine` | string | `sqlite` or `mysql` |
| `--prefix` | string | Table name prefix filter (optional) |
| `--file` | string | Output DBML path (default: `./migration/<dbname>.dbml` — auto-derived from DSN) |
| `--profile` | string | Use a named profile from `.dbs.json` |
| `--profiles-file` | string | Path to profiles JSON file (default: auto-discovered) |
| `--records` | string | Also export table data: `all` or `table1,table2,...` |

**Success output:**
```
EXIT OK [schema written to ./migration/mydb.dbml]
```

**What's extracted:** tables, columns (type, nullable, defaults, PK), indexes, foreign keys, triggers, views, stored procedures, enums, and optional row data (Records blocks).

---

### `dbs migrate` — Apply DBML to database

```
dbs migrate --dsn <string> --engine <sqlite|mysql> [--prefix <string>] [--file <path>] [--dry-run]
dbs migrate --profile <name> [--profiles-file <path>] [--file <path>] [--dry-run] [--records <filter>]
```

| Flag | Type | Description |
|------|------|-------------|
| `--dsn` | string | Data Source Name |
| `--engine` | string | `sqlite` or `mysql` |
| `--prefix` | string | Table name prefix filter |
| `--file` | string | Input DBML path (default: `./migration/<dbname>.dbml`) |
| `--dry-run` | bool | Preview SQL without executing (**always use this first**) |
| `--profile` | string | Named profile from `.dbs.json` |
| `--profiles-file` | string | Path to profiles JSON |
| `--records` | string | Insert Records from DBML: `all` or `table1,table2,...` |

**Success output (`--dry-run`):**
```
🧪 DRY RUN — SQL-команды НЕ будут выполнены:
  <color-coded SQL preview>
EXIT OK [dry-run: 5 operations previewed]
```

**Success output (real execution):**
```
🚀 Выполняю миграцию...
  ✓ <color-coded SQL with checkmarks>
✅ Миграция завершена: 5 операций выполнено успешно
EXIT OK [migration completed: 5 operations]
```

---

### `dbs` — Interactive mode

```bash
dbs          # Guided: select command → configure → confirm → execute
dbs --help   # Print usage
dbs --version # Print version
```

No subcommand triggers the interactive flow: choose Snash or Migrate, then pick a profile or enter DSN manually. Also prompts to save settings as a new profile.

When the first argument is an unknown command or a flag without a subcommand, you get:
```
ERROR [CONFIG] Unknown command: <cmd>
  hint: Use "dbs snash" or "dbs migrate"
  hint: Run "dbs --help" for usage information
```

---

## Configuration: `.dbs.json` Profiles

Profiles are stored in a JSON file. Discovery order:

1. `migration/.dbs.json` (preferred)
2. `.dbs.json` (project root)

Override with `--profiles-file <path>`.

### Schema

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

### Example

```json
{
  "dev": {
    "dsn": "./data/dev.sqlite",
    "engine": "sqlite"
  },
  "prod": {
    "dsn": "mysql://user:password@db.example.com:3306/myapp_production",
    "engine": "mysql",
    "prefix": "mypref_",
    "records": "all"
  }
}
```

### DSN Formats

| Engine | DSN Format | Example |
|--------|-----------|---------|
| SQLite | File path (relative or absolute) | `./data/dev.sqlite`, `:memory:` |
| MySQL | URL | `mysql://user:password@host:port/database` |

---

## ANSI Color Scheme (migrate output)

| Color | ANSI Code | Operation Types |
|-------|-----------|----------------|
| 🟢 Green | `\x1b[32m` | `CREATE TABLE`, `CREATE INDEX` |
| 🔵 Blue | `\x1b[34m` | `ADD COLUMN`, `ADD FOREIGN KEY`, `INSERT RECORDS` |
| 🟡 Yellow | `\x1b[33m` | `MODIFY COLUMN`, `REBUILD` |
| 🔴 Red | `\x1b[31m` | `DROP COLUMN`, `DROP INDEX`, `DROP FOREIGN KEY` |
| ⚫ Gray | `\x1b[90m` | SQL comments (`-- ...`) |
| **Bold** | `\x1b[1m` | SQL keywords (CREATE, TABLE, ALTER, etc.) |

When parsing output programmatically, **strip ANSI sequences**: `s/\x1b\[[0-9;]*m//g`.

---

## Output Format — AI Contract

Every execution ends with **exactly one** of these lines:

```
EXIT OK [<details>]               ← success (always stdout)
ERROR [<code>] <message>          ← failure header (stderr), followed by structured fields
```

### Structured Error Format (stderr)

```
ERROR [<code>] <human-readable message>
  engine: <value>          ← always present
  dsn: <value>             ← always present
  file: <path>             ← if relevant
  line: <number>           ← if DBML parse error
  operation: <sql>         ← if migration error
  table: <name>            ← if migration error
  column: <name>           ← if migration error
  cause: <root cause>      ← always present
  hint: <suggestion>       ← always present
```

**Parsing strategy for AI agents:**
1. Scan stdout for `EXIT OK [.*]` → if found, success.
2. Scan stderr for `ERROR \[([A-Z_]+)\]` → extract code.
3. Parse the YAML-like indented fields below the ERROR line for rich diagnostics.
4. Use exit code for quick categorization (see table below).

---

## Error Codes & Exit Codes

| Code | Exit | Meaning | Typical Fix |
|------|------|---------|-------------|
| `CONFIG` | 1 | Bad/missing `.dbs.json`, invalid JSON, missing profile | Check profiles file exists, is valid JSON, and profile is defined |
| `ENGINE` | 1 | Unsupported `--engine` value or adapter not implemented | Use `sqlite` or `mysql` |
| `CONNECT` | 2 | Cannot reach database | Check DSN, host, port, credentials, database is running |
| `SCHEMA_READ` | 3 | Cannot read schema from database | Check permissions, DB accessibility |
| `DBML_PARSE` | 3 | Invalid DBML syntax | Fix the `.dbml` file — check `line` and `cause` fields |
| `DBML_WRITE` | 5 | Cannot write output file | Check disk space, directory permissions |
| `MIGRATE` | 4 | SQL execution failed | Check `operation`, `table`, `column` fields in error |
| `TRANSACTION` | 4 | Commit/rollback failed | Check DB state, retry |

Additional warning lines may appear on stderr (non-fatal):
```
WARN [DISCONNECT] Failed to disconnect cleanly: <reason>
WARN [<code>] <message>
```

---

## Migration Behavior — Key Rules

1. **Tables NOT in DBML are never dropped.** Only tables present in DBML are compared.
2. **`DROP COLUMN` operations** are highlighted in red with `⚠️` prefix.
3. **The adapter does all the work** — no intermediate differ layer. Each adapter (`SqliteAdapter`, `MysqlAdapter`) reads the live schema, diffs against the DBML target, and generates engine-specific SQL.
4. **For SQLite:** column modifications may require a table rebuild (create new table → copy data → drop old → rename). This is shown as `↻ REBUILD`.
5. **For MySQL:** uses native `ALTER TABLE MODIFY COLUMN` and `ADD/DROP FOREIGN KEY` (no table rebuild).
6. **DBML `@dbs:` comments** preserve engine-specific metadata (auto-increment, character sets, collations, etc.) through roundtrips.

---

## `--records` Flag — Table Data

Both `snash` and `migrate` support the `--records` flag:

| Value | Meaning |
|-------|---------|
| *(not set)* | No record processing (schema only) |
| `all` | Process records for every table |
| `table1,table2,...` | Process records for specific tables only |

- **In snash:** extracts all rows from listed tables and writes `Records <table>(<cols>) { <values> }` blocks into the DBML.
- **In migrate:** reads `Records` blocks from DBML and inserts them into the database.
- **In `.dbs.json` profiles:** stored as a string field: `"records": "all"` or `"records": "users,settings"`.

---

## Default DBML Path Resolution

When `--file` is not provided, the DBML path is auto-derived from the DSN:

1. The adapter's `extractDbName(dsn)` method extracts a database name:
   - **SQLite:** filename without extension (e.g., `./data/dev.sqlite` → `dev`)
   - **MySQL:** last path segment of the URL (e.g., `mysql://.../myapp` → `myapp`)
2. The default path becomes: `./migration/<dbname>.dbml`

You can also set `"file"` in the profile to override this.

---

## Supported Databases

| Engine | Snash (DB → DBML) | Migrate (DBML → DB) | Records (data) |
|--------|:-----------------:|:-------------------:|:--------------:|
| SQLite | ✅ | ✅ | ✅ |
| MySQL | ✅ | ✅ | ✅ |
| PostgreSQL | 🔮 planned | 🔮 planned | 🔮 planned |

---

## Typical Workflows

### Workflow 1: Initial schema snapshot
```bash
dbs snash --dsn ./dev.db --engine sqlite
# → Creates ./migration/dev.dbml
# Commit dev.dbml to version control
```

### Workflow 2: Safe migration (always dry-run first!)
```bash
dbs migrate --profile prod --dry-run
# Review the color-coded SQL output. If OK:
dbs migrate --profile prod
```

### Workflow 3: Sync dev → staging via DBML
```bash
dbs snash --profile dev --file ./dev-schema.dbml
dbs migrate --profile staging --file ./dev-schema.dbml --dry-run
# If dry-run looks good:
dbs migrate --profile staging --file ./dev-schema.dbml
```

### Workflow 4: Snapshot with data
```bash
dbs snash --dsn ./dev.db --engine sqlite --records all
# Creates DBML file with schema + Records blocks for every table
```

### Workflow 5: Diagnose errors
```bash
# Step 1: Check config
cat migration/.dbs.json | python -m json.tool

# Step 2: Test connection
dbs snash --profile prod
# → EXIT OK [...] → connection works
# → ERROR [CONNECT] ... → fix DSN, host, port, or credentials

# Step 3: Parse structured error output
# Look for: ERROR [CODE], cause, hint fields
# Use exit code for quick categorization
```

### Workflow 6: Interactive guided mode
```bash
dbs
# → Choose Snash or Migrate
# → Pick a profile or configure DSN manually
# → Select tables for records (None / All / pick specific)
# → Confirm and optionally save as profile
# → Execute
```

---

## Programmatic API (TypeScript/JavaScript)

The package also exposes a programmatic API at `sr-db-sync/api`. All functions throw `DbsError` on failure — **never** `process.exit()`. The caller owns error handling and process lifecycle.

### Import

```typescript
// All imports come from 'sr-db-sync/api'
import {
  snash, migrate, createAdapter,
  parseDbml, generateDbml, parseRecordsFilter,
  DbsError,
} from 'sr-db-sync/api';
import type {
  SchemaIR, MigrationPlan, MigrationOp, MigrateOptions,
  TableDefinition, ColumnDef, IndexDef, FKDef,
  TriggerDef, ViewDef, ProcedureDef, EnumDef,
  RecordData, DatabaseAdapter,
} from 'sr-db-sync/api';
```

---

### `snash(options)` — Database → DBML file

```typescript
async function snash(options: {
  engine: 'sqlite' | 'mysql';   // database engine
  dsn: string;                   // connection string
  file: string;                  // output DBML path
  prefix?: string;               // strip this prefix from table names
  recordsFilter?: string;        // 'all' | 'table1,table2' (default: no data)
}): Promise<{ file: string; dbml: string }>
```

**Behavior:**
1. Creates adapter for the given engine
2. Connects to the database via the DSN
3. Reads full schema: tables, columns, indexes, foreign keys, triggers, views, procedures, enums
4. If `recordsFilter` is set, also reads table data
5. Generates DBML string, writes to file
6. Disconnects and returns `{ file, dbml }`

**Error codes it can throw:** `CONNECT`, `SCHEMA_READ`, `DBML_WRITE`

**Example:**
```typescript
const { file, dbml } = await snash({
  engine: 'sqlite',
  dsn: './dev.db',
  file: './schema.dbml',
  recordsFilter: 'users,settings',
});
// file = '/absolute/path/to/schema.dbml'
// dbml = 'Project default {\n  database_type: \'Sqlite\'\n}\n\nTable users { ...'
```

---

### `migrate(options)` — DBML file → Database

```typescript
async function migrate(options: {
  engine: 'sqlite' | 'mysql';
  dsn: string;
  file: string;                  // input DBML path
  prefix?: string;               // prepend this prefix to table names from DBML
  dryRun?: boolean;              // default: false — preview without executing
  recordsFilter?: string;        // 'all' | 'table1,table2' (default: no records insert)
}): Promise<{
  plan: MigrationPlan;              // { type, sql, table?, column? }[]
  sql: string[];                    // executable statements (comment-only no-ops excluded)
  summary: Record<string, number>;  // e.g. { create_table: 2, add_column: 1, drop_fk: 3 }
  totalOps: number;
}>
```

**Behavior:**
1. Reads the DBML file from disk
2. Parses it into `SchemaIR` (throws `DBML_PARSE` on invalid syntax)
3. Creates adapter, connects to database (creates the DB file if it doesn't exist)
4. Adapter diffs current DB schema vs target SchemaIR
5. Generates engine-specific SQL (CREATE TABLE, ALTER TABLE, etc.)
6. If `dryRun: false`, executes the SQL
7. If `recordsFilter` is set, inserts Records from DBML
8. Returns the MigrationPlan

**Crucial rule for AI agents:** **Always use `dryRun: true` first** to preview changes before executing `dryRun: false`.

**Error codes it can throw:** `DBML_PARSE`, `CONNECT`, `MIGRATE`

**Example:**
```typescript
// Step 1: Preview
const preview = await migrate({
  engine: 'sqlite',
  dsn: './prod.db',
  file: './schema.dbml',
  dryRun: true,
});
// Examine preview.plan, preview.summary, preview.sql
console.log(preview.summary); // { create_table: 2, drop_column: 1 }

// Step 2: Execute
const result = await migrate({
  engine: 'sqlite',
  dsn: './prod.db',
  file: './schema.dbml',
  dryRun: false,
});
console.log(`${result.totalOps} operations applied`);
```

---

### `MigrationPlan` and `MigrationOp` types

```typescript
type MigrationPlan = MigrationOp[];

interface MigrationOp {
  type: 'create_table' | 'add_column' | 'drop_column' | 'modify_column'
      | 'create_index' | 'drop_index' | 'add_fk' | 'drop_fk'
      | 'rebuild' | 'insert_records';
  sql: string;         // the SQL statement (or -- comment for unsupported engine features)
  table?: string;      // affected table name
  column?: string;     // affected column name (for column-level operations)
}
```

**When writing AI agents that process MigrationPlan:**
- Filter out `--` comment lines: `plan.filter(op => !op.sql.trimStart().startsWith('--'))`
- Comment-only ops happen for SQLite FK changes (SQLite doesn't support ALTER TABLE ADD CONSTRAINT)
- `rebuild` operations mean the table must be recreated (SQLite column modifications)

---

### `createAdapter(engine)` — Manual adapter lifecycle

```typescript
function createAdapter(engine: 'sqlite' | 'mysql'): DatabaseAdapter
```

Throws `DbsError` with code `ENGINE` for unsupported engines. Use this when you need fine-grained control over connect/disconnect or want to call `adapter.getTables()` / `adapter.migrateToSchema()` directly.

```typescript
const adapter = createAdapter('sqlite');
await adapter.connect('./app.db');
const tables = await adapter.getTables();
// ... manual operations ...
await adapter.disconnect();
```

---

### `parseDbml(source)` — DBML string → SchemaIR

```typescript
function parseDbml(source: string): SchemaIR
```

Throws `DbsError` with code `DBML_PARSE` on syntax errors (includes `line` and `cause` fields).

---

### `generateDbml(schema, options?)` — SchemaIR → DBML string

```typescript
function generateDbml(schema: SchemaIR, options?: {
  databaseType?: string;
  projectName?: string;
  projectNote?: string;
}): string
```

---

### `parseRecordsFilter(raw)` — Parse records filter string

```typescript
function parseRecordsFilter(raw: string | undefined): string[] | undefined
```

| Input | Output |
|-------|--------|
| `undefined` | `undefined` |
| `''` | `undefined` |
| `'all'` | `['*']` |
| `'users,posts'` | `['users', 'posts']` |

---

### Error Handling for AI Agents

All API functions throw `DbsError`. The class has these fields:

```typescript
class DbsError extends Error {
  code: 'CONFIG' | 'CONNECT' | 'ENGINE' | 'SCHEMA_READ' | 'DBML_PARSE' | 'DBML_WRITE' | 'MIGRATE' | 'TRANSACTION';
  cause: string;       // root cause / technical reason
  exitCode: number;    // 1–5 (maps to CLI exit codes)
  engine?: string;     // e.g. 'sqlite'
  dsn?: string;        // connection string
  hint?: string;       // human-readable suggestion
  file?: string;       // related file path
  line?: number;       // line number (for DBML_PARSE)
  operation?: string;  // SQL operation that failed
  table?: string;      // table that caused the error
  column?: string;     // column that caused the error
}
```

**Canonical error handling pattern for AI agents:**

```typescript
try {
  const result = await migrate({ ... });
  // success
} catch (err) {
  if (err instanceof DbsError) {
    // Structured error — all diagnostic fields available
    console.error(`[${err.code}] ${err.message}`);
    console.error(`  cause: ${err.cause}`);
    if (err.hint)  console.error(`  hint: ${err.hint}`);
    if (err.table) console.error(`  table: ${err.table}`);
    if (err.column) console.error(`  column: ${err.column}`);
    if (err.file)  console.error(`  file: ${err.file}`);
    if (err.line)  console.error(`  line: ${err.line}`);
    process.exit(err.exitCode);
  }
  // Unexpected error — rethrow for the runtime
  throw err;
}
```

---

### `SchemaIR` type (full intermediate representation)

```typescript
interface SchemaIR {
  tables: TableDefinition[];
  views: ViewDef[];
  procedures: ProcedureDef[];
  enums: EnumDef[];
  extensions: DbsExtension[];  // @dbs comments (triggers, views, procedures, engine, charset, etc.)
  records: RecordData[];       // parsed Records blocks from DBML
}

interface TableDefinition {
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: FKDef[];
  triggers: TriggerDef[];
}

interface ColumnDef {
  name: string;
  type: string;              // 'INTEGER', 'VARCHAR(255)', 'TEXT', etc.
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue?: string;
  comment?: string;
  enumValues?: string[];      // MySQL ENUM values
}

interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type?: string;              // 'btree', 'hash'
}

interface FKDef {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action';
  onUpdate?: 'cascade' | 'set null' | 'restrict' | 'no action';
}

interface ViewDef {
  name: string;
  definition: string;
}

interface ProcedureDef {
  name: string;
  body: string;
}

interface EnumDef {
  name: string;
  values: string[];
}

interface RecordData {
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
}
```

---

### Typical AI agent workflows with the API

**Workflow: Sync two environments**
```typescript
// Snapshot source DB
const { file } = await snash({ engine: 'mysql', dsn: PROD_DSN, file: './schema.dbml' });
// Preview destination changes
const preview = await migrate({ engine: 'mysql', dsn: STAGING_DSN, file, dryRun: true });
if (preview.totalOps > 0) {
  console.log('Changes needed:', preview.summary);
  // Apply
  await migrate({ engine: 'mysql', dsn: STAGING_DSN, file, dryRun: false });
}
```

**Workflow: Validate DBML before commit (git hook)**
```typescript
const schema = parseDbml(readFileSync('./schema.dbml', 'utf-8'));
// schema is valid if no exception thrown
// Optionally: roundtrip to verify
const regenerated = generateDbml(schema);
const reparsed = parseDbml(regenerated);
// Compare table count, column count, etc.
```

**Workflow: Generate migration SQL for review (CI)**
```typescript
const { sql, plan } = await migrate({ engine: 'mysql', dsn: PROD_DSN, file: './schema.dbml', dryRun: true });
// Write SQL to a file for human review
writeFileSync('./migration-review.sql', sql.join(';\n\n'));
// Output summary for CI log
console.log(JSON.stringify({ totalOps: plan.length, summary: groupBy(plan, 'type') }));
```

---

## Notes for AI Agents

- **Always run `--dry-run` before `migrate`** to preview changes. Never skip this step.
- Tables NOT in DBML are never dropped — the tool is non-destructive by default.
- The output uses ANSI escape codes for color — strip `\x1b\[[0-9;]*m` before parsing SQL.
- DBML files are Git-friendly — diff, blame, and PR reviews work natively on schema changes.
- DBML files can be visualized at [dbdiagram.io](https://dbdiagram.io) for a diagram view.
- The `format()` method on `DbsError` produces the canonical machine-parseable stderr output — use the structured fields for automated error handling.
- Warnings (`WARN [...]`) on stderr are non-fatal — the command may still have succeeded with an `EXIT OK` exit.
- The `--prefix` flag filters tables by name prefix in both snash and migrate — tables not matching the prefix are ignored entirely.
- `IMPLEMENTED_ENGINES` = `['sqlite', 'mysql']` — `'postgres'` is recognized as valid but has no adapter yet.
