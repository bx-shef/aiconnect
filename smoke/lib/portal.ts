// REST calls to the test portal via webhook — using the same b24jssdk as the application (`B24Hook`
// instead of `B24Frame`). Errors carry only the method and the portal's text: the webhook address
// (a secret) never makes it into the output.

import { B24Hook } from '@bitrix24/b24jssdk'

export interface Portal {
  /** REST v2: the response's `result`, or an error "method: portal text". */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** SDK exception without the request address: a network error's `cause`/`config` holds a URL with the secret. */
function safe(method: string, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e)
  return new Error(`${method}: ${message.replace(/https?:\/\/\S+/g, '<адрес скрыт>')}`)
}

export function connectPortal(hook: string): Portal {
  const b24 = B24Hook.fromWebhookUrl(hook)
  b24.offClientSideWarning()

  return {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      let res
      try {
        res = await b24.actions.v2.call.make({ method, params })
      } catch (e) {
        throw safe(method, e)
      }
      if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ')}`)
      return (res.getData() as { result?: T } | undefined)?.result as T
    }
  }
}
