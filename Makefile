.PHONY: build-local prod-up prod-down prod-pull prod-redeploy logs ps health doctor backup proxy-timeout \
        compose-update self-update help

# Голый `make` на сервере печатает справку, а не запускает первую цель.
.DEFAULT_GOAL := help

# Обёртки над командами выката — как в эталоне client-bank-alfa-by. Подробности — docs/DEPLOY.md.
# Прод-цели читают ./.env рядом с docker-compose.prod.yml (DOMAIN, ключи — см. .env.example).

# От чего защищаемся (ревью безопасности на #16):
# - окружение общего хоста: чужой экспортированный DOMAIN, REF, PROXY… не должен ничего менять —
#   внешние значения REF, PROXY, PROXY_TIMEOUT, CONFIRM берутся только из командной строки make;
# - значения, которые вставляют из чужих сообщений как есть (`REF=<ветка>`, `CONFIRM=<sha256>`):
#   берутся как текст ($(value …) — иначе make сам выполнил бы `$(shell …)` из значения ещё до
#   оболочки), в рецепт приходят переменными окружения, а не текстом команды, и проверяются по формату.
# От чего НЕ защищаемся: командная строка make — это команды оператора. `REF:=$(shell …)`, любая
# другая переменная с `$(…)`, `SHELL=` выполнят что угодно, и Makefile это не остановит. То же —
# MAKEFLAGS в окружении: make считает его командной строкой и разбирает ДО чтения этого файла. На
# сервере MAKEFLAGS в окружении быть не должно (docs/DEPLOY.md).
# override — у всего, что исполняется или проверяет: иначе переменная с тем же именем заменила бы
# функцию проверки или сами команды (как APP_CONTAINER ниже).
#   $(call cli,ИМЯ,умолчание)
override cli = $(if $(filter command line,$(origin $(1))),$(value $(1)),$(2))
# Переменные командной строки make сам кладёт в окружение каждой команды и для этого раскрывает их
# значение — `$(shell …)` в нём сработал бы там. unexport: в рецепт они попадают только копиями
# через cli (U_REF, PT_*, CU_CONFIRM), уже как текст.
unexport REF PROXY PROXY_TIMEOUT CONFIRM
# compose подставляет ${DOMAIN}, ${LETSENCRYPT_EMAIL} и ${B24_TOKEN_ENC_KEY} из окружения оболочки
# РАНЬШЕ, чем из ./.env: экспортированный на общем хосте DOMAIN соседнего проекта увёл бы наш
# VIRTUAL_HOST (и сертификат) на чужой домен. Поэтому compose запускается без них — источник один, ./.env.
override COMPOSE_ENV = env -u DOMAIN -u LETSENCRYPT_EMAIL -u B24_TOKEN_ENC_KEY docker compose
override COMPOSE = $(COMPOSE_ENV) -f docker-compose.prod.yml
# Имя контейнера приложения — container_name в docker-compose.prod.yml (сверяет tests/makefileProd.test.ts).
# override: ни `make … APP_CONTAINER=…`, ни MAKEFLAGS не подменят, чей VIRTUAL_HOST берёт proxy-timeout.
override APP_CONTAINER := aiconnect

# Общие shell-функции целей. make склеивает `\`-переносы присваивания в одну строку, поэтому
# команды разделены `;`. Ошибку функции кладут в $$err и возвращают 1.
#   app_domain — d: VIRTUAL_HOST работающего контейнера приложения (одна строка, формат домена);
#   find_proxy — p: запущенный контейнер nginx-proxy — PROXY из командной строки или единственный,
#                чей образ называется ровно nginx-proxy (nginxproxy/nginx-proxy:1.7, jwilder/nginx-proxy):
#                подстрока приняла бы и чужой образ вроде nginx-proxy-dashboard. Образ — из inspect
#                (.Config.Image): в `docker ps` после pull нового образа вместо имени виден его ID
#                (ревью на #16);
#   check_ref  — U_REF: имя ветки или тега для адреса raw.githubusercontent.com.
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

# ─── Локально ────────────────────────────────────────────────────────

## Собрать образ из исходников и запустить на 127.0.0.1:3000 на переднем плане (docker-compose.yml)
build-local:
	docker compose up --build

# ─── Прод (на сервере, /home/bitrix/aiconnect) ──────────────
# Нужны общий nginx-proxy + acme-companion, Watchtower и docker-сеть proxy-net на хосте.
# Свой Watchtower НЕ поднимаем — хостовый подхватывает контейнер по метке.

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
# Чистим только свои висящие образы (метка source ставится при сборке в CI): хост общий, и чужие
# проекты свои образы убирают сами.
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
# Проверку через прокси (request.forwardedFor = used) делайте снаружи:
#   curl -s https://<DOMAIN>/api/health
health:
	$(COMPOSE) exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r => r.text()).then(t => console.log(t))"

## Проверить выкат одной командой: контейнер, настройки, прокси, https, сертификат, Watchtower, диск
#
#   make doctor               # только читает, ничего не меняет
#   make doctor PROXY=<имя>   # если прокси не нашёлся или их несколько
#
# Как в эталоне client-bank (make doctor): одна команда вместо ручного обхода. Каждая строка — ✓,
# ✗ (после «→» — что делать; есть ✗ — make завершится с ошибкой) или ⚠ (необязательное не задано
# или проверить нечем — не ошибка, но и не «всё в порядке»). Что проверяет, кроме контейнера:
# - /api/health изнутри: сборка и что не задано — в .env, в compose-файле или необязательное;
# - прокси ходит в приложение без keepalive — иначе 502 на POST из портала (метка в compose) — и
#   видит хотя бы один рабочий сервер приложения;
# - таймаут прокси для домена подключён (make proxy-timeout);
# - https снаружи отвечает и видит адрес клиента; сертификат доверенный, на наш домен и не
#   истекает в ближайшие 14 дней;
# - Watchtower запущен; диск с каталогом данных docker занят меньше чем на 90 %.
# https проверяется с самого сервера: если он не видит себя по внешнему адресу, проверьте с другого
# компьютера — curl -s https://<домен>/api/health.
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
	h=$$(docker exec $(APP_CONTAINER) node -e "const env = { oauth: 'B24_CLIENT_ID/B24_CLIENT_SECRET', tokenKey: 'B24_TOKEN_ENC_KEY', appCode: 'B24_APP_CODE' }; const compose = { siteUrl: 'NUXT_PUBLIC_SITE_URL', trustProxy: 'TRUST_PROXY' }; const optional = { bitrixGpt: 'VIBE_API_KEY/BITRIXGPT_API_KEY' }; fetch('http://127.0.0.1:3000/api/health').then(r => r.json()).then(j => { const c = j.config || {}; const off = Object.keys(c).filter(k => c[k] !== true); const list = pick => off.filter(pick).map(k => env[k] || compose[k] || optional[k] || k).join(',') || '-'; console.log([String(j.commit || 'неизвестна').replace(/\s/g, ''), list(k => !(k in compose) && !(k in optional)), list(k => k in compose), list(k => k in optional)].join(' ')) }).catch(() => process.exit(1))" 2>/dev/null); \
	if [ -z "$$h" ]; then fail "GET /api/health изнутри контейнера не ответил → make logs"; else \
	  set -- $$h; \
	  if [ "$$2" = - ] && [ "$$3" = - ]; then ok "настройки сервера заданы, сборка $$1"; fi; \
	  [ "$$2" = - ] || fail "не задано в .env: $$2 → вписать и make prod-up (таблица переменных — docs/DEPLOY.md); сборка $$1"; \
	  [ "$$3" = - ] || fail "не задано в docker-compose.prod.yml: $$3 → make compose-update, затем make prod-up"; \
	  [ "$$4" = - ] || warn "не задано (необязательно): $$4 — без него не работают названия через BitrixGPT и консультации"; \
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
	    else fail "таймаут прокси для $$d не подключён — 60 с мало для BitrixGPT → make proxy-timeout"; fi; \
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
# Без ключа копия бесполезна, ключ — отдельно и вне сервера. Восстановление — docs/DEPLOY.md.
backup:
	@mkdir -p backups && f="backups/portals-$$(date +%Y%m%d-%H%M%S).tgz" \
	  && { $(COMPOSE) exec -T app tar czf - -C /app/.data . > "$$f" || { rm -f "$$f"; exit 1; }; } \
	  && echo "[make] копия: $$f ($$(du -h "$$f" | cut -f1))"

## Поднять таймаут общего nginx-proxy для нашего домена (по умолчанию он ждёт 60 с — мало для BitrixGPT)
#
#   make proxy-timeout                      # прокси найдётся по образу *nginx-proxy* (не acme/companion)
#   make proxy-timeout PROXY=<имя>          # если прокси не нашёлся или их несколько
#   make proxy-timeout PROXY_TIMEOUT=600s   # другой таймаут (по умолчанию 400s: BitrixGPT — до 120 с × 3)
#
# nginx-proxy подключает /etc/nginx/vhost.d/<домен>_location в блок location нашего домена, когда
# перестраивает конфиг. Цель:
# - берёт домен из VIRTUAL_HOST работающего контейнера приложения — того, что прокси реально
#   обслуживает, а не из разбора .env;
# - дописывает в файл строку таймаута, сохраняя другие директивы; новый файл начинает с содержимого
#   default_location, иначе общие настройки прокси перестали бы действовать на наш домен;
# - перестраивает конфиг прямо в прокси (docker-gen → nginx -t → reload), не трогая приложение, и
#   проверяет, что файл подключён. Уже настроено — ничего не пишет, только nginx -t и мягкий reload:
#   так повторный запуск чинит случай, когда в прошлый раз упал reload (ревью на #16).
# Значения передаются аргументами, а не текстом команд, и проверяются по формату (ревью безопасности
# на #16). PROXY и PROXY_TIMEOUT — только из командной строки make и только как текст (cli вверху файла).
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
#   make compose-update                   # скачать и показать, что изменится; файл не трогается
#   make compose-update CONFIRM=<sha256>  # заменить именно показанное (команду печатает первый запуск),
#                                         # копия прежнего — рядом; затем make prod-up
#   make compose-update REF=<ветка>       # взять файл из ветки или тега, а не из main
#
# Как в эталоне client-bank (compose-update): репозитория на сервере нет, и новые настройки
# контейнера (метки, переменные) приезжают только так — Watchtower обновляет образ, а не этот файл.
# Скачанное проверяет сам compose (`config`) с нашим .env: битый файл не заменит рабочий. Пин
# `:sha-…` (откат, пауза автообновлений) замена вернёт на `:latest` — это видно в разнице.
# Подтверждение — sha256 показанного файла (12 знаков), а не «да»: между показом и заменой в ветку
# мог прийти коммит, и тогда скачанное уже другое — отказ (ревью на #16). Файла ещё нет — ставит
# его. Замена атомарная: временный файл лежит рядом (compose ищет .env возле compose-файла), получает
# права прежнего (новый — 644: у mktemp только владельцу) и переименовывается поверх — оборванная
# запись не оставит полфайла. При Ctrl+C временный файл убирается.
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
#   make self-update                # из main
#   make self-update REF=<ветка>    # из ветки или тега
#
# Репозитория на сервере нет: Makefile кладётся туда один раз и сам не обновляется. Скачанное
# проверяется по признаку, который есть в любой версии файла (.PHONY и цель prod-redeploy), —
# иначе проверка не пропустила бы как раз то обновление, ради которого написана (грабли эталона).
# Вложенный make — буквально `make`, а не $(MAKE): строку с $(MAKE) make выполняет и под `make -n`,
# и `make -n self-update` скачивал и заменял бы Makefile (ревью на #16). Замена — как у
# compose-update: временный файл рядом, права прежнего, mv поверх.
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
# Запоминает последнюю строку `##` и печатает её у ближайшей следующей цели: между описанием и
# целью бывают строки комментария, и наивный `grep -B1` их терял.
help:
	@awk '/^## /{d=substr($$0,4)} \
	      /^[A-Za-z0-9_][A-Za-z0-9_.-]*:/{if(d!=""){printf "  %-15s %s\n", substr($$1,1,length($$1)-1), d; d=""}}' \
	      $(MAKEFILE_LIST)
