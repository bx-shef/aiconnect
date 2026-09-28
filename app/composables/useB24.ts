// Connection to the portal from the frame: B24Frame initialization (@bitrix24/b24jssdk) and a call wrapper.
// A module-level singleton — like in the client-bank-alfa-by reference app (app/composables/useB24.ts).
//
// ⚠ The frame token is also sent to OUR server (useApi.ts), but the SDK only refreshes it on its own
// request path. The `keepAuthFresh` option from the docs isn't in the installed 2.2.0 version yet
// (checked against the package types), so useApi.ts is what keeps the token fresh before a server request.

import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { sdkRestrictionParams } from '~/config/b24'

/** REST call error with the method name — so the UI can show WHAT failed. */
export class B24CallError extends Error {
  constructor(readonly method: string, readonly messages: string[]) {
    super(`${method}: ${messages.join('; ') || 'неизвестная ошибка'}`)
    this.name = 'B24CallError'
  }
}

let frame: B24Frame | undefined
let inFlight: Promise<B24Frame | undefined> | undefined

export function useB24() {
  const ready = useState('b24-ready', () => false)

  /**
   * Initializes the frame. `undefined` means the page is opened outside the portal (a direct link, a preview):
   * such a page has no `window.name` with portal data, and the SDK would fail immediately.
   */
  async function init(): Promise<B24Frame | undefined> {
    if (frame) return frame
    if (inFlight) return inFlight
    if (typeof window === 'undefined' || !window.name) return undefined
    // No automatic write retries on network failures — see sdkRestrictionParams (config/b24.ts).
    inFlight = initializeB24Frame({ restrictionParams: sdkRestrictionParams() })
      .then((f) => {
        frame = f
        ready.value = true
        return f
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  function get(): B24Frame | undefined {
    return frame
  }

  function getOrThrow(): B24Frame {
    if (!frame) throw new Error('Приложение открыто не в Битрикс24')
    return frame
  }

  /** A single REST v2 call: result or {@link B24CallError}. */
  async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await getOrThrow().actions.v2.call.make({ method, params })
    if (!res.isSuccess) throw new B24CallError(method, res.getErrorMessages())
    return res.getData()?.result as T
  }

  return { ready, init, get, getOrThrow, call }
}
