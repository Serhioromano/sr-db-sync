# db-sync

CLI-утилита для двунаправленной конвертации между базой данных и DBML (Database Markup Language).

- **Snash** — подключается к БД, извлекает схему → файл DBML
- **Migrate** — читает DBML-файл и применяет схему к БД (умная миграция)

## Статус проекта

- [x] Спецификация (SPEC.md)
- [x] План реализации (PLAN.md)
- [x] Фаза 0: Инициализация
- [x] Фаза 1: Типы и интерфейсы
- [x] Фаза 2: CLI-скелет
- [x] Фаза 3: Парсер DBML
- [x] Фаза 4: Адаптер SQLite (Snash)
- [x] Фаза 5: Генератор DBML
- [x] Фаза 6: Команда Snash
- [x] Фаза 7: SQLite Migrate (migrateToSchema)
- [x] Фаза 8: Команда Migrate (полная)
- [ ] Фаза 9: Адаптер MySQL
- [ ] Фаза 10: Полировка

## Технологический стек

| Компонент | Технология |
|-----------|------------|
| Рантайм | **Bun** 1.3.5 |
| Язык | **TypeScript** 5.9 |
| Формат | **DBML** |

## Установка и запуск

```bash
# Клонирование
git clone https://github.com/Serhioromano/db-sync.git
cd db-sync

# Установка зависимостей
bun install

# Запуск (dev-режим)
bun run dev

# Справка
bun run src/index.ts --help

# Версия
bun run src/index.ts --version
```

## Структура проекта

```
db-sync/
├── src/
│   ├── index.ts              # Точка входа CLI (команда dbs)
│   ├── cli/                  # Подкоманды snash / migrate
│   ├── core/                 # Бизнес-логика (snapper, migrator, differ)
│   ├── adapters/             # Адаптеры БД (SQLite, MySQL)
│   ├── config/               # Профили и типы конфигурации
│   ├── parser/               # Лексер и парсер DBML
│   ├── generator/            # Генератор DBML
│   └── utils/                # Утилиты (ошибки, комментарии, вывод)
├── package.json
├── tsconfig.json
└── .dbs.json                 # Файл профилей (в корне проекта)
```



WHen I dry run on existing DB it wants to recreate all foreign kekys. 

```
bun ./src/index.ts migrate

│
◇  Choose a profile or configure manually:
│  migrate
│
◇  Preview SQL only (dry-run)?
│  Yes

  Mode:    🧪 DRY RUN
  Engine:  sqlite
  DSN:     ./migration/new.db
  Input:   ./migration/test2.dbml

│
◇  Apply migration with these settings?
│  Yes

🧪 DRY RUN — SQL-команды НЕ будут выполнены:

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "follows" DROP FOREIGN KEY "fk_follows_users_0"

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "follows" DROP FOREIGN KEY "fk_follows_users_1"

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "follows" ADD FOREIGN KEY ("followed_user_id") REFERENCES "users" ("id")

ALTER TABLE "users" DROP COLUMN "password"

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "posts" DROP FOREIGN KEY "fk_posts_users_0"

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "posts" ADD CONSTRAINT "user_posts" FOREIGN KEY ("user_id") REFERENCES "users" ("id")

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "comments" DROP FOREIGN KEY "fk_comments_posts_0"

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "comments" DROP FOREIGN KEY "fk_comments_users_1"

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "comments" ADD CONSTRAINT "user_comments" FOREIGN KEY ("user_id") REFERENCES "users" ("id")

-- Note: SQLite requires table rebuild for FK changes
ALTER TABLE "comments" ADD CONSTRAINT "post_comments" FOREIGN KEY ("user_id") REFERENCES "posts" ("id")
```

If key already exists because I can see in dry run of creation that it is there.

```
CREATE TABLE "follows" (
  "following_user_id" INTEGER,
  "followed_user_id" INTEGER,
  "created_at" TIMESTAMP,
  FOREIGN KEY ("following_user_id") REFERENCES "users" ("id"),
  FOREIGN KEY ("followed_user_id") REFERENCES "users" ("id")
)

CREATE TABLE "users" (
  "id" INTEGER PRIMARY KEY,
  "username" VARCHAR,
  "password" VARCHAR,
  "role" VARCHAR,
  "created_at" TIMESTAMP
)

CREATE TABLE "posts" (
  "id" INTEGER PRIMARY KEY,
  "title" VARCHAR,
  "body" TEXT,
  "user_id" INTEGER NOT NULL,
  "status" VARCHAR,
  "created_at" TIMESTAMP,
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
)

CREATE TABLE "comments" (
  "id" INTEGER PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "post_id" INTEGER NOT NULL,
  FOREIGN KEY ("user_id") REFERENCES "users" ("id"),
  FOREIGN KEY ("user_id") REFERENCES "posts" ("id")
)
```

We have alter only tables that foreign key was changed. And only for sqlite the process of chage foreign key is to create temporary table, insert into it all the data from old table, delete old table, rename temporary table. Becuae sqlite does not support ALTER TABLE "follows" ADD FOREIGN KEY