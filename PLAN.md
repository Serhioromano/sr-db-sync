# План реализации db-sync

> Разбивка SPEC.md на фазы с зависимостями и критериями готовности.

---

## Фаза 0: Инициализация проекта

| Задача | Детали |
|--------|--------|
| Инициализация Bun + TypeScript | `bun init`, `tsconfig.json` |
| Базовая структура директорий | `src/`, `src/cli/`, `src/core/`, `src/adapters/`, `src/config/`, `src/parser/`, `src/generator/`, `src/utils/` |
| Настройка скриптов в `package.json` | `build`, `start`, `dev`, бинарный entrypoint `dbs` |

**Критерий готовности:** `bun run src/index.ts --help` выводит заглушку CLI.

---

## Фаза 1: Типы и интерфейсы

| Задача | Файл | Детали |
|--------|------|--------|
| Типы схемы БД | `src/core/types.ts` | `ColumnDef`, `IndexDef`, `FKDef`, `TriggerDef`, `ViewDef`, `ProcedureDef`, `EnumDef`, `TableDefinition`, `SchemaIR` |
| Интерфейс адаптера | `src/adapters/adapter.interface.ts` | `DatabaseAdapter` со всеми методами (connect, disconnect, get*, create*, drop*, modify*, транзакции) |
| Типы конфигурации | `src/config/config.types.ts` | `DbsConfig`, `ProfileConfig`, `DbsProfiles` |
| Типы ошибок | `src/utils/errors.ts` | `DbsError` с полями: code, message, cause, hint, engine, dsn, file, operation, table, column |

**Критерий готовности:** все интерфейсы компилируются без ошибок (`bun run build --noEmit`). Никакой логики — только типы.

---

## Фаза 2: CLI-скелет

| Задача | Файл | Детали |
|--------|------|--------|
| Точка входа | `src/index.ts` | Парсинг подкоманд `snash` / `migrate`, флагов (`--dsn`, `--engine`, `--prefix`, `--profile`, `--output`, `--input`, `--dry-run`, `--profiles-file`, `--insert`) |
| CLI Snash | `src/cli/snash.ts` | Заглушка: парсит аргументы, выводит имя команды |
| CLI Migrate | `src/cli/migrate.ts` | Заглушка: парсит аргументы, выводит имя команды |
| Профили | `src/config/profiles.ts` | Загрузка и парсинг `.dbs.json`, резолв профиля |
| AI-вывод | `src/utils/output.ts` | Функции `exitOk(details)`, `exitError(code, message, meta)`, форматирование ошибок |

**Критерий готовности:**
- `dbs snash --profile prod` — читает `.dbs.json`, выводит `EXIT OK [profile resolved: prod]`
- `dbs migrate --profile prod --dry-run` — читает `.dbs.json`, выводит `EXIT OK [dry-run]`
- `dbs snash` (без аргументов) — выводит `EXIT ERROR [CONFIG] No profile or --dsn provided`
- Все exit codes корректны (по таблице из SPEC.md)

---

## Фаза 3: Парсер DBML

| Задача | Файл | Детали |
|--------|------|--------|
| Лексер | `src/parser/dbml-lexer.ts` | Токенизация DBML: таблицы, колонки, настройки, индексы, Ref, Enum, TableGroup, комментарии `// @dbs:` |
| Парсер | `src/parser/dbml-parser.ts` | DBML токены → `SchemaIR` (промежуточное представление) |
| Парсинг `@dbs` | `src/utils/comments.ts` | Кодирование/декодирование `// @dbs:` комментариев → `DbsExtension` |

**Критерий готовности:**
- Парсинг тестового DBML с таблицами, колонками, индексами, Ref, Enum → корректный `SchemaIR`
- Парсинг `// @dbs:trigger`, `// @dbs:view`, `// @dbs:procedure`, `// @dbs:check`, `// @dbs:engine`, `// @dbs:charset`, `// @dbs:collation`, `// @dbs:raw` → корректные `DbsExtension`
- Ошибки парсинга → `EXIT ERROR [DBML_PARSE]` с указанием строки и контекста

---

## Фаза 4: Адаптер SQLite (Snash)

| Задача | Файл | Детали |
|--------|------|--------|
| Подключение | `src/adapters/sqlite.ts` | `connect(dsn)`, `disconnect()`, запросы к `sqlite_master` |
| Чтение схемы | `src/adapters/sqlite.ts` | `getTables()`, `getColumns()`, `getIndexes()`, `getForeignKeys()`, `getTriggers()`, `getViews()` |
| Типы | Использовать `bun:sqlite` (встроенный) | Прямые SQL-запросы к системным таблицам |

**Запросы для SQLite:**
- Таблицы: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
- Колонки: `PRAGMA table_info(<table>)`
- Индексы: `PRAGMA index_list(<table>)` + `PRAGMA index_info(<index>)`
- FK: `PRAGMA foreign_key_list(<table>)`
- Триггеры: `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='<table>'`
- Views: `SELECT name, sql FROM sqlite_master WHERE type='view'`

**Критерий готовности:** подключается к SQLite-файлу, извлекает полную схему в структуры данных. `getEnums()` и `getProcedures()` возвращают пустой массив (SQLite их не поддерживает).

---

## Фаза 5: Генератор DBML

| Задача | Файл | Детали |
|--------|------|--------|
| Генератор DBML | `src/generator/dbml-writer.ts` | `SchemaIR` → DBML-строка (Project, Table, Columns, Indexes, Ref, Enum, TableGroup, комментарии `// @dbs:`) |
| Форматирование | `src/generator/dbml-writer.ts` | Отступы, переносы строк, группировка по секциям |

**Критерий готовности:** `SchemaIR` → валидный DBML-файл, который проходит парсер (roundtrip Фазы 3). Все `@dbs`-расширения корректно сохраняются и восстанавливаются.

---

## Фаза 6: Команда Snash (полная)

| Задача | Файл | Детали |
|--------|------|--------|
| Бизнес-логика | `src/core/snapper.ts` | Алгоритм из SPEC 5.2: connect → getTables → getColumns → getIndexes → getFK → getTriggers → getViews → getProcedures → getEnums → SchemaIR → DBML → файл |
| Интеграция | `src/cli/snash.ts` | Связывает профили/флаги, адаптер, snapper, writer |

**Критерий готовности:** `dbs snash --dsn ./test.db --engine sqlite --output schema.dbml` создаёт валидный DBML-файл с полной схемой. `EXIT OK [schema written to schema.dbml]`.

---

## Фаза 7: Адаптер SQLite (Migrate)

| Задача | Файл | Детали |
|--------|------|--------|
| Миграция схемы | `src/adapters/sqlite.ts` | `migrateToSchema(target, options?)` — адаптер сам читает текущую схему, сравнивает с целевой SchemaIR, генерирует SQLite-специфичный SQL, выполняет (если не dryRun), возвращает MigrationPlan |
| Интерфейс | `src/adapters/adapter.interface.ts` | `migrateToSchema(target: SchemaIR, options?: MigrateOptions): Promise<MigrationPlan>` — заменяет 8 индивидуальных методов записи |
| Типы | `src/core/types.ts` | `MigrateOptions` (dryRun, insertRecords), `MigrationPlan`, `MigrationOp` |

**Архитектурное решение:** никакого промежуточного «differ» слоя. Адаптер получает целевой SchemaIR и делает всё сам: читает текущую схему, сравнивает, генерит engine-специфичный SQL, выполняет. Это правильный подход, потому что логика сравнения и SQL-генерации завязана на конкретный движок (SQLite MODIFY COLUMN ≠ MySQL MODIFY COLUMN, разные форматы идентификаторов, разные supported операции).

**Особенности SQLite:**
- `ALTER TABLE DROP COLUMN` доступен с SQLite 3.35.0+
- `ALTER TABLE MODIFY COLUMN` НЕ поддерживается → генерируется комментарий-предупреждение; реальная поддержка через table rebuild будет в будущей фазе
- FK операции требуют table rebuild → генерируется комментарий-предупреждение
- Выполнение: `PRAGMA foreign_keys = OFF` → SQL → `PRAGMA foreign_keys = ON`

**Критерий готовности:** `adapter.migrateToSchema(target, { dryRun: true })` возвращает корректный MigrationPlan. `adapter.migrateToSchema(target)` выполняет CREATE TABLE и ALTER TABLE ADD/DROP COLUMN в реальной SQLite БД. 13 новых тестов.

---

## Фаза 8: Команда Migrate (полная)

| Задача | Файл | Детали |
|--------|------|--------|
| Бизнес-логика | `src/core/migrator.ts` | Алгоритм из SPEC 6.2: DBML → parseDbml → SchemaIR, adapter.connect → adapter.migrateToSchema(targetIR, options) |
| Интеграция | `src/cli/migrate.ts` | Связывает профили/флаги, парсер, адаптер |
| Цветной вывод SQL | `src/cli/migrate.ts` | ANSI-цвета по SPEC 6.4 (зелёный CREATE, синий ADD, жёлтый MODIFY, красный DROP, серый комментарии, жирный ключевые слова) |
| Dry-run | `src/cli/migrate.ts` | Флаг `--dry-run` → вывод SQL без выполнения |
| Вставка записей | `src/cli/migrate.ts` | Флаг `--insert` → проверка и вставка Records из DBML (если есть) |

**Критерий готовности:**
- `dbs migrate --profile prod --dry-run` — выводит цветные SQL-команды, не выполняет. `EXIT OK [dry-run: N operations previewed]`
- `dbs migrate --profile prod` — выполняет миграцию, выводит цветной прогресс. `EXIT OK [N operations applied]`
- Ошибки миграции → `EXIT ERROR [MIGRATE]` / `EXIT ERROR [TRANSACTION]` с контекстом

---

## Фаза 9: Адаптер MySQL (Snash + Migrate)

| Задача | Файл | Детали |
|--------|------|--------|
| Чтение схемы | `src/adapters/mysql.ts` | Запросы к `information_schema.TABLES`, `COLUMNS`, `STATISTICS`, `KEY_COLUMN_USAGE`, `TRIGGERS`, `VIEWS`, `ROUTINES` |
| Запись схемы | `src/adapters/mysql.ts` | `CREATE TABLE`, `ALTER TABLE ADD/DROP/MODIFY`, `CREATE/DROP INDEX`, `ADD/DROP FOREIGN KEY` |
| ENUM | `src/adapters/mysql.ts` | `getEnums()`: извлечение ENUM-типов из information_schema |
| Engine/Charset | `src/adapters/mysql.ts` | Чтение/запись `ENGINE`, `CHARSET`, `COLLATION` через `// @dbs:` |
| NPM-зависимость | — | `mysql2` |

**Критерий готовности:** полный roundtrip MySQL: snash → DBML → migrate на чистую БД MySQL → snash → идентичный DBML.

---

## Фаза 10: Финальная полировка

| Задача | Детали |
|--------|--------|
| Валидация `--prefix` | Проверка и обрезка префикса в snash, добавление в migrate Префикс работает только с таблицами. Если указан в snash то он делает снепшот только таблиц с этим префиксом но при сохранении в dmbl этот префикс удаляется. Если указан в migrate то добавляет этот префикс к таблицам. Префикс это чать профиля. А значит и интерактивного ввода тоже. |
| Обработка `--file` | Путь к входному DBML для migrate or snash (по умолчанию `./schema.dbml`) |
| Проверка всех кодов ошибок | Полное покрытие всех `EXIT ERROR` из таблицы SPEC |
| Чистка и финализация типов | Убрать `any`, проверить `strict: true` |
| Украшение | Делаем все сообщения оформлены разными цветами |
| сообщения | Все сообщения в терминал и надписи интеракитвного режима должны быть на английском. |

**Критерий готовности:** проект готов к публикации в NPM.

---

## Диаграмма зависимостей фаз

```
Фаза 0: Инициализация
  └─► Фаза 1: Типы и интерфейсы
       ├─► Фаза 2: CLI-скелет
       │    └─► Фаза 6: Snash ─────────────────────────┐
       │         (зависит: Фаза 1, 2, 4, 5)             │
       │                                                │
       ├─► Фаза 3: DBML-парсер                          ├─► Фаза 10: Полировка
       │    └─► Фаза 5: DBML-генератор                  │
       │         └─► Фаза 8: Migrate ───────────────────┘
       │              (зависит: Фаза 1, 2, 3, 5, 7)
       │
       └─► Фаза 4: SQLite Snash
            └─► Фаза 7: SQLite Migrate
                 └─► Фаза 9: MySQL
                      (зависит: Фаза 3, 4, 5, 7 — повторяет паттерн)
```

**Ключевой момент:** Адаптеры MySQL (Фаза 9) можно делать параллельно с Фазой 8 после завершения Фазы 7 — они независимы, но используют те же интерфейсы.

---

## Оценка трудозатрат

| Фаза | Описание | Сложность |
|------|----------|-----------|
| 0 | Инициализация | ⭐ |
| 1 | Типы и интерфейсы | ⭐⭐ |
| 2 | CLI-скелет | ⭐⭐ |
| 3 | Парсер DBML | ⭐⭐⭐ |
| 4 | SQLite Snash | ⭐⭐ |
| 5 | DBML-генератор | ⭐⭐⭐ |
| 6 | Snash (полная) | ⭐⭐ |
| 7 | SQLite Migrate | ⭐⭐⭐ |
| 8 | Migrate (полная) | ⭐⭐⭐ |
| 9 | MySQL | ⭐⭐⭐⭐ |
| 10 | Полировка | ⭐⭐ |
