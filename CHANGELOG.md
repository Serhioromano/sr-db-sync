# Changelog

## [Unreleased]

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
