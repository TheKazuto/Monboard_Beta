import { NextResponse } from 'next/server'

export const revalidate = 0

const KURU_GQL = 'https://www.kuru.io/graphql'

async function tryQuery(label: string, query: string, variables?: any) {
  try {
    const res = await fetch(KURU_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.kuru.io',
        'Referer': 'https://www.kuru.io/markets',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    let data: any = null
    const text = await res.text()
    try { data = JSON.parse(text) } catch { data = text.slice(0, 500) }
    return { label, status: res.status, ok: res.ok, data }
  } catch (e: any) {
    return { label, status: 0, ok: false, data: e.message }
  }
}

async function tryRest(label: string, url: string) {
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.kuru.io',
        'Referer': 'https://www.kuru.io/markets',
      },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    let data: any = null
    try { data = await res.json() } catch { data = await res.text().catch(() => null) }
    return { label, url, status: res.status, ok: res.ok, data: JSON.stringify(data)?.slice(0, 600) }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, data: e.message }
  }
}

export async function GET() {
  const results = await Promise.all([
    // Introspection para descobrir o schema completo
    tryQuery('introspection __schema', `{ __schema { queryType { fields { name description args { name type { name kind ofType { name kind } } } } } } }`),

    // Queries comuns de DEX
    tryQuery('pools query', `{ pools { id token0 token1 fee apr tvl } }`),
    tryQuery('markets query', `{ markets { id baseToken quoteToken apr volume24h liquidity } }`),
    tryQuery('pairs query', `{ pairs { id token0 { symbol } token1 { symbol } volumeUSD reserveUSD } }`),
    tryQuery('poolStats query', `{ poolStats { address apr volume24h tvl } }`),

    // REST endpoints alternativos
    tryRest('kuru /v1/pools',         'https://www.kuru.io/v1/pools'),
    tryRest('kuru /v1/markets',       'https://www.kuru.io/v1/markets'),
    tryRest('kuru /api/pools',        'https://www.kuru.io/api/pools'),
    tryRest('kuru /api/markets',      'https://www.kuru.io/api/markets'),
    tryRest('api.kuru.io /pools',     'https://api.kuru.io/pools'),
    tryRest('api.kuru.io /v1/pools',  'https://api.kuru.io/v1/pools'),
    tryRest('api.kuru.io /markets',   'https://api.kuru.io/markets'),
  ])

  return NextResponse.json({ timestamp: new Date().toISOString(), results })
}
