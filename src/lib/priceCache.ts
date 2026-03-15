/**
 * priceCache.ts — cache unificado de preços CoinGecko.
 *
 * Estratégia de cache em duas camadas (L1 + L2):
 *
 *   L1 — In-memory (módulo-level, ~0ms)
 *       Serve requests dentro do mesmo isolate sem latência.
 *       Reseta em cold starts e é isolado por instância do Worker.
 *
 *   L2 — Cloudflare Workers KV (~5–50ms)
 *       Compartilhado entre todos os isolates e regiões.
 *       Sobrevive a cold starts. Garante que uma nova instância não
 *       precise chamar a CoinGecko se outra já populou o KV recentemente.
 *
 * Fluxo de leitura:
 *   1. In-memory fresco? → retorna imediatamente (L1 hit)
 *   2. KV disponível e com dado fresco? → popula L1 e retorna (L2 hit)
 *   3. Busca na CoinGecko → grava em KV e L1 (miss total)
 *
 * Resultado: com múltiplos isolates rodando, cada isolate faz no máximo
 * 1 chamada à CoinGecko por cold start. O KV garante que isolates novos
 * não precisem buscar na CoinGecko se o dado já está lá.
 */

import { getOptionalRequestContext } from '@opennextjs/cloudflare'

// ─── Master coin list ─────────────────────────────────────────────────────────
export const ALL_COIN_IDS = [
  'monad',           // MON / WMON / sMON / gMON / shMON / aprMON
  'usd-coin',        // USDC
  'ethereum',        // ETH / WETH
  'tether',          // USDT / USDT0
  'wrapped-bitcoin', // WBTC
  'agora-dollar',    // AUSD
] as const

export type CoinId = typeof ALL_COIN_IDS[number]

// ─── Tipos ────────────────────────────────────────────────────────────────────
export interface PriceData {
  prices:    Record<string, number>
  images:    Record<string, string>
  change24h: Record<string, number>
  fetchedAt: number
}

// ─── Fallback hardcoded ───────────────────────────────────────────────────────
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

// ─── TTLs ─────────────────────────────────────────────────────────────────────
const TTL_MS  = 5 * 60 * 1000   // 5 minutos em ms  (comparação com Date.now())
const TTL_SEC = 5 * 60          // 5 minutos em seg  (KV usa segundos)

// ─── L1 — In-memory (por isolate) ────────────────────────────────────────────
let memCache:     PriceData | null = null
let fetchPromise: Promise<PriceData> | null = null

// ─── L2 — Cloudflare Workers KV (global, entre isolates) ─────────────────────
const KV_KEY = 'prices:all'

function getKV(): KVNamespace | null {
  try {
    const ctx = getOptionalRequestContext()
    return (ctx?.env as CloudflareEnv | undefined)?.PRICE_KV ?? null
  } catch {
    // Fora do contexto de request (ex: build time) — retorna null silenciosamente
    return null
  }
}

async function readFromKV(kv: KVNamespace): Promise<PriceData | null> {
  try {
    const raw = await kv.get(KV_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PriceData
    // Valida estrutura mínima para evitar dado corrompido
    if (!data.prices || typeof data.fetchedAt !== 'number') return null
    return data
  } catch {
    return null
  }
}

async function writeToKV(kv: KVNamespace, data: PriceData): Promise<void> {
  try {
    await kv.put(KV_KEY, JSON.stringify(data), { expirationTtl: TTL_SEC })
  } catch (err) {
    // Falha de escrita não deve quebrar a resposta ao usuário
    console.error('[priceCache] KV write failed:', err)
  }
}

// ─── Fetch CoinGecko ──────────────────────────────────────────────────────────
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

  const coins: any[] = await res.json()
  const prices:    Record<string, number> = {}
  const images:    Record<string, string> = {}
  const change24h: Record<string, number> = {}

  for (const coin of coins) {
    if (!coin.id) continue
    prices[coin.id]    = coin.current_price                ?? 0
    change24h[coin.id] = coin.price_change_percentage_24h  ?? 0
    if (coin.image) images[coin.id] = coin.image
  }

  return { prices, images, change24h, fetchedAt: Date.now() }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Retorna preços, imagens e variação 24h de todos os tokens do projeto.
 *
 * Hierarquia de cache: L1 in-memory (0ms) → L2 KV (~10ms) → CoinGecko (~300ms)
 */
export async function getAllPrices(): Promise<PriceData> {
  const now = Date.now()

  // ── L1: in-memory fresco ──────────────────────────────────────────────────
  if (memCache && now - memCache.fetchedAt < TTL_MS) return memCache

  // ── Deduplicação: evita múltiplos fetches simultâneos no mesmo isolate ────
  if (fetchPromise) {
    try { return await fetchPromise } catch { /* segue para fallback */ }
  }

  fetchPromise = (async (): Promise<PriceData> => {
    const kv = getKV()

    // ── L2: KV (compartilhado globalmente) ───────────────────────────────────
    if (kv) {
      const kvData = await readFromKV(kv)
      if (kvData && now - kvData.fetchedAt < TTL_MS) {
        memCache = kvData  // aquece L1 com o dado do KV
        return kvData
      }
    }

    // ── Miss total: busca na CoinGecko ───────────────────────────────────────
    const fresh = await fetchFromCoinGecko()
    memCache = fresh
    if (kv) await writeToKV(kv, fresh)
    return fresh
  })()

  try {
    const result = await fetchPromise
    fetchPromise = null
    return result
  } catch (err) {
    fetchPromise = null
    if (memCache) return memCache  // stale é melhor que erro
    console.error('[priceCache] falha total, usando fallback hardcoded:', err)
    return FALLBACK
  }
}

/**
 * Preço MON + variação 24h. Usado por /api/mon-price.
 */
export async function getMonPriceData(): Promise<{
  price:        number
  change24h:    number
  changeAmount: number
}> {
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
 * Apenas o preço MON em USD.
 * Drop-in replacement para o antigo getMonPrice() de lib/monad.ts.
 */
export async function getMonPrice(): Promise<number> {
  const data = await getAllPrices()
  return data.prices['monad'] ?? FALLBACK.prices['monad']!
}
