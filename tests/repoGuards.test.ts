// Гарды репозитория — перенесены из эталона client-bank-alfa-by (mdReviewStamp.test.ts,
// ciWorkflowGuard.test.ts) и дополнены сверкой реестра REST-методов, которую там оставили в TODO.

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function trackedMarkdown(): string[] {
  return execSync('git ls-files --cached --others --exclude-standard "*.md"', { cwd: ROOT })
    .toString().trim().split('\n').filter(Boolean)
}

describe('документация', () => {
  it('каждый .md несёт штамп «> Last reviewed: YYYY-MM-DD»', () => {
    const files = trackedMarkdown()
    expect(files.length).toBeGreaterThan(0)
    const missing = files.filter(f => !/^> Last reviewed: \d{4}-\d{2}-\d{2}$/m.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(missing, `Нет штампа в:\n${missing.join('\n')}`).toEqual([])
  })
})

describe('CI запускает проверки и падает на них', () => {
  const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')

  it('ни один шаг не гасит провал (continue-on-error / || true)', () => {
    const lines = CI.split('\n').map(l => l.trim())
    expect(lines.filter(l => /^continue-on-error\s*:\s*true/.test(l))).toEqual([])
    expect(lines.filter(l => /^(- )?run:\s/.test(l) && /\|\|\s*(true|:)\b|;\s*true\b|\|\|\s*exit\s+0/.test(l))).toEqual([])
  })

  it('джоба `ci` запускает lint, test, typecheck и build', () => {
    for (const cmd of ['pnpm lint', 'pnpm test', 'pnpm typecheck', 'pnpm build']) {
      expect(CI, `CI не запускает \`${cmd}\``).toMatch(new RegExp(`run:\\s*${cmd}\\s*$`, 'm'))
    }
  })

  it('имена джоб `ci` и `docker-build` сохранены — на них ссылается защита main', () => {
    expect(CI).toMatch(/^ {2}ci:\n {4}name: ci$/m)
    expect(CI).toMatch(/^ {2}docker-build:\n {4}name: docker-build$/m)
  })
})

describe('выкат (docs/DEPLOY.md): main → GHCR → Watchtower → nginx-proxy', () => {
  const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const COMPOSE = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8')
  // Блок джобы deploy: от `  deploy:` до заголовка следующей джобы (`  имя:`) или конца файла.
  // Граница — по следующей джобе, а не по отступам строк: комментарий с любым отступом блок не рвёт.
  const DEPLOY = (() => {
    const start = CI.search(/^ {2}deploy:\s*$/m)
    if (start < 0) return ''
    const rest = CI.slice(start + 1)
    const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m)
    return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next)
  })()

  it('deploy ждёт зелёный ci и выкатывает только main — пушем или ручным запуском', () => {
    expect(DEPLOY, 'нет джобы deploy').not.toBe('')
    expect(DEPLOY).toMatch(/^ {4}needs: (?:ci|\[[^\]]*\bci\b[^\]]*\])\s*$/m)
    // Условие целиком: `&&` → `||` пустил бы в GHCR как latest образ любой ветки.
    expect(DEPLOY).toMatch(/^ {4}if: \$\{\{ \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main' \}\}$/m)
    expect(DEPLOY).toMatch(/^ {10}push: true$/m)
  })

  it('сервер тянет тот образ, который публикует deploy', () => {
    expect(DEPLOY).toMatch(/images: ghcr\.io\/\$\{\{ github\.repository \}\}$/m)
    expect(DEPLOY).toMatch(/type=raw,value=latest/)
    expect(COMPOSE).toMatch(/^ {4}image: ghcr\.io\/bx-shef\/aiconnect:latest$/m)
  })

  it('токены установки живут в томе: Watchtower пересоздаёт контейнер на каждом выкате', () => {
    // Каталог данных = рабочий каталог образа + база fs-хранилища Nitro (nuxt.config.ts).
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)?.[1]
    const base = /portals: \{ driver: 'fs', base: '\.\/([^/']+)\/portals' \}/.exec(readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8'))?.[1]
    expect(workdir && base, 'не нашли WORKDIR или базу хранилища portals').toBeTruthy()
    expect(COMPOSE).toMatch(new RegExp(`^ {6}- portals:${workdir}/${base}$`, 'm'))
    expect(COMPOSE).toMatch(/^volumes:\n {2}portals:$/m)
  })

  it('nginx-proxy ходит на тот порт, который слушает сервер образа', () => {
    const port = /^ENV PORT=(\d+)$/m.exec(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))?.[1]
    expect(port, 'нет ENV PORT в Dockerfile').toBeTruthy()
    expect(COMPOSE).toMatch(new RegExp(`^ {6}VIRTUAL_PORT: ${port}$`, 'm'))
    expect(COMPOSE).toMatch(new RegExp(`^ {6}- "${port}"$`, 'm'))
  })

  it('за nginx-proxy: окружение из .env, адрес из DOMAIN, TRUST_PROXY=1, перезапуск, метка Watchtower, proxy-net', () => {
    expect(COMPOSE).toMatch(/^ {4}env_file: \.env$/m)
    expect(COMPOSE).toMatch(/^ {4}restart: unless-stopped$/m)
    expect(COMPOSE).toMatch(/^ {6}NUXT_PUBLIC_SITE_URL: https:\/\/\$\{DOMAIN\}$/m)
    expect(COMPOSE).toMatch(/^ {6}TRUST_PROXY: "1"$/m)
    expect(COMPOSE).toMatch(/^ {6}- "com\.centurylinklabs\.watchtower\.enable=true"$/m)
    // Без этого — 502 на POST-запросах портала после паузы (keepalive nginx-proxy против Node, 2026-09-25).
    expect(COMPOSE).toMatch(/^ {6}- "com\.github\.nginx-proxy\.nginx-proxy\.keepalive=disabled"$/m)
    expect(COMPOSE).toMatch(/^networks:\n {2}proxy-net:\n {4}external: true$/m)
    expect(COMPOSE).toMatch(/^ {6}B24_TOKEN_ENC_KEY: \$\{B24_TOKEN_ENC_KEY:\?/m)
  })

  it('образ знает свой коммит: deploy передаёт его, Dockerfile кладёт в окружение, health читает', () => {
    expect(DEPLOY).toMatch(/^ {10}build-args: COMMIT_SHA=\$\{\{ github\.sha \}\}$/m)
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    const runner = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
    expect(runner).toMatch(/^ARG COMMIT_SHA=""\nENV COMMIT_SHA=\$COMMIT_SHA$/m)
    expect(readFileSync(join(ROOT, 'server/api/health.get.ts'), 'utf8')).toMatch(/buildCommit\(process\.env\.COMMIT_SHA\)/)
  })

  it('скрипты и стили уходят сжатыми: перед Nitro нет своего nginx, а общий nginx-proxy не сжимает', () => {
    expect(readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8')).toMatch(/^ {4}compressPublicAssets: true,$/m)
  })
})

describe('шаблоны Vue', () => {
  // Nuxt называет компоненты из подкаталогов с приставкой каталога (components/invoice/FillPreview.vue →
  // InvoiceFillPreview). Незнакомый тег Vue рисует пустым элементом без ошибки — так в шаблоне
  // invoice-from-tasks предпросмотр счёта не показывался вовсе (живой прогон 2026-09-25).
  it('незнакомый компонент в шаблоне — ошибка typecheck', () => {
    // tsconfig.json — JSONC: убираем комментарии-строки и смотрим настройку там, где её читает vue-tsc.
    const text = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const config = JSON.parse(text) as { vueCompilerOptions?: { checkUnknownComponents?: unknown } }
    expect(config.vueCompilerOptions?.checkUnknownComponents).toBe(true)
  })

  // То же, но и в быстром `pnpm test`, а не только в typecheck: каждый компонент в <template> страниц и
  // компонентов — тот, что Nuxt зарегистрировал (.nuxt/components.d.ts пишет nuxt prepare при установке
  // зависимостей), встроенный в Vue или импортированный в самом файле как компонент: иконка
  // `@bitrix24/b24icons-vue/…` или файл `.vue` (любой другой импорт с большой буквы — не компонент, и
  // опечатка в теге не должна проходить). Компонент — тег с большой буквы или с дефисом
  // (fill-preview → FillPreview); обычные теги HTML дефиса не содержат.
  it('каждый компонент в шаблонах зарегистрирован Nuxt под этим именем', () => {
    const dts = join(ROOT, '.nuxt/components.d.ts')
    expect(existsSync(dts), 'нет .nuxt/components.d.ts — запустите pnpm install (nuxt prepare)').toBe(true)
    const registered = new Set([...readFileSync(dts, 'utf8').matchAll(/^export const (\w+):/gm)].map(m => m[1]))
    for (const builtin of ['Component', 'KeepAlive', 'Suspense', 'Teleport', 'Transition', 'TransitionGroup']) registered.add(builtin)
    // Проверка, что список вообще прочитан: иначе пустой набор «зарегистрированных» пропустил бы всё.
    expect(registered.has('InPortalGate')).toBe(true)
    const pascal = (tag: string) => tag.includes('-') ? tag.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('') : tag
    const unknown: string[] = []
    for (const file of sources(join(ROOT, 'app')).filter(f => f.endsWith('.vue'))) {
      const text = readFileSync(file, 'utf8')
      const template = text.slice(text.indexOf('<template>'), text.lastIndexOf('</template>'))
      // Импорт компонента по умолчанию в <script> файла: иконка b24icons или .vue.
      const imported = new Set([...text.matchAll(/^import\s+([A-Z]\w*)\s+from\s+['"]((?:@bitrix24\/b24icons-vue\/[^'"]+)|[^'"]+\.vue)['"]/gm)].map(m => m[1]))
      for (const m of template.matchAll(/<([A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g)) {
        const name = pascal(m[1]!)
        if (!registered.has(name) && !imported.has(name)) unknown.push(`${relative(ROOT, file)}: <${m[1]}>`)
      }
    }
    expect(unknown).toEqual([])
  })
})

/** Все .ts/.vue файлы каталога рекурсивно. */
function sources(dir: string): string[] {
  const out: string[] = []
  // shared/ пуст после этапа 0 (git не хранит пустые каталоги), но вернётся — не падаем без него.
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.(ts|vue)$/.test(name)) out.push(path)
  }
  return out
}

/**
 * Имена REST-методов в коде: строковые литералы вида `crm.item.get`, `profile`, `scope`.
 * ⚠ Ищем по префиксам модулей, которые мы зовём; новый модуль — новый префикс здесь, иначе
 * метод пройдёт мимо реестра. Лучше лишнее совпадение, чем пропуск.
 */
// Имена методов — в одинарных кавычках или обратных (строки кода, шаблоны, ссылки в комментариях).
// Двойные не берём: в шаблонах Vue это выражения (`"app.loaded.value"`), а не имена методов.
// Пространства имён — с запасом: новый вызов из соседнего модуля тоже должен попасть в реестр.
const METHOD_RE = /['`]((?:crm|tasks?|catalog|user|app|placement|event|department|im|imbot|disk|entity|lists|sale|timeman|bizproc|calendar|sonet_group|documentgenerator|landing|ai|server|userfieldtype|biconnector)\.[a-z][a-z0-9_.]*[a-z0-9]|profile|scope|methods|batch)['`]/g

describe('реестр REST-методов (docs/REST_METHODS.md)', () => {
  it('каждый метод, который зовёт код, описан в реестре', () => {
    const registry = readFileSync(join(ROOT, 'docs/REST_METHODS.md'), 'utf8')
    const used = new Map<string, string>()
    for (const file of [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'server')), ...sources(join(ROOT, 'shared'))]) {
      for (const m of readFileSync(file, 'utf8').matchAll(METHOD_RE)) {
        if (!used.has(m[1]!)) used.set(m[1]!, relative(ROOT, file))
      }
    }
    // Порог — чтобы поломка поиска (пустой результат) не выдавала себя за «всё в реестре».
    expect(used.size).toBeGreaterThanOrEqual(6)
    const missing = [...used].filter(([method]) => !registry.includes(`\`${method}\``)).map(([m, f]) => `${m} (${f})`)
    expect(missing, `Нет в docs/REST_METHODS.md:\n${missing.join('\n')}`).toEqual([])
  })
})
