# Системный промпт — db-sync

Проект: **db-sync** — CLI-утилита для двунаправленной конвертации между базой данных и DBML (Database Markup Language).

## Текущее состояние

- **Фаза 0** (Инициализация) завершена.
- **Фаза 1** (Типы и интерфейсы) завершена.
- **Фаза 2** (CLI-скелет) завершена.
- Полноценный парсинг флагов через `node:util.parseArgs`.
- Загрузка и резолв профилей из `.dbs.json`.
- Интерактивный режим через `@clack/prompts` (без подкоманды).
- AI-friendly вывод: `exitOk()`, `exitError()`, `warn()`, `DbsError.format()`.
- Поддержка `--profile`, `--dsn`, `--engine`, `--prefix`, `--output`, `--input`, `--dry-run`, `--insert`, `--profiles-file`.
- Корректные exit codes (0–5).

## Следующая фаза

Фаза 3: Парсер DBML — лексер, парсер, парсинг @dbs-комментариев → SchemaIR.

## Ключевые файлы

| Файл | Назначение |
|------|-----------|
| `SPEC.md` | Полная спецификация |
| `PLAN.md` | Пофазовый план реализации |
| `README.md` | Документация и статус проекта |
| `CHANGELOG.md` | История изменений |
| `src/index.ts` | Точка входа CLI, диспетчер подкоманд, интерактивный режим |
| `src/cli/snash.ts` | Подкоманда snash (заглушка) |
| `src/cli/migrate.ts` | Подкоманда migrate (заглушка) |
| `src/core/types.ts` | Все типы схемы БД, SchemaIR, MigrationPlan |
| `src/adapters/adapter.interface.ts` | Интерфейс DatabaseAdapter |
| `src/config/config.types.ts` | Типы конфигурации профилей |
| `src/config/profiles.ts` | Загрузка и резолв `.dbs.json` |
| `src/utils/errors.ts` | Класс DbsError |
| `src/utils/output.ts` | Функции вывода: exitOk, exitError, warn
