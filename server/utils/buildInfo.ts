// Which build is running — for GET /api/health. The commit is baked into the image by CI
// (Dockerfile, ARG COMMIT_SHA): from it the server shows whether Watchtower has rolled out the
// new image, and which `sha-<7 chars>` tag to roll back to (docs/DEPLOY.md, "Rollback").

/** How many commit characters we expose: same length as in the `sha-…` image tag (docker/metadata-action). */
export const SHORT_SHA = 7

/**
 * Short build commit from the environment. Only a full git SHA (40 hex characters) is accepted;
 * exposed externally are just the first {@link SHORT_SHA}: health is open without login, so we
 * never return an arbitrary string from the variable (in case something else ended up there by
 * mistake) nor the full version fingerprint (security review on #16) — the short form is enough
 * to find the `sha-…` tag to roll back to.
 *
 * @returns 7 lowercase SHA characters, or `null` if unset (local build) or not SHA-shaped
 */
export function buildCommit(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? ''
  return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, SHORT_SHA) : null
}
