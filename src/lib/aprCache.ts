/**
 * lib/aprCache.ts
 *
 * Shared in-memory APR cache — populated by best-aprs/route.ts,
 * consumed by defi/route.ts without any HTTP self-call.
 *
 * Both routes live in the same Cloudflare Worker isolate and share
 * module-level state, so this cache bridges them at zero latency.
 *
 * Flow:
 *   best-aprs GET  →  fetchAllData()  →  setAprCache(entries)
 *   defi      GET  →  ensureWarm()   →  getAprEntries() → inject APRs
 *
 * If defi is called first (cold cache), ensureWarm() triggers fetchAllData()
 * directly — no HTTP self-call, no duplication, single source of truth.
 */

export interface AprCacheEntry {
  protocol: string
  tokens:   string[]
  label:    string
  apr:      number
}

const TTL = 4 * 60 * 1000  // 4 min — slightly longer than best-aprs own 3-min cache

let cache:          { entries: AprCacheEntry[]; ts: number } | null = null
let warmingPromise: Promise<void> | null = null

/** Called by best-aprs/route.ts after building the full entry list. */
export function setAprCache(entries: AprCacheEntry[]): void {
  cache = { entries, ts: Date.now() }
}

/**
 * Returns cached entries if fresh, null otherwise.
 * Prefer ensureWarm() when you need data guaranteed.
 */
export function getAprEntries(): AprCacheEntry[] | null {
  if (!cache) return null
  if (Date.now() - cache.ts > TTL) return null
  return cache.entries
}

/**
 * Ensures the APR cache is warm before returning.
 *
 * If cache is already fresh — returns immediately (fast path).
 * If cache is cold or stale — calls fetchAllData() from best-aprs/route.ts
 * to warm it. Concurrent callers share a single in-flight promise so
 * fetchAllData() is never called more than once simultaneously.
 */
export async function ensureWarm(): Promise<void> {
  if (getAprEntries()) return

  if (warmingPromise) {
    await warmingPromise
    return
  }

  warmingPromise = (async () => {
    try {
      const { fetchAllData } = await import('@/app/api/best-aprs/route')
      await fetchAllData()
    } catch {
      // Warming failed — positions will show apy: 0, ok on next request.
    } finally {
      warmingPromise = null
    }
  })()

  await warmingPromise
}
