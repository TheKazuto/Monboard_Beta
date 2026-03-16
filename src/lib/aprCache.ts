/**
 * lib/aprCache.ts
 *
 * Shared in-memory APR cache — populated by best-aprs/route.ts,
 * consumed by defi/route.ts without any HTTP self-call.
 *
 * Works because both routes live in the same Cloudflare Worker instance
 * and share module-level state within a single isolate.
 */

export interface AprCacheEntry {
  protocol: string
  tokens:   string[]
  label:    string
  apr:      number
}

const TTL = 4 * 60 * 1000  // 4 minutes (slightly longer than best-aprs own 3-min cache)

let cache: { entries: AprCacheEntry[]; ts: number } | null = null

/** Called by best-aprs/route.ts after building the full entry list */
export function setAprCache(entries: AprCacheEntry[]): void {
  cache = { entries, ts: Date.now() }
}

/**
 * Returns cached entries, or null if cache is stale / not yet populated.
 * Callers should gracefully degrade (apy = 0) when null is returned.
 */
export function getAprEntries(): AprCacheEntry[] | null {
  if (!cache) return null
  if (Date.now() - cache.ts > TTL) return null
  return cache.entries
}
