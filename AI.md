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
