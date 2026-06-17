# Системный промпт — db-sync

Проект: **db-sync** — CLI-утилита для двунаправленной конвертации между базой данных и DBML (Database Markup Language).

## Текущее состояние

- **Фаза 0** (Инициализация) завершена.
- **Фаза 1** (Типы и интерфейсы) завершена.
- **Фаза 2** (CLI-скелет) завершена.
- **Фаза 3** (Парсер DBML) завершена.
- **Фаза 4** (Адаптер SQLite, Snash) завершена.
- Полноценный парсинг флагов через `node:util.parseArgs`.
- Загрузка и резолв профилей из `.dbs.json`.
- Интерактивный режим через `@clack/prompts` (без подкоманды).
- AI-friendly вывод: `exitOk()`, `exitError()`, `warn()`, `DbsError.format()`.
- Поддержка `--profile`, `--dsn`, `--engine`, `--prefix`, `--output`, `--input`, `--dry-run`, `--insert`, `--profiles-file`.
- Корректные exit codes (0–5).
- DBML лексер, парсер → SchemaIR, парсинг @dbs-комментариев.
- Адаптер SQLite: connect/disconnect, getTables, getColumns, getIndexes, getForeignKeys, getTriggers, getViews, getProcedures (пусто), getEnums (пусто).

## Следующая фаза

Фаза 5: Генератор DBML — `SchemaIR` → DBML-строка.

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
| `src/adapters/sqlite.ts` | Адаптер SQLite: Snash (чтение схемы) + заглушки Migrate (Фаза 8) |
| `src/config/config.types.ts` | Типы конфигурации профилей |
| `src/config/profiles.ts` | Загрузка и резолв `.dbs.json` |
| `src/parser/dbml-lexer.ts` | Токенизатор DBML (ключевые слова, символы, строки, числа, комментарии) |
| `src/parser/dbml-parser.ts` | Парсер DBML → SchemaIR (таблицы, колонки, индексы, Ref, Enum, DBS-расширения) |
| `src/utils/comments.ts` | Кодирование/декодирование `// @dbs:` комментариев |
| `src/utils/errors.ts` | Класс DbsError |
| `src/utils/output.ts` | Функции вывода: exitOk, exitError, warn |
