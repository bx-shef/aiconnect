# aiconnect

> Last reviewed: 2026-09-28

Приложение для облачного Битрикс24 **`shef.aiconnect`**: подключает вашу модель (ваш API-ключ)
к BitrixGPT как AI-провайдера (`ai.engine.register`). Модель появится в списках выбора модели в
настройках BitrixGPT рядом со штатными. Первый провайдер — DeepSeek; дальше любой
OpenAI-совместимый.

Статус: **каркас (этап 0)** — приложение ставится в портал и сохраняет токены установки;
подключения моделей ещё нет. План — [`docs/PLAN.md`](docs/PLAN.md), как это устроено у
Битрикс24 — [`docs/RESEARCH.md`](docs/RESEARCH.md). Репозиторий начат с шаблона
[`invoice-from-tasks`](https://github.com/bx-shef/invoice-from-tasks); его предметная часть удалена.

## Быстрый старт

```bash
pnpm install
cp .env.example .env    # заполнить
pnpm build && node .output/server/index.mjs
```

Подключение к порталу и проверка установки — [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Документация

Указатель — [`docs/README.md`](docs/README.md). Главное: устройство —
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), вызовы REST и права —
[`docs/REST_METHODS.md`](docs/REST_METHODS.md), правила работы с репозиторием —
[`docs/AGENT_RULES.md`](docs/AGENT_RULES.md).

## Требования

Node.js 22+, pnpm 10 (версия — в `packageManager`). Публичный https-адрес для сервера.
Облачный Битрикс24 (в коробке `ai.engine.register` недоступен). Права приложения в портале:
`ai_admin`, `user_brief`.

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | разработка |
| `pnpm check` | линт, проверка типов, тесты |
| `pnpm build` | сборка сервера |
| `pnpm test` | только тесты |
| `pnpm smoke` | смок на тестовом портале (`docs/SMOKE.md`) |

## Разработка

Ветка от `main` → PR → ревью (`/code-review` + панель из пяти) → зелёный CI → squash-мерж.
В `main` напрямую не коммитим. Подробно — [`docs/AGENT_RULES.md`](docs/AGENT_RULES.md).

## Лицензия

MIT — [`LICENSE`](LICENSE).
