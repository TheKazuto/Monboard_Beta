/**
 * monad.ts — shared utilities for Monad Mainnet RPC and CoinGecko price fetching.
 *
 * Centralises:
 *  - MONAD_RPC constant (was repeated in 5 API routes)
 *  - rpcBatch() helper (was copied into defi, nfts, token-exposure routes)
 *  - KNOWN_TOKENS list (was duplicated between token-exposure and portfolio-history,
 *    with a coingeckoId inconsistency for WBTC)
 *  - getMonPrice() with a 60-second in-memory cache (eliminates duplicate
 *    CoinGecko calls from /api/defi and /api/nfts firing in parallel)
 */

// ─── RPC ─────────────────────────────────────────────────────────────────────

export const MONAD_RPC = 'https://rpc.monad.xyz'

/**
 * Send a JSON-RPC batch to the Monad node.
 * @param calls  Array of JSON-RPC call objects
 * @param timeoutMs  AbortSignal timeout in ms (default 15 000)
 */
export async function rpcBatch(calls: object[], timeoutMs = 15_000): Promise<any[]> {
  if (!calls.length) return []
  const res = await fetch(MONAD_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(calls),
    cache:   'no-store',
    signal:  AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json()
  return Array.isArray(data) ? data : [data]
}

// ─── balanceOf call builder ───────────────────────────────────────────────────

/** Build a JSON-RPC eth_call object for ERC-20 balanceOf(walletAddress). */
export function buildBalanceOfCall(
  tokenContract: string,
  walletAddress:  string,
  id:             string | number = tokenContract,
) {
  const paddedAddress = walletAddress.slice(2).toLowerCase().padStart(64, '0')
  return {
    jsonrpc: '2.0',
    method:  'eth_call',
    params:  [{ to: tokenContract, data: '0x70a08231' + paddedAddress }, 'latest'],
    id,
  }
}

// ─── KNOWN_TOKENS ─────────────────────────────────────────────────────────────
// Single authoritative list used by both /api/token-exposure and
// /api/portfolio-history (previously two copies with a WBTC coingeckoId
// inconsistency: 'bitcoin' vs 'wrapped-bitcoin').

export interface KnownToken {
  symbol:      string
  name:        string
  contract:    string
  decimals:    number
  coingeckoId: string
  color:       string
}

export const KNOWN_TOKENS: KnownToken[] = [
  {
    symbol:      'USDC',
    name:        'USD Coin',
    contract:    '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
    decimals:    6,
    coingeckoId: 'usd-coin',
    color:       '#2775CA',
  },
  {
    symbol:      'WETH',
    name:        'Wrapped ETH',
    contract:    '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242',
    decimals:    18,
    coingeckoId: 'weth',
    color:       '#627EEA',
  },
  {
    symbol:      'USDT',
    name:        'Tether USD',
    contract:    '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
    decimals:    6,
    coingeckoId: 'tether',
    color:       '#26A17B',
  },
  {
    symbol:      'WBTC',
    name:        'Wrapped BTC',
    contract:    '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    decimals:    8,
    coingeckoId: 'wrapped-bitcoin',
    color:       '#F7931A',
  },
  {
    symbol:      'WMON',
    name:        'Wrapped MON',
    contract:    '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    decimals:    18,
    coingeckoId: 'monad',
    color:       '#836EF9',
  },
  {
    symbol:      'AUSD',
    name:        'Agora USD',
    contract:    '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    decimals:    6,
    coingeckoId: 'agora-dollar',
    color:       '#FF6B35',
  },
]

// ─── MON price (shared, cached) ───────────────────────────────────────────────
// Eliminates duplicate CoinGecko calls when /api/defi and /api/nfts are
// triggered in parallel (e.g. on wallet connect via PortfolioContext).

interface PriceEntry {
  price:     number
  fetchedAt: number
}

const MON_PRICE_TTL = 60_000 // 60 seconds
let monPriceCache: PriceEntry | null = null

/**
 * Fetch the current MON/USD price from CoinGecko.
 * Results are cached for 60 seconds so concurrent route handlers
 * (e.g. /api/defi + /api/nfts firing in parallel) share one upstream call.
 */
export async function getMonPrice(): Promise<number> {
  const now = Date.now()
  if (monPriceCache && now - monPriceCache.fetchedAt < MON_PRICE_TTL) {
    return monPriceCache.price
  }
  try {
    const apiKey   = process.env.COINGECKO_API_KEY
    const cgHeaders: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) cgHeaders['x-cg-demo-api-key'] = apiKey
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd',
      { headers: cgHeaders, cache: 'no-store' },
    )
    const d     = await res.json()
    const price = (d?.monad?.usd as number) ?? 0
    monPriceCache = { price, fetchedAt: now }
    return price
  } catch {
    return monPriceCache?.price ?? 0
  }
}
