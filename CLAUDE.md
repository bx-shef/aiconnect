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
[`docs/RESEARCH.md`](docs/RESEARCH.md).

⚠ **Переходное состояние.** Репозиторий начат импортом шаблона `bx-shef/invoice-from-tasks`
(переименована только идентичность: пакет, образ, домен). Предметная часть счетов ещё в коде и в
`docs/` — её убирает этап 0 плана. До этого карта ниже — это карта шаблона; инфраструктурные
модули (`frameAuth`, `tokenStore`, `secretCrypto`, `b24Events`, `verifyInstallMember`, `b24Host`,
`rateLimit`, `requestLimits`, CI, Docker, выкат) остаются, всё про счета, задачи, ставки и НДС —
уходит.

Этот файл — карта и конвенции. Держим коротким: журналы, замеры и история — в `docs/`.

## Команды

```bash
pnpm install          # + nuxt prepare (postinstall)
pnpm dev              # разработка; страницы работают только во фрейме портала
pnpm check            # lint + typecheck + test — перед каждым PR
pnpm build            # сборка сервера .output/server/index.mjs
```

## Карта (шаблона — до этапа 0)

| Где | Что |
|---|---|
| `shared/domain/` | **чистые правила**: `time` (округление), `rates` (ставки по датам), `markup` (наценки по тегам), `currency` (пересчёт по курсу портала), `vat` (НДС по «Реквизитам вашей компании»), `money` (копейки как у портала), `fill` (сборка строк, тип 1/2, цена часа или сумма × 1), `tasks` (разбор задач и времени, привязка к CRM), `invoice`, `settings` (формат настроек), `storageBudget` (место в app.option), `prompts` (BitrixGPT), `answer` (разбор ответа модели — общий для ленты и окна), `activity` (запись консультации в ленте) |
| `app/pages/` | `index` (публичная), `install` (установка), `app` (главная в портале), `settings`, `invoice` (встройка в карточку счёта) |
| `app/composables/` | `useB24` (фрейм и REST v2/v3), `useApi` (наш /api с фрейм-токеном), `useAppSettings`, `useInvoiceFill` (сценарий счёта), `useCatalog` (единицы измерения, ставки НДС), `useMyCompanies` (реквизиты вашей компании), `useUsers`, `useStorageProbe` |
| `app/utils/` | `install` (шаги установки), `placement` (ID счёта из встройки), `storageProbe` (замер места), `frameToken`, `concurrency` (параллельные чтения с ограничением), `paging` (сбор страниц), `b24Batch` (ошибки REST, разбор пакета), `writeOutcome` (итог записи в счёт), `serverHealth` (что не настроено на сервере), `measures` (единицы измерения, ОКЕИ), `vatSettings` (выбор НДС в настройках), `invoiceRequests` (параметры REST-запросов сценария счёта) |
| `app/config/b24.ts` | права, встройка, события, настройки SDK (без автоповторов записи) — одно место |
| `server/api/` | тонкие обёртки: `b24/events` (установка/удаление), `settings`, `rates`, `ai/names`, `ai/consult`, `health` (флаги настроек и коммит сборки) |
| `server/middleware/` | `securityHeaders` (CSP для фрейма), `requestLimits` (размер тела) |
| `server/utils/` | `frameAuth` (кто пришёл), `requestContext` (обвязка обработчиков, IP), `b24Host` (SSRF-гард, CSP, серверы авторизации), `b24Client` (REST через B24OAuth), `b24Events` (разбор события) + `b24EventsHandler` (решение по событию), `verifyInstallMember` (сверка member_id и домена), `tokenStore` + `secretCrypto` (токены установки), `installerCall` (токен установщика: свежая запись, очередь), `options` (app.option с бюджетом) + `optionWrites` (кто и каким токеном пишет), `requestLimits` (пределы, IP за прокси), `buildInfo` (коммит сборки для health), `llm` + `aiGateway` + `aiRequests` + `rateLimit` (BitrixGPT, лимиты) |
| `tests/` | юнит-тесты (vitest, node); `tests/server/` — серверные модули; `repoGuards` — гарды репо |
| `docker-compose.prod.yml`, `Makefile` | выкат как в client-bank: `main` → GHCR → Watchtower → nginx-proxy, `invoice-from-tasks.bx-shef.by`; проверка сервера — `make doctor` — `docs/DEPLOY.md` |
| `smoke/` | смок на тестовом портале (`pnpm smoke`, свой vitest-конфиг, не в CI): страж портала, засев, формы REST, матрица расчёта, BitrixGPT — `docs/SMOKE.md` |

Подробно: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), правила расчёта —
[`docs/PROCESSING.md`](docs/PROCESSING.md).

## Конвенции

- **По Битрикс24 не гадаем — читаем.** REST — MCP `b24-dev-mcp` (подключён в `.mcp.json`);
  b24jssdk и b24ui — их `llms.txt` (навык `b24-docs`). Документация задаёт форму запроса, живой
  портал подтверждает результат. Протокол `ai.engine.register` — `docs/RESEARCH.md`, замеры —
  `docs/PROTOCOL.md` (этап 1).
- **Добавил REST-метод — строка в `docs/REST_METHODS.md`.** Иначе краснеет `tests/repoGuards.test.ts`.
- **Чистые функции отдельно**, с тестами; REST и запись — тонким слоем поверх. Серверные модули
  с автоимпортами Nitro (`useStorage`, `createError`) — только в обработчиках, `server/middleware/`
  и `requestContext.ts`, чтобы чистые модули импортировались в тестах. Решение обработчика —
  в чистом модуле с внедряемыми зависимостями (`b24EventsHandler`, `optionWrites`, `aiRequests`,
  `installerCall`); на клиенте — так же (`app/utils/paging`, `writeOutcome`, `b24Batch`).
- **Секреты — только окружением** (`.env.example`). Токены, API-ключи клиентов, промпты и ответы
  моделей в журнал не пишем. Ключи клиентов — только зашифрованными (`secretCrypto`).
- **Язык** — по таблице `docs/AGENT_RULES.md` §0: код, JSDoc, комментарии, тесты, коммиты — по-английски;
  документация — на языке файла, новая — по-английски; PR, issues и отчёты — по-русски.
- **Штамп `> Last reviewed: YYYY-MM-DD`** под заголовком каждого `.md`.
- **Компоненты из подкаталогов — с приставкой каталога**: `components/settings/SettingsGeneral.vue` —
  тег `<SettingsGeneral>`. Незнакомый тег Vue рисует пустым без ошибки; ловит `pnpm typecheck`
  (`checkUnknownComponents` в `tsconfig.json`).
- **Тест должен краснеть при мутации кода** (`AGENT_RULES.md` §5.2); откат мутации — из копии,
  не `git checkout --`.
