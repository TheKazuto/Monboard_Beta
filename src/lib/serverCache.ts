/**
 * serverCache — in-memory cache for API route responses.
 *
 * Replaces Next.js ISR (`export const revalidate = N` / `next: { revalidate: N }`)
 * which is NOT supported on Cloudflare Pages/Workers.
 *
 * Module-level variables persist across requests within the same CF Worker isolate,
 * providing best-effort caching similar to Vercel serverless warm instances.
 *
 * Features:
 *  - TTL-based expiration
 *  - In-flight request deduplication (prevents thundering herd)
 *  - Stale fallback on error
 */

interface CacheEntry<T> {
  data:      T
  fetchedAt: number
  promise:   Promise<T> | null
}

const store = new Map<string, CacheEntry<any>>()

/**
 * Get-or-fetch with caching and dedup.
 * @param key       Unique cache key (e.g. 'mon-price', 'exchange-rates')
 * @param fetcher   Async function that produces fresh data
 * @param ttlMs     Time-to-live in milliseconds
 */
export async function cached<T>(
  key:     string,
  fetcher: () => Promise<T>,
  ttlMs:   number,
): Promise<T> {
  const entry = store.get(key) as CacheEntry<T> | undefined
  const now   = Date.now()

  // Return cached data if fresh
  if (entry && !entry.promise && now - entry.fetchedAt < ttlMs) {
    return entry.data
  }

  // Deduplicate in-flight requests
  if (entry?.promise) {
    return entry.promise
  }

  // Fire new fetch
  const promise = fetcher()

  store.set(key, {
    data:      entry?.data ?? (null as any),
    fetchedAt: entry?.fetchedAt ?? 0,
    promise,
  })

  try {
    const data = await promise
    store.set(key, { data, fetchedAt: Date.now(), promise: null })
    return data
  } catch (err) {
    // Clear promise so next request retries
    const current = store.get(key)
    if (current) store.set(key, { ...current, promise: null })
    // Return stale data if available
    if (entry?.data) return entry.data
    throw err
  }
}
