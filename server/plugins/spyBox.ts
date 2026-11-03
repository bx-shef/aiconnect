// At startup: is the spy box stand (B24_SPY_BOX_APP) and each B24_SPY_APPS line on, off or misconfigured — the host and the
// reason only, never the credentials. A typo must not stay silent until the install fails.

import { spyAppsState, spyBoxState } from '../utils/b24Client'

export default defineNitroPlugin(() => {
  const s = spyBoxState()
  if (s.state === 'on') console.info(`[spy-box] on for ${s.app.host}`)
  else if (s.state === 'invalid') console.error(`[spy-box] B24_SPY_BOX_APP is set but ignored for ${s.host || '?'}: ${s.reason}`)
  const apps = spyAppsState()
  for (const a of apps.apps) console.info(`[spy-apps] on for ${a.host}`)
  for (const i of apps.invalid) console.error(`[spy-apps] B24_SPY_APPS line ignored for ${i.host || '?'}: ${i.reason}`)
})
