# Changelog

## [Unreleased]

### Changed (Architecture)
- `extractDbName` вынесен как метод интерфейса `DatabaseAdapter`
  - Каждый адаптер реализует парсинг своего формата DSN
  - `SqliteAdapter.extractDbName(dsn)` — извлечение имени файла без расширения
  - `profiles.ts`: `extractDbName()` делегирует адаптеру; fallback URL-парсинг для MySQL/PostgreSQL (пока нет адаптеров)
  - Добавлена `createAdapterForEngine()` — фабрика адаптеров для DSN-парсинга (без подключения к БД)

### Changed (SPEC update)
- Унификация `--output`/`--input` → `--file` во всех CLI-слоях и тестах (§4.2, §4.3)
- `DbsConfig`: поля `output?`/`input?` заменены на единое `file`
- `ProfileConfig`: добавлено поле `file`
- Добавлен `extractDbName(dsn, engine)` — извлечение имени БД из DSN (§4.4)
  - SQLite: имя файла без расширения
  - MySQL/PostgreSQL: последний сегмент URL (имя БД)
- Добавлен `defaultDbmlPath(dsn, engine)` — путь по умолчанию `./migration/<dbname>.dbml`
- Приоритет разрешения `file`: явный `--file` > `file` в профиле > авто-вывод из DSN
- `.dbs.json` — добавлены поля `file` в профили prod и staging
- Обновлён USAGE в `src/index.ts` (убраны Snash/Migrate flags, добавлен `--file`)

### Added (Phase 5)
- `src/generator/dbml-writer.ts` — генератор DBML: SchemaIR → DBML-строка:
  - `generateDbml(schema, options?)` — основная функция, опциональный Project-блок
  - `DbmlWriterOptions` — опции: `projectName`, `projectNote`, `databaseType`
  - Генерация таблиц с колонками и настройками (`[pk, increment, not null, null, unique, default:, note:]`)
  - Генерация блоков `Indexes` (одиночные и композитные с `unique, name:, type:`)
  - Генерация `Ref:` для внешних ключей (короткий синтаксис с `>`, настройки `[delete:, update:]`)
  - Генерация `Enum`-блоков
  - Генерация `// @dbs:` комментариев для триггеров, представлений, процедур и расширений (check, engine, charset, collation, raw)
  - Форматирование default-значений: строки в кавычках, backtick-выражения как есть, числа/булевы/null без кавычек
  - Эскейпинг идентификаторов с пробелами/спецсимволами в двойные кавычки
  - Подавление `type: btree` (значение по умолчанию) для индексов
  - Подавление `unique` для primary key колонок (избыточно)
- **Фиксы парсера:**
  - `collectDbsComments` теперь разделяет последовательные `@dbs:` комментарии разных типов (прежде сливались в одну группу)
  - `parseRef` теперь парсит настройки `[delete:, update:]` в коротком синтаксисе `Ref:` (прежде только в блочном `Ref name { }`)
- **Тесты:** 54 теста в `test/dbml-writer.test.ts`:
  - 25 тестов генерации (Project, таблицы, колонки, индексы, FK, Enum, @dbs расширения, edge cases)
  - 9 тестов roundtrip (таблицы, FK, Enum, триггеры, views, procedures, расширения, default-значения, полная схема test.dbml)
  - 8 тестов форматирования default-значений
  - 3 теста эскейпинга идентификаторов
  - 9 тестов edge cases (пустая таблица, пустой тип, pk+unique, пустое тело триггера и т.д.)

### Added (Phase 4)
- `src/adapters/sqlite.ts` — адаптер SQLite (Snash):
  - `connect(dsn)` / `disconnect()` — подключение к SQLite через `bun:sqlite` (встроенный, без внешних зависимостей)
  - Статические поля `dsnFields` и `buildDsn()` для интерактивного построения DSN
  - `getTables()` — список таблиц из `sqlite_master` (исключая `sqlite_*`)
  - `getColumns(tableName)` — колонки через `PRAGMA table_info`, автоопределение AUTOINCREMENT из CREATE TABLE SQL, канонизация типов
  - `getIndexes(tableName)` — индексы через `PRAGMA index_list` + `PRAGMA index_info`, фильтрация `sqlite_autoindex_*`, разрешение имён колонок
  - `getForeignKeys(tableName)` — внешние ключи через `PRAGMA foreign_key_list`, группировка по constraint id, нормализация ON DELETE/UPDATE
  - `getTriggers(tableName)` — триггеры из `sqlite_master`, парсинг timing (BEFORE/AFTER/INSTEAD OF) и event (INSERT/UPDATE/DELETE)
  - `getViews()` — представления из `sqlite_master`
  - `getProcedures()` / `getEnums()` — возвращают пустой массив (SQLite не поддерживает)
  - Migrate-методы (`createTable`, `addColumn`, `dropColumn`, `modifyColumn`, `createIndex`, `dropIndex`, `addForeignKey`, `dropForeignKey`, `beginTransaction`, `commit`, `rollback`) — заглушки с ошибками до Фазы 8
- **Тесты:** 29 тестов в `test/sqlite-adapter.test.ts`:
  - 2 теста DSN-контракта (dsnFields, buildDsn)
  - 5 тестов connect/disconnect (in-memory, file DB, nonexistent file, double disconnect, без connect)
  - 2 теста getTables (список таблиц, исключение sqlite_*)
  - 2 теста getColumns (полная таблица users, таблица без AUTOINCREMENT)
  - 3 теста getIndexes (пользовательские индексы, исключение autoindex, пустой массив)
  - 3 теста getForeignKeys (одиночный FK, два FK, пустой массив)
  - 3 теста getTriggers (AFTER INSERT, BEFORE DELETE, пустой массив)
  - 1 тест getViews
  - 2 теста getProcedures/getEnums
  - 1 тест полного roundtrip-извлечения схемы
  - 5 edge cases (минимальная таблица, composite PK, SET NULL/RESTRICT FK, INSTEAD OF триггер, множественный disconnect)

### Added (Phase 3)
- `src/parser/dbml-lexer.ts` — токенизатор DBML: ключевые слова (Table, Project, Enum, Ref, TableGroup, Indexes, Note, Records), символы, идентификаторы, строки (одинарные/двойные/backtick), многострочные строки, числа, комментарии `//` и `--` (LINE_COMMENT), отслеживание номеров строк и колонок
- `src/parser/dbml-parser.ts` — рекурсивный парсер DBML → `SchemaIR`:
  - Парсинг таблиц с колонками, типами (включая параметры), настройками (`[pk, increment, not null, unique, default:, note:, ref:]`)
  - Парсинг блоков Indexes (одиночные и композитные индексы с настройками `unique, name:, type:`)
  - Парсинг Ref-деклараций (inline `Ref: a.b > c.d`, блочные с `{ }`, с настройками `delete:, update:`), определение направления FK (`>`, `<`)
  - Парсинг Enum-блоков
  - Парсинг и пропуск Project, TableGroup, Records, Note
  - Авто-генерация имён индексов если не указаны
- `src/utils/comments.ts` — кодирование/декодирование `// @dbs:` комментариев:
  - Парсинг всех типов: trigger, view, procedure, check, engine, charset, collation, raw
  - Обратный формат (round-trip): DbsExtension → `// @dbs:` строки
- Интеграция DBS-расширений в SchemaIR: триггеры привязываются к таблицам, views/procedures в schema.views/schema.procedures, engine/charset/collation/check/raw в schema.extensions
- **Тесты:** 76 тестов в `test/parser.test.ts`:
  - 29 тестов лексера (ключевые слова, символы, строки, числа, комментарии, трекинг строк)
  - 14 тестов DBS-комментариев (все 9 типов, round-trip форматирования)
  - 33 теста парсера (таблицы, колонки, настройки, индексы, Ref, Enum, Project, DBS-расширения, TableGroup, Records, обработка ошибок, edge cases, полная схема)

### Added (Phase 0)
- Инициализация Bun + TypeScript проекта
- Настройка `tsconfig.json` (strict, ESNext, bundler module resolution)
- Базовая структура директорий: `src/`, `src/cli/`, `src/core/`, `src/adapters/`, `src/config/`, `src/parser/`, `src/generator/`, `src/utils/`
- Настройка скриптов в `package.json`: `build`, `start`, `dev`, `typecheck`, `bin` entrypoint `dbs`
- CLI-скелет `src/index.ts` с командами `snash`, `migrate`, `--help`, `--version`
- AI-friendly вывод: `EXIT OK`, `EXIT ERROR [CODE]`, структурированные ошибки
- Корректные exit codes (0 — успех, 1 — ошибка конфигурации)
- DevDependencies: `@types/bun`, `typescript`, `fallow`

### Added (Phase 2)
- `src/utils/output.ts` — функции `exitOk(details)`, `exitError(code, message, meta)`, `warn(code, message)`
- `src/config/profiles.ts` — загрузка и парсинг `.dbs.json`, резолв профиля в `DbsConfig` с валидацией
- `src/cli/snash.ts` — заглушка команды snash: парсинг флагов (`--profile`, `--dsn`, `--engine`, `--prefix`, `--output`, `--profiles-file`)
- `src/cli/migrate.ts` — заглушка команды migrate: парсинг флагов (`--dry-run`, `--insert`, `--input` + общие)
- `src/index.ts` — полноценный диспетчер подкоманд, интерактивный режим через `@clack/prompts` (выбор команды и движка)
- Все exit codes корректны (0 — успех, 1 — CONFIG/ENGINE, 2 — CONNECT, 3 — SCHEMA/DBML, 4 — MIGRATE, 5 — DBML_WRITE)
- Зависимость `@clack/prompts` для интерактивного режима
- Тестовый `.dbs.json` с профилями `prod` и `staging`
- **Тесты:** 58 тестов в 6 файлах (100% passing):
  - `test/helpers.ts` — моки `process.exit`, `console.log/error`, `CapturedExit`
  - `test/errors.test.ts` — 9 тестов: конструктор, форматирование, exit codes
  - `test/output.test.ts` — 10 тестов: exitOk, exitError, warn
  - `test/profiles.test.ts` — 12 тестов: загрузка .dbs.json и резолв профилей
  - `test/cli-snash.test.ts` — 10 тестов: все флаги и edge cases
  - `test/cli-migrate.test.ts` — 11 тестов: все флаги, dry-run, insert
  - `test/cli-main.test.ts` — 6 тестов: диспетчер подкоманд, help, version

### Added (Phase 1)
- `src/core/types.ts` — все типы схемы БД: `ColumnDef`, `IndexDef`, `FKDef`, `TriggerDef`, `ViewDef`, `ProcedureDef`, `EnumDef`, `TableDefinition`, `SchemaIR`
- Типы расширений DbsExtension для `@dbs`-комментариев (trigger, view, procedure, check, engine, charset, collation, raw)
- Типы миграции: `MigrationOp`, `MigrationOpType`, `MigrationPlan`
- `src/adapters/adapter.interface.ts` — интерфейс `DatabaseAdapter` (connect/disconnect, get*/create*/drop*/modify*, транзакции)
- Тип `DsnField` для интерактивного построения DSN
- Интерфейс `DatabaseAdapterConstructor` со статическими `dsnFields` и `buildDsn()`
- `src/config/config.types.ts` — типы конфигурации: `ProfileConfig`, `DbsProfiles`, `DbsConfig`
- `src/utils/errors.ts` — класс `DbsError` с полями code/cause/hint/engine/dsn/file/operation/table/column
- Методы `DbsError.exit()`, `DbsError.format()`, `DbsError.exitCode`
- Таблица `EXIT_CODES` — маппинг кодов ошибок на exit codes (1–5)

### Added (Initial)
- `SPEC.md` — полная спецификация утилиты
- `PLAN.md` — пофазовый план реализации
- `.pi/SYSTEM.md` — системный промпт агента Pi
- `.pi/APPEND_SYSTEM.md` — обязательные требования для агента Pi
- `README.md` — описание проекта и roadmap
- Fallow добавлен как devDependency для проверки TypeScript кода
