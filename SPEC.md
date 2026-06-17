# Спецификация db-sync

> Утилита для двунаправленной конвертации между базой данных и DBML (Database Markup Language)

---

# ЧАСТЬ 1: ФУНКЦИОНАЛ УТИЛИТЫ

> В этом разделе — всё, что относится непосредственно к коду, архитектуре и возможностям db-sync.
> Именно эту часть нужно передавать ИИ-разработчику для реализации.

---

## 1. Общее описание

**db-sync** — CLI-утилита, которая:

- **Snash (Snapshot)** — подключается к БД, извлекает полную схему (таблицы, колонки, типы, умолчания, индексы, внешние ключи) и сохраняет в файл формата DBML. Возможности, не поддерживаемые стандартом DBML, сохраняются в специальных комментариях `// @dbs:` для последующего восстановления.

- **Migrate** — читает DBML-файл и применяет схему к базе данных наименее деструктивным способом:
  - Таблицы, которых нет в БД → создаются
  - Таблицы, которых нет в DBML → оставляет как есть (не трогает)
  - Поля новых таблиц → создаются
  - Поля, добавленные в DBML для существующей таблицы → ALTER ADD
  - Поля, удалённые из DBML (были в БД, но не в DBML) → ALTER DROP
  - Поля с изменённым типом/настройками → ALTER MODIFY
  - Индексы и внешние ключи → синхронизируются аналогично (добавить/удалить/изменить)

**Ключевые преимущества формата DBML:**

- **Визуализация схемы.** DBML-файлы открываются в визуальных редакторах (dbdiagram.io и др.) — можно увидеть всю структуру базы данных как диаграмму, со связями и таблицами.
- **Git-friendly.** DBML — это plain text. Файлы `.dbml` отлично работают в Git: diff, blame, pull requests, code review. Команда может совместно работать над структурой базы данных так же, как над кодом.
- **Единый source of truth.** Один DBML-файл = полная схема БД. Не нужно читать 50 файлов миграций, чтобы понять текущую структуру.

---

## 2. Технологический стек

| Компонент | Технология |
|-----------|------------|
| Рантайм | **Bun** |
| Язык | **TypeScript** |
| CLI | Встроенный парсинг аргументов через Bun |
| Формат вывода | DBML (Database Markup Language) |
| Публикация | NPM / BAN / любой npm-совместимый registry |

---

## 3. Структура проекта (только код)

```
db-sync/
├── src/
│   ├── index.ts                  # Точка входа CLI (команда dbs)
│   ├── cli/
│   │   ├── snash.ts              # Подкоманда snash
│   │   └── migrate.ts            # Подкоманда migrate
│   ├── core/
│   │   ├── snapper.ts            # Бизнес-логика: БД → DBML
│   │   ├── migrator.ts           # Бизнес-логика: DBML → БД (умная миграция)
│   │   └── differ.ts             # Сравнение схем: текущая БД vs DBML (дифф)
│   ├── adapters/
│   │   ├── adapter.interface.ts  # Абстрактный интерфейс адаптера
│   │   ├── sqlite.ts             # Адаптер SQLite
│   │   └── mysql.ts              # Адаптер MySQL
│   ├── config/
│   │   ├── profiles.ts           # Загрузка и парсинг JSON-профилей
│   │   └── config.types.ts       # Типы конфигурации
│   ├── parser/
│   │   ├── dbml-lexer.ts         # Лексер DBML
│   │   └── dbml-parser.ts        # Парсер DBML → промежуточное представление
│   ├── generator/
│   │   └── dbml-writer.ts        # Генератор DBML из промежуточного представления
│   └── utils/
│       └── comments.ts           # Кодирование/декодирование @dbs-комментариев
├── package.json
├── tsconfig.json
└── .dbs.json                     # Файл профилей (в корне проекта)
```

---

## 4. CLI — команда `dbs`

### 4.1 Подкоманды

| Команда | Назначение |
|---------|-----------|
| `dbs snash` | Сделать снимок БД → файл DBML |
| `dbs migrate` | Применить DBML к БД (умная миграция) |

### 4.2 Параметры

#### Способ A: явные флаги

```
dbs snash --dsn "./my.db" --engine sqlite --prefix "mypref_"
dbs snash --dsn "mysql://user:***@localhost:3306/mydb" --engine mysql --prefix "mypref_"
```

| Флаг | Описание | Пример |
|------|----------|--------|
| `--dsn` | Строка подключения (Data Source Name) | `./my.db`, `mysql://user:***@host/db` |
| `--engine` | Движок базы данных | `sqlite`, `mysql` |
| `--prefix` | Префикс для имён таблиц (опционально) | `mypref_` |

#### Способ B: профиль из JSON-файла

```
dbs snash --profile "prod"
dbs migrate --profile "prod"
```

Файл профилей `.dbs.json` ищется в корне рабочей директории (или в директории, из-под которой запускается команда). Также можно указать другой путь через `--profiles-file`:

```json
{
  "prod": {
    "dsn": "./my.db",
    "engine": "sqlite",
    "prefix": "mypref_"
  },
  "staging": {
    "dsn": "mysql://user:***@staging-host:3306/mydb",
    "engine": "mysql",
    "prefix": ""
  }
}
```

### 4.3 Дополнительные флаги

| Флаг | Подкоманда | Описание | По умолчанию |
|------|-----------|----------|--------------|
| `--output` | snash | Путь к выходному DBML-файлу | `./schema.dbml` |
| `--input` | migrate | Путь к входному DBML-файлу | `./schema.dbml` |
| `--dry-run` | migrate | Показать SQL-команды (цветные) без выполнения | `false` |
| `--profiles-file` | обе | Путь к JSON-файлу профилей | `.dbs.json` (в рабочей директории) |
| `--insert` | migrate | Если флаг установлен, то миграция не только стурктур востанавливает а проверяет так же Records и вставляет если их нет. | `false` |


### 4.4 AI-friendly вывод и обработка ошибок

Вывод всех команд спроектирован так, чтобы искусственный интеллект мог однозначно его интерпретировать.

#### Структура вывода

Каждая команда завершается одной из двух строк:

```
EXIT OK [<details>]
EXIT ERROR [<error-code>] <message>
```

Между началом и финальной строкой — человекочитаемый вывод (цветной, с эмодзи). ИИ-агент может игнорировать середину и смотреть только на финальную строку.

#### Коды ошибок

| Код | Категория | Описание |
|-----|-----------|----------|
| `CONFIG` | Конфигурация | `.dbs.json` не найден, невалидный JSON, отсутствует профиль |
| `CONNECT` | Подключение | Не удалось подключиться к БД (DSN, порт, хост, креды) |
| `ENGINE` | Движок | Неподдерживаемый `--engine`, отсутствует адаптер |
| `SCHEMA_READ` | Чтение схемы | Ошибка при извлечении таблиц/колонок/индексов из БД |
| `DBML_PARSE` | Парсинг DBML | Синтаксическая ошибка в DBML-файле |
| `DBML_WRITE` | Запись DBML | Ошибка записи выходного файла |
| `MIGRATE` | Миграция | Ошибка при выполнении SQL (конкретная операция + строка) |
| `TRANSACTION` | Транзакция | Ошибка при commit/rollback |

#### Формат ошибки (stderr)

Ошибки выводятся в структурированном формате:

```
ERROR [CONNECT] Failed to connect to database
  engine: mysql
  dsn: mysql://user:***@localhost:3306/mydb
  cause: Connection refused (OS Error: 111)
  hint: Check that MySQL is running on localhost:3306
```

Обязательные поля: `ERROR [<code>]`, `cause`. Опциональные: `engine`, `dsn`, `hint`, `file`, `line`, `operation`, `table`, `column`.

#### Exit codes

| Exit code | Значение |
|-----------|----------|
| 0 | Успех |
| 1 | Ошибка конфигурации |
| 2 | Ошибка подключения |
| 3 | Ошибка схемы/парсинга |
| 4 | Ошибка миграции |
| 5 | Ошибка записи файла |

ИИ-агент может полагаться на exit code для определения категории ошибки без парсинга текста.

---

## 5. Команда Snash — детальное описание

### 5.1 Что извлекается из БД

| Элемент БД | Что именно | Куда в DBML |
|------------|-----------|-------------|
| **Таблицы** | Имя таблицы (с учётом `--prefix`) | `Table <name> { ... }` |
| **Колонки** | Имя, тип, nullable, default, PK, unique, auto-increment | Настройки колонки `[pk, increment, not null, ...]` |
| **Индексы** | Состав, уникальность, имя, тип (btree/hash) | Блок `Indexes { ... }` внутри таблицы |
| **Внешние ключи** | Колонка-источник, таблица-цель, колонка-цель, ON DELETE, ON UPDATE | `Ref: source.col > target.col [delete: cascade]` |
| **Enum (MySQL)** | Допустимые значения enum-колонок | `Enum <name> { ... }` или `// @dbs:enum:` |
| **Триггеры** | Тело триггера (нестандарт DBML) | `// @dbs:trigger:` |
| **Представления (Views)** | Определение view | `// @dbs:view:` |
| **Хранимые процедуры** | Тело процедуры | `// @dbs:procedure:` |
| **CHECK-ограничения** | Условие проверки | `// @dbs:check:` |

### 5.2 Алгоритм Snash

```
1. Парсим аргументы (флаги или профиль)
2. Выбираем адаптер по --engine
3. adapter.connect(dsn)
4. Извлекаем список таблиц:      adapter.getTables()
5. Для каждой таблицы:
   a. Извлекаем колонки:         adapter.getColumns(tableName)
   b. Извлекаем индексы:         adapter.getIndexes(tableName)
   c. Извлекаем внешние ключи:   adapter.getForeignKeys(tableName)
   d. Извлекаем триггеры:        adapter.getTriggers(tableName)
6. Извлекаем глобальные объекты:
   a. Представления:             adapter.getViews()
   b. Хранимые процедуры:        adapter.getProcedures()
   c. Enum-типы:                 adapter.getEnums()
7. Формируем промежуточное представление (IR)
8. Генерируем DBML-файл (dbml-writer.ts)
9. Сохраняем в --output
```

---

## 6. Команда Migrate — детальное описание

### 6.1 Принцип умной миграции

Миграция НЕ пересоздаёт базу с нуля. Она сравнивает текущее состояние БД с целевым (из DBML) и генерирует минимальный набор ALTER-операций.

### 6.2 Алгоритм Migrate

```
1. Парсим аргументы (флаги или профиль)
2. Читаем и парсим DBML-файл (--input) → целевая схема
3. Выбираем адаптер по --engine
4. adapter.connect(dsn)
5. Извлекаем текущую схему БД: adapter.getSchema()
6. differ.ts сравнивает текущую и целевую схемы:

   ДЛЯ ТАБЛИЦ:
   ├── Таблица есть в DBML, но не в БД → CREATE TABLE
   ├── Таблица есть в БД, но не в DBML → ничего не делаем (не удаляем)
   └── Таблица есть и там, и там → сравниваем колонки:

   ДЛЯ КОЛОНОК (внутри таблицы):
   ├── Колонка есть в DBML, но не в БД → ALTER TABLE ADD COLUMN
   ├── Колонка есть в БД, но не в DBML → ALTER TABLE DROP COLUMN ⚠️
   ├── Колонка есть в обоих, но тип/настройки различаются → ALTER TABLE MODIFY COLUMN
   └── Колонка идентична → ничего не делаем

   ДЛЯ ИНДЕКСОВ:
   ├── Индекс есть в DBML, но не в БД → CREATE INDEX
   ├── Индекс есть в БД, но не в DBML → DROP INDEX
   └── Индекс идентичен → ничего не делаем

   ДЛЯ FOREIGN KEYS:
   ├── FK есть в DBML, но не в БД → ALTER TABLE ADD CONSTRAINT
   ├── FK есть в БД, но не в DBML → ALTER TABLE DROP FOREIGN KEY
   └── FK идентичен → ничего не делаем

7. Если --dry-run → вывести SQL-команды в терминал (цветные) без выполнения
8. Иначе → вывести SQL-команды и выполнить их в транзакции (где поддерживается)
9. adapter.disconnect()

Примечание: и в dry-run, и в реальном режиме SQL-команды выводятся в терминал.
Разница: dry-run НЕ выполняет их, реальный режим — выполняет.
```

### 6.3 Безопасность миграции

- ⚠️ **Удаление колонок** (DROP COLUMN) — самая опасная операция. При `--dry-run` показывается предупреждение.
- Таблицы, которых нет в DBML — **не трогаем** (миграция не удаляет таблицы, чтобы не потерять данные)
- При возможности — оборачиваем миграцию в транзакцию
- Перед миграцией рекомендуется делать резервную копию (`dbs snash` — уже своего рода backup схемы)

### 6.4 Вывод SQL-команд — цветовая схема

При выполнении `dbs migrate` (и в dry-run, и в реальном режиме) SQL-команды выводятся в терминал с цветовой разметкой. Используются ANSI-escape коды.

#### Цвета по типу операции

| Операция | Цвет | ANSI |
|----------|------|------|
| `CREATE TABLE` | Зелёный | `\x1b[32m` |
| `CREATE INDEX` | Зелёный | `\x1b[32m` |
| `ALTER TABLE ADD` | Синий | `\x1b[34m` |
| `ALTER TABLE MODIFY` | Жёлтый | `\x1b[33m` |
| `ALTER TABLE DROP` | Красный | `\x1b[31m` |
| `DROP INDEX` | Красный | `\x1b[31m` |
| `ADD FOREIGN KEY` | Синий | `\x1b[34m` |
| `DROP FOREIGN KEY` | Красный | `\x1b[31m` |
| Ключевые слова SQL | Жирный | `\x1b[1m` |
| Комментарии `--` | Серый | `\x1b[90m` |
| Сброс | — | `\x1b[0m` |

#### Пример вывода `dbs migrate --dry-run`

```
🧪 DRY RUN — SQL-команды НЕ будут выполнены:

\033[32mCREATE TABLE users (\033[0m
\033[32m  id INTEGER PRIMARY KEY AUTOINCREMENT,\033[0m
\033[32m  email VARCHAR(255) NOT NULL UNIQUE,\033[0m
\033[32m  name VARCHAR(100) NOT NULL\033[0m
\033[32m);\033[0m

\033[34mALTER TABLE posts ADD COLUMN updated_at TIMESTAMP NULL;\033[0m

\033[33m-- MODIFY: тип колонки title изменён (VARCHAR(100) → VARCHAR(255))\033[0m
\033[33mALTER TABLE posts MODIFY COLUMN title VARCHAR(255) NOT NULL;\033[0m

\033[31m⚠️  ALTER TABLE posts DROP COLUMN legacy_field;\033[0m

\033[32mCREATE INDEX idx_posts_user_id ON posts (user_id);\033[0m

✅ Существующие таблицы без изменений: roles, permissions, audit_log
ℹ️  Всего операций: 5 (2 CREATE, 1 ADD, 1 MODIFY, 1 DROP)
EXIT OK [dry-run: 5 operations previewed]
```

#### Пример вывода `dbs migrate` (реальный режим)

```
🚀 Выполняю миграцию...

\033[32m✓ CREATE TABLE users\033[0m
\033[34m✓ ALTER TABLE posts ADD COLUMN updated_at\033[0m
\033[33m✓ ALTER TABLE posts MODIFY COLUMN title\033[0m
\033[31m✓ ALTER TABLE posts DROP COLUMN legacy_field\033[0m
\033[32m✓ CREATE INDEX idx_posts_user_id\033[0m

✅ Миграция завершена: 5 операций выполнено успешно
EXIT OK [5 operations applied]
```

---

## 7. Архитектура адаптеров

### 7.1 Интерфейс DatabaseAdapter

```typescript
interface DatabaseAdapter {
  // Подключение / отключение
  connect(dsn: string): Promise<void>;
  disconnect(): Promise<void>;

  // ===== Snash: чтение схемы =====
  getTables(): Promise<string[]>;
  getColumns(tableName: string): Promise<ColumnDef[]>;
  getIndexes(tableName: string): Promise<IndexDef[]>;
  getForeignKeys(tableName: string): Promise<FKDef[]>;
  getTriggers(tableName: string): Promise<TriggerDef[]>;
  getViews(): Promise<ViewDef[]>;
  getProcedures(): Promise<ProcedureDef[]>;
  getEnums(): Promise<EnumDef[]>;

  // ===== Migrate: запись схемы =====
  createTable(table: TableDefinition): Promise<void>;
  addColumn(tableName: string, column: ColumnDef): Promise<void>;
  dropColumn(tableName: string, columnName: string): Promise<void>;
  modifyColumn(tableName: string, column: ColumnDef): Promise<void>;
  createIndex(tableName: string, index: IndexDef): Promise<void>;
  dropIndex(tableName: string, indexName: string): Promise<void>;
  addForeignKey(tableName: string, fk: FKDef): Promise<void>;
  dropForeignKey(tableName: string, fkName: string): Promise<void>;

  // Транзакции (где поддерживаются)
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

### 7.2 Типы данных

```typescript
interface ColumnDef {
  name: string;
  type: string;            // 'INTEGER', 'VARCHAR(255)', 'TEXT'
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue?: string;   // 'now()', '0', 'NULL'
  comment?: string;
  enumValues?: string[];   // Для ENUM-типов MySQL
}

interface IndexDef {
  name: string;
  columns: string[];       // ['col1', 'col2']
  unique: boolean;
  type?: string;           // 'btree', 'hash'
}

interface FKDef {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action';
  onUpdate?: 'cascade' | 'set null' | 'restrict' | 'no action';
}

interface TriggerDef {
  name: string;
  timing: 'before' | 'after' | 'instead of';
  event: 'insert' | 'update' | 'delete';
  body: string;
}

interface ViewDef {
  name: string;
  definition: string;      // CREATE VIEW ... AS SELECT ...
}

interface ProcedureDef {
  name: string;
  body: string;
}

interface EnumDef {
  name: string;
  values: string[];
}

interface TableDefinition {
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: FKDef[];
  triggers: TriggerDef[];
}
```

### 7.3 Набор адаптеров

| Адаптер | Файл | Статус |
|---------|------|--------|
| SQLite | `src/adapters/sqlite.ts` | ✅ версия 1.0 |
| MySQL | `src/adapters/mysql.ts` | ✅ версия 1.0 |
| PostgreSQL | `src/adapters/postgres.ts` | 🔮 будущая версия |

Добавление нового адаптера: создать файл `src/adapters/<engine>.ts` и реализовать `DatabaseAdapter`.

---

## 8. Формат DBML — полный справочник

### 8.1 Стандартные конструкции DBML

#### Project (опционально)
```dbml
Project my_project {
  database_type: 'MySQL'
  Note: 'Generated by db-sync'
}
```

#### Table
```dbml
Table users {
  id integer [pk, increment, not null]
  email varchar(255) [not null, unique]
  name varchar(100) [not null]
  bio text [null]
  role varchar(20) [default: 'user']
  created_at timestamp [default: `now()`]
  updated_at timestamp [null]
  Note: 'User accounts table'
}
```

**Column settings (настройки колонок):**

| Setting | DBML | Назначение |
|---------|------|------------|
| primary key | `[pk]` или `[primary key]` | Первичный ключ |
| not null | `[not null]` | Не может быть NULL |
| null | `[null]` | Может быть NULL (явно) |
| unique | `[unique]` | Уникальное значение |
| auto-increment | `[increment]` | Автоинкремент |
| default value | `[default: 'value']` | Значение по умолчанию |
| note | `[note: 'description']` | Комментарий к колонке |
| inline reference | `[ref: > other.col]` | Внешний ключ на месте |

#### Indexes
```dbml
Table users {
  id integer [pk]
  email varchar(255) [unique]
  name varchar(100)
  city varchar(50)
  Indexes {
    email [unique, name: 'idx_email']
    (name, city) [name: 'idx_name_city', type: btree]
  }
}
```

#### Relationships (Ref)
```dbml
// Сокращённый синтаксис:
Ref: posts.user_id > users.id

// Полный синтаксис:
Ref rel_name {
  posts.user_id > users.id [delete: cascade, update: cascade]
}

// Типы связей:
// >   — many-to-one (внешний ключ на левой стороне)
// <   — one-to-many (внешний ключ на правой стороне)
// -   — one-to-one
// <>  — many-to-many (создаётся промежуточная таблица)
```

**Настройки Ref:**

| Setting | Описание |
|---------|----------|
| `[delete: cascade]` | ON DELETE CASCADE |
| `[delete: set null]` | ON DELETE SET NULL |
| `[delete: restrict]` | ON DELETE RESTRICT |
| `[update: cascade]` | ON UPDATE CASCADE |
| `[update: set null]` | ON UPDATE SET NULL |
| `[update: restrict]` | ON UPDATE RESTRICT |

#### Enum
```dbml
Enum role {
  admin
  editor
  viewer
}
```

#### TableGroup
```dbml
TableGroup auth_system {
  users
  roles
  permissions
}
```

#### Note / Comment
```dbml
// Это однострочный комментарий DBML
Table users {
  id integer
  Note: '''
  Это многострочное
  примечание к таблице
  '''
}
```

### 8.2 Расширенные комментарии `// @dbs:`

Для данных, которые не поддерживаются стандартом DBML (триггеры, представления, процедуры, CHECK-ограничения, специфичные настройки движка), используется собственный синтаксис в комментариях:

```
// @dbs:<тип>:<имя>:<параметры>
```

| Тег | Назначение | Пример |
|-----|-----------|--------|
| `@dbs:trigger` | Триггер | `// @dbs:trigger:after_insert_audit:users:AFTER:INSERT` |
| `@dbs:view` | Представление (View) | `// @dbs:view:active_users` |
| `@dbs:procedure` | Хранимая процедура | `// @dbs:procedure:calculate_stats` |
| `@dbs:check` | CHECK-ограничение | `// @dbs:check:users:age_check:age >= 0` |
| `@dbs:engine` | Движок таблицы (MySQL) | `// @dbs:engine:users:InnoDB` |
| `@dbs:charset` | Кодировка таблицы | `// @dbs:charset:users:utf8mb4` |
| `@dbs:collation` | Collation таблицы | `// @dbs:collation:users:utf8mb4_unicode_ci` |
| `@dbs:raw` | Произвольный SQL | `// @dbs:raw:CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` |

#### Пример DBML с расширенными комментариями

```dbml
Project my_project {
  database_type: 'MySQL'
  Note: 'Generated by db-sync v1.0.0'
}

// @dbs:raw:CREATE EXTENSION IF NOT EXISTS "uuid-ossp"

Table users {
  id integer [pk, increment, not null]
  email varchar(255) [not null, unique]
  name varchar(100) [not null]
  created_at timestamp [default: `now()`]
  Indexes {
    email [unique, name: 'idx_users_email']
  }
}

// @dbs:trigger:after_insert_users:users:AFTER:INSERT
// CREATE TRIGGER after_insert_users
// AFTER INSERT ON users
// FOR EACH ROW
// BEGIN
//   INSERT INTO audit_log (table_name, record_id, action)
//   VALUES ('users', NEW.id, 'INSERT');
// END;

Table posts {
  id integer [pk, increment, not null]
  user_id integer [not null]
  title varchar(255) [not null]
  body text [null]
  Indexes {
    user_id [name: 'idx_posts_user_id', type: btree]
  }
}

Ref: posts.user_id > users.id [delete: cascade]

// @dbs:view:active_users
// CREATE VIEW active_users AS
// SELECT u.id, u.name, COUNT(p.id) as post_count
// FROM users u
// LEFT JOIN posts p ON p.user_id = u.id
// GROUP BY u.id, u.name;

// @dbs:procedure:cleanup_old_posts
// CREATE PROCEDURE cleanup_old_posts(IN days_old INT)
// BEGIN
//   DELETE FROM posts WHERE created_at < DATE_SUB(NOW(), INTERVAL days_old DAY);
// END;
```
