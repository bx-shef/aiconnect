// Repository guards — ported from the client-bank-alfa-by reference project (mdReviewStamp.test.ts,
// ciWorkflowGuard.test.ts) and extended with the REST method registry check, which was left as a TODO there.

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function trackedMarkdown(): string[] {
  return execSync('git ls-files --cached --others --exclude-standard "*.md"', { cwd: ROOT })
    .toString().trim().split('\n').filter(Boolean)
}

describe('documentation', () => {
  it('every .md carries the "> Last reviewed: YYYY-MM-DD" stamp', () => {
    const files = trackedMarkdown()
    expect(files.length).toBeGreaterThan(0)
    const missing = files.filter(f => !/^> Last reviewed: \d{4}-\d{2}-\d{2}$/m.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(missing, `Missing stamp in:\n${missing.join('\n')}`).toEqual([])
  })
})

describe('CI runs the checks and fails on them', () => {
  const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')

  it('no step swallows a failure (continue-on-error / || true)', () => {
    const lines = CI.split('\n').map(l => l.trim())
    expect(lines.filter(l => /^continue-on-error\s*:\s*true/.test(l))).toEqual([])
    expect(lines.filter(l => /^(- )?run:\s/.test(l) && /\|\|\s*(true|:)\b|;\s*true\b|\|\|\s*exit\s+0/.test(l))).toEqual([])
  })

  it('the `ci` job runs lint, test, typecheck and build', () => {
    for (const cmd of ['pnpm lint', 'pnpm test', 'pnpm typecheck', 'pnpm build']) {
      expect(CI, `CI does not run \`${cmd}\``).toMatch(new RegExp(`run:\\s*${cmd}\\s*$`, 'm'))
    }
  })

  it('the `ci` and `docker-build` job names are unchanged — main branch protection references them', () => {
    expect(CI).toMatch(/^ {2}ci:\n {4}name: ci$/m)
    expect(CI).toMatch(/^ {2}docker-build:\n {4}name: docker-build$/m)
  })
})

describe('rollout (docs/DEPLOY.md): main → GHCR → Watchtower → nginx-proxy', () => {
  const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const COMPOSE = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8')
  // The deploy job block: from `  deploy:` to the next job's header (`  name:`) or end of file.
  // Bounded by the next job, not by line indentation: a comment at any indent does not break the block.
  const DEPLOY = (() => {
    const start = CI.search(/^ {2}deploy:\s*$/m)
    if (start < 0) return ''
    const rest = CI.slice(start + 1)
    const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m)
    return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next)
  })()

  it('deploy waits for a green ci run and only rolls out main — on push or manual dispatch', () => {
    expect(DEPLOY, 'no deploy job').not.toBe('')
    expect(DEPLOY).toMatch(/^ {4}needs: (?:ci|\[[^\]]*\bci\b[^\]]*\])\s*$/m)
    // The condition as a whole: `&&` → `||` would let GHCR push a latest image from any branch.
    expect(DEPLOY).toMatch(/^ {4}if: \$\{\{ \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main' \}\}$/m)
    expect(DEPLOY).toMatch(/^ {10}push: true$/m)
  })

  it('the server pulls the same image that deploy publishes', () => {
    expect(DEPLOY).toMatch(/images: ghcr\.io\/\$\{\{ github\.repository \}\}$/m)
    expect(DEPLOY).toMatch(/type=raw,value=latest/)
    expect(COMPOSE).toMatch(/^ {4}image: ghcr\.io\/bx-shef\/aiconnect:latest$/m)
  })

  it('install tokens live in a volume: Watchtower recreates the container on every rollout', () => {
    // Data directory = image working directory + Nitro's fs storage base (nuxt.config.ts).
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)?.[1]
    const base = /portals: \{ driver: 'fs', base: '\.\/([^/']+)\/portals' \}/.exec(readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8'))?.[1]
    expect(workdir && base, 'could not find WORKDIR or the portals storage base').toBeTruthy()
    expect(COMPOSE).toMatch(new RegExp(`^ {6}- portals:${workdir}/${base}$`, 'm'))
    expect(COMPOSE).toMatch(/^volumes:\n {2}portals:$/m)
  })

  it('nginx-proxy talks to the port the image server listens on', () => {
    const port = /^ENV PORT=(\d+)$/m.exec(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))?.[1]
    expect(port, 'no ENV PORT in Dockerfile').toBeTruthy()
    expect(COMPOSE).toMatch(new RegExp(`^ {6}VIRTUAL_PORT: ${port}$`, 'm'))
    expect(COMPOSE).toMatch(new RegExp(`^ {6}- "${port}"$`, 'm'))
  })

  it('behind nginx-proxy: env from .env, address from DOMAIN, TRUST_PROXY=1, restart policy, Watchtower label, proxy-net', () => {
    expect(COMPOSE).toMatch(/^ {4}env_file: \.env$/m)
    expect(COMPOSE).toMatch(/^ {4}restart: unless-stopped$/m)
    expect(COMPOSE).toMatch(/^ {6}NUXT_PUBLIC_SITE_URL: https:\/\/\$\{DOMAIN\}$/m)
    expect(COMPOSE).toMatch(/^ {6}TRUST_PROXY: "1"$/m)
    expect(COMPOSE).toMatch(/^ {6}- "com\.centurylinklabs\.watchtower\.enable=true"$/m)
    // Without this — 502s on portal POST requests after a pause (nginx-proxy vs Node keepalive, 2026-09-25).
    expect(COMPOSE).toMatch(/^ {6}- "com\.github\.nginx-proxy\.nginx-proxy\.keepalive=disabled"$/m)
    expect(COMPOSE).toMatch(/^networks:\n {2}proxy-net:\n {4}external: true$/m)
    expect(COMPOSE).toMatch(/^ {6}B24_TOKEN_ENC_KEY: \$\{B24_TOKEN_ENC_KEY:\?/m)
  })

  it('the image knows its own commit: deploy passes it, the Dockerfile puts it in the environment, health reads it', () => {
    expect(DEPLOY).toMatch(/^ {10}build-args: COMMIT_SHA=\$\{\{ github\.sha \}\}$/m)
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    const runner = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
    expect(runner).toMatch(/^ARG COMMIT_SHA=""\nENV COMMIT_SHA=\$COMMIT_SHA$/m)
    expect(readFileSync(join(ROOT, 'server/api/health.get.ts'), 'utf8')).toMatch(/buildCommit\(process\.env\.COMMIT_SHA\)/)
  })

  it('scripts and styles go out compressed: no nginx of our own in front of Nitro, and the shared nginx-proxy does not compress', () => {
    expect(readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8')).toMatch(/^ {4}compressPublicAssets: true,$/m)
  })
})

describe('Vue templates', () => {
  // Nuxt names components from subdirectories with the directory as a prefix (components/invoice/FillPreview.vue →
  // InvoiceFillPreview). An unrecognized Vue tag renders as an empty element with no error — that is how the
  // invoice-from-tasks template ended up not showing the invoice preview at all (live run on 2026-09-25).
  it('an unrecognized component in a template — typecheck error', () => {
    // tsconfig.json is JSONC: strip line comments and check the setting where vue-tsc actually reads it.
    const text = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const config = JSON.parse(text) as { vueCompilerOptions?: { checkUnknownComponents?: unknown } }
    expect(config.vueCompilerOptions?.checkUnknownComponents).toBe(true)
  })

  // Same guarantee, but also in the fast `pnpm test`, not only in typecheck: every component in a page's or
  // component's <template> must be one Nuxt registered (.nuxt/components.d.ts, written by nuxt prepare during
  // dependency install), a Vue built-in, or imported in that same file as a component: a
  // `@bitrix24/b24icons-vue/…` icon or a `.vue` file (any other capitalized import is not a component, and a
  // typo in a tag must not pass). A component is a capitalized tag or a hyphenated one
  // (fill-preview → FillPreview); plain HTML tags never contain a hyphen.
  it('every component in the templates is registered by Nuxt under that name', () => {
    const dts = join(ROOT, '.nuxt/components.d.ts')
    expect(existsSync(dts), 'missing .nuxt/components.d.ts — run pnpm install (nuxt prepare)').toBe(true)
    const registered = new Set([...readFileSync(dts, 'utf8').matchAll(/^export const (\w+):/gm)].map(m => m[1]))
    for (const builtin of ['Component', 'KeepAlive', 'Suspense', 'Teleport', 'Transition', 'TransitionGroup']) registered.add(builtin)
    // Sanity check that the list was actually read: otherwise an empty "registered" set would let everything through.
    expect(registered.has('InPortalGate')).toBe(true)
    const pascal = (tag: string) => tag.includes('-') ? tag.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('') : tag
    const unknown: string[] = []
    for (const file of sources(join(ROOT, 'app')).filter(f => f.endsWith('.vue'))) {
      const text = readFileSync(file, 'utf8')
      const template = text.slice(text.indexOf('<template>'), text.lastIndexOf('</template>'))
      // Default component import in the file's <script>: a b24icons icon or a .vue file.
      const imported = new Set([...text.matchAll(/^import\s+([A-Z]\w*)\s+from\s+['"]((?:@bitrix24\/b24icons-vue\/[^'"]+)|[^'"]+\.vue)['"]/gm)].map(m => m[1]))
      for (const m of template.matchAll(/<([A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g)) {
        const name = pascal(m[1]!)
        if (!registered.has(name) && !imported.has(name)) unknown.push(`${relative(ROOT, file)}: <${m[1]}>`)
      }
    }
    expect(unknown).toEqual([])
  })
})

/** Recursively all .ts/.vue files under a directory. */
function sources(dir: string): string[] {
  const out: string[] = []
  // shared/ is empty after stage 0 (git does not track empty directories), but will come back — don't fail without it.
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.(ts|vue)$/.test(name)) out.push(path)
  }
  return out
}

/**
 * REST method names in the code: string literals like `crm.item.get`, `profile`, `scope`.
 * WARNING: matched by the module prefixes we call; a new module needs a new prefix here, or its
 * methods will slip past the registry check. A false positive is better than a miss.
 */
// Method names in single quotes or backticks (code strings, templates, references in comments).
// Double quotes are skipped: in Vue templates those are expressions (`"app.loaded.value"`), not method names.
// Namespaces are listed generously: a new call from a sibling module should also be caught by the registry.
const METHOD_RE = /['`]((?:crm|tasks?|catalog|user|app|placement|event|department|im|imbot|disk|entity|lists|sale|timeman|bizproc|calendar|sonet_group|documentgenerator|landing|ai|server|userfieldtype|biconnector)\.[a-z][a-z0-9_.]*[a-z0-9]|profile|scope|methods|batch)['`]/g

describe('REST method registry (docs/REST_METHODS.md)', () => {
  it('every method the code calls is documented in the registry', () => {
    const registry = readFileSync(join(ROOT, 'docs/REST_METHODS.md'), 'utf8')
    const used = new Map<string, string>()
    for (const file of [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'server')), ...sources(join(ROOT, 'shared'))]) {
      for (const m of readFileSync(file, 'utf8').matchAll(METHOD_RE)) {
        if (!used.has(m[1]!)) used.set(m[1]!, relative(ROOT, file))
      }
    }
    // Threshold so a broken search (empty result) doesn't pass itself off as "all documented".
    expect(used.size).toBeGreaterThanOrEqual(6)
    const missing = [...used].filter(([method]) => !registry.includes(`\`${method}\``)).map(([m, f]) => `${m} (${f})`)
    expect(missing, `Missing from docs/REST_METHODS.md:\n${missing.join('\n')}`).toEqual([])
  })
})
