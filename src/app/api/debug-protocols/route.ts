import { NextResponse } from 'next/server'

export const revalidate = 0

const GQL = 'https://kintsu.xyz/api/graphql'

const QUERY = `{
  Protocol_LST_Analytics_Day(
    where: { chainId: { _eq: 143 } }
    order_by: { date: desc }
    limit: 8
  ) { date totalRewards totalPooledStaked }
}`

async function tryGql(label: string, headers: Record<string, string>, body: any) {
  try {
    const res = await fetch(GQL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    let data: any = null
    const text = await res.text()
    try { data = JSON.parse(text) } catch { data = text.slice(0, 300) }
    return { label, status: res.status, ok: res.ok, data }
  } catch (e: any) {
    return { label, status: 0, ok: false, data: e.message }
  }
}

// Tentar também GET para ver se há endpoint REST
async function tryGet(label: string, url: string) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    })
    let data: any = null
    try { data = await res.json() } catch { data = await res.text().catch(() => null) }
    return { label, status: res.status, ok: res.ok, data: JSON.stringify(data)?.slice(0, 500) }
  } catch (e: any) {
    return { label, status: 0, ok: false, data: e.message }
  }
}

export async function GET() {
  const results = await Promise.all([
    // Variações de headers para o GraphQL
    tryGql('json only', { 'Content-Type': 'application/json' }, { query: QUERY }),

    tryGql('with accept', {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, { query: QUERY }),

    tryGql('with browser headers', {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Origin': 'https://kintsu.xyz',
      'Referer': 'https://kintsu.xyz/earn',
    }, { query: QUERY }),

    tryGql('with operationName', {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, { query: QUERY, operationName: null, variables: {} }),

    // Tentar Hasura endpoint alternativo (Kintsu usa Hasura pelo formato da query)
    tryGql('hasura endpoint', {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, { query: QUERY }),

    // GET endpoints REST alternativos da Kintsu
    tryGet('kintsu /api/stats',     'https://kintsu.xyz/api/stats'),
    tryGet('kintsu /api/apr',       'https://kintsu.xyz/api/apr'),
    tryGet('kintsu /api/analytics', 'https://kintsu.xyz/api/analytics'),
    tryGet('kintsu /api/lst',       'https://kintsu.xyz/api/lst'),
  ])

  return NextResponse.json({ timestamp: new Date().toISOString(), results })
}
