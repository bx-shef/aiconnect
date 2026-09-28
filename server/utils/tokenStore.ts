// Install token store: member_id → domain, installer-admin tokens, and application_token.
// Right now this exists for one thing: confirming a request to our API came from a portal where
// the app is installed (frameAuth.ts, docs/B24_EVENTS.md). Installer tokens are saved ahead of
// time: whether the provider will need them is a call for stages 1-3 of docs/PLAN.md.
//
// Storage is unstorage (Nitro `useStorage('portals')`, fs driver, see nuxt.config.ts), not
// Postgres like the reference app: here it's one record per portal and no field-level queries.
// Both tokens are encrypted (secretCrypto.ts): the access token lives for an hour, but that's an
// hour of portal admin rights — a leaked volume must not be readable (finding from the panel's
// security team).

import { DEFAULT_OAUTH_HOST } from './b24Host'
import { decryptSecret, encryptSecret } from './secretCrypto'

export interface PortalRecord {
  memberId: string
  domain: string
  /** Encrypted access token (`iv:tag:data`). */
  accessTokenEnc: string
  /** Encrypted refresh token (`iv:tag:data`). */
  refreshTokenEnc: string
  /** Access token expiry timestamp, ms. */
  expiresAt: number
  /** Portal event-signing secret; written once — on first install. */
  applicationToken: string
  installedAt: number
  /** Portal's authorization server (from install's `auth[server_endpoint]`); older records lack it. */
  oauthHost?: string
}

/**
 * The minimal slice of unstorage we use. Our own interface rather than a type from `unstorage`:
 * the package arrives transitively via Nitro, and a direct import would depend on node_modules
 * layout. `useStorage()` satisfies it structurally; tests pass in a Map.
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
  // The index may be stale: a record whose domain has since changed no longer belongs to this domain.
  return record && record.domain === domain.toLowerCase() ? record : null
}

export interface SaveInstallInput {
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  applicationToken: string
  /** Authorization server; unset — {@link DEFAULT_OAUTH_HOST}. */
  oauthHost?: string
}

/**
 * Saves an install. `applicationToken` is write-once: a reinstall doesn't overwrite it, or else a
 * forged "install" could swap out the secret that events are verified with.
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
 * Removes the domain index only if it still points at this portal. The domain may have moved to
 * another portal (migration, freed-up name) — touching someone else's index is off-limits, or
 * that portal would get "not installed" on every request (finding of /code-review on this PR).
 */
async function removeDomainIfOwned(kv: KeyValue, domain: string, memberId: string): Promise<void> {
  const owner = await kv.getItem(domainKey(domain))
  if (typeof owner === 'string' && owner === memberId.toLowerCase()) await kv.removeItem(domainKey(domain))
}

/** Updates tokens after a refresh. Existing records only — we don't resurrect a removed portal. */
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

/** Deletes everything we know about a portal (app-uninstall event). */
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

/** Decrypted access token of a record; `''` if missing or the key changed. */
export function accessTokenOf(record: PortalRecord): string {
  return decryptOrEmpty(record.accessTokenEnc)
}

/** Decrypted refresh token of a record; `''` if missing or the key changed. */
export function refreshTokenOf(record: PortalRecord): string {
  return decryptOrEmpty(record.refreshTokenEnc)
}
