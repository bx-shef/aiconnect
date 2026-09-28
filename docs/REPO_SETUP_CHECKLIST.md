# Настройки репозитория (разово, владельцу)

> Last reviewed: 2026-09-28

Перенесено из эталона `client-bank-alfa-by`. Делается в интерфейсе GitHub один раз; агент
этого сделать не может и не должен (`docs/AGENT_RULES.md` §5.8).

## Состояние (сверено 2026-09-28)

Правила ветки `main` читаются публичным API GitHub без токена — перепроверить может кто угодно
(без токена — 60 запросов в час; `-f` покажет отказ, а не пустой ответ):

```bash
curl -fsS https://api.github.com/repos/bx-shef/aiconnect/rules/branches/main   # §1: пустой список [] — правил нет
```

Остальное API отдаёт только с правами на репозиторий — это проверяет владелец своим `gh`:

```bash
gh api repos/bx-shef/aiconnect --jq .delete_branch_on_merge                        # §2: true
gh api repos/bx-shef/aiconnect/vulnerability-alerts --silent && echo alerts on      # §3
gh api repos/bx-shef/aiconnect/automated-security-fixes --jq .enabled               # §3: true
```

| Пункт | Состояние | Как сверено |
|---|---|---|
| §1 Защита `main` | ❌ **правил нет**: прямой пуш и force-push не запрещены, PR не обязателен | API без токена вернул `[]` (2026-09-28) |
| §1 Обязательные проверки `ci`, `docker-build` | ❌ не заданы — мерж возможен и при красном CI | то же |
| §1 Bypass list пуст | не сверялось: список обходов API показывает только администратору — смотрите Settings → Rules | — |
| §2 Удаление веток после мержа | ✅ | ветки bx-shef/aiconnect#5 и bx-shef/aiconnect#8 удалены GitHub сразу после мержа |
| §3 Dependabot | version updates ✅ (открыты PR dependabot); alerts и security updates не сверялись — команды выше | — |
| §4 Пакет GHCR публичный | ✅ | анонимный запрос манифеста `ghcr.io/bx-shef/aiconnect:latest` — 200 (2026-09-28) |

Таблица перенесена из шаблона вместе с его состоянием; 2026-09-28 сверена заново для этого
репозитория. Ведётся руками: поменяли настройку — обновите строку и дату.

Одобрений 0, потому что человек в репозитории один: одобрять свой же PR — не защита. Ревью держит
процесс — `/code-review` и панель из пяти перед каждым мержем (`docs/AGENT_RULES.md` §3); GitHub его
не проверяет, поэтому его и не ослабляем.

## 1. Защита `main` — ruleset `protect-main`

Settings → Rules → Rulesets → New branch ruleset:

- **Enforcement:** Active; **Bypass list:** пусто; **Target:** default branch.
- **Restrict deletions** и **Block force pushes** — включить.
- **Require a pull request before merging** — включить; approvals — 0 или 1; «Dismiss stale
  approvals» и «Require conversation resolution» — включить; **Allowed merge methods** — только
  Squash (мержим squash-коммитом, `docs/AGENT_RULES.md` §4.1).
- **Require status checks to pass** — включить, проверки **`ci`** и **`docker-build`**, «Require
  branches to be up to date» — включить. `docker-build` обязателен с тех пор, как `main` выкатывается
  в GHCR (`docs/DEPLOY.md`): PR с несобираемым образом иначе влился бы, и выкат молча встал бы на
  всех следующих мержах.

⚠ Имена джоб `ci` и `docker-build` — то, на что ссылается правило. Переименуете джобу — правило
продолжит ждать проверку со старым именем, и каждый PR встанет на «Expected — Waiting for status to
be reported» без возможности мержа. Имена стережёт `tests/repoGuards.test.ts`; переименовывать —
только вместе с правилом.

Проверка: попытка `git push --force` в `main` и удаление ветки должны отклоняться.

## 2. Ветки

Settings → General → **Automatically delete head branches** — включить.

## 3. Dependabot

Settings → Code security: alerts, security updates, version updates — включить.
Конфигурация — `.github/dependabot.yml` (группы `nuxt`, `b24`, `dev-deps`, actions, docker).

## 4. Пакет GHCR

Первый push в `main` после выката (джоба `deploy`) создаст пакет `ghcr.io/bx-shef/aiconnect`.
Сделать его публичным: профиль `bx-shef` на GitHub (это пользователь, не организация) → вкладка
**Packages** → `aiconnect` → **Package settings** → **Change visibility** → Public. Тогда серверу
и Watchtower не нужен `docker login` (`docs/DEPLOY.md`).

Проверка: `docker pull ghcr.io/bx-shef/aiconnect:latest` без логина проходит.

## 5. Жизненный цикл изменения

ветка от `main` → код + тесты + документация одним PR → `/code-review` + панель из пяти →
исправления в том же PR → зелёные `ci` и `docker-build` → squash-мерж → удаление ветки →
комментарий в issue.
Подробно — `docs/AGENT_RULES.md`.
