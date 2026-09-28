# Research: plugging an own model into BitrixGPT

> Last reviewed: 2026-09-28

What we know before writing code, and what is still unverified. Stage 1 of `docs/PLAN.md`
(the protocol spy) turns every "unverified" line here into a measured fact in `docs/PROTOCOL.md`.
Sources: MCP `b24-dev-mcp` (`ai.engine.register`, `ai.engine.list`, article "AI в Битрикс24:
обзор методов"), https://apidocs.bitrix24.ru/api-reference/ai/ai-engine-register.html,
legacy https://dev.1c-bitrix.ru/rest_help/ai/ai_engine_register.php, Market app pages.

## Mechanism

Not a placement. The app registers an **AI provider** with `ai.engine.register` (scope
`ai_admin`, admin only, **cloud only** — not available in on-premise). Bitrix24 lists registered
providers of the matching category in its model selectors ("Выберите модель AI для …" in
BitrixGPT settings: CRM, video calls, chat, tasks, sites). The "Выбрать в Маркетплейсе" item
leads to Market apps with `ai_admin`.

### `ai.engine.register`

| Param | Notes |
|---|---|
| `name` | shown in the selector |
| `code` | `A-Za-z0-9-_`; ours: `sh_aiconnect_<category>` |
| `category` | `text`, `image`, `audio`, `call` (call recordings), `vision`, `classify` |
| `completions_url` | Bitrix24 sends a GET on registration and expects **200**, otherwise `ENGINE_REGISTER_ERROR_COMPLETIONS_URL_FAIL` |
| `settings.code_alias` | optional alias |
| `settings.model_context_type` | `token` or `symbol` |
| `settings.model_context_limit` | default 15666 |

Related: `ai.engine.list` (in OAuth context returns only this app's providers, linked via
`APP_CODE`), `ai.engine.unregister`.

### Request protocol (asynchronous)

1. Bitrix24 POSTs the request to `completions_url`. We must answer within **5 s** with **202**
   and `{"result":"OK"}`; any other status is an error.
2. When done, POST `{"result": "..."}` to `callbackUrl`.
3. On failure, POST `{"message", "code", "api_request_completed"}` to `errorCallbackUrl`.
   `api_request_completed=false` tells Bitrix24 the request was not served (it restores the
   portal's quota).
4. `ttl`: default 14400 s, max 86400 s; after it Bitrix24 no longer accepts callbacks.

Request fields: `prompt`, `payload_role` (→ system message), `context` (use only when
`collect_context=true`), `max_tokens`, `temperature`, `payload_raw`, `payload_provider`,
`payload_prompt_text`, `payload_markers`, `auth` (app auth data; `null` when the provider was
registered outside an app), `callbackUrl`, `errorCallbackUrl`, `ttl`.

- `audio`: `prompt` is an object `{file, fileExtension, fields: {type, prompt}}`; the file may
  come without an extension — use `fields.type`.
- `image`: `prompt` is `{prompt, style, format: square|portrait|landscape|null, images_number}`.

Reference endpoint from Bitrix24: https://helpdesk.bitrix24.ru/examples/endpoint.zip

## Unverified — stage 1 must measure

1. Which category feeds which selector (CRM "расшифровка звонков" is probably `call`, the other
   CRM selectors — summary, script scoring, auto-activities — probably `text`).
2. `prompt` shape for `call`, `vision`, `classify` — not documented.
3. Success callback shape for `image` and `audio` (URL, array, text?) — not documented.
4. What `auth` contains (`application_token`, `member_id`, `domain`?) — decides how we verify
   that a request really comes from an installed portal.
5. ~~Re-`register` with the same `code`~~ — measured via webhook, see below: it fails with
   `ENGINE_REGISTER_ERROR_CODE_UNIQUE`. From an app context (`app_code` set) — still to confirm.
6. Bitrix24 behaviour on error callback and on expired `ttl`.

## Measured on the test portal (2026-09-28)

Portal `b24-ypkv9c.bitrix24.by` (cloud, zone `.by`), admin inbound webhook, raw REST. Temporary
providers `sh_aiconnect_probe*` were registered and removed in the same run; `ai.engine.list` was
empty before and after.

- `methods` with `scope: ai_admin` → `ai.engine.register`, `ai.engine.unregister`,
  `ai.engine.list`, `ai.prompt.register`, `ai.prompt.unregister`, `ai.history.enable`,
  `ai.history.disable`, `ai.history.list`. The `ai.prompt.*` / `ai.history.*` methods are not
  used yet.
- `ai.engine.register` returns the numeric id. Registered via webhook, the provider has
  `app_code: null` in `ai.engine.list` — so such a provider gets `auth: null` in requests (docs);
  our providers must be registered from the app context.
- Second `register` with the same `code` → `400 ENGINE_REGISTER_ERROR_CODE_UNIQUE`, the record is
  unchanged. Re-registration is `unregister` + `register` until the app context says otherwise.
- `completions_url` answering 404 → `400 ENGINE_REGISTER_ERROR_COMPLETIONS_URL_FAIL`: the GET
  check on registration is real. A URL answering 200 (`https://example.com/`) is accepted.
- `category: vision` is accepted, although the docs' error text lists only `text, image, audio,
  call`.
- `ai.engine.unregister` → `true` for an existing code, `false` for an unknown one (no error).
- `ai.engine.list` fields: `id`, `app_code`, `name`, `code`, `category`, `completions_url`,
  `settings` (`model_context_type`, `model_context_limit` as sent), `date_create` (unix seconds).
- Webhook limits: `event.get` → `403 WRONG_AUTH_TYPE`; `app.info` answers without `CODE`. Both
  need the installed app.

## Market landscape (2026-09-28)

| App | What it is | Relevance |
|---|---|---|
| `skyweb24.copilotopenai` | provider via `ai_admin` (+ `im`, `user_brief`), cloud only, OpenAI models (text, image, audio); own key needs a user-supplied HTTP proxy, or their key with prepaid balance | the only direct competitor; OpenAI-only, proxy is a pain for RU/BY clients |
| `itnebo.chatgpt_midjorney` | standalone chat window, no `ai_admin` | not a provider, not in BitrixGPT selectors |
| `itnebo.openline_ai` | open-lines chatbot (`imbot`, `imopenlines`, `crm`, `bizproc`…), resold tokens | different niche |

Positioning: **we sell the connection** — "your key, your model inside BitrixGPT". Any
OpenAI-compatible provider via configurable `baseURL`; DeepSeek first (reachable from RU/BY
without a proxy).

## DeepSeek

OpenAI-compatible API, text only — covers `text` (and likely `classify`); no audio, image or
vision. Model ids change between releases — take them from the provider's `GET /models`, never
hard-code.
