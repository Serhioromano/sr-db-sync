
# ЧАСТЬ 2: ИНФРАСТРУКТУРА И ДОКУМЕНТАЦИЯ

> В этом разделе — Makefile, публикация, README, AI-документация и организационные вопросы.
> Эту часть можно обрабатывать отдельно от функционала.

---

## 9. Makefile и публикация

### 9.1 Полный Makefile

```makefile
.PHONY: build publish install

build:
	bun build ./src/index.ts --outdir ./dist --target bun

install:
	bun install

publish: build
	@# 1. Проверить, что передана версия
	@test -n "$(v)" || { \
		echo "❌ Usage: make publish v=<version>"; \
		echo "   Example: make publish v=patch"; \
		echo "   Valid: major, minor, patch, premajor, preminor, prepatch, prerelease"; \
		exit 1; \
	}
	@# 2. Проверить GitHub CLI
	@command -v gh >/dev/null 2>&1 || { \
		echo "❌ GitHub CLI (gh) not found. Install: https://cli.github.com/"; \
		exit 1; \
	}
	@# 3. Проверить авторизацию в GitHub
	@gh auth status >/dev/null 2>&1 || { \
		echo "❌ Not logged in to GitHub. Run: gh auth login"; \
		exit 1; \
	}
	@# 4. Проверить авторизацию в npm
	@npm ping >/dev/null 2>&1 || { \
		echo "❌ Not logged in to npm."; \
		echo "   Create a token at https://www.npmjs.com/settings/<your-username>/tokens"; \
		echo "   Then run: npm config set //registry.npmjs.org/:_authToken <token>"; \
		exit 1; \
	}
	@# 5. Закоммитить незакоммиченные изменения
	@if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then \
		echo "📦 Uncommitted changes found. Committing..."; \
		git add -A; \
		git commit -m "Prepare for new version $(v)"; \
	fi
	@# 6. Синхронизация с remote
	@git pull --rebase origin main
	@# 7. Поднять версию в package.json
	@newver=$$(npm version $(v) 2>&1 | tail -1); \
		echo "🏷️  Version bumped: $$newver"
	@# 8. Запушить с тегами
	@git push origin main --follow-tags
	@echo "🚀 Pushed to GitHub"
	@# 9. Опубликовать в npm
	@npm publish
	@echo "📦 Published db-sync to npm"
	@# 10. Создать GitHub Release из CHANGELOG.md
	@tag=$$(git describe --tags --abbrev=0); \
		notes_file=$$(mktemp); \
		awk -v ver="## [$$tag]" 'found && /^## \[/{exit} {print} /^## \[/ && $$0 == ver{found=1}' CHANGELOG.md > "$$notes_file"; \
		if [ ! -s "$$notes_file" ]; then \
			echo "⚠️  No release notes found in CHANGELOG.md for $$tag, using auto-generated notes"; \
			gh release create "$$tag" --title "$$tag" --generate-notes; \
		else \
			echo "📝 Release notes extracted ($$(wc -l < "$$notes_file") lines)"; \
			gh release create "$$tag" --title "$$tag" --notes-file "$$notes_file"; \
		fi; \
		rm -f "$$notes_file"; \
		echo "🎉 GitHub release created: $$tag"
```

### 9.2 Что делает `make publish`

| Шаг | Действие | Проверка / Результат |
|-----|----------|---------------------|
| 1 | Проверяет `v=<version>` | Обязательный параметр: `patch`, `minor`, `major` |
| 2 | Проверяет наличие `gh` CLI | Ошибка если не установлен |
| 3 | Проверяет `gh auth login` | Ошибка если не залогинен |
| 4 | Проверяет `npm ping` | Ошибка если нет npm-токена |
| 5 | Коммитит незакоммиченные изменения | Автоматический коммит |
| 6 | `git pull --rebase` + `git push` | Синхронизация с основной веткой |
| 7 | `npm version <v>` | Бампает версию в package.json |
| 8 | `git push --follow-tags` | Пушит тег версии |
| 9 | `npm publish` | Публикация в npm registry |
| 10 | `gh release create` | GitHub Release из CHANGELOG.md |

### 9.3 Примеры

```bash
make publish v=patch    # 1.0.0 → 1.0.1
make publish v=minor    # 1.0.1 → 1.1.0
make publish v=major    # 1.1.0 → 2.0.0
```

### 9.4 CHANGELOG.md (формат)

```markdown
# Changelog

## [1.0.1] - 2026-06-17

### Fixed
- Исправлена обработка NULL-значений в MySQL адаптере

### Added
- Поддержка параметра `--dry-run` для migrate

## [1.0.0] - 2026-06-15

### Added
- Первый релиз db-sync
- Поддержка SQLite и MySQL
- Команды snash и migrate
```

---

## 10. package.json

```json
{
  "name": "db-sync",
  "version": "1.0.0",
  "description": "Bidirectional DB ↔ DBML sync utility — snapshot and smart migration",
  "main": "dist/index.js",
  "bin": {
    "dbs": "./dist/index.js"
  },
  "files": ["dist/"],
  "scripts": {
    "build": "bun build ./src/index.ts --outdir ./dist --target bun"
  }
}
```

---

## 11. README.md

Файл `README.md` в корне проекта. Содержит: описание проблемы, решение, быстрый старт, примеры.

### 11.1 Заголовок и девиз

```markdown
# db-sync

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

**db-sync** решает это иначе.
```

### 11.3 Решение

```markdown
## Решение

**db-sync** не хранит историю миграций. Он работает с конечным состоянием:

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
npm install -g db-sync

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
# AI Guide: db-sync

> Read this to use db-sync effectively as an AI agent.

## Overview

db-sync is a CLI utility for bidirectional sync between databases and DBML.
- `dbs snash` — export DB schema → DBML file
- `dbs migrate` — apply DBML file → database (smart migration)

## Quick Install

npm install -g db-sync

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
