# aiconnect

> Last reviewed: 2026-09-28

Приложение для облачного Битрикс24 **`shef.aiconnect`**: подключает вашу модель (ваш API-ключ)
к BitrixGPT. Модель появляется в штатных списках «Выберите модель AI для …» — в CRM, чате,
задачах, видеозвонках — рядом с BitrixGPT. Первый провайдер — DeepSeek; дальше любой
OpenAI-совместимый.

Статус: в разработке, план — [`docs/PLAN.md`](docs/PLAN.md), как это устроено у Битрикс24 —
[`docs/RESEARCH.md`](docs/RESEARCH.md). Репозиторий начат с шаблона `invoice-from-tasks`;
его предметная часть удаляется на этапе 0.

## Быстрый старт

```bash
pnpm install
cp .env.example .env    # заполнить
pnpm build && node .output/server/index.mjs
```

Подключение к порталу и первая настройка — [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Документация

Указатель — [`docs/README.md`](docs/README.md). Главное: как считается счёт —
[`docs/PROCESSING.md`](docs/PROCESSING.md), настройки и место в хранилище —
[`docs/SETTINGS.md`](docs/SETTINGS.md), правила работы с репозиторием —
[`docs/AGENT_RULES.md`](docs/AGENT_RULES.md).

## Требования

Node.js 22+, pnpm 10 (версия — в `packageManager`). Публичный https-адрес для сервера.
Права приложения в портале: `crm`, `task`, `catalog`, `user_brief`, `placement`.

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | разработка |
| `pnpm check` | линт, проверка типов, тесты |
| `pnpm build` | сборка сервера |
| `pnpm test` | только тесты |

## Разработка

Ветка от `main` → PR → ревью (`/code-review` + панель из пяти) → зелёный CI → squash-мерж.
В `main` напрямую не коммитим. Подробно — [`docs/AGENT_RULES.md`](docs/AGENT_RULES.md).

## Лицензия

MIT — [`LICENSE`](LICENSE).
