# Обязательные требования

## 1. Обновление документации после работы с TypeScript

После завершения работы с любым файлом TypeScript (`.ts`, `.tsx`) необходимо:
- Обновить `README.md`
- Обновить `.pi/SYSTEM.md`
- Обновить `CHANGELOG.md`

## 2. Проверка через Fallow

После изменения любого файла TypeScript необходимо проверить его при помощи утилиты **Fallow**.

### Установка и использование Fallow

Fallow — утилита для анализа dead code, дубликатов и здоровья кодовой базы.

```bash
# Установка (уже добавлена как devDependency)
npm install

# Быстрый запуск (все проверки разом)
npx fallow

# Отдельные проверки
npx fallow dead-code     # неиспользуемый код
npx fallow dupes         # дубликаты
npx fallow health        # сложность и кандидаты на рефакторинг

# Превью авто-исправлений
npx fallow fix --dry-run

# JSON-вывод (для агентов/CI)
npx fallow --format json
```

114 встроенных плагинов покрывают Next.js, Vite, Ember, Jest, Tailwind и другие фреймворки. Первый запуск не требует конфигурации.

Ссылка на документацию: https://fallow.tools/docs/quickstart/
