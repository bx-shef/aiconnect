// At startup: is the spy box stand (B24_SPY_BOX_APP) on, off or misconfigured — the host and the
// reason only, never the credentials. A typo must not stay silent until the install fails.

import { spyBoxState } from '../utils/b24Client'

export default defineNitroPlugin(() => {
  const s = spyBoxState()
  if (s.state === 'on') console.info(`[spy-box] on for ${s.app.host}`)
  else if (s.state === 'invalid') console.error(`[spy-box] B24_SPY_BOX_APP is set but ignored for ${s.host || '?'}: ${s.reason}`)
})
