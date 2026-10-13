import { env } from './env'
import type { CheckResult } from './mediaPermissions'

// A real reachability probe against the backend's own /healthz — confirmed
// against CLAUDE.md's "Backend contract" section: unprefixed, no /api/v1,
// unauthenticated. Deliberately NOT routed through api/index.ts's configured
// axios instance — that instance's baseURL already includes /api/v1 and its
// interceptors (auth header, 401 refresh) have nothing to do with this
// endpoint, so a plain fetch() is the honest tool here, not a workaround.
// Derived from env.apiBaseUrl's origin (new URL(path, base) resolves a
// leading-slash path against the origin, discarding /api/v1) so this keeps
// working if that path prefix ever changes.
const HEALTHZ_URL = new URL('/health', env.apiBaseUrl).toString()
const TIMEOUT_MS = 5000

export async function checkNetworkStability(): Promise<CheckResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(HEALTHZ_URL, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) {
      return { ok: false, reason: `Backend health check returned ${response.status}.` }
    }
    return { ok: true }
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'Network check timed out — your connection may be unstable.'
        : "Couldn't reach the server — check your internet connection."
    return { ok: false, reason }
  } finally {
    clearTimeout(timeout)
  }
}
