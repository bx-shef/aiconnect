// Who opened the page: a pure decision on top of the `profile` answer, so it is covered by a test.

/**
 * Is the current user a portal administrator. `profile.ADMIN` must be the boolean `true` (the same
 * strict check as server/utils/frameAuth.ts; the template smoke measured it as a boolean). The
 * frame's own `auth.isAdmin` is a fallback for a missing or unexpected answer.
 */
export function isPortalAdmin(profile: unknown, frameIsAdmin: boolean): boolean {
  return (profile as { ADMIN?: unknown } | null | undefined)?.ADMIN === true || frameIsAdmin === true
}
