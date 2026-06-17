# Changelog

## [Unreleased]

### Added
- **Programmatic API** (`src/api.ts`) — importable functions `snash()` and `migrate()` for use in TypeScript/JavaScript code.
  - `snash(options)` — snapshot database schema to DBML file, returns `{ file, dbml }`.
  - `migrate(options)` — apply DBML schema to database, returns `{ plan, sql, summary, totalOps }`.
  - `createAdapter(engine)` — factory for creating adapter instances.
  - Re-exports: `parseDbml`, `generateDbml`, `parseRecordsFilter`, `DbsError`, and all core types (`SchemaIR`, `MigrationPlan`, etc.).
  - Options mirror CLI flags (`engine`, `dsn`, `file`, `prefix`, `recordsFilter`, `dryRun`).
  - Functions throw `DbsError` on failure — never call `process.exit()`.

## [v1.0.19]

### Added
- `--prefix` parameter for both `snash` and `migrate` commands.
  - **Snash:** Filters tables by prefix, strips prefix from table names (and FK refTable) in DBML output.
  - **Migrate:** Prepends prefix to table names (and FK refTable) from DBML before migration.
  - Interactive prompts for prefix in both snash and migrate flows.
  - Prefix saved to/loaded from `.dbs.json` profiles.
  - Prefix shown in confirmation summary.

### Changed
- `.pi/SYSTEM.md` — rewritten to be lean and essential: architecture summary, key files map, code conventions, test infra — everything an AI agent needs to orient itself in one read.

### Added
- `AI.md` — comprehensive documentation for AI agents: installation, all commands, flags, error codes, ANSI color scheme, output parsing strategies, and typical workflows.
