.PHONY: build-local prod-up prod-down prod-pull prod-redeploy logs ps health doctor backup proxy-timeout \
        compose-update self-update help

# A bare `make` on the server prints help instead of running the first target.
.DEFAULT_GOAL := help

# Wrappers over deploy commands — as in the client-bank-alfa-by reference. Details — docs/DEPLOY.md.
# Prod targets read ./.env next to docker-compose.prod.yml (DOMAIN, keys — see .env.example).

# What we defend against (security review in #16):
# - shared host environment: another exported DOMAIN, REF, PROXY… must not change anything —
#   external REF, PROXY, PROXY_TIMEOUT, CONFIRM values are taken only from the make command line;
# - values pasted verbatim from someone else's messages (`REF=<branch>`, `CONFIRM=<sha256>`):
#   taken as text ($(value …) — otherwise make itself would run `$(shell …)` from the value before
#   the shell even sees it), reach the recipe as environment variables, not command text, and are
#   validated by format.
# What we do NOT defend against: the make command line is the operator's own commands. `REF:=$(shell …)`,
# any other variable with `$(…)`, `SHELL=` will run anything, and the Makefile won't stop it. Same for
# MAKEFLAGS in the environment: make treats it as a command line and parses it BEFORE reading this file.
# On the server, MAKEFLAGS must not be set in the environment (docs/DEPLOY.md).
# override — on everything that executes or checks: otherwise a variable of the same name would
# replace the check function or the commands themselves (like APP_CONTAINER below).
#   $(call cli,NAME,default)
override cli = $(if $(filter command line,$(origin $(1))),$(value $(1)),$(2))
# make itself puts command-line variables into every command's environment, and expands their value
# to do so — `$(shell …)` inside it would run there. unexport: they reach the recipe only as copies
# through cli (U_REF, PT_*, CU_CONFIRM), already as text.
unexport REF PROXY PROXY_TIMEOUT CONFIRM
# compose substitutes ${DOMAIN}, ${LETSENCRYPT_EMAIL} and ${B24_TOKEN_ENC_KEY} from the shell
# environment BEFORE ./.env: on a shared host, a neighbour project's exported DOMAIN would steer our
# VIRTUAL_HOST (and certificate) to the wrong domain. So compose runs without them — one source, ./.env.
override COMPOSE_ENV = env -u DOMAIN -u LETSENCRYPT_EMAIL -u B24_TOKEN_ENC_KEY docker compose
override COMPOSE = $(COMPOSE_ENV) -f docker-compose.prod.yml
# App container name — container_name in docker-compose.prod.yml (checked by tests/makefileProd.test.ts).
# override: neither `make … APP_CONTAINER=…` nor MAKEFLAGS can substitute whose VIRTUAL_HOST proxy-timeout reads.
override APP_CONTAINER := aiconnect

# Shared shell functions for targets. make joins `\`-continued assignment lines into one, so
# commands are separated by `;`. A function's error goes into $$err and it returns 1.
#   app_domain — d: VIRTUAL_HOST of the running app container (single line, domain format);
#   find_proxy — p: the running nginx-proxy container — PROXY from the command line, or the single
#                one whose image is named exactly nginx-proxy (nginxproxy/nginx-proxy:1.7, jwilder/nginx-proxy):
#                a substring match would also accept an unrelated image like nginx-proxy-dashboard. Image
#                comes from inspect (.Config.Image): in `docker ps` after pulling a new image, its ID
#                shows instead of the name (review in #16);
#   check_ref  — U_REF: branch or tag name for the raw.githubusercontent.com address.
override SH_LIB = one_line() { [ "$$(printf '%s' "$$1" | wc -l)" -eq 0 ]; }; \
	app_domain() { \
	  d=$$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(APP_CONTAINER) 2>/dev/null | sed -n 's/^VIRTUAL_HOST=//p'); \
	  [ -n "$$d" ] || { err="контейнер $(APP_CONTAINER) не запущен или без VIRTUAL_HOST — сначала make prod-up"; return 1; }; \
	  { one_line "$$d" && printf '%s' "$$d" | grep -Eqx '[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+'; } \
	    || { err="VIRTUAL_HOST контейнера не похож на один домен: '$$d'"; return 1; }; \
	}; \
	find_proxy() { \
	  p="$$PT_PROXY"; \
	  [ -n "$$p" ] || p=$$(docker ps -q | xargs -r docker inspect -f '{{.Name}} {{.Config.Image}}' 2>/dev/null | awk '$$2 ~ /(^|\/)nginx-proxy(:|@|$$)/ {sub(/^\//, "", $$1); print $$1}'); \
	  n=$$(printf '%s\n' "$$p" | grep -c . || true); \
	  [ "$$n" = 1 ] || { err="контейнеров nginx-proxy найдено: $$n. Укажите нужный: make $@ PROXY=<имя>"; return 1; }; \
	  { one_line "$$p" && printf '%s' "$$p" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9_.-]*'; } || { err="странное имя контейнера: '$$p'"; return 1; }; \
	  [ "$$(docker inspect -f '{{.State.Running}}' "$$p" 2>/dev/null)" = true ] \
	    || { err="контейнер прокси $$p не запущен или такого нет — имена: docker ps; make $@ PROXY=<имя>"; return 1; }; \
	}; \
	check_ref() { \
	  { one_line "$$U_REF" && printf '%s' "$$U_REF" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._/-]{0,199}' && ! printf '%s' "$$U_REF" | grep -qF '..'; } \
	    || { err="REF — имя ветки или тега (буквы, цифры, . _ / -): '$$U_REF'"; return 1; }; \
	};

# ─── Local ───────────────────────────────────────────────────────────

## Собрать образ из исходников и запустить на 127.0.0.1:3000 на переднем плане (docker-compose.yml)
build-local:
	docker compose up --build

# ─── Prod (on the server, /home/bitrix/aiconnect) ────────────
# Requires the shared nginx-proxy + acme-companion, Watchtower, and docker network proxy-net on the host.
# We do NOT run our own Watchtower — the host's one picks up the container by label.

## Запустить / обновить контейнер приложения
prod-up:
	$(COMPOSE) up -d

## Остановить приложение (том с токенами установки остаётся)
prod-down:
	$(COMPOSE) down

## Скачать свежий образ, не перезапуская контейнер
prod-pull:
	$(COMPOSE) pull

## Обновить прямо сейчас, не дожидаясь Watchtower
#
# We only clean our own dangling images (the source label is set at build time in CI): the host is
# shared, and other projects clean up their own images themselves.
prod-redeploy:
	$(COMPOSE) pull && \
	$(COMPOSE) up -d && \
	docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/bx-shef/aiconnect"

## Живой лог приложения (Ctrl+C — выйти)
logs:
	$(COMPOSE) logs -f app

## Состояние контейнера и его healthcheck
ps:
	$(COMPOSE) ps

## Что не настроено на сервере: GET /api/health изнутри контейнера (флаги «задано / нет», без секретов)
#
# Check through the proxy (request.forwardedFor = used) from outside:
#   curl -s https://<DOMAIN>/api/health
health:
	$(COMPOSE) exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r => r.text()).then(t => console.log(t))"

## Проверить выкат одной командой: контейнер, настройки, прокси, https, сертификат, Watchtower, диск
#
#   make doctor               # read-only, changes nothing
#   make doctor PROXY=<name>  # if the proxy wasn't found, or there are several
#
# Like the client-bank reference (make doctor): one command instead of a manual walkthrough. Each
# line is ✓, ✗ (after "→" — what to do; any ✗ makes make exit with an error), or ⚠ (nothing to check
# with — not an error, but not "all fine" either). What it checks, besides the container:
# - /api/health from inside: the build, and what's unset — in .env or in the compose file;
# - the proxy reaches the app without keepalive — otherwise 502 on POST from the portal (label in
#   compose) — and sees at least one working app server;
# - the proxy timeout for the domain is wired up (make proxy-timeout);
# - https responds from outside and sees the client address; the certificate is trusted, for our
#   domain, and not expiring within the next 14 days;
# - Watchtower is running; the disk holding docker's data directory is under 90% full.
# https is checked from the server itself: if it can't see itself at the external address, check
# from another computer — curl -s https://<domain>/api/health.
doctor: export PT_PROXY = $(call cli,PROXY,)
doctor:
	@$(SH_LIB) \
	bad=0; skip=0; ok() { echo "  ✓ $$*"; }; fail() { echo "  ✗ $$*"; bad=$$((bad + 1)); }; warn() { echo "  ⚠ $$*"; skip=$$((skip + 1)); }; \
	s=$$(docker inspect -f '{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}' $(APP_CONTAINER) 2>/dev/null); \
	case "$$s" in \
	  "running healthy") ok "контейнер $(APP_CONTAINER) работает, healthcheck зелёный";; \
	  "") fail "контейнера $(APP_CONTAINER) нет → make prod-up"; echo "[make] проблем: 1"; exit 1;; \
	  *) fail "контейнер $(APP_CONTAINER): $$s → make logs";; \
	esac; \
	h=$$(docker exec $(APP_CONTAINER) node -e "const env = { oauth: 'B24_CLIENT_ID/B24_CLIENT_SECRET', tokenKey: 'B24_TOKEN_ENC_KEY', appCode: 'B24_APP_CODE' }; const compose = { siteUrl: 'NUXT_PUBLIC_SITE_URL', trustProxy: 'TRUST_PROXY' }; fetch('http://127.0.0.1:3000/api/health').then(r => r.json()).then(j => { const c = j.config || {}; const off = Object.keys(c).filter(k => c[k] !== true); const list = pick => off.filter(pick).map(k => env[k] || compose[k] || k).join(',') || '-'; console.log([String(j.commit || 'неизвестна').replace(/\s/g, ''), list(k => !(k in compose)), list(k => k in compose)].join(' ')) }).catch(() => process.exit(1))" 2>/dev/null); \
	if [ -z "$$h" ]; then fail "GET /api/health изнутри контейнера не ответил → make logs"; else \
	  set -- $$h; \
	  if [ "$$2" = - ] && [ "$$3" = - ]; then ok "настройки сервера заданы, сборка $$1"; fi; \
	  [ "$$2" = - ] || fail "не задано в .env: $$2 → вписать и make prod-up (таблица переменных — docs/DEPLOY.md); сборка $$1"; \
	  [ "$$3" = - ] || fail "не задано в docker-compose.prod.yml: $$3 → make compose-update, затем make prod-up"; \
	fi; \
	[ "$$(docker inspect -f '{{index .Config.Labels "com.github.nginx-proxy.nginx-proxy.keepalive"}}' $(APP_CONTAINER) 2>/dev/null)" = disabled ] \
	  && ok "у контейнера метка keepalive=disabled" \
	  || fail "нет метки keepalive=disabled — жди 502 из портала → make compose-update, затем make prod-up"; \
	if ! app_domain; then fail "$$err"; else \
	  if ! find_proxy; then fail "$$err"; else \
	    conf=$$(docker exec "$$p" cat /etc/nginx/conf.d/default.conf 2>/dev/null); \
	    up=$$(printf '%s\n' "$$conf" | awk -v h="upstream $$d {" '{ sub(/^[ \t]+/, ""); sub(/[ \t\r]+$$/, "") } $$0 == h {f = 1} f {print} f && $$0 == "}" {exit}'); \
	    if [ -z "$$up" ]; then fail "в конфиге прокси $$p нет upstream $$d → make prod-up и снова make doctor"; \
	    elif ! printf '%s\n' "$$up" | grep -E '^server[[:space:]]' | grep -vqE '[[:space:]]down;'; then fail "в upstream $$d у прокси $$p нет рабочего сервера — прокси не видит приложение → make ps, make logs"; \
	    elif printf '%s\n' "$$up" | grep -Eq '^keepalive[[:space:]]'; then fail "прокси $$p держит соединения с приложением (keepalive) — жди 502 → метка выше, затем make prod-up"; \
	    else ok "прокси $$p ходит в приложение без keepalive"; fi; \
	    f="/etc/nginx/vhost.d/$${d}_location"; \
	    t=$$(docker exec "$$p" cat "$$f" 2>/dev/null | sed -n 's/^[[:space:]]*proxy_read_timeout[[:space:]]*\([^;]*\);.*/\1/p' | tail -n 1); \
	    if [ -n "$$t" ] && printf '%s\n' "$$conf" | grep -qF "include $$f;"; then ok "таймаут прокси для $$d: $$t"; \
	    else fail "таймаут прокси для $$d не подключён → make proxy-timeout"; fi; \
	  fi; \
	  if ! command -v curl >/dev/null 2>&1; then warn "https не проверен: на сервере нет curl (sudo apt install curl)"; else \
	    r=$$(curl -fsS --max-time 10 "https://$$d/api/health" 2>&1); \
	    if [ $$? -ne 0 ]; then fail "https://$$d/api/health не ответил: $$r"; \
	    elif printf '%s' "$$r" | grep -Eq '"forwardedFor"[[:space:]]*:[[:space:]]*"used"'; then ok "https://$$d отвечает, адрес клиента виден через прокси"; \
	    else fail "https://$$d отвечает, но адрес клиента не виден (forwardedFor не used) — лимиты по IP общие на всех → TRUST_PROXY в docker-compose.prod.yml"; fi; \
	  fi; \
	  if ! command -v openssl >/dev/null 2>&1; then warn "сертификат не проверен: на сервере нет openssl (sudo apt install openssl)"; else \
	    cert=$$(echo | timeout 10 openssl s_client -servername "$$d" -verify_hostname "$$d" -verify_return_error -connect "$$d:443" 2>/dev/null); \
	    e=$$(printf '%s\n' "$$cert" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2); \
	    if [ -z "$$e" ]; then fail "сертификат $$d не прочитан или не доверенный (ещё не выпущен, самоподписанный, на другой домен) → DNS и docker logs контейнера acme-companion"; \
	    elif printf '%s\n' "$$cert" | openssl x509 -noout -checkend 1209600 >/dev/null 2>&1; then ok "сертификат доверенный, действует до $$e"; \
	    else fail "сертификат истекает меньше чем через 14 дней ($$e) → docker logs контейнера acme-companion"; fi; \
	  fi; \
	fi; \
	docker ps -q | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null | grep -Eq '(^|/)watchtower(:|@|$$)' \
	  && ok "Watchtower запущен: новые образы из main приедут сами" \
	  || fail "Watchtower не запущен: обновления сами не приедут (он общий на хост — docs/DEPLOY.md §1)"; \
	root=$$(docker info -f '{{.DockerRootDir}}' 2>/dev/null); root=$${root:-/var/lib/docker}; \
	u=$$(df -P "$$root" 2>/dev/null | awk 'NR == 2 {sub(/%/, "", $$5); print $$5}'); \
	if [ -z "$$u" ]; then warn "место на диске не проверено (df $$root не ответил) → df -h"; \
	elif [ "$$u" -lt 90 ]; then ok "диск docker ($$root) занят на $$u%"; \
	else fail "диск docker ($$root) занят на $$u% → docker system df; make prod-redeploy убирает старые образы приложения"; fi; \
	if [ "$$bad" -gt 0 ]; then echo "[make] проблем: $$bad — что делать, написано после «→»; частые сбои — docs/DEPLOY.md"; exit 1; \
	elif [ "$$skip" -gt 0 ]; then echo "[make] ошибок нет, предупреждений: $$skip (⚠ выше)"; \
	else echo "[make] всё в порядке"; fi

## Копия тома с токенами установки в ./backups (токены в нём зашифрованы B24_TOKEN_ENC_KEY)
#
# Without the key the copy is useless; keep the key separately and off the server. Restore — docs/DEPLOY.md.
backup:
	@mkdir -p backups && f="backups/portals-$$(date +%Y%m%d-%H%M%S).tgz" \
	  && { $(COMPOSE) exec -T app tar czf - -C /app/.data . > "$$f" || { rm -f "$$f"; exit 1; }; } \
	  && echo "[make] копия: $$f ($$(du -h "$$f" | cut -f1))"

## Поднять таймаут общего nginx-proxy для нашего домена (по умолчанию он ждёт 60 с)
#
#   make proxy-timeout                      # proxy is found by its image *nginx-proxy* (not acme/companion)
#   make proxy-timeout PROXY=<name>         # if the proxy wasn't found, or there are several
#   make proxy-timeout PROXY_TIMEOUT=600s   # a different timeout (default 400s)
#
# Inherited from a template where the model answered synchronously. The ai.engine protocol is
# asynchronous (202 in 5s, the answer arrives as a separate POST to callbackUrl, docs/RESEARCH.md),
# so a long timeout is probably not needed; to be settled at stage 2 of docs/PLAN.md.
#
# nginx-proxy includes /etc/nginx/vhost.d/<domain>_location in our domain's location block when it
# rebuilds its config. The target:
# - takes the domain from the VIRTUAL_HOST of the running app container — the one the proxy actually
#   serves, not from parsing .env;
# - appends the timeout line to the file, keeping other directives; a new file starts from the
#   contents of default_location, otherwise the proxy's shared settings would stop applying to our
#   domain;
# - rebuilds the config right inside the proxy (docker-gen → nginx -t → reload) without touching the
#   app, and checks that the file is included. Already configured — writes nothing, only nginx -t and
#   a soft reload: that way a repeat run fixes the case where reload failed last time (review in #16).
# Values are passed as arguments, not as command text, and validated by format (security review in
# #16). PROXY and PROXY_TIMEOUT come only from the make command line, and only as text (cli at the top
# of this file).
proxy-timeout: export PT_TIMEOUT = $(call cli,PROXY_TIMEOUT,400s)
proxy-timeout: export PT_PROXY = $(call cli,PROXY,)
proxy-timeout:
	@$(SH_LIB) \
	app_domain || { echo "[make] $$err"; exit 1; }; \
	{ one_line "$$PT_TIMEOUT" && printf '%s' "$$PT_TIMEOUT" | grep -Eqx '[0-9]{1,4}[smh]?'; } \
	  || { echo "[make] PROXY_TIMEOUT — число с s/m/h, например 400s: '$$PT_TIMEOUT'"; exit 1; }; \
	find_proxy || { echo "[make] $$err"; docker ps --format '  {{.Names}}\t{{.Image}}'; exit 1; }; \
	f="/etc/nginx/vhost.d/$${d}_location"; want="proxy_read_timeout $$PT_TIMEOUT;"; \
	echo "[make] прокси: $$p, домен: $$d, таймаут: $$PT_TIMEOUT"; \
	docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$$p" | grep -qx /etc/nginx/vhost.d \
	  || echo "[make] ⚠ /etc/nginx/vhost.d у прокси — не отдельный том: настройка пропадёт, когда прокси пересоздадут"; \
	if docker exec "$$p" grep -qsxF "$$want" "$$f" && docker exec "$$p" grep -rqsF "include $$f;" /etc/nginx/conf.d/; then \
	  docker exec "$$p" nginx -t && docker exec "$$p" nginx -s reload \
	    || { echo "[make] ⚠ файл подключён, но прокси не перечитал конфиг (ошибка выше)"; exit 1; }; \
	  echo "[make] уже настроено: $$f подключён, прокси перечитал конфиг"; exit 0; \
	fi; \
	docker exec "$$p" sh -c 'f=$$1; w=$$2; d=$${f%/*}; mkdir -p "$$d" || exit 1; \
	  if [ ! -f "$$f" ] && [ -f "$$d/default_location" ]; then cp "$$d/default_location" "$$f" || exit 1; fi; \
	  { if [ -f "$$f" ]; then grep -v "^[[:space:]]*proxy_read_timeout[[:space:]]" "$$f"; fi; printf "%s\n" "$$w"; } > "$$f.new" \
	  && mv "$$f.new" "$$f"' _ "$$f" "$$want" \
	  && docker exec "$$p" docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf \
	  && docker exec "$$p" nginx -t \
	  && docker exec "$$p" nginx -s reload \
	  || { echo "[make] ⚠ конфиг прокси не перестроен или не перечитан (ошибка выше). docker-gen не найден — прокси из отдельных контейнеров, перезапустите его docker-gen; упал reload — повторите make proxy-timeout"; exit 1; }; \
	if docker exec "$$p" grep -rqsF "include $$f;" /etc/nginx/conf.d/; then \
	  echo "[make] готово: конфиг прокси подключает $$f"; \
	else \
	  echo "[make] ⚠ конфиг перестроен, но $$f не подключён — проверьте, нет ли для домена своего _location_override"; exit 1; \
	fi

## Обновить docker-compose.prod.yml из репозитория: показать разницу, заменить — подтвердив её sha256
#
#   make compose-update                   # download and show what would change; file untouched
#   make compose-update CONFIRM=<sha256>  # replace exactly what was shown (the command is printed by
#                                         # the first run), the previous copy stays alongside; then make prod-up
#   make compose-update REF=<branch>      # take the file from a branch or tag instead of main
#
# Like the client-bank reference (compose-update): there's no repo on the server, and new container
# settings (labels, variables) arrive only this way — Watchtower updates the image, not this file.
# The download is checked by compose itself (`config`) against our .env: a broken file won't replace
# the working one. A `:sha-…` pin (rollback, pausing auto-updates) — a replacement would revert it to
# `:latest`, and that shows up in the diff.
# Confirmation is the sha256 of the shown file (12 chars), not a "yes": a commit could land on the
# branch between the show and the replace, so the download would already differ — refused (review in
# #16). If there's no file yet, it's installed. The replace is atomic: the temp file sits alongside
# (compose looks for .env next to the compose file), takes on the previous file's permissions (a new
# one gets 644: mktemp gives owner-only), and is renamed over it — a cut-off write won't leave a half
# file. On Ctrl+C the temp file is removed.
compose-update: export U_REF = $(call cli,REF,main)
compose-update: export CU_CONFIRM = $(call cli,CONFIRM,)
compose-update:
	@$(SH_LIB) \
	check_ref || { echo "[make] $$err"; exit 1; }; \
	[ -z "$$CU_CONFIRM" ] || { one_line "$$CU_CONFIRM" && printf '%s' "$$CU_CONFIRM" | grep -Eqx '[0-9a-f]{12}'; } \
	  || { echo "[make] CONFIRM — 12 знаков sha256 из вывода make compose-update"; exit 1; }; \
	t=$$(mktemp ./.docker-compose.prod.yml.XXXXXX) || exit 1; \
	trap 'rm -f "$$t"' EXIT; trap 'rm -f "$$t"; exit 130' INT TERM; \
	{ curl -fsSL -o "$$t" "https://raw.githubusercontent.com/bx-shef/aiconnect/$$U_REF/docker-compose.prod.yml" \
	  && grep -q '^services:' "$$t" \
	  && $(COMPOSE_ENV) -f "$$t" config -q; } \
	  || { echo "[make] docker-compose.prod.yml из $$U_REF не скачался или не прошёл проверку compose (ошибка выше; нет .env?) — рабочий не тронут"; exit 1; }; \
	sum=$$(sha256sum "$$t" | cut -c1-12); \
	if [ -f docker-compose.prod.yml ] && cmp -s "$$t" docker-compose.prod.yml; then echo "[make] docker-compose.prod.yml уже как в $$U_REF (sha256 $$sum)"; exit 0; fi; \
	if [ -f docker-compose.prod.yml ]; then diff -u docker-compose.prod.yml "$$t"; else echo "[make] docker-compose.prod.yml здесь ещё нет — будет поставлен"; fi; \
	if [ -z "$$CU_CONFIRM" ]; then echo "[make] выше — что изменится ($$U_REF, sha256 $$sum). Заменить именно это: make compose-update CONFIRM=$$sum"; exit 0; fi; \
	[ "$$CU_CONFIRM" = "$$sum" ] \
	  || { echo "[make] подтверждён sha256 $$CU_CONFIRM, а скачанный сейчас — $$sum: файл в $$U_REF изменился после показа. Разница выше; заменить её — make compose-update CONFIRM=$$sum"; exit 1; }; \
	b="нет"; \
	if [ -f docker-compose.prod.yml ]; then b="./docker-compose.prod.yml.bak-$$(date +%Y%m%d-%H%M%S)"; cp -p docker-compose.prod.yml "$$b" && chmod --reference=docker-compose.prod.yml "$$t" || exit 1; \
	else chmod 644 "$$t" || exit 1; fi; \
	mv "$$t" docker-compose.prod.yml \
	  && echo "[make] docker-compose.prod.yml обновлён из $$U_REF (sha256 $$sum), копия прежнего: $$b. Теперь make prod-up"

## Обновить САМ этот Makefile из репозитория (новые цели появляются на сервере только так)
#
#   make self-update                # from main
#   make self-update REF=<branch>   # from a branch or tag
#
# There's no repo on the server: the Makefile is placed there once and doesn't update itself. The
# download is checked against a marker present in every version of the file (.PHONY and the
# prod-redeploy target) — otherwise the check wouldn't let through exactly the update it was written
# for (the reference implementation's own pitfall). The nested make is literally `make`, not $(MAKE):
# a line with $(MAKE) also runs under `make -n`, and `make -n self-update` would download and replace
# the Makefile (review in #16). The replace works like compose-update's: temp file alongside, previous
# permissions, mv over it.
self-update: export U_REF = $(call cli,REF,main)
self-update:
	@$(SH_LIB) \
	check_ref || { echo "[make] $$err"; exit 1; }; \
	t=$$(mktemp ./.Makefile.XXXXXX) || exit 1; \
	trap 'rm -f "$$t"' EXIT; trap 'rm -f "$$t"; exit 130' INT TERM; \
	{ curl -fsSL -o "$$t" "https://raw.githubusercontent.com/bx-shef/aiconnect/$$U_REF/Makefile" \
	  && grep -q '^\.PHONY:' "$$t" \
	  && make -n -f "$$t" prod-redeploy >/dev/null 2>&1; } \
	  || { echo "[make] Makefile из $$U_REF не скачался или не прошёл проверку — рабочий не тронут"; exit 1; }; \
	b="./Makefile.bak-$$(date +%Y%m%d-%H%M%S)"; \
	cp -p ./Makefile "$$b" && chmod --reference=./Makefile "$$t" && mv "$$t" ./Makefile \
	  && echo "[make] Makefile обновлён из $$U_REF, копия прежнего: $$b" \
	  && make --no-print-directory help

## Список целей с описаниями
#
# Remembers the last `##` line and prints it at the nearest following target: comment lines can sit
# between the description and the target, and a naive `grep -B1` would lose them.
help:
	@awk '/^## /{d=substr($$0,4)} \
	      /^[A-Za-z0-9_][A-Za-z0-9_.-]*:/{if(d!=""){printf "  %-15s %s\n", substr($$1,1,length($$1)-1), d; d=""}}' \
	      $(MAKEFILE_LIST)
