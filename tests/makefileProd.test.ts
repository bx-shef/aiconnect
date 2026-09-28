// Makefile на сервере (docs/DEPLOY.md): цели `proxy-timeout`, `doctor`, `compose-update` и запуск compose.
//
// ⚠ Прогоняется НАСТОЯЩИЙ make на тексте Makefile из репозитория, а не его пересказ: у рецептов
// три слоя экранирования (make → sh → sh внутри контейнера прокси), и копия в тесте разошлась бы с
// ними молча. docker подменён скриптом в PATH: он пишет вызовы в журнал, а скрипт, который цель
// выполняет внутри контейнера прокси (`sh -c …`), запускает по-настоящему во временном каталоге
// вместо корня контейнера — так проверяется и то, что станет с файлом vhost.d.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')

// Подставной docker на node: журнал вызовов, «контейнер прокси» — каталог FAKE_ROOT. Скрипт записи
// (`exec … sh -c`) и проверки (`exec … grep`) выполняются ПО-НАСТОЯЩЕМУ с теми аргументами, что
// передала цель, — пути подменяются на FAKE_ROOT. docker-gen повторяет шаблон nginx-proxy: include
// строится по файлам vhost.d, которые лежат в момент генерации, и `_location_override` хоста
// вытесняет его `_location`.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process')
const a = process.argv.slice(2), env = process.env, R = env.FAKE_ROOT
fs.appendFileSync(env.DOCKER_LOG, a.join(' ') + '\\n')
const nl = s => s.replace(/\\\\n/g, '\\n')
// FAKE_PS — строки «имя образ». \`ps -q\` отдаёт имена вместо ID; образ — через inspect (.Config.Image),
// а в самом \`ps\` при FAKE_PS_IMAGE_IDS=1 вместо образа виден ID, как после pull нового образа.
const ps = nl(env.FAKE_PS ?? '').split('\\n').filter(Boolean).map(l => { const [name, image] = l.split(' '); return { name, image } })
if (a[0] === 'ps') {
  if (a.includes('-q')) process.stdout.write(ps.map(c => c.name + '\\n').join(''))
  else {
    const fmt = a.includes('--format') ? a[a.indexOf('--format') + 1] : '{{.Names}} {{.Image}}'
    const image = c => env.FAKE_PS_IMAGE_IDS === '1' ? '4f1a2b3c4d5e' : c.image
    process.stdout.write(ps.map(c => fmt.replace('{{.Names}}', c.name).replace('{{.Image}}', image(c)).replace('\\\\t', '\\t') + '\\n').join(''))
  }
  process.exit(0)
}
if (a[0] === 'inspect') {
  const j = a.join(' ')
  if (j.includes('{{.Config.Image}}')) {
    for (const id of a.slice(3)) {
      const c = ps.find(x => x.name === id)
      if (c) process.stdout.write((j.includes('{{.Name}}') ? '/' + c.name + ' ' : '') + c.image + '\\n')
    }
    process.exit(0)
  }
  if (j.includes('.State.Running')) {
    process.stdout.write((env.FAKE_NOT_RUNNING ?? '').split(',').includes(a.at(-1)) ? 'false\\n' : 'true\\n')
    process.exit(0)
  }
  if (j.includes('.State.Status')) {
    if ((env.FAKE_STATE ?? 'running healthy') === '') process.exit(1)
    process.stdout.write((env.FAKE_STATE ?? 'running healthy') + '\\n')
  }
  if (j.includes('nginx-proxy.keepalive')) process.stdout.write((env.FAKE_KEEPALIVE ?? 'disabled') + '\\n')
  if (j.includes('Config.Env')) {
    if (!env.FAKE_VHOST) process.exit(1)
    process.stdout.write('PATH=/usr/bin\\nVIRTUAL_HOST=' + nl(env.FAKE_VHOST) + '\\nTRUST_PROXY=1\\n')
  }
  if (j.includes('Mounts') && (env.FAKE_MOUNTED ?? '1') === '1') process.stdout.write('/etc/nginx/vhost.d\\n/etc/nginx/certs\\n')
  process.exit(0)
}
if (a[0] === 'info') { process.stdout.write((env.FAKE_DOCKER_ROOT ?? '/var/lib/docker') + '\\n'); process.exit(0) }
if (a[0] === 'compose') {
  fs.appendFileSync(env.DOCKER_LOG, 'compose-env DOMAIN=' + (env.DOMAIN ?? 'unset') + ' KEY=' + (env.B24_TOKEN_ENC_KEY ?? 'unset') + '\\n')
  if (a.includes('config')) process.exit(Number(env.FAKE_CONFIG ?? 0))
  process.exit(0)
}
if (a[0] === 'exec') {
  const [cmd, ...rest] = a.slice(2)
  // Скрипт health, который doctor запускает node в контейнере приложения, — настоящий; fetch подменён.
  if (cmd === 'node') {
    const stub = 'globalThis.fetch = async () => { const h = process.env.FAKE_HEALTH; if (h === "down") throw new Error("down"); return { ok: true, json: async () => JSON.parse(h) } };'
    process.exit(cp.spawnSync(process.execPath, ['-e', stub + rest[1]], { stdio: 'inherit' }).status ?? 1)
  }
  if (cmd === 'cat') {
    try { process.stdout.write(fs.readFileSync(R + rest[0])) } catch { process.exit(1) }
    process.exit(0)
  }
  if (cmd === 'sh') process.exit(cp.spawnSync('sh', ['-c', rest[1], '_', R + rest[3], rest[4]], { stdio: 'inherit' }).status ?? 1)
  if (cmd === 'grep') {
    rest[rest.length - 1] = R + rest[rest.length - 1]
    process.exit(cp.spawnSync('grep', rest, { stdio: 'inherit' }).status ?? 2)
  }
  if (cmd === 'docker-gen') {
    if (env.FAKE_GEN_FAIL === '1') process.exit(1)
    const dir = R + '/etc/nginx/vhost.d'
    const lines = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter(f => f.endsWith('_location') && f !== 'default_location')
      .map(f => fs.existsSync(path.join(dir, f + '_override')) ? 'include /etc/nginx/vhost.d/' + f + '_override;' : 'include /etc/nginx/vhost.d/' + f + ';')
    fs.mkdirSync(R + '/etc/nginx/conf.d', { recursive: true })
    fs.writeFileSync(R + '/etc/nginx/conf.d/default.conf', lines.join('\\n') + '\\n')
    process.exit(0)
  }
  if (cmd === 'nginx') process.exit(Number((rest[0] === '-t' ? env.FAKE_NGINX_T : env.FAKE_RELOAD) ?? 0))
}
process.exit(0)
`

// Хост: curl (скачивание из репозитория и https снаружи), openssl (сертификат), df (диск).
const FAKE_CURL = `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), env = process.env
const url = a.find(x => x.startsWith('https://')) ?? ''
fs.appendFileSync(env.DOCKER_LOG, 'curl ' + url + '\\n')
if (url.startsWith('https://raw.githubusercontent.com/')) {
  if (env.FAKE_DL === undefined) process.exit(22)
  fs.writeFileSync(a[a.indexOf('-o') + 1], env.FAKE_DL)
  process.exit(0)
}
if (env.FAKE_EXT === undefined) { process.stderr.write('curl: (7) Failed to connect'); process.exit(7) }
process.stdout.write(env.FAKE_EXT)
`
const FAKE_OPENSSL = `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), env = process.env
const input = fs.readFileSync(0, 'utf8')
if (a[0] === 's_client') {
  // Недоверенный сертификат (самоподписанный заглушки nginx-proxy): с проверкой цепочки и имени
  // рукопожатие обрывается, без неё — сертификат читается, как у настоящего openssl.
  const strict = a.includes('-verify_return_error') && a[a.indexOf('-verify_hostname') + 1] === 'aiconnect.example.by'
  if (env.FAKE_CERT_UNTRUSTED === '1' && strict) process.exit(1)
  process.stdout.write(env.FAKE_CERT ?? '-----BEGIN CERTIFICATE-----\\n')
  process.exit(0)
}
if (!input.includes('BEGIN CERTIFICATE')) process.exit(1)
if (a.includes('-enddate')) process.stdout.write('notAfter=Dec 24 10:00:00 2026 GMT\\n')
if (a.includes('-checkend')) process.exit(env.FAKE_CERT_SOON === '1' ? 1 : 0)
`
const FAKE_DF = `#!/bin/sh
[ "\${FAKE_DF_USED:-}" = none ] && exit 1
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "/dev/sda1 100 50 50 \${FAKE_DF_USED:-42}% /"
`

// Рядом с прокси — companion обоих поколений: старый образ тоже содержит «nginx-proxy» в имени.
const ONE_PROXY = 'nginx-proxy nginxproxy/nginx-proxy:1.7\\nnginx-proxy-acme nginxproxy/acme-companion:2.5\\nletsencrypt jrcs/letsencrypt-nginx-proxy-companion:latest\\naiconnect ghcr.io/bx-shef/aiconnect:latest\\n'
const VHOST_DIR = '/etc/nginx/vhost.d'
const FILE = `${VHOST_DIR}/aiconnect.example.by_location`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Run { code: number, out: string, calls: string[], dir: string, root: string }

interface MakeOpts {
  args?: string[]
  env?: Record<string, string>
  /** Файлы в vhost.d прокси. */
  files?: Record<string, string>
  /** /etc/nginx/conf.d/default.conf прокси. */
  conf?: string
  noVhostDir?: boolean
  /** Файлы рядом с Makefile (каталог на сервере). */
  here?: Record<string, string>
  /** Права файлов из `here`. */
  modes?: Record<string, number>
  /** Утилиты, которых «нет на сервере»: ни подставной, ни настоящей в PATH. */
  hide?: string[]
}

/**
 * Каталог со ссылками на все программы PATH, кроме `hide`, — сервер без curl или openssl. Сам PATH
 * урезать нельзя: в тех же каталогах лежат sh, awk, sed, которые нужны make.
 */
function pathWithout(hide: string[], into: string): string {
  mkdirSync(into)
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d || !existsSync(d)) continue
    for (const name of readdirSync(d)) {
      if (hide.includes(name) || existsSync(join(into, name))) continue
      try {
        if (statSync(join(d, name)).isFile()) symlinkSync(join(d, name), join(into, name))
      } catch { /* битая ссылка в PATH — пропускаем */ }
    }
  }
  return into
}

function make(target: string, opts: MakeOpts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'ift-make-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'Makefile'), MAKEFILE)
  const bin = join(dir, 'bin')
  const root = join(dir, 'proxy-root')
  mkdirSync(bin)
  mkdirSync(opts.noVhostDir ? root : join(root, VHOST_DIR), { recursive: true })
  for (const [name, text] of Object.entries(opts.files ?? {})) writeFileSync(join(root, VHOST_DIR, name), text)
  if (opts.conf !== undefined) {
    mkdirSync(join(root, '/etc/nginx/conf.d'), { recursive: true })
    writeFileSync(join(root, '/etc/nginx/conf.d/default.conf'), opts.conf)
  }
  for (const [name, text] of Object.entries(opts.here ?? {})) writeFileSync(join(dir, name), text)
  for (const [name, mode] of Object.entries(opts.modes ?? {})) chmodSync(join(dir, name), mode)
  for (const [name, text] of [['docker', FAKE_DOCKER], ['curl', FAKE_CURL], ['openssl', FAKE_OPENSSL], ['df', FAKE_DF]] as const) {
    if (opts.hide?.includes(name)) continue
    writeFileSync(join(bin, name), text)
    chmodSync(join(bin, name), 0o755)
  }
  const sysPath = opts.hide?.length ? pathWithout(opts.hide, join(dir, 'sys')) : process.env.PATH
  const log = join(dir, 'docker.log')
  writeFileSync(log, '')
  const env: Record<string, string> = {
    PATH: `${bin}:${sysPath}`,
    HOME: dir,
    DOCKER_LOG: log,
    FAKE_ROOT: root,
    FAKE_PS: ONE_PROXY,
    FAKE_VHOST: 'aiconnect.example.by',
    ...opts.env
  }
  const res = spawnSync('make', ['--no-print-directory', target, ...(opts.args ?? [])], { cwd: dir, env, encoding: 'utf8' })
  const calls = readFileSync(log, 'utf8').split('\n').filter(l => l && !l.startsWith('ps ') && !l.startsWith('inspect '))
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}`, calls, dir, root }
}

const proxyTimeout = (opts: Parameters<typeof make>[1] = {}) => make('proxy-timeout', opts)
const vhostFile = (r: Run) => readFileSync(join(r.root, FILE), 'utf8')

describe('make proxy-timeout', () => {
  it('домен — из VIRTUAL_HOST контейнера; пишет таймаут, перестраивает конфиг в прокси, приложение не трогает', () => {
    const r = proxyTimeout()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by, таймаут: 400s')
    expect(vhostFile(r)).toBe('proxy_read_timeout 400s;\n')
    expect(r.calls).toEqual(expect.arrayContaining([
      'exec nginx-proxy docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf',
      'exec nginx-proxy nginx -t',
      'exec nginx-proxy nginx -s reload'
    ]))
    const order = ['docker-gen', 'nginx -t', 'nginx -s reload'].map(s => r.calls.findIndex(c => c.includes(s)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(r.calls.some(c => c.startsWith('compose'))).toBe(false)
    expect(existsSync(join(r.root, `${FILE}.new`)), 'временный файл убран (mv, не cp)').toBe(false)
    expect(r.out).toContain('готово')
  })

  it('vhost.d у прокси ещё нет — каталог создаётся, файл пишется', () => {
    const r = proxyTimeout({ noVhostDir: true })
    expect(r.code, r.out).toBe(0)
    expect(vhostFile(r)).toBe('proxy_read_timeout 400s;\n')
  })

  it('другие директивы в файле сохраняются, старый таймаут заменяется', () => {
    const r = proxyTimeout({ files: { 'aiconnect.example.by_location': 'client_max_body_size 50m;\nproxy_read_timeout 60s;\n' } })
    expect(r.code, r.out).toBe(0)
    expect(vhostFile(r)).toBe('client_max_body_size 50m;\nproxy_read_timeout 400s;\n')
  })

  it('новый файл начинается с default_location — общие настройки прокси не теряются', () => {
    const r = proxyTimeout({ files: { default_location: 'add_header X-Common 1;\n' } })
    expect(r.code, r.out).toBe(0)
    expect(vhostFile(r)).toBe('add_header X-Common 1;\nproxy_read_timeout 400s;\n')
  })

  it('уже настроено — ничего не пишет и не перестраивает, только мягкий reload', () => {
    const r = proxyTimeout({
      files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n' },
      conf: `include ${FILE};\n`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('уже настроено')
    expect(r.calls.some(c => c.includes('sh -c') || c.includes('docker-gen'))).toBe(false)
    expect(r.calls).toEqual(expect.arrayContaining(['exec nginx-proxy nginx -t', 'exec nginx-proxy nginx -s reload']))
  })

  it('reload упал — ошибка; повторный запуск видит «уже настроено» и перечитывает конфиг', () => {
    const first = proxyTimeout({ env: { FAKE_RELOAD: '1' } })
    expect(first.code).not.toBe(0)
    expect(first.out).toContain('повторите make proxy-timeout')
    const again = proxyTimeout({
      files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n' },
      conf: `include ${FILE};\n`,
      env: { FAKE_RELOAD: '1' }
    })
    expect(again.code, 'и в ветке «уже настроено» провал reload — не успех').not.toBe(0)
  })

  it('наш файл есть, но в конфиге подключён только соседний хост — перестраивает, а не «уже настроено»', () => {
    const r = proxyTimeout({
      files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n', 'aiconnectxexample.by_location': 'gzip on;\n' },
      conf: 'include /etc/nginx/vhost.d/aiconnectxexample.by_location;\n'
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('уже настроено')
    expect(r.calls).toContain('exec nginx-proxy docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf')
  })

  it('таймаут в файле только в комментарии — это не «уже настроено»', () => {
    const r = proxyTimeout({
      files: { 'aiconnect.example.by_location': '#proxy_read_timeout 400s;\n' },
      conf: `include ${FILE};\n`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('уже настроено')
    expect(vhostFile(r)).toBe('#proxy_read_timeout 400s;\nproxy_read_timeout 400s;\n')
  })

  it('nginx -t не прошёл — без reload и с ошибкой', () => {
    const r = proxyTimeout({ env: { FAKE_NGINX_T: '1' } })
    expect(r.code).not.toBe(0)
    expect(r.calls.some(c => c.includes('reload'))).toBe(false)
    expect(r.out).toContain('не перестроен')
  })

  it('для домена есть _location_override — файл не подключён: ошибка, а не «готово»', () => {
    // Соседний хост, отличающийся от нашего одной буквой на месте точки: подстрока или регулярное
    // выражение вместо точной строки include приняли бы его include за наш.
    const r = proxyTimeout({ files: { 'aiconnect.example.by_location_override': 'return 503;\n', 'aiconnectxexample.by_location': 'gzip on;\n' } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('не подключён')
  })

  it('vhost.d прокси не отдельный том — предупреждает', () => {
    const r = proxyTimeout({ env: { FAKE_MOUNTED: '0' } })
    expect(r.out).toContain('не отдельный том')
  })

  it('контейнер приложения не запущен — просит make prod-up', () => {
    const r = proxyTimeout({ env: { FAKE_VHOST: '' } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('сначала make prod-up')
    expect(r.calls).toEqual([])
  })

  it.each([
    ['нет прокси', 'watchtower containrrr/watchtower\\n', 0],
    ['только образы, похожие на прокси по имени', 'dash someone/nginx-proxy-dashboard:1\\nle jrcs/letsencrypt-nginx-proxy-companion\\n', 0],
    ['два прокси', 'p1 nginxproxy/nginx-proxy\\np2 jwilder/nginx-proxy\\n', 2]
  ])('%s — просит PROXY=<имя> и ничего не пишет', (_label, ps, n) => {
    const r = proxyTimeout({ env: { FAKE_PS: ps } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`контейнеров nginx-proxy найдено: ${n}. Укажите нужный: make proxy-timeout PROXY=<имя>`)
    expect(r.calls).toEqual([])
  })

  it('после pull нового образа docker ps показывает ID вместо имени — прокси всё равно находится (образ из inspect)', () => {
    const r = proxyTimeout({ env: { FAKE_PS_IMAGE_IDS: '1' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by')
  })

  it('PROXY=<опечатка> — контейнера нет или он не запущен: так и говорит, ничего не делает', () => {
    const r = proxyTimeout({ args: ['PROXY=nginx-prxy'], env: { FAKE_NOT_RUNNING: 'nginx-prxy' } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('контейнер прокси nginx-prxy не запущен или такого нет')
    expect(r.calls).toEqual([])
    const d = doctor({ args: ['PROXY=nginx-prxy'], env: { FAKE_NOT_RUNNING: 'nginx-prxy' } })
    expect(failures(d)).toEqual([expect.stringContaining('контейнер прокси nginx-prxy не запущен или такого нет')])
  })

  it('прокси — только образ с именем ровно nginx-proxy: соседский nginx-proxy-dashboard не в счёт', () => {
    const r = proxyTimeout({ env: { FAKE_PS: `dash someone/nginx-proxy-dashboard:1\\n${ONE_PROXY}` } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by')
  })

  it('PROXY=<имя> и PROXY_TIMEOUT=… из командной строки — берутся', () => {
    const r = proxyTimeout({ args: ['PROXY=edge-proxy', 'PROXY_TIMEOUT=600s'], env: { FAKE_PS: '' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: edge-proxy, домен: aiconnect.example.by, таймаут: 600s')
  })

  it('контейнер приложения не подменить ни командной строкой, ни MAKEFLAGS', () => {
    for (const r of [
      proxyTimeout({ args: ['APP_CONTAINER=evil'] }),
      proxyTimeout({ env: { MAKEFLAGS: 'APP_CONTAINER=evil' } })
    ]) {
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(r.dir, 'docker.log'), 'utf8')).toMatch(/^inspect .* aiconnect$/m)
      expect(readFileSync(join(r.dir, 'docker.log'), 'utf8')).not.toContain('evil')
    }
  })

  it('PROXY и PROXY_TIMEOUT из окружения оболочки — не берутся, даже с make-функцией внутри', () => {
    for (const env of [{ PROXY: 'http://10.0.0.1:3128', PROXY_TIMEOUT: '1s' }, { PROXY: '$(shell touch PWNED)', PROXY_TIMEOUT: '$(shell touch PWNED)' }]) {
      const r = proxyTimeout({ env })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by, таймаут: 400s')
      expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    }
  })

  // Находки ревью безопасности на #16: значения не должны становиться командами ни на хосте, ни в прокси.
  it.each([
    ['подстановка команды в VIRTUAL_HOST', { env: { FAKE_VHOST: 'x$(touch PWNED)y.by' } }],
    ['выход из vhost.d', { env: { FAKE_VHOST: '../../etc/nginx/nginx.conf' } }],
    ['несколько доменов через запятую', { env: { FAKE_VHOST: 'a.by,b.by' } }],
    ['кавычка и команда в таймауте', { args: ['PROXY_TIMEOUT=1s\'; touch PWNED; echo \''] }],
    ['перевод строки в таймауте', { args: ['PROXY_TIMEOUT=400s\n\'; touch PWNED; echo \''] }],
    ['таймаут без числа', { args: ['PROXY_TIMEOUT=long'] }],
    ['странное имя прокси', { args: ['PROXY=p;touch PWNED'] }],
    // make сам выполнил бы $(shell …) из значения ещё до оболочки, если бы брал его не как текст.
    ['make-функция в таймауте', { args: ['PROXY_TIMEOUT=$(shell touch PWNED)'] }],
    ['make-функция в имени прокси', { args: ['PROXY=$(shell touch PWNED)'] }]
  ])('%s — отказ до любой записи', (_label, opts) => {
    const r = proxyTimeout(opts)
    expect(r.code).not.toBe(0)
    expect(r.calls).toEqual([])
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    expect(existsSync(join(r.root, 'PWNED'))).toBe(false)
  })
})

describe('make proxy-timeout: перевод строки в VIRTUAL_HOST', () => {
  it('берётся первая строка, хвост командой не становится', () => {
    const r = proxyTimeout({ env: { FAKE_VHOST: 'aiconnect.example.by\\nx; touch PWNED; y.by' } })
    expect(r.out).toContain('домен: aiconnect.example.by,')
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    expect(existsSync(join(r.root, 'PWNED'))).toBe(false)
  })
})

describe('compose на сервере берёт окружение только из ./.env', () => {
  it('DOMAIN и ключ шифрования из оболочки до compose не доходят', () => {
    const r = make('prod-up', { env: { DOMAIN: 'bank-import.example.by', B24_TOKEN_ENC_KEY: 'neighbour' } })
    expect(r.code, r.out).toBe(0)
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
  })

  it('DOMAIN=… в командной строке make тоже не доходит', () => {
    const r = make('prod-up', { args: ['DOMAIN=bank-import.example.by'] })
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
  })

  it('имя контейнера в Makefile совпадает с container_name в docker-compose.prod.yml', () => {
    const name = /^override APP_CONTAINER := (\S+)$/m.exec(MAKEFILE)?.[1]
    const compose = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8')
    expect(name).toBeTruthy()
    expect(compose).toMatch(new RegExp(`^ {4}container_name: ${name}$`, 'm'))
  })
})

// ─── make doctor ──────────────────────────────────────────────────────
// Здоровый сервер: прокси, Watchtower и приложение запущены; upstream без keepalive, таймаут подключён,
// health отвечает изнутри и снаружи, сертификат свежий, диск свободен. Каждый тест ломает одно.
const SHA = 'a8f2ef2b57059e518ff1f14a880dcee79dd41d00'
const HEALTH = (config: Record<string, boolean> = {}) => JSON.stringify({
  ok: true,
  commit: SHA.slice(0, 7),
  config: { siteUrl: true, oauth: true, tokenKey: true, appCode: true, trustProxy: true, ...config },
  request: { forwardedFor: 'used' }
})
const UPSTREAM = (extra = '') => `upstream aiconnect.example.by {\n    # Container: aiconnect\n    server 172.18.0.14:3000;\n${extra}}\n`
const HEALTHY: MakeOpts = {
  env: {
    // Имя без «watchtower»: Watchtower узнаётся по образу, а не по имени контейнера.
    FAKE_PS: `${ONE_PROXY}wt containrrr/watchtower:latest\\n`,
    FAKE_HEALTH: HEALTH(),
    FAKE_EXT: HEALTH()
  },
  files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n' },
  conf: `${UPSTREAM()}server {\n    location / {\n        include ${FILE};\n    }\n}\n`
}
const doctor = (patch: MakeOpts = {}) => make('doctor', {
  ...HEALTHY,
  ...patch,
  env: { ...HEALTHY.env, ...patch.env },
  files: patch.files ?? HEALTHY.files
})
const failures = (r: Run) => r.out.split('\n').filter(l => l.startsWith('  ✗'))

describe('make doctor', () => {
  it('здоровый сервер — все проверки ✓, код 0; сборка — первые 7 знаков коммита', () => {
    const r = doctor()
    expect(r.code, r.out).toBe(0)
    expect(failures(r)).toEqual([])
    for (const line of [
      '✓ контейнер aiconnect работает, healthcheck зелёный',
      `✓ настройки сервера заданы, сборка ${SHA.slice(0, 7)}`,
      '✓ у контейнера метка keepalive=disabled',
      '✓ прокси nginx-proxy ходит в приложение без keepalive',
      '✓ таймаут прокси для aiconnect.example.by: 400s',
      '✓ https://aiconnect.example.by отвечает, адрес клиента виден через прокси',
      '✓ сертификат доверенный, действует до Dec 24 10:00:00 2026 GMT',
      '✓ Watchtower запущен',
      '✓ диск docker (/var/lib/docker) занят на 42%'
    ]) expect(r.out).toContain(line)
    expect(r.out).not.toContain('⚠')
    expect(r.out).toContain('[make] всё в порядке')
  })

  it('только читает: ни записи в прокси, ни перезапуска прокси или приложения', () => {
    const r = doctor()
    const actions = r.calls.filter(c => !c.startsWith('curl '))
    expect(actions.every(c => /^(exec (aiconnect node -e |nginx-proxy cat \/etc\/nginx\/)|info -f )/.test(c)), actions.join('\n')).toBe(true)
  })

  it('upstream прокси с keepalive — ✗ и код 1: это сегодняшний 502', () => {
    const r = doctor({ conf: `${UPSTREAM('    keepalive 2;\n')}server { include ${FILE}; }\n` })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('прокси nginx-proxy держит соединения с приложением (keepalive)')])
  })

  it('keepalive соседнего хоста — не наш: upstream ищется по точному имени домена', () => {
    const neighbour = 'upstream aiconnectxexample.by {\n    server 172.18.0.9:3000;\n    keepalive 2;\n}\n'
    const r = doctor({ conf: `${neighbour}${UPSTREAM()}server { include ${FILE}; }\n` })
    expect(failures(r)).toEqual([])
  })

  it('нет метки keepalive=disabled — ✗ со ссылкой на compose-update', () => {
    const r = doctor({ env: { FAKE_KEEPALIVE: '' } })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('→ make compose-update, затем make prod-up')])
  })

  it('в upstream только заглушка «down» — прокси не видит приложение: ✗, а не ложный ✓ про keepalive', () => {
    const conf = `upstream aiconnect.example.by {\n    # Fallback entry\n    server 127.0.0.1 down;\n}\nserver { include ${FILE}; }\n`
    const r = doctor({ conf })
    expect(failures(r)).toEqual([expect.stringContaining('нет рабочего сервера')])
  })

  it('upstream с отступами и пробелами в конце строк — разбирается так же', () => {
    const conf = `  upstream aiconnect.example.by {  \r\n\tserver 172.18.0.14:3000;\r\n\tkeepalive 2;\r\n  }\r\nserver { include ${FILE}; }\n`
    const r = doctor({ conf })
    expect(failures(r)).toEqual([expect.stringContaining('держит соединения с приложением (keepalive)')])
  })

  it('upstream нашего домена в конфиге нет — ✗', () => {
    const r = doctor({ conf: `server { include ${FILE}; }\n` })
    expect(failures(r)).toEqual([expect.stringContaining('нет upstream aiconnect.example.by')])
  })

  it.each([
    ['файла таймаута нет', { files: {} }],
    ['таймаут только в комментарии', { files: { 'aiconnect.example.by_location': '#proxy_read_timeout 400s;\n' } }],
    ['файл есть, но не подключён', { conf: UPSTREAM() }]
  ])('%s — ✗ и совет make proxy-timeout', (_label, patch) => {
    const r = doctor(patch as MakeOpts)
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('→ make proxy-timeout')])
  })

  it('контейнера нет — один ✗ и стоп: остальное проверять не на чем', () => {
    const r = doctor({ env: { FAKE_STATE: '' } })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual(['  ✗ контейнера aiconnect нет → make prod-up'])
    expect(r.calls).toEqual([])
  })

  it('контейнер нездоров — ✗ с его состоянием', () => {
    const r = doctor({ env: { FAKE_STATE: 'running unhealthy' } })
    expect(failures(r)).toEqual(['  ✗ контейнер aiconnect: running unhealthy → make logs'])
  })

  it('health: незаданное в .env — ✗ с именем переменной и сборкой', () => {
    const r = doctor({ env: { FAKE_HEALTH: HEALTH({ appCode: false, oauth: false }) } })
    expect(failures(r)).toEqual([`  ✗ не задано в .env: B24_CLIENT_ID/B24_CLIENT_SECRET,B24_APP_CODE → вписать и make prod-up (таблица переменных — docs/DEPLOY.md); сборка ${SHA.slice(0, 7)}`])
    expect(r.out).not.toContain('✓ настройки сервера заданы')
  })

  it('неизвестный флаг health (сервер новее Makefile) — ✗ с именем флага, а не молчание', () => {
    const r = doctor({ env: { FAKE_HEALTH: HEALTH({ newFlag: false }) } })
    expect(failures(r)).toEqual([expect.stringContaining('не задано в .env: newFlag')])
  })

  it('TRUST_PROXY задаёт compose-файл, а не .env — совет про compose-update', () => {
    const r = doctor({ env: { FAKE_HEALTH: HEALTH({ trustProxy: false }) } })
    expect(failures(r)).toEqual([expect.stringContaining('не задано в docker-compose.prod.yml: TRUST_PROXY → make compose-update')])
    expect(r.out).not.toContain('✓ настройки сервера заданы')
  })

  it('health изнутри не ответил — ✗', () => {
    const r = doctor({ env: { FAKE_HEALTH: 'down' } })
    expect(failures(r)).toEqual([expect.stringContaining('/api/health изнутри контейнера не ответил')])
  })

  it('https снаружи не отвечает — ✗ с ошибкой curl', () => {
    const r = doctor({ env: { FAKE_EXT: undefined as unknown as string } })
    expect(failures(r)).toEqual([expect.stringContaining('https://aiconnect.example.by/api/health не ответил: curl: (7)')])
  })

  it('ответ снаружи с пробелами в JSON (DEBUG) — адрес клиента всё равно виден', () => {
    const r = doctor({ env: { FAKE_EXT: JSON.stringify(JSON.parse(HEALTH()), null, 2) } })
    expect(failures(r)).toEqual([])
  })

  it('на сервере нет curl и openssl — ⚠ «не проверено», а не молчаливое «всё в порядке»', () => {
    const r = doctor({ hide: ['curl', 'openssl'] })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('⚠ https не проверен: на сервере нет curl')
    expect(r.out).toContain('⚠ сертификат не проверен: на сервере нет openssl')
    expect(r.out).toContain('[make] ошибок нет, предупреждений: 2')
  })

  it('снаружи отвечает, но адрес клиента не виден — ✗', () => {
    const r = doctor({ env: { FAKE_EXT: HEALTH().replace('"used"', '"absent"') } })
    expect(failures(r)).toEqual([expect.stringContaining('forwardedFor не used')])
  })

  it.each([
    ['истекает меньше чем через 14 дней', { FAKE_CERT_SOON: '1' }, 'истекает меньше чем через 14 дней'],
    ['не прочитан', { FAKE_CERT: '' }, 'не прочитан'],
    ['самоподписанный (Let\'s Encrypt ещё не выпустил) — срок у него большой, но он не доверенный', { FAKE_CERT_UNTRUSTED: '1' }, 'не доверенный']
  ])('сертификат %s — ✗', (_label, env, text) => {
    const r = doctor({ env })
    expect(failures(r)).toEqual([expect.stringContaining(text)])
  })

  it('после pull новых образов docker ps показывает ID — прокси и Watchtower всё равно находятся', () => {
    const r = doctor({ env: { FAKE_PS_IMAGE_IDS: '1' } })
    expect(r.code, r.out).toBe(0)
    expect(failures(r)).toEqual([])
  })

  it('образ, лишь похожий на Watchtower по имени (watchtower-ui), — не Watchtower', () => {
    const r = doctor({ env: { FAKE_PS: `${ONE_PROXY}wtui someone/watchtower-ui:1\\n` } })
    expect(failures(r)).toEqual([expect.stringContaining('Watchtower не запущен')])
  })

  it('Watchtower не запущен — ✗', () => {
    const r = doctor({ env: { FAKE_PS: ONE_PROXY } })
    expect(failures(r)).toEqual([expect.stringContaining('Watchtower не запущен')])
  })

  it('диск занят на 90 % и больше — ✗; каталог — тот, что называет docker', () => {
    const r = doctor({ env: { FAKE_DF_USED: '95', FAKE_DOCKER_ROOT: '/srv/docker' } })
    expect(failures(r)).toEqual([expect.stringContaining('диск docker (/srv/docker) занят на 95%')])
  })

  it.each([['89', true], ['90', false]])('диск занят на %s%% — граница 90 %%', (used, fine) => {
    const r = doctor({ env: { FAKE_DF_USED: used } })
    expect(failures(r)).toEqual(fine ? [] : [expect.stringContaining(`занят на ${used}%`)])
  })

  it('df не ответил — ⚠ «не проверено»', () => {
    const r = doctor({ env: { FAKE_DF_USED: 'none' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('⚠ место на диске не проверено')
  })

  it('два прокси — ✗ с просьбой PROXY=<имя>, остальные проверки идут; PROXY из командной строки берётся', () => {
    const two = `p1 nginxproxy/nginx-proxy\\np2 jwilder/nginx-proxy\\nwatchtower containrrr/watchtower\\n`
    const r = doctor({ env: { FAKE_PS: two } })
    expect(failures(r)).toEqual([expect.stringContaining('найдено: 2. Укажите нужный: make doctor PROXY=<имя>')])
    expect(r.out).toContain('✓ https://aiconnect.example.by отвечает')
    const chosen = doctor({ env: { FAKE_PS: two }, args: ['PROXY=p1'] })
    expect(chosen.out).toContain('✓ прокси p1 ходит в приложение без keepalive')
  })

  it('подстановка команды в VIRTUAL_HOST — ✗ домена, в прокси и наружу не ходит', () => {
    const r = doctor({ env: { FAKE_VHOST: 'x$(touch PWNED)y.by' } })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('не похож на один домен')])
    expect(r.calls.some(c => c.includes(' cat ') || c.startsWith('curl '))).toBe(false)
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
  })
})

// ─── make compose-update ──────────────────────────────────────────────
describe('make compose-update', () => {
  const OLD = 'services:\n  app:\n    image: ghcr.io/bx-shef/aiconnect:latest\n'
  const NEW = `${OLD}    labels:\n      - "com.github.nginx-proxy.nginx-proxy.keepalive=disabled"\n`
  const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)
  const update = (opts: MakeOpts = {}) => make('compose-update', { ...opts, here: { 'docker-compose.prod.yml': OLD, ...opts.here } })
  const current = (r: Run) => readFileSync(join(r.dir, 'docker-compose.prod.yml'), 'utf8')
  const leftovers = (r: Run) => readdirSync(r.dir).filter(f => f.startsWith('.docker-compose.prod.yml.'))
  const backups = (r: Run) => readdirSync(r.dir).filter(f => f.startsWith('docker-compose.prod.yml.bak-'))

  it('без CONFIRM — показывает разницу и готовую команду с sha256 показанного, файл не трогает', () => {
    const r = update({ env: { FAKE_DL: NEW } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('+      - "com.github.nginx-proxy.nginx-proxy.keepalive=disabled"')
    expect(r.out).toContain(`(main, sha256 ${sha(NEW)}). Заменить именно это: make compose-update CONFIRM=${sha(NEW)}`)
    expect(current(r)).toBe(OLD)
    expect(leftovers(r)).toEqual([])
  })

  it('CONFIRM=<sha256 показанного> — заменяет, копия прежнего рядом; compose проверял без DOMAIN из оболочки', () => {
    const r = update({ env: { FAKE_DL: NEW, DOMAIN: 'bank-import.example.by' }, args: [`CONFIRM=${sha(NEW)}`] })
    expect(r.code, r.out).toBe(0)
    expect(current(r)).toBe(NEW)
    expect(backups(r)).toHaveLength(1)
    expect(readFileSync(join(r.dir, backups(r)[0]!), 'utf8')).toBe(OLD)
    expect(r.out).toContain(`обновлён из main (sha256 ${sha(NEW)})`)
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
    expect(r.calls).toContain('curl https://raw.githubusercontent.com/bx-shef/aiconnect/main/docker-compose.prod.yml')
    expect(leftovers(r)).toEqual([])
  })

  it('права файла при замене остаются прежними', () => {
    const r = update({ env: { FAKE_DL: NEW }, args: [`CONFIRM=${sha(NEW)}`], modes: { 'docker-compose.prod.yml': 0o640 } })
    expect(r.code, r.out).toBe(0)
    expect(current(r)).toBe(NEW)
    expect(statSync(join(r.dir, 'docker-compose.prod.yml')).mode & 0o777).toBe(0o640)
  })

  it('в ветке появился коммит после показа — sha256 другой: отказ, файл не тронут', () => {
    const r = update({ env: { FAKE_DL: `${NEW}# новый коммит\n` }, args: [`CONFIRM=${sha(NEW)}`] })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('файл в main изменился после показа')
    expect(r.out).toContain(`make compose-update CONFIRM=${sha(`${NEW}# новый коммит\n`)}`)
    expect(current(r)).toBe(OLD)
    expect(backups(r)).toEqual([])
    expect(leftovers(r)).toEqual([])
  })

  it.each([
    ['«1» вместо sha256', '1'],
    ['make-функция', '$(shell touch PWNED)'],
    ['кавычка и команда', 'a";touch PWNED;echo "']
  ])('CONFIRM=%s — отказ до скачивания', (_label, CONFIRM) => {
    const r = update({ env: { FAKE_DL: NEW }, args: [`CONFIRM=${CONFIRM}`] })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('CONFIRM — 12 знаков sha256')
    expect(r.calls.some(c => c.startsWith('curl '))).toBe(false)
    expect(current(r)).toBe(OLD)
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
  })

  it('CONFIRM из окружения оболочки — не считается', () => {
    const r = update({ env: { FAKE_DL: NEW, CONFIRM: sha(NEW) } })
    expect(r.code, r.out).toBe(0)
    expect(current(r)).toBe(OLD)
  })

  it('файл уже как в репозитории — так и говорит', () => {
    const r = update({ env: { FAKE_DL: OLD }, args: [`CONFIRM=${sha(OLD)}`] })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`уже как в main (sha256 ${sha(OLD)})`)
    expect(backups(r)).toEqual([])
    expect(leftovers(r)).toEqual([])
  })

  it('compose-файла ещё нет — показывает, а с CONFIRM ставит его без копии и с обычными правами', () => {
    const look = make('compose-update', { env: { FAKE_DL: NEW } })
    expect(look.code, look.out).toBe(0)
    expect(look.out).toContain('здесь ещё нет')
    expect(existsSync(join(look.dir, 'docker-compose.prod.yml'))).toBe(false)
    const put = make('compose-update', { env: { FAKE_DL: NEW }, args: [`CONFIRM=${sha(NEW)}`] })
    expect(put.code, put.out).toBe(0)
    expect(readFileSync(join(put.dir, 'docker-compose.prod.yml'), 'utf8')).toBe(NEW)
    expect(put.out).toContain('копия прежнего: нет')
    // У mktemp права только владельцу; файл для compose должен читаться, как обычный (umask теста).
    expect(statSync(join(put.dir, 'docker-compose.prod.yml')).mode & 0o044).not.toBe(0)
  })

  it.each([
    ['не скачался', {}],
    ['скачалась не compose-страница (404 и т. п.)', { FAKE_DL: '404: Not Found' }],
    ['compose его не принял', { FAKE_DL: NEW, FAKE_CONFIG: '1' }]
  ])('%s — ошибка, рабочий файл не тронут', (_label, env) => {
    const r = update({ env, args: [`CONFIRM=${sha(NEW)}`] })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('рабочий не тронут')
    expect(current(r)).toBe(OLD)
    expect(leftovers(r)).toEqual([])
  })

  it('REF=<ветка> — берёт файл из неё', () => {
    const r = update({ env: { FAKE_DL: NEW }, args: ['REF=claude/some-branch'] })
    expect(r.calls).toContain('curl https://raw.githubusercontent.com/bx-shef/aiconnect/claude/some-branch/docker-compose.prod.yml')
  })
})

// ─── REF: compose-update и self-update ────────────────────────────────
// Находка безопасности и тестировщика на #16: REF подставлялся в команду текстом и брался из
// окружения — `REF='a";touch PWNED;echo "'` выполнял команду на хосте, а `$(shell …)` — ещё make.
describe('REF у compose-update и self-update', () => {
  const RAW = 'https://raw.githubusercontent.com/bx-shef/aiconnect'

  it.each(['compose-update', 'self-update'])('%s: REF из окружения оболочки — не берётся, даже с make-функцией', (target) => {
    for (const REF of ['feature-x', '$(shell touch PWNED)']) {
      const r = make(target, { env: { REF }, here: { 'docker-compose.prod.yml': 'services: {}\n' } })
      expect(r.calls.find(c => c.startsWith('curl '))).toMatch(new RegExp(`^curl ${RAW}/main/`))
      expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    }
  })

  it.each([
    ['кавычка и команда', 'a";touch PWNED;echo "'],
    ['подстановка команды', 'x$(touch PWNED)'],
    ['make-функция', '$(shell touch PWNED)'],
    ['выход вверх по пути', 'main/../../evil'],
    ['начинается с дефиса', '-o/tmp/x'],
    ['перевод строки', 'main\ntouch PWNED'],
    ['пусто', '']
  ])('%s — отказ до скачивания', (_label, REF) => {
    for (const target of ['compose-update', 'self-update']) {
      const r = make(target, { args: [`REF=${REF}`], here: { 'docker-compose.prod.yml': 'services: {}\n' } })
      expect(r.code, `${target}: ${r.out}`).not.toBe(0)
      expect(r.out).toContain('REF — имя ветки или тега')
      expect(r.calls.some(c => c.startsWith('curl '))).toBe(false)
      expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    }
  })

  it('self-update: REF=<ветка> из командной строки — берёт Makefile из неё', () => {
    const r = make('self-update', { args: ['REF=claude/some-branch'] })
    expect(r.calls).toContain(`curl ${RAW}/claude/some-branch/Makefile`)
  })
})

// ─── override: команды и проверки Makefile не подменить ───────────────
// Находка безопасности на #16: переменная командной строки (или MAKEFLAGS) заменяла SH_LIB — начало
// рецепта каждой цели, — функцию проверки cli и саму команду compose.
describe('внутренние переменные Makefile не подменить командной строкой', () => {
  it.each([
    ['SH_LIB — начало рецепта', 'doctor', ['SH_LIB=touch PWNED;']],
    ['cli — функция проверки значений', 'doctor', ['cli=$(shell touch PWNED)', 'PROXY=x']],
    // Вложенный make в self-update — буквально `make`: MAKE= из командной строки его не подменяет.
    ['MAKE — вложенный make', 'self-update', ['MAKE=touch PWNED;']]
  ])('%s', (_label, target, args) => {
    const r = make(target, { ...HEALTHY, args, env: { ...HEALTHY.env, FAKE_DL: MAKEFILE } })
    expect(existsSync(join(r.dir, 'PWNED')), r.out).toBe(false)
  })

  it('COMPOSE_ENV — prod-up всё равно зовёт docker compose без DOMAIN из оболочки', () => {
    const r = make('prod-up', { args: ['COMPOSE_ENV=touch PWNED;'], env: { DOMAIN: 'bank-import.example.by' } })
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
  })
})

// ─── make self-update ─────────────────────────────────────────────────
describe('make self-update', () => {
  const NEXT = `${MAKEFILE}\n# следующая версия\n`

  it('скачанный Makefile заменяет рабочий, прежний — в копии, затем справка', () => {
    const r = make('self-update', { env: { FAKE_DL: NEXT } })
    expect(r.code, r.out).toBe(0)
    expect(readdirSync(r.dir).filter(f => f.startsWith('.Makefile.')), 'временный файл убран').toEqual([])
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(NEXT)
    const backups = readdirSync(r.dir).filter(f => f.startsWith('Makefile.bak-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(r.dir, backups[0]!), 'utf8')).toBe(MAKEFILE)
    expect(r.out).toContain('Makefile обновлён из main')
    expect(r.out).toContain('self-update')
  })

  it.each([
    ['не скачался', {}],
    ['скачалась не Makefile-страница', { FAKE_DL: '404: Not Found' }]
  ])('%s — говорит об этом, рабочий Makefile не тронут', (_label, env) => {
    const r = make('self-update', { env })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('Makefile из main не скачался или не прошёл проверку — рабочий не тронут')
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(MAKEFILE)
  })

  it('права Makefile при замене остаются прежними: замена — mv временного файла с правами прежнего', () => {
    const r = make('self-update', { env: { FAKE_DL: NEXT }, modes: { Makefile: 0o640 } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(NEXT)
    expect(statSync(join(r.dir, 'Makefile')).mode & 0o777).toBe(0o640)
  })

  it('make -n self-update только показывает команды: ничего не скачивает и не заменяет', () => {
    const r = make('self-update', { args: ['-n'], env: { FAKE_DL: NEXT } })
    expect(r.calls.some(c => c.startsWith('curl '))).toBe(false)
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(MAKEFILE)
  })
})
