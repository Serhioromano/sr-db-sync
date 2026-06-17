# SYSTEM — sr-db-sync

CLI-утилита для двунаправленной конвертации между базой данных и DBML.
Бинарь: `dbs`. Две команды: `dbs snash` (БД → DBML) и `dbs migrate` (DBML → БД).

---

## Архитектура (ключевое)

**Главное правило:** никакого промежуточного «differ» слоя. Адаптер делает всё сам:
читает живую схему БД, сравнивает с целевым SchemaIR, генерирует engine-specific SQL,
выполняет его (или выводит в dry-run).

**Поток snash:**  `CLI → adapter.connect → adapter.getTables/getColumns/... → SchemaIR → DBML writer → файл`
**Поток migrate:** `CLI → DBML parser → SchemaIR → adapter.connect → adapter.migrateToSchema(target) → MigrationPlan → SQL`

## Движки

| Engine | Адаптер | Статус |
|--------|---------|--------|
| `sqlite` | `src/adapters/sqlite.ts` | ✅ |
| `mysql` | `src/adapters/mysql.ts` | ✅ |
| `postgres` | нет | 🔮 planned |

`IMPLEMENTED_ENGINES = ['sqlite', 'mysql']` (в `cli/snash.ts` и `cli/migrate.ts`).

## Флаги (единые для обеих команд)

`--dsn`, `--engine`, `--prefix`, `--file`, `--profile`, `--profiles-file`, `--dry-run` (только migrate), `--records` (all | table1,table2,...)

- `--file` унифицирован: snash пишет в него, migrate читает из него.
- По умолчанию `--file` = `./migration/<dbname>.dbml` (dbname извлекается адаптером из DSN через `extractDbName()`).
- Профили: `migration/.dbs.json` (приоритет), затем `.dbs.json` (корень).

## Programmatic API

`src/api.ts` — публичное API для использования в коде (не только CLI).

```typescript
import { snash, migrate } from 'sr-db-sync/api';

const { file, dbml } = await snash({ engine: 'sqlite', dsn: './db', file: './s.dbml' });
const result = await migrate({ engine: 'sqlite', dsn: './db', file: './s.dbml', dryRun: true });
```

**Экспорты:** `snash()`, `migrate()`, `createAdapter()`, `parseDbml()`, `generateDbml()`, `parseRecordsFilter()`, `DbsError` + все core-типы.

**Правило:** API-функции **никогда** не вызывают `process.exit()` — бросают `DbsError`. Адаптер создаётся, коннектится и дисконнектится внутри функций.

## Ключевые файлы (куда идти)

| Файл | Когда менять |
|------|-------------|
| `src/index.ts` | CLI-диспетчер, usage, интерактивный режим |
| `src/api.ts` | **Публичное API** — `snash()` и `migrate()` для programmatic использования |
| `src/cli/snash.ts` | Логика команды snash (флаги, профили, вызов snapper) |
| `src/cli/migrate.ts` | Логика команды migrate (флаги, профили, ANSI-вывод SQL) |
| `src/core/snapper.ts` | Бизнес-логика: БД → SchemaIR → DBML |
| `src/core/migrator.ts` | Бизнес-логика: DBML → SchemaIR → adapter.migrateToSchema() |
| `src/core/types.ts` | SchemaIR, ColumnDef, IndexDef, FKDef, MigrationPlan, RecordData |
| `src/adapters/adapter.interface.ts` | Интерфейс DatabaseAdapter (connect, getTables, getColumns, migrateToSchema, ...) |
| `src/adapters/sqlite.ts` | Адаптер SQLite (~1066 строк) |
| `src/adapters/mysql.ts` | Адаптер MySQL (~1203 строк) |
| `src/config/profiles.ts` | Загрузка `.dbs.json`, resolveProfile, extractDbName, defaultDbmlPath |
| `src/config/config.types.ts` | DbsConfig, ProfileConfig, DbsProfiles |
| `src/parser/dbml-lexer.ts` | Токенизатор DBML |
| `src/parser/dbml-parser.ts` | Парсер DBML → SchemaIR |
| `src/generator/dbml-writer.ts` | SchemaIR → DBML-текст |
| `src/utils/errors.ts` | DbsError (code, message, cause, engine, dsn, file, line, hint...), EXIT_CODES |
| `src/utils/output.ts` | exitOk(), exitError(), warn() — AI-friendly контракт |
| `test/` | Все тесты (OneTest/Bun) |
| `SPEC.md` | Полная спецификация |
| `PLAN.md` | Пофазовый план |
| `AI.md` | Полный AI-справочник (команды, флаги, ошибки, workflow) |

## Конвенции кода

- **Весь вывод** идёт через `exitOk()` / `exitError()` / `warn()` из `src/utils/output.ts`.
- **Ошибки** — всегда `DbsError` с кодом. Коды: `CONFIG`, `CONNECT`, `ENGINE`, `SCHEMA_READ`, `DBML_PARSE`, `DBML_WRITE`, `MIGRATE`, `TRANSACTION`.
- **Exit codes:** 0=OK, 1=CONFIG/ENGINE, 2=CONNECT, 3=SCHEMA_READ/DBML_PARSE, 4=MIGRATE/TRANSACTION, 5=DBML_WRITE.
- **Миграция безопасна:** таблицы, которых нет в DBML, **никогда не удаляются**.
- **ANSI-цвета** в migrate-выводе: зелёный=CREATE, синий=ADD, жёлтый=MODIFY, красный=DROP.

## Тесты

```bash
bun test                  # все тесты
bun test --watch          # автоперезапуск
bun test --coverage       # покрытие
```

Тестовый фреймворк: **OneTest** (встроен в Bun). Файлы: `test/*.test.ts`.
Эталонная схема: `test/test.dbml`. Временные SQLite-базы в `test/*.sqlite` (в `.gitignore`).

## После изменений в TypeScript

1. `bun test` — прогнать тесты.
2. `npx fallow` — проверить dead code/duplication/health.
3. Обновить `CHANGELOG.md`, `README.md` (если затронута публичная поверхность), этот файл (если новая архитектурная деталь).
