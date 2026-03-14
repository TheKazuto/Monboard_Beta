/**
 * priceCache.ts — single source of truth for CoinGecko price data.
 *
 * Problem solved:
 *   Previously every API route (token-exposure, defi, mon-price, nfts) made
 *   its own independent CoinGecko call with short TTLs (30–60s). With multiple
 *   concurrent users this multiplied into dozens of calls per minute for the
 *   exact same data.
 *
 * Solution:
 *   One shared cache for ALL price/image/change24h data needed by the project.
 *   A single /coins/markets call fetches every required coin at once.
 *   TTL = 5 minutes — shared across all users and all routes.
 *   In-flight deduplication prevents thundering herd on cache expiry.
 *
 * CoinGecko calls reduced: from ~1/30s per route to ~1/5min total.
 */

// ─── Master coin list ─────────────────────────────────────────────────────────
// All CoinGecko IDs used anywhere in the project.
// Adding a new token here is the only change needed to include it everywhere.
export const ALL_COIN_IDS = [
  'monad',           // MON / WMON / sMON / gMON / shMON / aprMON (all MON-pegged)
  'usd-coin',        // USDC
  'ethereum',        // ETH / WETH
  'tether',          // USDT / USDT0
  'wrapped-bitcoin', // WBTC
  'agora-dollar',    // AUSD
] as const

export type CoinId = typeof ALL_COIN_IDS[number]

// ─── Cache types ──────────────────────────────────────────────────────────────
export interface PriceData {
  prices:    Record<string, number>  // coinId → USD price
  images:    Record<string, string>  // coinId → image URL
  change24h: Record<string, number>  // coinId → 24h % change
  fetchedAt: number
}

// Fallback prices used when CoinGecko is unreachable
const FALLBACK: PriceData = {
  prices: {
    'monad':           0.02,
    'usd-coin':        1.00,
    'ethereum':        2300,
    'tether':          1.00,
    'wrapped-bitcoin': 85000,
    'agora-dollar':    1.00,
  },
  images:    {},
  change24h: {},
  fetchedAt: 0,
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
const PRICE_TTL = 5 * 60 * 1000 // 5 minutes

let cache:   PriceData | null = null
let promise: Promise<PriceData> | null = null

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchFromCoinGecko(): Promise<PriceData> {
  const apiKey  = process.env.COINGECKO_API_KEY
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey

  const ids = ALL_COIN_IDS.join(',')
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?ids=${ids}&vs_currency=usd&per_page=20&price_change_percentage=24h`,
    { headers, cache: 'no-store', signal: AbortSignal.timeout(8_000) }
  )

  if (!res.ok) throw new Error(`CoinGecko ${res.status}`)

  const data: any[] = await res.json()
  const prices:    Record<string, number> = {}
  const images:    Record<string, string> = {}
  const change24h: Record<string, number> = {}

  for (const coin of data) {
    if (!coin.id) continue
    prices[coin.id]    = coin.current_price                  ?? 0
    change24h[coin.id] = coin.price_change_percentage_24h   ?? 0
    if (coin.image) images[coin.id] = coin.image
  }

  return { prices, images, change24h, fetchedAt: Date.now() }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all prices, images and 24h changes for every token used in the project.
 * Results are cached for 5 minutes and shared across all concurrent requests.
 * Falls back to stale data (or hardcoded fallback) if CoinGecko is unreachable.
 */
export async function getAllPrices(): Promise<PriceData> {
  const now = Date.now()

  // Return fresh cache immediately (no await)
  if (cache && now - cache.fetchedAt < PRICE_TTL) return cache

  // Deduplicate concurrent requests — share one in-flight fetch
  if (promise) {
    try { return await promise } catch { /* fall through to stale/fallback */ }
  }

  promise = fetchFromCoinGecko()

  try {
    const data = await promise
    cache   = data
    promise = null
    return data
  } catch (err) {
    promise = null
    // Return stale cache if available, otherwise hardcoded fallback
    if (cache) return cache
    console.error('[priceCache] CoinGecko unreachable, using fallback prices:', err)
    return FALLBACK
  }
}

/**
 * Convenience: get just the MON/USD price + 24h change.
 * Used by /api/mon-price and lib/monad.ts getMonPrice().
 */
export async function getMonPriceData(): Promise<{ price: number; change24h: number; changeAmount: number }> {
  const data  = await getAllPrices()
  const price = data.prices['monad'] ?? FALLBACK.prices['monad']!
  const chg   = data.change24h['monad'] ?? 0
  return {
    price,
    change24h:    chg,
    changeAmount: price - price / (1 + chg / 100),
  }
}

/**
 * Convenience: get just the MON/USD price as a number.
 * Drop-in replacement for the old getMonPrice() in lib/monad.ts.
 */
export async function getMonPrice(): Promise<number> {
  const data = await getAllPrices()
  return data.prices['monad'] ?? FALLBACK.prices['monad']!
}
