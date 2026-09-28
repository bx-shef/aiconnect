// Шифрование секретов (токены портала) перед записью в хранилище: AES-256-GCM.
// Перенесено из client-bank-alfa-by (server/utils/secretCrypto.ts) без ротации ключа —
// её добавим, когда понадобится (правило «без кода на гипотетическое будущее»).

import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/**
 * Ключ из окружения `B24_TOKEN_ENC_KEY`: 64 hex-символа или base64 от 32 байт.
 * Бросает, если ключа нет или длина не та, — лучше упасть, чем сохранить токен открытым текстом.
 */
export function loadEncKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.B24_TOKEN_ENC_KEY?.trim()
  if (!raw) throw new Error('B24_TOKEN_ENC_KEY is not set (need a 32-byte hex/base64 key)')
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== KEY_BYTES) throw new Error(`B24_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}`)
  return buf
}

/** Шифрует строку: `iv:tag:данные` (base64). Свежий IV на каждый вызов. */
export function encryptSecret(plaintext: string, key: Buffer = loadEncKey()): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}

/** Расшифровка. Бросает на битом блобе или чужом ключе (GCM проверяет подпись) — мусор не вернёт. */
export function decryptSecret(blob: string, key: Buffer = loadEncKey()): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('decryptSecret: malformed blob')
  const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer]
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
