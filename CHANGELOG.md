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

### Added (Initial)
- `SPEC.md` — полная спецификация утилиты
- `PLAN.md` — пофазовый план реализации
- `.pi/SYSTEM.md` — системный промпт агента Pi
- `.pi/APPEND_SYSTEM.md` — обязательные требования для агента Pi
- `README.md` — описание проекта и roadmap
- Fallow добавлен как devDependency для проверки TypeScript кода
