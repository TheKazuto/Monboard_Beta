/**
 * serverCache.ts — cache genérico para respostas de API routes.
 *
 * Mesma estratégia de 2 camadas do priceCache:
 *   L1 — In-memory por isolate (0ms, reseta em cold starts)
 *   L2 — Cloudflare Workers KV (global, sobrevive a cold starts)
 *
 * Usado por: /api/top-tokens, /api/exchange-rates, /api/portfolio-history
 */

import { getOptionalRequestContext } from '@opennextjs/cloudflare'

interface CacheEntry<T> {
  data:      T
  fetchedAt: number
  promise:   Promise<T> | null
}

// ─── L1 — In-memory ───────────────────────────────────────────────────────────
const store = new Map<string, CacheEntry<any>>()

// ─── L2 — KV ─────────────────────────────────────────────────────────────────
function getKV(): KVNamespace | null {
  try {
    const ctx = getOptionalRequestContext()
    return (ctx?.env as CloudflareEnv | undefined)?.PRICE_KV ?? null
  } catch {
    return null
  }
}

async function kvGet<T>(key: string): Promise<T | null> {
  const kv = getKV()
  if (!kv) return null
  try {
    const raw = await kv.get(`cache:${key}`)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function kvSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const kv = getKV()
  if (!kv) return
  try {
    const ttlSec = Math.max(60, Math.floor(ttlMs / 1000))
    await kv.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttlSec })
  } catch (err) {
    console.error(`[serverCache] KV write failed for key "${key}":`, err)
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Get-or-fetch com cache em 2 camadas.
 *
 * @param key     Chave única (ex: 'top-tokens', 'price-history:monad:30')
 * @param fetcher Função async que produz o dado fresco
 * @param ttlMs   TTL em milissegundos
 */
export async function cached<T>(
  key:     string,
  fetcher: () => Promise<T>,
  ttlMs:   number,
): Promise<T> {
  const entry = store.get(key) as CacheEntry<T> | undefined
  const now   = Date.now()

  // ── L1: in-memory fresco ────────────────────────────────────────────────
  if (entry && !entry.promise && now - entry.fetchedAt < ttlMs) {
    return entry.data
  }

  // ── Deduplicação de requests em voo ────────────────────────────────────
  if (entry?.promise) {
    return entry.promise
  }

  // ── Inicia fetch ────────────────────────────────────────────────────────
  const promise: Promise<T> = (async () => {
    // ── L2: KV ──────────────────────────────────────────────────────────
    const kvData = await kvGet<{ data: T; fetchedAt: number }>(key)
    if (kvData && now - kvData.fetchedAt < ttlMs) {
      // Aquece L1 com dado do KV
      store.set(key, { data: kvData.data, fetchedAt: kvData.fetchedAt, promise: null })
      return kvData.data
    }

    // ── Miss total: executa fetcher ──────────────────────────────────────
    const data = await fetcher()
    const fetchedAt = Date.now()
    store.set(key, { data, fetchedAt, promise: null })
    // Grava no KV com o timestamp incluído para verificação de freshness
    await kvSet(key, { data, fetchedAt }, ttlMs)
    return data
  })()

  // Regista promise para deduplicação
  store.set(key, {
    data:      entry?.data ?? (null as any),
    fetchedAt: entry?.fetchedAt ?? 0,
    promise,
  })

  try {
    return await promise
  } catch (err) {
    // Limpa promise e tenta retornar dado stale
    const current = store.get(key)
    if (current) store.set(key, { ...current, promise: null })
    if (entry?.data != null) return entry.data
    throw err
  }
}
