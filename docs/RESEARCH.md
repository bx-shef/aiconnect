# Исследование: своя модель в BitrixGPT

> Last reviewed: 2026-09-28

Что известно до кода и что ещё не проверено. Этап 1 `docs/PLAN.md` (шпион протокола) превращает
каждую строку «не проверено» в замеренный факт в `docs/PROTOCOL.md`.
Источники: MCP `b24-dev-mcp` (`ai.engine.register`, `ai.engine.list`, статья «AI в Битрикс24:
обзор методов»), https://apidocs.bitrix24.ru/api-reference/ai/ai-engine-register.html,
старая документация https://dev.1c-bitrix.ru/rest_help/ai/ai_engine_register.php, страницы
приложений Маркета.

## Механизм

Не встройка. Приложение регистрирует **AI-провайдера** методом `ai.engine.register` (право
`ai_admin`, только администратор, **только облако** — в коробке недоступно). Битрикс24 показывает
зарегистрированных провайдеров нужной категории в своих списках выбора модели («Выберите модель
AI для …» в настройках BitrixGPT: CRM, видеозвонки, чат, задачи, сайты). Пункт «Выбрать в
Маркетплейсе» ведёт к приложениям Маркета с `ai_admin`.

### `ai.engine.register`

| Параметр | Что |
|---|---|
| `name` | показывается в списке выбора |
| `code` | `A-Za-z0-9-_`; у нас — `sh_aiconnect_<category>` |
| `category` | `text`, `image`, `audio`, `call` (записи звонков), `vision`, `classify` |
| `completions_url` | при регистрации Битрикс24 шлёт GET и ждёт **200**, иначе `ENGINE_REGISTER_ERROR_COMPLETIONS_URL_FAIL` |
| `settings.code_alias` | необязательный псевдоним |
| `settings.model_context_type` | `token` или `symbol` |
| `settings.model_context_limit` | по умолчанию 15666 |

Рядом: `ai.engine.list` (в контексте OAuth возвращает только провайдеров этого приложения,
связь через `APP_CODE`), `ai.engine.unregister`.

### Протокол запроса (асинхронный)

1. Битрикс24 шлёт POST с запросом на `completions_url`. Ответить нужно за **5 с** статусом
   **202** и `{"result":"OK"}`; любой другой статус — ошибка.
2. Когда готово — POST `{"result": "..."}` на `callbackUrl`.
3. При сбое — POST `{"message", "code", "api_request_completed"}` на `errorCallbackUrl`.
   `api_request_completed=false` говорит Битрикс24, что запрос не обслужен (он вернёт порталу
   квоту).
4. `ttl`: по умолчанию 14400 с, максимум 86400 с; после него Битрикс24 callback не принимает.

Поля запроса: `prompt`, `payload_role` (→ system-сообщение), `context` (брать только при
`collect_context=true`), `max_tokens`, `temperature`, `payload_raw`, `payload_provider`,
`payload_prompt_text`, `payload_markers`, `auth` (данные авторизации приложения; `null`, если
провайдер зарегистрирован не из приложения), `callbackUrl`, `errorCallbackUrl`, `ttl`.

- `audio`: `prompt` — объект `{file, fileExtension, fields: {type, prompt}}`; файл может прийти
  без расширения — брать `fields.type`.
- `image`: `prompt` — `{prompt, style, format: square|portrait|landscape|null, images_number}`.

Эталонный обработчик от Битрикс24: https://helpdesk.bitrix24.ru/examples/endpoint.zip

## Не проверено — замерить на этапе 1

1. Какая категория питает какой список выбора (в CRM «расшифровка звонков» — вероятно `call`,
   остальные списки CRM — резюме, оценка по скрипту, автодела — вероятно `text`).
2. Форма `prompt` для `call`, `vision`, `classify` — не описана.
3. Форма успешного callback для `image` и `audio` (URL, массив, текст?) — не описана.
4. Что лежит в `auth` (`application_token`, `member_id`, `domain`?) — от этого зависит, как мы
   проверяем, что запрос правда пришёл с установленного портала.
5. ~~Повторный `register` с тем же `code`~~ — замерено вебхуком, см. ниже: падает с
   `ENGINE_REGISTER_ERROR_CODE_UNIQUE`. Из контекста приложения (`app_code` задан) — подтвердить.
6. Поведение Битрикс24 на error callback и на истёкший `ttl`.

## Замерено на тестовом портале (2026-09-28)

Портал `b24-ypkv9c.bitrix24.by` (облако, зона `.by`), входящий вебхук администратора, REST
напрямую. Временные провайдеры `sh_aiconnect_probe*` зарегистрированы и сняты в том же прогоне;
`ai.engine.list` пуст до и после.

- `methods` с `scope: ai_admin` → `ai.engine.register`, `ai.engine.unregister`,
  `ai.engine.list`, `ai.prompt.register`, `ai.prompt.unregister`, `ai.history.enable`,
  `ai.history.disable`, `ai.history.list`. Методы `ai.prompt.*` / `ai.history.*` пока не
  используем.
- `ai.engine.register` возвращает числовой id. Провайдер, зарегистрированный вебхуком, в
  `ai.engine.list` имеет `app_code: null` — значит, в запросах ему придёт `auth: null`
  (документация); наших провайдеров регистрировать из контекста приложения.
- Второй `register` с тем же `code` → `400 ENGINE_REGISTER_ERROR_CODE_UNIQUE`, запись не
  меняется. Перерегистрация — `unregister` + `register`, пока контекст приложения не покажет иное.
- `completions_url`, отвечающий 404 → `400 ENGINE_REGISTER_ERROR_COMPLETIONS_URL_FAIL`: проверка
  GET при регистрации настоящая. Адрес, отвечающий 200 (`https://example.com/`), принимается.
- `category: vision` принимается, хотя текст ошибки в документации перечисляет только `text,
  image, audio, call`.
- `ai.engine.unregister` → `true` для существующего кода, `false` для неизвестного (не ошибка).
- Поля `ai.engine.list`: `id`, `app_code`, `name`, `code`, `category`, `completions_url`,
  `settings` (`model_context_type`, `model_context_limit` — как отправили), `date_create`
  (секунды unix).
- Ограничения вебхука: `event.get` → `403 WRONG_AUTH_TYPE`; `app.info` отвечает без `CODE`.
  Обоим нужно установленное приложение.

## Рынок (2026-09-28)

| Приложение | Что это | Значение для нас |
|---|---|---|
| `skyweb24.copilotopenai` | провайдер через `ai_admin` (+ `im`, `user_brief`), только облако, модели OpenAI (текст, картинки, аудио); свой ключ — только через HTTP-прокси пользователя, или их ключ с предоплатой | единственный прямой конкурент; только OpenAI, прокси — боль для клиентов из РФ/РБ |
| `itnebo.chatgpt_midjorney` | отдельное окно чата, без `ai_admin` | не провайдер, в списках BitrixGPT его нет |
| `itnebo.openline_ai` | чат-бот открытых линий (`imbot`, `imopenlines`, `crm`, `bizproc`…), перепродаёт токены | другая ниша |

Позиционирование: **продаём подключение** — «ваш ключ, ваша модель внутри BitrixGPT». Любой
OpenAI-совместимый провайдер через настраиваемый `baseURL`; первым — DeepSeek (доступен из РФ/РБ
без прокси).

## DeepSeek

OpenAI-совместимый API. Покрывает `text` (и, вероятно, `classify`); аудио и генерации картинок
нет. Идентификаторы моделей меняются от релиза к релизу — брать их из `GET /models` провайдера,
в код не зашивать.
