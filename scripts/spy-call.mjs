#!/usr/bin/env node
// Test incoming call for the protocol spy (docs/SPY_CHECK.md): creates a lead with a phone,
// registers an incoming call as a PBX would (telephony.externalCall.register → finish →
// attachRecord) and attaches a synthetic Russian dialogue (scripts/fixtures). The webhook comes
// from the environment only and is never printed.
//
//   B24_WEBHOOK=https://<portal>/rest/<user>/<token>/ node scripts/spy-call.mjs [label]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hook = (process.env.B24_WEBHOOK ?? '').replace(/\/+$/, '')
if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+$/.test(hook)) {
  console.error('B24_WEBHOOK=https://<portal>/rest/<user>/<token>/ is required')
  process.exit(2)
}
const label = (process.argv[2] ?? 'call').replace(/[^\w.-]/g, '').slice(0, 40) || 'call'
const file = fileURLToPath(new URL('./fixtures/call-won-supply.mp3', import.meta.url))
const phone = `+37529${String(Date.now()).slice(-7)}`

async function call(method, params) {
  const res = await fetch(`${hook}/${method}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(`${method}: ${res.status} ${data.error ?? ''} ${data.error_description ?? ''}`.trim())
  return data.result
}

const lead = await call('crm.lead.add', { fields: { TITLE: `spy-${label}: Поставка насосов`, NAME: 'Ирина', LAST_NAME: 'Котова', PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] } })
const reg = await call('telephony.externalcall.register', { USER_ID: 1, PHONE_NUMBER: phone, TYPE: 2, CRM_CREATE: 0, CRM_ENTITY_TYPE: 'LEAD', CRM_ENTITY_ID: lead, SHOW: 0 })
await call('telephony.externalcall.finish', { CALL_ID: reg.CALL_ID, USER_ID: 1, DURATION: 29, STATUS_CODE: '200' })
const att = await call('telephony.externalcall.attachRecord', { CALL_ID: reg.CALL_ID, FILENAME: 'call-won-supply.mp3', FILE_CONTENT: readFileSync(file).toString('base64') })
console.log(`lead ${lead}, call ${reg.CALL_ID}, file ${att.FILE_ID}`)
console.log(`${new URL(hook).origin}/crm/lead/details/${lead}/`)
