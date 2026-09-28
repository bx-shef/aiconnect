# Work plan — shef.aiconnect

> Last reviewed: 2026-09-28

App code `shef.aiconnect`, repository `bx-shef/aiconnect`, provider codes
`sh_aiconnect_<category>`. We sell the connection: the client's own model (own API key) inside
BitrixGPT. Background — `docs/RESEARCH.md`. Every stage is its own PR; nothing goes to `main`
directly (`docs/AGENT_RULES.md` §2).

## Stage 0 — clean scaffold (PR #1)

The repository starts as an import of `bx-shef/invoice-from-tasks` (only the identity was
renamed). Remove the invoice domain: `invoice` page and components, invoice composables,
`shared/domain/*` of invoices/rates/VAT/tasks, the placement, `ai/names`, `ai/consult`,
`rates`, their tests and smoke, invoice docs (`PROCESSING`, invoice parts of `SETTINGS`,
`REST_METHODS`, `ARCHITECTURE`, `project-map`, `b24-docs` skill pitfalls). Keep `frameAuth`,
`tokenStore`, `secretCrypto`, `b24Events`, `verifyInstallMember`, `b24Host`, `rateLimit`,
`requestLimits`, CI, Docker, deploy.
Scopes: `ai_admin`, `user_brief`. Drop the `openai` package (AI SDK comes in stage 2).
**Done when:** the app installs on the test portal, tokens are stored, CI is green.

## Stage 1 — protocol spy (PR #2)

- `/api/engine/[category]`: GET → 200; POST → log the payload (`auth` masked, `prompt`
  truncated) → 202 → POST an error to `errorCallbackUrl` with `api_request_completed=false`.
- A button registers the spy for all 6 categories ("TEST text", "TEST call", …).
- Run portal scenarios: AI chat, tasks, feed, CRM (transcription, summary, script scoring,
  auto-activities — the owner provides calls: short, 10+ min, one with a script), video calls,
  sites.
- Also: send a successful `callbackUrl`, see behaviour on error and on expired `ttl`.
- **Result:** `docs/PROTOCOL.md` with real payloads answering the "Unverified" list of
  `docs/RESEARCH.md`.

## Stage 2 — text via DeepSeek (PR #3, full review panel)

- Vercel AI SDK: `createOpenAICompatible` with `baseURL` (DeepSeek may use `@ai-sdk/deepseek`).
- Messages: `payload_role` → system, `context` only with `collect_context`, `prompt` → user;
  `max_tokens`, `temperature` from the request; reasoning content never goes to the callback.
- Queue in `unstorage`: 202 at once, a worker calls the model and sends the callback; retries
  within `ttl`; pending jobs picked up after restart.
- Errors: provider 401/402 → error callback; 429/5xx → retry, then error callback; callback
  delivery failure → retry delivery.
- Security: portal verified by `auth` + per-portal HMAC in the path; callback URLs only
  `https` on the portal's own host (SSRF); key encrypted, neither key nor texts in logs.
- **Done when:** AI chat and call summary on the test portal answer via DeepSeek. Unit tests for
  message building, callback host check, error mapping.

## Stage 3 — settings (PR #4)

- b24ui, admin only: `baseURL`, key, "Check" (`GET /models`), model per category, enabled
  categories, provider `name` shown in Bitrix24 selectors.
- Save → `unregister` + `register` (or update, per stage 1). `model_context_limit` from the
  model.
- `ONAPPUNINSTALL` wipes the portal's key and jobs.

## Stage 4 — hardening (PR #5)

Per-portal rate limit; metrics without content (jobs accepted, callback result, provider
latency); smoke on a real portal: register → request → callback.

## Stage 5 — other categories (after MVP)

`call`/`audio` via a Whisper-compatible provider; `image`, `vision` per `docs/PROTOCOL.md`;
provider selectable per category.

## Stage 6 — Market

EULA and privacy policy (base: `bx-shef/ai-price-import` documents); state that data goes to the
provider chosen by the client under the client's key (DeepSeek — China). Market card ("your key —
your model in BitrixGPT"), DeepSeek key how-to, moderation.
