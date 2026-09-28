// Пределы входящих запросов к /api — защита одного на всех сервера от переполнения памяти и
// от потока запросов на публичный адрес вебхука (находка отдела безопасности панели: анонимный
// POST на 15 МБ принимался целиком). Чистые функции; применяет их server/middleware/requestLimits.ts.

import type { WindowLimit } from './rateLimit'

/** Тело события портала — PHP-форма в несколько сотен байт; 64 КБ — с большим запасом. */
export const EVENTS_BODY_LIMIT = 64 * 1024
/** Прочие POST: самое крупное — контекст консультации (до 30 тыс. символов) и ставки. */
export const API_BODY_LIMIT = 512 * 1024

/**
 * Частота событий установки и удаления с одного адреса (прочие события не считаются —
 * b24EventsHandler.ts). Битрикс24 шлёт их со своих серверов, и лавины установок там не бывает.
 */
export const EVENTS_PER_IP: WindowLimit = { max: 60, windowMs: 60_000 }
/**
 * Общий потолок сверок установки: каждая — исходящий запрос к серверу авторизации с нашими
 * client_id/secret, и поток поддельных установок с тысяч адресов не должен превратиться в поток
 * таких запросов (за злоупотребление Битрикс24 может заблокировать ключи). Списывается прямо
 * перед запросом, после всех проверок: мусор и события удаления его не тратят — иначе поток
 * мусора блокировал бы настоящие удаления (находка /code-review).
 */
export const OAUTH_VERIFY_GLOBAL: WindowLimit = { max: 600, windowMs: 60_000 }
/** Живых проверок фрейм-токена (вызовов `profile` в чужой портал) с одного IP. */
export const FRAME_CHECKS_PER_IP: WindowLimit = { max: 60, windowMs: 60_000 }

/** Предел тела для пути; `null` — путь не ограничиваем (страницы, GET). */
export function bodyLimitFor(method: string, path: string): number | null {
  if (method.toUpperCase() !== 'POST' || !path.startsWith('/api/')) return null
  return path.startsWith('/api/b24/events') ? EVENTS_BODY_LIMIT : API_BODY_LIMIT
}

export type BodyVerdict = { ok: true } | { ok: false, status: 411 | 413 }

/**
 * Решение по заголовку `Content-Length`. Без него — 411: и портал, и наша страница его шлют,
 * а тело неизвестной длины пришлось бы читать целиком, чтобы узнать, что оно слишком большое.
 */
export function checkBodySize(contentLength: string | undefined | null, limit: number): BodyVerdict {
  if (contentLength === undefined || contentLength === null || contentLength.trim() === '') return { ok: false, status: 411 }
  const n = Number(contentLength)
  if (!Number.isInteger(n) || n < 0) return { ok: false, status: 411 }
  return n > limit ? { ok: false, status: 413 } : { ok: true }
}

/** IPv4-mapped IPv6 → IPv4: `::ffff:10.0.0.1` и `::ffff:a00:1` → `10.0.0.1`; прочее — как есть. */
function unmapIPv4(ip: string): string {
  const a = ip.trim().toLowerCase()
  if (!a.startsWith('::ffff:')) return a
  const tail = a.slice('::ffff:'.length)
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!hex) return tail
  const hi = Number.parseInt(hex[1]!, 16)
  const lo = Number.parseInt(hex[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/**
 * Ключ адреса для лимитов: IPv4 — целиком, IPv6 — сеть /64. Одному клиенту обычно выдают целую
 * /64, и лимит по полному адресу обходился бы перебором адресов внутри неё (находка /code-review).
 */
export function ipBucketKey(ip: string): string {
  const a = unmapIPv4(String(ip ?? ''))
  if (!a.includes(':')) return a
  const [head = '', tail = ''] = a.split('::')
  const left = head ? head.split(':') : []
  const right = a.includes('::') && tail ? tail.split(':') : []
  const groups = a.includes('::')
    ? [...left, ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0'), ...right]
    : left
  return `${groups.slice(0, 4).map(g => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * Адрес из частной сети: loopback, RFC 1918, CGNAT, link-local, IPv6 ULA (в том числе
 * IPv4-mapped). Только такому соседу — своему прокси, мосту Docker — верим `X-Forwarded-For`.
 */
export function isPrivateAddress(ip: string): boolean {
  const a = unmapIPv4(String(ip ?? ''))
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a)
  if (v4) {
    const o1 = Number(v4[1])
    const o2 = Number(v4[2])
    return o1 === 10 || o1 === 127
      || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 192 && o2 === 168)
      || (o1 === 169 && o2 === 254)
      || (o1 === 100 && o2 >= 64 && o2 <= 127)
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)
}

/**
 * IP клиента для лимитов.
 *
 * Без доверенного прокси — адрес сокета. С ним (`TRUST_PROXY=1`) — ПОСЛЕДНИЙ адрес из
 * `X-Forwarded-For`: его дописывает наш прокси, а всё, что левее, прислал клиент. h3
 * (`getRequestIP` с `xForwardedFor`) берёт первый — подделываемый, и лимит обходился бы сменой
 * заголовка. Заголовку верим, только если соединение пришло из частной сети: если порт сервера
 * опубликован наружу, клиент, дошедший мимо прокси, иначе назначал бы себе адрес сам (находка
 * /code-review). Схема рассчитана на ОДИН прокси перед сервером (docs/DEPLOY.md).
 */
export function pickClientIp(forwardedFor: string | undefined | null, socketIp: string | undefined | null, trustProxy: boolean): string {
  if (forwardedStatus(forwardedFor, socketIp, trustProxy) === 'used') return lastForwarded(forwardedFor)
  return socketIp || 'unknown'
}

/** Последний непустой адрес `X-Forwarded-For`; `''` — нет ни одного. */
function lastForwarded(forwardedFor: string | undefined | null): string {
  return String(forwardedFor ?? '').split(',').map(part => part.trim()).filter(Boolean).pop() ?? ''
}

export type ForwardedStatus = 'used' | 'ignored' | 'absent'

/**
 * Учтён ли `X-Forwarded-For` для запроса: `used` — да; `ignored` — заголовок есть, но ему не
 * верим (нет `TRUST_PROXY=1` или прокси пришёл не из частной сети — тогда все клиенты делят лимиты
 * адреса прокси); `absent` — заголовка нет. Показывается в `/api/health`: иначе молча
 * игнорируемый заголовок не заметить (находка /code-review).
 */
export function forwardedStatus(forwardedFor: string | undefined | null, socketIp: string | undefined | null, trustProxy: boolean): ForwardedStatus {
  if (!lastForwarded(forwardedFor)) return 'absent'
  return trustProxy && !!socketIp && isPrivateAddress(socketIp) ? 'used' : 'ignored'
}
