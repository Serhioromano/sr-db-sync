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
- [ ] Фаза 8: Команда Migrate
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
