// Encrypts secrets (portal tokens) before writing them to storage: AES-256-GCM.
// Ported from client-bank-alfa-by (server/utils/secretCrypto.ts) without key rotation —
// we'll add it when it's actually needed (the "no code for a hypothetical future" rule).

import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/**
 * Key from the `B24_TOKEN_ENC_KEY` environment variable: 64 hex characters, or base64 of 32 bytes.
 * Throws if the key is missing or the wrong length — better to fail than store a token in plaintext.
 */
export function loadEncKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.B24_TOKEN_ENC_KEY?.trim()
  if (!raw) throw new Error('B24_TOKEN_ENC_KEY is not set (need a 32-byte hex/base64 key)')
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== KEY_BYTES) throw new Error(`B24_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}`)
  return buf
}

/** Encrypts a string: `iv:tag:data` (base64). A fresh IV on every call. */
export function encryptSecret(plaintext: string, key: Buffer = loadEncKey()): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}

/** Decryption. Throws on a corrupted blob or wrong key (GCM checks the tag) — never returns garbage. */
export function decryptSecret(blob: string, key: Buffer = loadEncKey()): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('decryptSecret: malformed blob')
  const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer]
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
