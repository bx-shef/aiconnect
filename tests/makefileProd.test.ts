// The server Makefile (docs/DEPLOY.md): targets `proxy-timeout`, `doctor`, `compose-update`, and compose runs.
//
// ⚠ This runs the REAL make against the Makefile text from the repo, not a retelling of it: recipes
// have three layers of escaping (make → sh → sh inside the proxy container), and a copy in the test
// would silently drift from them. docker is replaced by a script on PATH: it logs calls, and the
// script the target runs inside the proxy container (`sh -c …`) actually executes in a temp
// directory instead of the container root — this also verifies what happens to the vhost.d file.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')

// A stand-in docker on node: logs calls, and the "proxy container" is the FAKE_ROOT directory. The
// write script (`exec … sh -c`) and the check script (`exec … grep`) run FOR REAL with the arguments
// the target passed — paths get rewritten to FAKE_ROOT. docker-gen mirrors the nginx-proxy template:
// include is built from whatever vhost.d files exist at generation time, and a host's
// `_location_override` takes precedence over its `_location`.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process')
const a = process.argv.slice(2), env = process.env, R = env.FAKE_ROOT
fs.appendFileSync(env.DOCKER_LOG, a.join(' ') + '\\n')
const nl = s => s.replace(/\\\\n/g, '\\n')
// FAKE_PS — "name image" lines. \`ps -q\` returns names instead of IDs; the image comes from inspect
// (.Config.Image), while \`ps\` itself shows an ID instead of the image when FAKE_PS_IMAGE_IDS=1, like
// right after pulling a new image.
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
  // The health script that doctor runs via node inside the app container is real; fetch is stubbed.
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

// Host tools: curl (download from the repo and external https), openssl (certificate), df (disk).
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
  // Untrusted certificate (nginx-proxy's stub self-signed one): with chain and name verification the
  // handshake fails; without it, the certificate reads normally, as with real openssl.
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

// Alongside the proxy — companions of both generations: the old image also has "nginx-proxy" in its name.
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
  /** Files in the proxy's vhost.d. */
  files?: Record<string, string>
  /** The proxy's /etc/nginx/conf.d/default.conf. */
  conf?: string
  noVhostDir?: boolean
  /** Files next to the Makefile (the directory on the server). */
  here?: Record<string, string>
  /** Permissions for files from `here`. */
  modes?: Record<string, number>
  /** Tools that are "missing on the server": neither the stand-in nor the real one on PATH. */
  hide?: string[]
}

/**
 * A directory of symlinks to every PATH program except `hide` — a server without curl or openssl.
 * PATH itself can't just be trimmed: the same directories hold sh, awk, sed, which make needs.
 */
function pathWithout(hide: string[], into: string): string {
  mkdirSync(into)
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d || !existsSync(d)) continue
    for (const name of readdirSync(d)) {
      if (hide.includes(name) || existsSync(join(into, name))) continue
      try {
        if (statSync(join(d, name)).isFile()) symlinkSync(join(d, name), join(into, name))
      } catch { /* broken symlink on PATH — skip it */ }
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
  it('domain comes from the container VIRTUAL_HOST; writes the timeout, rebuilds the proxy config, leaves the app alone', () => {
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
    expect(existsSync(join(r.root, `${FILE}.new`)), 'temp file cleaned up (mv, not cp)').toBe(false)
    expect(r.out).toContain('готово')
  })

  it('proxy has no vhost.d yet — directory is created, file is written', () => {
    const r = proxyTimeout({ noVhostDir: true })
    expect(r.code, r.out).toBe(0)
    expect(vhostFile(r)).toBe('proxy_read_timeout 400s;\n')
  })

  it('other directives in the file are preserved, old timeout is replaced', () => {
    const r = proxyTimeout({ files: { 'aiconnect.example.by_location': 'client_max_body_size 50m;\nproxy_read_timeout 60s;\n' } })
    expect(r.code, r.out).toBe(0)
    expect(vhostFile(r)).toBe('client_max_body_size 50m;\nproxy_read_timeout 400s;\n')
  })

  it('new file starts from default_location — the proxy shared settings are not lost', () => {
    const r = proxyTimeout({ files: { default_location: 'add_header X-Common 1;\n' } })
    expect(r.code, r.out).toBe(0)
    expect(vhostFile(r)).toBe('add_header X-Common 1;\nproxy_read_timeout 400s;\n')
  })

  it('already configured — writes and rebuilds nothing, only a soft reload', () => {
    const r = proxyTimeout({
      files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n' },
      conf: `include ${FILE};\n`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('уже настроено')
    expect(r.calls.some(c => c.includes('sh -c') || c.includes('docker-gen'))).toBe(false)
    expect(r.calls).toEqual(expect.arrayContaining(['exec nginx-proxy nginx -t', 'exec nginx-proxy nginx -s reload']))
  })

  it('reload failed — error; a repeat run sees "already configured" and re-reads the config', () => {
    const first = proxyTimeout({ env: { FAKE_RELOAD: '1' } })
    expect(first.code).not.toBe(0)
    expect(first.out).toContain('повторите make proxy-timeout')
    const again = proxyTimeout({
      files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n' },
      conf: `include ${FILE};\n`,
      env: { FAKE_RELOAD: '1' }
    })
    expect(again.code, 'reload failing is not a success even on the "already configured" branch').not.toBe(0)
  })

  it('our file exists, but only a neighbour host is included in the config — rebuilds, not "already configured"', () => {
    const r = proxyTimeout({
      files: { 'aiconnect.example.by_location': 'proxy_read_timeout 400s;\n', 'aiconnectxexample.by_location': 'gzip on;\n' },
      conf: 'include /etc/nginx/vhost.d/aiconnectxexample.by_location;\n'
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('уже настроено')
    expect(r.calls).toContain('exec nginx-proxy docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf')
  })

  it('timeout in the file is only in a comment — that\'s not "already configured"', () => {
    const r = proxyTimeout({
      files: { 'aiconnect.example.by_location': '#proxy_read_timeout 400s;\n' },
      conf: `include ${FILE};\n`
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('уже настроено')
    expect(vhostFile(r)).toBe('#proxy_read_timeout 400s;\nproxy_read_timeout 400s;\n')
  })

  it('nginx -t fails — no reload, and an error', () => {
    const r = proxyTimeout({ env: { FAKE_NGINX_T: '1' } })
    expect(r.code).not.toBe(0)
    expect(r.calls.some(c => c.includes('reload'))).toBe(false)
    expect(r.out).toContain('не перестроен')
  })

  it('domain has a _location_override — file not included: error, not "готово"', () => {
    // A neighbour host that differs from ours by one character in place of the dot: a substring or
    // regex match instead of an exact include string would mistake its include for ours.
    const r = proxyTimeout({ files: { 'aiconnect.example.by_location_override': 'return 503;\n', 'aiconnectxexample.by_location': 'gzip on;\n' } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('не подключён')
  })

  it('proxy vhost.d is not a separate volume — warns', () => {
    const r = proxyTimeout({ env: { FAKE_MOUNTED: '0' } })
    expect(r.out).toContain('не отдельный том')
  })

  it('app container is not running — asks for make prod-up', () => {
    const r = proxyTimeout({ env: { FAKE_VHOST: '' } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('сначала make prod-up')
    expect(r.calls).toEqual([])
  })

  it.each([
    ['no proxy', 'watchtower containrrr/watchtower\\n', 0],
    ['only images that merely look like a proxy by name', 'dash someone/nginx-proxy-dashboard:1\\nle jrcs/letsencrypt-nginx-proxy-companion\\n', 0],
    ['two proxies', 'p1 nginxproxy/nginx-proxy\\np2 jwilder/nginx-proxy\\n', 2]
  ])('%s — asks for PROXY=<name> and writes nothing', (_label, ps, n) => {
    const r = proxyTimeout({ env: { FAKE_PS: ps } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`контейнеров nginx-proxy найдено: ${n}. Укажите нужный: make proxy-timeout PROXY=<имя>`)
    expect(r.calls).toEqual([])
  })

  it('after pulling a new image, docker ps shows an ID instead of a name — proxy is still found (image from inspect)', () => {
    const r = proxyTimeout({ env: { FAKE_PS_IMAGE_IDS: '1' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by')
  })

  it('PROXY=<typo> — container missing or not running: says so, does nothing', () => {
    const r = proxyTimeout({ args: ['PROXY=nginx-prxy'], env: { FAKE_NOT_RUNNING: 'nginx-prxy' } })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('контейнер прокси nginx-prxy не запущен или такого нет')
    expect(r.calls).toEqual([])
    const d = doctor({ args: ['PROXY=nginx-prxy'], env: { FAKE_NOT_RUNNING: 'nginx-prxy' } })
    expect(failures(d)).toEqual([expect.stringContaining('контейнер прокси nginx-prxy не запущен или такого нет')])
  })

  it('proxy is only an image named exactly nginx-proxy: a neighbouring nginx-proxy-dashboard doesn\'t count', () => {
    const r = proxyTimeout({ env: { FAKE_PS: `dash someone/nginx-proxy-dashboard:1\\n${ONE_PROXY}` } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by')
  })

  it('PROXY=<name> and PROXY_TIMEOUT=… from the command line — are taken', () => {
    const r = proxyTimeout({ args: ['PROXY=edge-proxy', 'PROXY_TIMEOUT=600s'], env: { FAKE_PS: '' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('прокси: edge-proxy, домен: aiconnect.example.by, таймаут: 600s')
  })

  it('app container cannot be substituted via the command line or MAKEFLAGS', () => {
    for (const r of [
      proxyTimeout({ args: ['APP_CONTAINER=evil'] }),
      proxyTimeout({ env: { MAKEFLAGS: 'APP_CONTAINER=evil' } })
    ]) {
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(r.dir, 'docker.log'), 'utf8')).toMatch(/^inspect .* aiconnect$/m)
      expect(readFileSync(join(r.dir, 'docker.log'), 'utf8')).not.toContain('evil')
    }
  })

  it('PROXY and PROXY_TIMEOUT from the shell environment — not taken, even with a make function inside', () => {
    for (const env of [{ PROXY: 'http://10.0.0.1:3128', PROXY_TIMEOUT: '1s' }, { PROXY: '$(shell touch PWNED)', PROXY_TIMEOUT: '$(shell touch PWNED)' }]) {
      const r = proxyTimeout({ env })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('прокси: nginx-proxy, домен: aiconnect.example.by, таймаут: 400s')
      expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    }
  })

  // Findings from the security review in #16: values must not become commands, on the host or in the proxy.
  it.each([
    ['command substitution in VIRTUAL_HOST', { env: { FAKE_VHOST: 'x$(touch PWNED)y.by' } }],
    ['escaping vhost.d', { env: { FAKE_VHOST: '../../etc/nginx/nginx.conf' } }],
    ['several comma-separated domains', { env: { FAKE_VHOST: 'a.by,b.by' } }],
    ['quote and command in the timeout', { args: ['PROXY_TIMEOUT=1s\'; touch PWNED; echo \''] }],
    ['newline in the timeout', { args: ['PROXY_TIMEOUT=400s\n\'; touch PWNED; echo \''] }],
    ['timeout without a number', { args: ['PROXY_TIMEOUT=long'] }],
    ['odd proxy name', { args: ['PROXY=p;touch PWNED'] }],
    // make itself would run $(shell …) from the value before the shell, if it didn't take it as text.
    ['make function in the timeout', { args: ['PROXY_TIMEOUT=$(shell touch PWNED)'] }],
    ['make function in the proxy name', { args: ['PROXY=$(shell touch PWNED)'] }]
  ])('%s — refused before any write', (_label, opts) => {
    const r = proxyTimeout(opts)
    expect(r.code).not.toBe(0)
    expect(r.calls).toEqual([])
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    expect(existsSync(join(r.root, 'PWNED'))).toBe(false)
  })
})

describe('make proxy-timeout: newline in VIRTUAL_HOST', () => {
  it('takes the first line; the rest does not become a command', () => {
    const r = proxyTimeout({ env: { FAKE_VHOST: 'aiconnect.example.by\\nx; touch PWNED; y.by' } })
    expect(r.out).toContain('домен: aiconnect.example.by,')
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    expect(existsSync(join(r.root, 'PWNED'))).toBe(false)
  })
})

describe('on the server, compose takes its environment only from ./.env', () => {
  it('DOMAIN and the encryption key from the shell do not reach compose', () => {
    const r = make('prod-up', { env: { DOMAIN: 'bank-import.example.by', B24_TOKEN_ENC_KEY: 'neighbour' } })
    expect(r.code, r.out).toBe(0)
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
  })

  it('DOMAIN=… on the make command line doesn\'t reach it either', () => {
    const r = make('prod-up', { args: ['DOMAIN=bank-import.example.by'] })
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
  })

  it('container name in the Makefile matches container_name in docker-compose.prod.yml', () => {
    const name = /^override APP_CONTAINER := (\S+)$/m.exec(MAKEFILE)?.[1]
    const compose = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8')
    expect(name).toBeTruthy()
    expect(compose).toMatch(new RegExp(`^ {4}container_name: ${name}$`, 'm'))
  })
})

// ─── make doctor ──────────────────────────────────────────────────────
// A healthy server: proxy, Watchtower and the app are running; upstream has no keepalive, the timeout
// is wired up, health responds from inside and outside, the certificate is fresh, disk is free. Each
// test breaks one thing.
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
    // A name without "watchtower": Watchtower is recognized by its image, not the container name.
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
  it('healthy server — all checks ✓, code 0; build shown as the first 7 commit chars', () => {
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

  it('read-only: no writes to the proxy, no restarting the proxy or the app', () => {
    const r = doctor()
    const actions = r.calls.filter(c => !c.startsWith('curl '))
    expect(actions.every(c => /^(exec (aiconnect node -e |nginx-proxy cat \/etc\/nginx\/)|info -f )/.test(c)), actions.join('\n')).toBe(true)
  })

  it('proxy upstream with keepalive — ✗ and code 1: this is today\'s 502', () => {
    const r = doctor({ conf: `${UPSTREAM('    keepalive 2;\n')}server { include ${FILE}; }\n` })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('прокси nginx-proxy держит соединения с приложением (keepalive)')])
  })

  it('keepalive on a neighbour host is not ours: upstream is looked up by exact domain name', () => {
    const neighbour = 'upstream aiconnectxexample.by {\n    server 172.18.0.9:3000;\n    keepalive 2;\n}\n'
    const r = doctor({ conf: `${neighbour}${UPSTREAM()}server { include ${FILE}; }\n` })
    expect(failures(r)).toEqual([])
  })

  it('missing the keepalive=disabled label — ✗ pointing to compose-update', () => {
    const r = doctor({ env: { FAKE_KEEPALIVE: '' } })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('→ make compose-update, затем make prod-up')])
  })

  it('upstream has only a "down" stub — proxy can\'t see the app: ✗, not a false ✓ about keepalive', () => {
    const conf = `upstream aiconnect.example.by {\n    # Fallback entry\n    server 127.0.0.1 down;\n}\nserver { include ${FILE}; }\n`
    const r = doctor({ conf })
    expect(failures(r)).toEqual([expect.stringContaining('нет рабочего сервера')])
  })

  it('upstream with indentation and trailing whitespace — parsed the same way', () => {
    const conf = `  upstream aiconnect.example.by {  \r\n\tserver 172.18.0.14:3000;\r\n\tkeepalive 2;\r\n  }\r\nserver { include ${FILE}; }\n`
    const r = doctor({ conf })
    expect(failures(r)).toEqual([expect.stringContaining('держит соединения с приложением (keepalive)')])
  })

  it('no upstream for our domain in the config — ✗', () => {
    const r = doctor({ conf: `server { include ${FILE}; }\n` })
    expect(failures(r)).toEqual([expect.stringContaining('нет upstream aiconnect.example.by')])
  })

  it.each([
    ['no timeout file', { files: {} }],
    ['timeout only in a comment', { files: { 'aiconnect.example.by_location': '#proxy_read_timeout 400s;\n' } }],
    ['file exists but not included', { conf: UPSTREAM() }]
  ])('%s — ✗ and a make proxy-timeout suggestion', (_label, patch) => {
    const r = doctor(patch as MakeOpts)
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual([expect.stringContaining('→ make proxy-timeout')])
  })

  it('no container — one ✗ and stop: nothing left to check', () => {
    const r = doctor({ env: { FAKE_STATE: '' } })
    expect(r.code).not.toBe(0)
    expect(failures(r)).toEqual(['  ✗ контейнера aiconnect нет → make prod-up'])
    expect(r.calls).toEqual([])
  })

  it('container unhealthy — ✗ with its state', () => {
    const r = doctor({ env: { FAKE_STATE: 'running unhealthy' } })
    expect(failures(r)).toEqual(['  ✗ контейнер aiconnect: running unhealthy → make logs'])
  })

  it('health: unset in .env — ✗ with the variable name and the build', () => {
    const r = doctor({ env: { FAKE_HEALTH: HEALTH({ appCode: false, oauth: false }) } })
    expect(failures(r)).toEqual([`  ✗ не задано в .env: B24_CLIENT_ID/B24_CLIENT_SECRET,B24_APP_CODE → вписать и make prod-up (таблица переменных — docs/DEPLOY.md); сборка ${SHA.slice(0, 7)}`])
    expect(r.out).not.toContain('✓ настройки сервера заданы')
  })

  it('unknown health flag (server newer than the Makefile) — ✗ with the flag name, not silence', () => {
    const r = doctor({ env: { FAKE_HEALTH: HEALTH({ newFlag: false }) } })
    expect(failures(r)).toEqual([expect.stringContaining('не задано в .env: newFlag')])
  })

  it('TRUST_PROXY is set by the compose file, not .env — suggests compose-update', () => {
    const r = doctor({ env: { FAKE_HEALTH: HEALTH({ trustProxy: false }) } })
    expect(failures(r)).toEqual([expect.stringContaining('не задано в docker-compose.prod.yml: TRUST_PROXY → make compose-update')])
    expect(r.out).not.toContain('✓ настройки сервера заданы')
  })

  it('health from inside did not respond — ✗', () => {
    const r = doctor({ env: { FAKE_HEALTH: 'down' } })
    expect(failures(r)).toEqual([expect.stringContaining('/api/health изнутри контейнера не ответил')])
  })

  it('https from outside does not respond — ✗ with the curl error', () => {
    const r = doctor({ env: { FAKE_EXT: undefined as unknown as string } })
    expect(failures(r)).toEqual([expect.stringContaining('https://aiconnect.example.by/api/health не ответил: curl: (7)')])
  })

  it('external response with whitespace in the JSON (DEBUG) — client address still visible', () => {
    const r = doctor({ env: { FAKE_EXT: JSON.stringify(JSON.parse(HEALTH()), null, 2) } })
    expect(failures(r)).toEqual([])
  })

  it('server has neither curl nor openssl — ⚠ "not checked", not a silent "all fine"', () => {
    const r = doctor({ hide: ['curl', 'openssl'] })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('⚠ https не проверен: на сервере нет curl')
    expect(r.out).toContain('⚠ сертификат не проверен: на сервере нет openssl')
    expect(r.out).toContain('[make] ошибок нет, предупреждений: 2')
  })

  it('responds from outside, but the client address isn\'t visible — ✗', () => {
    const r = doctor({ env: { FAKE_EXT: HEALTH().replace('"used"', '"absent"') } })
    expect(failures(r)).toEqual([expect.stringContaining('forwardedFor не used')])
  })

  it.each([
    ['expiring in less than 14 days', { FAKE_CERT_SOON: '1' }, 'истекает меньше чем через 14 дней'],
    ['unreadable', { FAKE_CERT: '' }, 'не прочитан'],
    ['self-signed (Let\'s Encrypt hasn\'t issued one yet) — long-lived, but untrusted', { FAKE_CERT_UNTRUSTED: '1' }, 'не доверенный']
  ])('certificate %s — ✗', (_label, env, text) => {
    const r = doctor({ env })
    expect(failures(r)).toEqual([expect.stringContaining(text)])
  })

  it('after pulling new images docker ps shows IDs — proxy and Watchtower are still found', () => {
    const r = doctor({ env: { FAKE_PS_IMAGE_IDS: '1' } })
    expect(r.code, r.out).toBe(0)
    expect(failures(r)).toEqual([])
  })

  it('an image merely named like Watchtower (watchtower-ui) is not Watchtower', () => {
    const r = doctor({ env: { FAKE_PS: `${ONE_PROXY}wtui someone/watchtower-ui:1\\n` } })
    expect(failures(r)).toEqual([expect.stringContaining('Watchtower не запущен')])
  })

  it('Watchtower is not running — ✗', () => {
    const r = doctor({ env: { FAKE_PS: ONE_PROXY } })
    expect(failures(r)).toEqual([expect.stringContaining('Watchtower не запущен')])
  })

  it('disk 90% full or more — ✗; the directory is the one docker names', () => {
    const r = doctor({ env: { FAKE_DF_USED: '95', FAKE_DOCKER_ROOT: '/srv/docker' } })
    expect(failures(r)).toEqual([expect.stringContaining('диск docker (/srv/docker) занят на 95%')])
  })

  it.each([['89', true], ['90', false]])('disk %s%% full — the 90%% boundary', (used, fine) => {
    const r = doctor({ env: { FAKE_DF_USED: used } })
    expect(failures(r)).toEqual(fine ? [] : [expect.stringContaining(`занят на ${used}%`)])
  })

  it('df did not respond — ⚠ "not checked"', () => {
    const r = doctor({ env: { FAKE_DF_USED: 'none' } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('⚠ место на диске не проверено')
  })

  it('two proxies — ✗ asking for PROXY=<name>, other checks still run; PROXY from the command line is taken', () => {
    const two = `p1 nginxproxy/nginx-proxy\\np2 jwilder/nginx-proxy\\nwatchtower containrrr/watchtower\\n`
    const r = doctor({ env: { FAKE_PS: two } })
    expect(failures(r)).toEqual([expect.stringContaining('найдено: 2. Укажите нужный: make doctor PROXY=<имя>')])
    expect(r.out).toContain('✓ https://aiconnect.example.by отвечает')
    const chosen = doctor({ env: { FAKE_PS: two }, args: ['PROXY=p1'] })
    expect(chosen.out).toContain('✓ прокси p1 ходит в приложение без keepalive')
  })

  it('command substitution in VIRTUAL_HOST — ✗ for the domain, never reaches the proxy or outside', () => {
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

  it('without CONFIRM — shows the diff and the ready-made command with the sha256 shown, leaves the file alone', () => {
    const r = update({ env: { FAKE_DL: NEW } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('+      - "com.github.nginx-proxy.nginx-proxy.keepalive=disabled"')
    expect(r.out).toContain(`(main, sha256 ${sha(NEW)}). Заменить именно это: make compose-update CONFIRM=${sha(NEW)}`)
    expect(current(r)).toBe(OLD)
    expect(leftovers(r)).toEqual([])
  })

  it('CONFIRM=<sha256 shown> — replaces, previous copy stays alongside; compose checked without DOMAIN from the shell', () => {
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

  it('file permissions stay the same after the replace', () => {
    const r = update({ env: { FAKE_DL: NEW }, args: [`CONFIRM=${sha(NEW)}`], modes: { 'docker-compose.prod.yml': 0o640 } })
    expect(r.code, r.out).toBe(0)
    expect(current(r)).toBe(NEW)
    expect(statSync(join(r.dir, 'docker-compose.prod.yml')).mode & 0o777).toBe(0o640)
  })

  it('a commit landed on the branch after the show — sha256 differs: refused, file untouched', () => {
    const r = update({ env: { FAKE_DL: `${NEW}# new commit\n` }, args: [`CONFIRM=${sha(NEW)}`] })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('файл в main изменился после показа')
    expect(r.out).toContain(`make compose-update CONFIRM=${sha(`${NEW}# new commit\n`)}`)
    expect(current(r)).toBe(OLD)
    expect(backups(r)).toEqual([])
    expect(leftovers(r)).toEqual([])
  })

  it.each([
    ['"1" instead of sha256', '1'],
    ['make function', '$(shell touch PWNED)'],
    ['quote and command', 'a";touch PWNED;echo "']
  ])('CONFIRM=%s — refused before downloading', (_label, CONFIRM) => {
    const r = update({ env: { FAKE_DL: NEW }, args: [`CONFIRM=${CONFIRM}`] })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('CONFIRM — 12 знаков sha256')
    expect(r.calls.some(c => c.startsWith('curl '))).toBe(false)
    expect(current(r)).toBe(OLD)
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
  })

  it('CONFIRM from the shell environment — does not count', () => {
    const r = update({ env: { FAKE_DL: NEW, CONFIRM: sha(NEW) } })
    expect(r.code, r.out).toBe(0)
    expect(current(r)).toBe(OLD)
  })

  it('file already matches the repo — says so', () => {
    const r = update({ env: { FAKE_DL: OLD }, args: [`CONFIRM=${sha(OLD)}`] })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`уже как в main (sha256 ${sha(OLD)})`)
    expect(backups(r)).toEqual([])
    expect(leftovers(r)).toEqual([])
  })

  it('no compose file yet — shows it, and with CONFIRM installs it with no backup and normal permissions', () => {
    const look = make('compose-update', { env: { FAKE_DL: NEW } })
    expect(look.code, look.out).toBe(0)
    expect(look.out).toContain('здесь ещё нет')
    expect(existsSync(join(look.dir, 'docker-compose.prod.yml'))).toBe(false)
    const put = make('compose-update', { env: { FAKE_DL: NEW }, args: [`CONFIRM=${sha(NEW)}`] })
    expect(put.code, put.out).toBe(0)
    expect(readFileSync(join(put.dir, 'docker-compose.prod.yml'), 'utf8')).toBe(NEW)
    expect(put.out).toContain('копия прежнего: нет')
    // mktemp gives owner-only permissions; the compose file should be readable normally (test's umask).
    expect(statSync(join(put.dir, 'docker-compose.prod.yml')).mode & 0o044).not.toBe(0)
  })

  it.each([
    ['download failed', {}],
    ['downloaded a non-compose page (404 etc.)', { FAKE_DL: '404: Not Found' }],
    ['compose rejected it', { FAKE_DL: NEW, FAKE_CONFIG: '1' }]
  ])('%s — error, working file untouched', (_label, env) => {
    const r = update({ env, args: [`CONFIRM=${sha(NEW)}`] })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('рабочий не тронут')
    expect(current(r)).toBe(OLD)
    expect(leftovers(r)).toEqual([])
  })

  it('REF=<branch> — takes the file from it', () => {
    const r = update({ env: { FAKE_DL: NEW }, args: ['REF=claude/some-branch'] })
    expect(r.calls).toContain('curl https://raw.githubusercontent.com/bx-shef/aiconnect/claude/some-branch/docker-compose.prod.yml')
  })
})

// ─── REF: compose-update and self-update ──────────────────────────────
// A security and testing finding from #16: REF used to be inserted into the command as text and
// taken from the environment — `REF='a";touch PWNED;echo "'` ran a command on the host, and
// `$(shell …)` ran one in make itself.
describe('REF for compose-update and self-update', () => {
  const RAW = 'https://raw.githubusercontent.com/bx-shef/aiconnect'

  it.each(['compose-update', 'self-update'])('%s: REF from the shell environment — not taken, even with a make function', (target) => {
    for (const REF of ['feature-x', '$(shell touch PWNED)']) {
      const r = make(target, { env: { REF }, here: { 'docker-compose.prod.yml': 'services: {}\n' } })
      expect(r.calls.find(c => c.startsWith('curl '))).toMatch(new RegExp(`^curl ${RAW}/main/`))
      expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    }
  })

  it.each([
    ['quote and command', 'a";touch PWNED;echo "'],
    ['command substitution', 'x$(touch PWNED)'],
    ['make function', '$(shell touch PWNED)'],
    ['path traversal upward', 'main/../../evil'],
    ['starts with a dash', '-o/tmp/x'],
    ['newline', 'main\ntouch PWNED'],
    ['empty', '']
  ])('%s — refused before downloading', (_label, REF) => {
    for (const target of ['compose-update', 'self-update']) {
      const r = make(target, { args: [`REF=${REF}`], here: { 'docker-compose.prod.yml': 'services: {}\n' } })
      expect(r.code, `${target}: ${r.out}`).not.toBe(0)
      expect(r.out).toContain('REF — имя ветки или тега')
      expect(r.calls.some(c => c.startsWith('curl '))).toBe(false)
      expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
    }
  })

  it('self-update: REF=<branch> from the command line — takes the Makefile from it', () => {
    const r = make('self-update', { args: ['REF=claude/some-branch'] })
    expect(r.calls).toContain(`curl ${RAW}/claude/some-branch/Makefile`)
  })
})

// ─── override: Makefile commands and checks can't be substituted ──────
// A security finding from #16: a command-line variable (or MAKEFLAGS) used to be able to replace
// SH_LIB — the start of every target's recipe — the cli check function, and the compose command itself.
describe('internal Makefile variables cannot be substituted from the command line', () => {
  it.each([
    ['SH_LIB — start of the recipe', 'doctor', ['SH_LIB=touch PWNED;']],
    ['cli — the value-checking function', 'doctor', ['cli=$(shell touch PWNED)', 'PROXY=x']],
    // The nested make in self-update is literally `make`: MAKE= from the command line doesn't replace it.
    ['MAKE — the nested make', 'self-update', ['MAKE=touch PWNED;']]
  ])('%s', (_label, target, args) => {
    const r = make(target, { ...HEALTHY, args, env: { ...HEALTHY.env, FAKE_DL: MAKEFILE } })
    expect(existsSync(join(r.dir, 'PWNED')), r.out).toBe(false)
  })

  it('COMPOSE_ENV — prod-up still calls docker compose without DOMAIN from the shell', () => {
    const r = make('prod-up', { args: ['COMPOSE_ENV=touch PWNED;'], env: { DOMAIN: 'bank-import.example.by' } })
    expect(r.calls).toContain('compose-env DOMAIN=unset KEY=unset')
    expect(existsSync(join(r.dir, 'PWNED'))).toBe(false)
  })
})

// ─── make self-update ─────────────────────────────────────────────────
describe('make self-update', () => {
  const NEXT = `${MAKEFILE}\n# next version\n`

  it('downloaded Makefile replaces the working one, previous one is kept as a copy, then help runs', () => {
    const r = make('self-update', { env: { FAKE_DL: NEXT } })
    expect(r.code, r.out).toBe(0)
    expect(readdirSync(r.dir).filter(f => f.startsWith('.Makefile.')), 'temp file cleaned up').toEqual([])
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(NEXT)
    const backups = readdirSync(r.dir).filter(f => f.startsWith('Makefile.bak-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(r.dir, backups[0]!), 'utf8')).toBe(MAKEFILE)
    expect(r.out).toContain('Makefile обновлён из main')
    expect(r.out).toContain('self-update')
  })

  it.each([
    ['download failed', {}],
    ['downloaded a non-Makefile page', { FAKE_DL: '404: Not Found' }]
  ])('%s — says so, working Makefile untouched', (_label, env) => {
    const r = make('self-update', { env })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('Makefile из main не скачался или не прошёл проверку — рабочий не тронут')
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(MAKEFILE)
  })

  it('Makefile permissions stay the same after the replace: mv of a temp file with the previous permissions', () => {
    const r = make('self-update', { env: { FAKE_DL: NEXT }, modes: { Makefile: 0o640 } })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(NEXT)
    expect(statSync(join(r.dir, 'Makefile')).mode & 0o777).toBe(0o640)
  })

  it('make -n self-update only shows the commands: downloads and replaces nothing', () => {
    const r = make('self-update', { args: ['-n'], env: { FAKE_DL: NEXT } })
    expect(r.calls.some(c => c.startsWith('curl '))).toBe(false)
    expect(readFileSync(join(r.dir, 'Makefile'), 'utf8')).toBe(MAKEFILE)
  })
})
