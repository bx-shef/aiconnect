# CLAUDE.md

> Last reviewed: 2026-09-28

Приложение Битрикс24 **`shef.aiconnect`**: подключает собственную модель клиента (его API-ключ)
к BitrixGPT как AI-провайдер через `ai.engine.register`. Коды провайдеров —
`sh_aiconnect_<category>`. Первый провайдер — DeepSeek (OpenAI-совместимый API, Vercel AI SDK).
Продаём коннект, а не токены.

**Правила процесса — [`docs/AGENT_RULES.md`](docs/AGENT_RULES.md): они главнее этого файла.**
Коротко: в `main` только через PR; собрал или доработал PR — `/code-review`, по триггерам §3.1 —
панель из пяти сабагентов (`.claude/agents/reviewer-*`, навык `review-panel`); мерж — навык `merge-pr`.

**План — [`docs/PLAN.md`](docs/PLAN.md)**, исследование протокола —
[`docs/RESEARCH.md`](docs/RESEARCH.md), срез — [`docs/project-map.md`](docs/project-map.md).
Сейчас — каркас после этапа 0: установка, токены, проверка фрейма, выкат; провайдеров ещё нет.

Этот файл — карта и конвенции. Держим коротким: журналы, замеры и история — в `docs/`.

## Команды

```bash
pnpm install          # + nuxt prepare (postinstall)
pnpm dev              # разработка; страницы работают только во фрейме портала
pnpm check            # lint + typecheck + test — перед каждым PR
pnpm build            # сборка сервера .output/server/index.mjs
```

## Карта

| Где | Что |
|---|---|
| `app/pages/` | `index` (публичная), `install` (установка: права, события, `installFinish`), `app` (главная в портале; администратору — что не настроено на сервере) |
| `app/composables/` | `useB24` (фрейм, REST v2), `useApi` (наш /api с фрейм-токеном) |
| `app/utils/` | `install` (шаги установки), `frameToken` (свежесть токена фрейма), `serverHealth` (что не настроено на сервере), `profile` (администратор ли) |
| `app/config/b24.ts` | права (`ai_admin`, `user_brief`), события, настройки SDK (без автоповторов записи) — одно место |
| `server/api/` | тонкие обёртки: `b24/events` (установка/удаление), `health` (флаги настроек и коммит сборки) |
| `server/middleware/` | `securityHeaders` (CSP для фрейма), `requestLimits` (размер тела) |
| `server/utils/` | `frameAuth` (кто пришёл), `requestContext` (обвязка обработчиков, IP), `b24Host` (SSRF-гард, CSP, серверы авторизации), `b24Client` (REST через B24OAuth), `b24Events` (разбор события) + `b24EventsHandler` (решение по событию), `verifyInstallMember` (сверка member_id и домена), `tokenStore` + `secretCrypto` (токены установки), `requestLimits` + `rateLimit` (пределы, лимиты, IP за прокси), `buildInfo` (коммит сборки для health) |
| `tests/` | юнит-тесты (vitest, node); `tests/server/` — серверные модули; `repoGuards` — гарды репо; `makefileProd` — цели `make` |
| `docker-compose.prod.yml`, `Makefile` | выкат: `main` → GHCR → Watchtower → nginx-proxy, `aiconnect.bx-shef.by`; проверка сервера — `make doctor` — `docs/DEPLOY.md` |
| `smoke/` | смок на тестовом портале (`pnpm smoke`, свой vitest-конфиг, не в CI): страж портала, формы REST — `docs/SMOKE.md` |

Подробно: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), вызовы REST —
[`docs/REST_METHODS.md`](docs/REST_METHODS.md), события установки —
[`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).

## Конвенции

- **По Битрикс24 не гадаем — читаем.** REST — MCP `b24-dev-mcp` (подключён в `.mcp.json`);
  b24jssdk и b24ui — их `llms.txt` (навык `b24-docs`). Документация задаёт форму запроса, живой
  портал подтверждает результат. Протокол `ai.engine.register` — `docs/RESEARCH.md`, замеры —
  `docs/PROTOCOL.md` (этап 1).
- **Добавил REST-метод — строка в `docs/REST_METHODS.md`.** Иначе краснеет `tests/repoGuards.test.ts`.
- **Чистые функции отдельно**, с тестами; REST и запись — тонким слоем поверх. Серверные модули
  с автоимпортами Nitro (`useStorage`, `createError`) — только в обработчиках, `server/middleware/`
  и `requestContext.ts`, чтобы чистые модули импортировались в тестах. Решение обработчика —
  в чистом модуле с внедряемыми зависимостями (`b24EventsHandler`); на клиенте — так же
  (`app/utils/install`, `serverHealth`, `profile`).
- **Секреты — только окружением** (`.env.example`). Токены, API-ключи клиентов, промпты и ответы
  моделей в журнал не пишем. Ключи клиентов — только зашифрованными (`secretCrypto`).
- **Язык** — по таблице `docs/AGENT_RULES.md` §0: код, JSDoc, комментарии, тесты, коммиты — по-английски;
  документация — на языке файла, новая — по-английски; PR, issues и отчёты — по-русски. Код,
  перенесённый из шаблона `invoice-from-tasks`, пока комментирован по-русски.
- **Штамп `> Last reviewed: YYYY-MM-DD`** под заголовком каждого `.md`.
- **Компоненты из подкаталогов — с приставкой каталога**: например, будущий `components/settings/General.vue` —
  тег `<SettingsGeneral>`. Незнакомый тег Vue рисует пустым без ошибки; ловит `pnpm typecheck`
  (`checkUnknownComponents` в `tsconfig.json`).
- **Тест должен краснеть при мутации кода** (`AGENT_RULES.md` §5.2); откат мутации — из копии,
  не `git checkout --`.
