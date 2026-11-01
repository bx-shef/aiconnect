# aiconnect

> Last reviewed: 2026-11-01

**Шпион протокола BitrixGPT** для облачного Битрикс24 (`shef.aiconnect`): регистрирует сторонний
AI-движок (`ai.engine.register`) и показывает администратору, что BitrixGPT присылает движку в
каждом сценарии — чат, задачи, CRM, звонки. Инструмент разведки для тестовых порталов, модели за
ним нет. План — [`docs/PLAN.md`](docs/PLAN.md), замеры — [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
Подключение собственной модели клиента к BitrixGPT — отдельное облачное приложение.

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
`ai_admin`, `user_brief`; для тестовых звонков — `telephony`, `crm`.

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
