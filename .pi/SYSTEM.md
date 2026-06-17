# Системный промпт — db-sync

Проект: **db-sync** — CLI-утилита для двунаправленной конвертации между базой данных и DBML (Database Markup Language).

## Текущее состояние

- **Фаза 0** (Инициализация) завершена.
- **Фаза 1** (Типы и интерфейсы) завершена.
- **Фаза 2** (CLI-скелет) завершена.
- **Фаза 3** (Парсер DBML) завершена.
- **Фаза 4** (Адаптер SQLite, Snash) завершена.
- **Фаза 5** (Генератор DBML) завершена.
- **Фаза 6** (Команда Snash) завершена.
- **Фаза 7** (Адаптер SQLite Migrate) завершена.
- `dbs snash --dsn ./test.db --engine sqlite --file schema.dbml` создаёт валидный DBML-файл с полной схемой (272 теста).
- `adapter.migrateToSchema(targetIR, { dryRun: true })` — адаптер сам читает текущую схему, сравнивает с целевой SchemaIR, генерирует SQLite-специфичный SQL и возвращает MigrationPlan (13 тестов).
- Архитектурное решение: никакого промежуточного «differ» слоя — адаптер делает всё.
- Унификация `--output`/`--input` → `--file` (единый флаг для обеих подкоманд).
- Авто-вывод пути DBML-файла из DSN (`./migration/<dbname>.dbml`) через `extractDbName()` и `defaultDbmlPath()`.
- `extractDbName` добавлен как метод интерфейса `DatabaseAdapter` (каждый адаптер знает, как парсить свой DSN).
- `extractDbName` в `profiles.ts` делегирует адаптеру; fallback для движков без адаптера (MySQL/PostgreSQL).
- `.dbs.json` в `migration/.dbs.json` (приоритетная локация).
- `discoverProfilesFile()` — поиск `.dbs.json` в `migration/`, затем в корне.
- Полноценный парсинг флагов через `node:util.parseArgs`.
- Загрузка и резолв профилей из `.dbs.json`.
- Интерактивный режим через `@clack/prompts` (без подкоманды).
- AI-friendly вывод: `exitOk()`, `exitError()`, `warn()`, `DbsError.format()`.
- Поддержка `--profile`, `--dsn`, `--engine`, `--prefix`, `--file`, `--dry-run`, `--insert`, `--profiles-file`.
- Корректные exit codes (0–5).
- DBML лексер, парсер → SchemaIR, парсинг @dbs-комментариев.
- Полный roundtrip: SchemaIR → DBML → parseDbml → SchemaIR (54 теста).
- Diff-движок: сравнение двух SchemaIR → MigrationPlan (40 тестов).

## Следующая фаза

Фаза 8: Команда Migrate (полная) — CLI-интеграция: чтение DBML, вызов adapter.migrateToSchema(), цветной вывод SQL, dry-run.

## Ключевые файлы
|------|-----------|
| `SPEC.md` | Полная спецификация |
| `PLAN.md` | Пофазовый план реализации |
| `README.md` | Документация и статус проекта |
| `CHANGELOG.md` | История изменений |
| `src/index.ts` | Точка входа CLI, диспетчер подкоманд, интерактивный режим |
| `src/cli/snash.ts` | Подкоманда snash: разрешение конфигурации, вызов snapper, обработка ошибок |
| `src/cli/migrate.ts` | Подкоманда migrate (заглушка) |
| `src/core/snapper.ts` | Бизнес-логика: БД → SchemaIR → DBML файл |
| `src/core/types.ts` | Все типы схемы БД, SchemaIR, MigrationPlan, MigrateOptions |
| `src/adapters/adapter.interface.ts` | Интерфейс DatabaseAdapter (Snash + migrateToSchema) |
| `src/adapters/sqlite.ts` | Адаптер SQLite: чтение схемы + migrateToSchema (сравнение + SQL + выполнение) |
| `src/config/config.types.ts` | Типы конфигурации профилей |
| `src/config/profiles.ts` | Загрузка и резолв `.dbs.json`, `extractDbName()`, `defaultDbmlPath()` |
| `src/generator/dbml-writer.ts` | Генератор DBML: SchemaIR → валидный DBML (таблицы, колонки, индексы, Ref, Enum, @dbs) |
| `src/parser/dbml-lexer.ts` | Токенизатор DBML (ключевые слова, символы, строки, числа, комментарии) |
| `src/parser/dbml-parser.ts` | Парсер DBML → SchemaIR (таблицы, колонки, индексы, Ref, Enum, DBS-расширения) |
| `src/utils/comments.ts` | Кодирование/декодирование `// @dbs:` комментариев |
| `src/utils/errors.ts` | Класс DbsError |
| `src/utils/output.ts` | Функции вывода: exitOk, exitError, warn |
