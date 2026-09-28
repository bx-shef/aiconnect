// Хранилище токенов установки: member_id → домен, токены администратора-установщика и
// application_token. Нужно ровно для двух вещей (docs/ARCHITECTURE.md):
//   1) записать ставки от имени администратора, когда их меняет назначенный НЕ-администратор
//      (app.option.set разрешён только администратору — документация метода);
//   2) убедиться, что запрос к BitrixGPT пришёл с портала, где приложение установлено.
//
// Хранилище — unstorage (Nitro `useStorage('portals')`, драйвер fs, см. nuxt.config.ts), а не
// Postgres, как в эталоне: здесь одна запись на портал и никаких запросов по полям.
// Оба токена шифруются (secretCrypto.ts): access-токен живёт час, но это час прав администратора
// портала — при утечке тома он не должен читаться (находка отдела безопасности панели).

import { DEFAULT_OAUTH_HOST } from './b24Host'
import { decryptSecret, encryptSecret } from './secretCrypto'

export interface PortalRecord {
  memberId: string
  domain: string
  /** Зашифрованный access-токен (`iv:tag:data`). */
  accessTokenEnc: string
  /** Зашифрованный refresh-токен (`iv:tag:data`). */
  refreshTokenEnc: string
  /** Момент истечения access-токена, мс. */
  expiresAt: number
  /** Секрет подписи событий портала; пишется один раз — при первой установке. */
  applicationToken: string
  installedAt: number
  /** Сервер авторизации портала (из `auth[server_endpoint]` установки); у старых записей нет. */
  oauthHost?: string
}

/**
 * Минимальный срез unstorage, который мы используем. Свой интерфейс, а не тип из `unstorage`:
 * пакет приходит транзитивно через Nitro, и прямой импорт зависел бы от раскладки node_modules.
 * `useStorage()` ему удовлетворяет структурно, тесты подсовывают Map.
 */
export interface KeyValue {
  getItem(key: string): Promise<unknown>
  setItem(key: string, value: unknown): Promise<void>
  removeItem(key: string): Promise<void>
}

const portalKey = (memberId: string) => `portal:${memberId.toLowerCase()}`
const domainKey = (domain: string) => `domain:${domain.toLowerCase()}`

function isRecord(value: unknown): value is PortalRecord {
  const o = value as PortalRecord | null
  return !!o && typeof o === 'object' && typeof o.memberId === 'string' && typeof o.domain === 'string'
}

export async function getPortal(kv: KeyValue, memberId: string): Promise<PortalRecord | null> {
  const value = await kv.getItem(portalKey(memberId))
  return isRecord(value) ? value : null
}

export async function getPortalByDomain(kv: KeyValue, domain: string): Promise<PortalRecord | null> {
  const memberId = await kv.getItem(domainKey(domain))
  if (typeof memberId !== 'string') return null
  const record = await getPortal(kv, memberId)
  // Индекс мог устареть: запись, чей домен уже другой, этому домену не принадлежит.
  return record && record.domain === domain.toLowerCase() ? record : null
}

export interface SaveInstallInput {
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  applicationToken: string
  /** Сервер авторизации; не задан — {@link DEFAULT_OAUTH_HOST}. */
  oauthHost?: string
}

/**
 * Сохраняет установку. `applicationToken` — write-once: переустановка его не перезаписывает,
 * иначе поддельная «установка» могла бы подменить секрет, которым проверяются события.
 */
export async function saveInstall(kv: KeyValue, input: SaveInstallInput, now = Date.now()): Promise<void> {
  const prev = await getPortal(kv, input.memberId)
  const record: PortalRecord = {
    memberId: input.memberId.toLowerCase(),
    domain: input.domain.toLowerCase(),
    accessTokenEnc: input.accessToken ? encryptSecret(input.accessToken) : '',
    refreshTokenEnc: input.refreshToken ? encryptSecret(input.refreshToken) : '',
    expiresAt: now + input.expiresIn * 1000,
    applicationToken: prev?.applicationToken || input.applicationToken,
    installedAt: prev?.installedAt ?? now,
    oauthHost: input.oauthHost || DEFAULT_OAUTH_HOST
  }
  if (prev && prev.domain !== record.domain) await removeDomainIfOwned(kv, prev.domain, record.memberId)
  await kv.setItem(portalKey(record.memberId), record)
  await kv.setItem(domainKey(record.domain), record.memberId)
}

/**
 * Снимает индекс домена, только если он всё ещё указывает на этот портал. Домен мог перейти к
 * другому порталу (переезд, освобождённое имя) — чужой индекс трогать нельзя, иначе тот портал
 * получит «не установлено» на каждый запрос (находка /code-review этого PR).
 */
async function removeDomainIfOwned(kv: KeyValue, domain: string, memberId: string): Promise<void> {
  const owner = await kv.getItem(domainKey(domain))
  if (typeof owner === 'string' && owner === memberId.toLowerCase()) await kv.removeItem(domainKey(domain))
}

/** Обновление токенов после рефреша. Только для существующей записи — удалённый портал не воскрешаем. */
export async function updateTokens(kv: KeyValue, memberId: string, tokens: { accessToken: string, refreshToken: string, expiresAt: number }): Promise<void> {
  const prev = await getPortal(kv, memberId)
  if (!prev) return
  await kv.setItem(portalKey(prev.memberId), {
    ...prev,
    accessTokenEnc: tokens.accessToken ? encryptSecret(tokens.accessToken) : prev.accessTokenEnc,
    refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : prev.refreshTokenEnc,
    expiresAt: tokens.expiresAt
  })
}

/** Удаление всего, что мы знаем о портале (событие удаления приложения). */
export async function removePortal(kv: KeyValue, memberId: string): Promise<void> {
  const prev = await getPortal(kv, memberId)
  if (prev) await removeDomainIfOwned(kv, prev.domain, prev.memberId)
  await kv.removeItem(portalKey(memberId))
}

function decryptOrEmpty(blob: string): string {
  if (!blob) return ''
  try {
    return decryptSecret(blob)
  } catch {
    return ''
  }
}

/** Расшифрованный access-токен записи; `''`, если его нет или ключ сменился. */
export function accessTokenOf(record: PortalRecord): string {
  return decryptOrEmpty(record.accessTokenEnc)
}

/** Расшифрованный refresh-токен записи; `''`, если его нет или ключ сменился. */
export function refreshTokenOf(record: PortalRecord): string {
  return decryptOrEmpty(record.refreshTokenEnc)
}
