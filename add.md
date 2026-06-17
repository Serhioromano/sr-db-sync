##  README.md

Файл `README.md` в корне проекта. Содержит: описание проблемы, решение, быстрый старт, примеры.

### 11.1 Заголовок и девиз

```markdown
# sr-db-sync

> Состояние БД — единственный источник правды. Всегда.
```

### 11.2 Проблема (почему проект создан)

```markdown
## Проблема

Классический подход к миграциям баз данных сложен и ненадёжен:

1. **Миграции накапливаются.** Каждое изменение схемы — новый файл миграции.
   Через полгода у вас 50+ файлов, и понять текущую схему можно только прочитав их все.

2. **Пошаговые действия хрупки.** Сначала `CREATE TABLE`, потом `ALTER TABLE ADD COLUMN`,
   потом `ALTER TABLE MODIFY`... Одна ошибка в цепочке — и база в неконсистентном состоянии.

3. **Сбой миграции = потеря ориентира.** Если миграция упала на середине,
   вы не знаете, что уже применено, а что нет. Восстановление требует ручного анализа.

4. **Синхронизация с кодом — боль.** Разработчик изменил схему локально,
   а миграцию забыл написать. Production начинает падать с ошибками о недостающих колонках.

**sr-db-sync** решает это иначе.
```

### 11.3 Решение

```markdown
## Решение

**sr-db-sync** не хранит историю миграций. Он работает с конечным состоянием:

Текущая БД  →  dbs snash   →  schema.dbml  (фиксируем состояние)
schema.dbml →  dbs migrate  →  БД           (приводим к целевому)

- **Snash** — делает «слепок» схемы базы данных в файл DBML.
  Это твоя документация, твой source of truth.
- **Migrate** — читает DBML и применяет схему к базе наименее деструктивным способом:
  добавляет недостающие колонки, удаляет лишние, меняет типы.
  Не пересоздаёт таблицы. Сохраняет данные.

### Почему DBML?

- **Визуальный просмотр.** Открой `.dbml` файл в dbdiagram.io — и увидишь схему как диаграмму.
- **Git для структуры БД.** DBML — это plain text. Diff, blame, pull requests, code review — всё работает. Команда может совместно работать над схемой БД так же, как над кодом.

Не важно, на версию вперёд или назад — инструмент сам определит разницу
и выполнит только необходимое. База всегда приходит к тому состоянию,
которое описано в DBML.
```

### 11.4 Быстрый старт

```markdown
## Быстрый старт

### Установка
npm install -g sr-db-sync

### Создай .dbs.json в корне проекта
cat > .dbs.json << 'EOF'
{
  "dev": {
    "dsn": "./dev.db",
    "engine": "sqlite",
    "prefix": ""
  },
  "prod": {
    "dsn": "mysql://user:pass@localhost:3306/mydb",
    "engine": "mysql",
    "prefix": ""
  }
}
EOF

### Сделать снимок схемы
dbs snash --profile dev

### Применить схему к базе (умная миграция)
dbs migrate --profile prod

### Посмотреть, что будет изменено (без реальных правок)
dbs migrate --profile prod --dry-run
```

### 11.5 Примеры использования

```markdown
## Примеры

### Снять снимок
dbs snash --dsn ./my.db --engine sqlite --prefix mypref_
dbs snash --profile "prod"
dbs snash --dsn "mysql://..." --engine mysql --output ./docs/schema.dbml

### Применить миграцию
dbs migrate --profile "prod"
dbs migrate --profile "dev" --input ./schema.dbml
dbs migrate --profile "prod" --dry-run
```

### 11.6 Поддерживаемые БД

```markdown
## Поддерживаемые БД

| Движок | Статус |
|--------|--------|
| SQLite | ✅ |
| MySQL  | ✅ |
| PostgreSQL | 🔮 planned |
```

### 11.7 Лицензия

```markdown
## Лицензия
MIT
```

---

## 12. AI.md — документация для искусственного интеллекта

Файл `AI.md` в корне проекта. Написан так, чтобы ИИ-агент, прочитав его, сразу понял как работать с утилитой: установка, все команды, все флаги, форматы ввода/вывода, коды ошибок, типичные сценарии.

### 12.1 Содержание AI.md

```markdown
# AI Guide: sr-db-sync

> Read this to use sr-db-sync effectively as an AI agent.

## Overview

sr-db-sync is a CLI utility for bidirectional sync between databases and DBML.
- `dbs snash` — export DB schema → DBML file
- `dbs migrate` — apply DBML file → database (smart migration)

## Quick Install

npm install -g sr-db-sync

## Configuration

Profiles live in `.dbs.json` in the working directory:

{
  "profile_name": {
    "dsn": "connection-string",
    "engine": "sqlite|mysql",
    "prefix": "optional_table_prefix"
  }
}

## Commands

### dbs snash — Export schema to DBML

dbs snash --dsn <string> --engine <sqlite|mysql> [--prefix <string>] [--output <path>]
dbs snash --profile <name> [--profiles-file <path>] [--output <path>]

Output: DBML file at --output (default: ./schema.dbml)

### dbs migrate — Apply DBML to database

dbs migrate --dsn <string> --engine <sqlite|mysql> [--prefix <string>] [--input <path>]
dbs migrate --profile <name> [--profiles-file <path>] [--input <path>] [--dry-run]

Flags:
  --dry-run    Preview SQL without executing (always use this first!)
  --input      DBML file to apply (default: ./schema.dbml)

## Output Format

Every command ends with exactly one of:

EXIT OK [<details>]
EXIT ERROR [<code>] <message>

On success: exit code 0 + EXIT OK
On failure: non-zero exit code + EXIT ERROR with structured error info

## Error Codes

| Code | Meaning | Typical Fix |
|------|---------|-------------|
| CONFIG | Bad/missing .dbs.json | Check .dbs.json exists and is valid JSON |
| CONNECT | Cannot reach DB | Check DSN, host, port, credentials |
| ENGINE | Unsupported engine | Use 'sqlite' or 'mysql' |
| SCHEMA_READ | Cannot read DB schema | Check permissions, DB accessibility |
| DBML_PARSE | Invalid DBML syntax | Fix the .dbml file |
| DBML_WRITE | Cannot write output | Check disk space, permissions |
| MIGRATE | SQL execution failed | Check the specific operation in error output |
| TRANSACTION | Commit/rollback failed | Check DB state, retry |

## Structured Error Format (stderr)

ERROR [CODE] Short description
  engine: <engine>
  dsn: <dsn>
  file: <path>          # if relevant
  line: <number>        # if DBML parse error
  operation: <sql>      # if migration error
  table: <name>         # if migration error
  column: <name>        # if migration error
  cause: <root cause>
  hint: <suggestion>

## Exit Codes

| Code | Category |
|------|----------|
| 0 | Success |
| 1 | Configuration error |
| 2 | Connection error |
| 3 | Schema/parse error |
| 4 | Migration error |
| 5 | File write error |

## Typical Workflows

### Workflow 1: Initial schema snapshot
dbs snash --dsn ./dev.db --engine sqlite
# → creates schema.dbml
# Commit schema.dbml to version control.

### Workflow 2: Safe migration (always dry-run first!)
dbs migrate --profile prod --dry-run
# Review the SQL output. If OK:
dbs migrate --profile prod

### Workflow 3: Sync dev → staging
dbs snash --profile dev --output ./dev-schema.dbml
dbs migrate --profile staging --input ./dev-schema.dbml --dry-run
# If dry-run looks good:
dbs migrate --profile staging --input ./dev-schema.dbml

### Workflow 4: Diagnose errors
# Step 1: Check config
cat .dbs.json | python -m json.tool

# Step 2: Test connection
dbs snash --profile prod
# → EXIT ERROR [CONNECT] ... → fix DSN
# → EXIT OK → connection works

# Step 3: Parse the error output
# Look for: ERROR [CODE], cause, hint fields
# Use exit code for quick categorization

## Notes

- Always run --dry-run before migrate to preview changes.
- Tables NOT in DBML are never dropped (safe by default).
- DROP COLUMN operations are highlighted in red with ⚠️ warning.
- The tool uses ANSI colors in terminal output; strip \x1b[...m sequences
  if you need plain text parsing.
- DBML files can be visualized: open in dbdiagram.io for a diagram view.
- DBML is Git-friendly: diff, blame, PRs work natively on schema changes.
```
