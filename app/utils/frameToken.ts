// Freshness of the frame token before a request to our server. Pure function — tested in node.

/** Margin before token expiry: refresh ahead of time so it doesn't die en route to the server and portal. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000

/** Whether the frame token needs refreshing. SDK's `expires` is epoch seconds (frame/auth.mjs, package 2.2.0). */
export function tokenNeedsRefresh(auth: false | { expires: number }, nowMs = Date.now()): boolean {
  return !auth || auth.expires * 1000 - nowMs < TOKEN_REFRESH_MARGIN_MS
}
