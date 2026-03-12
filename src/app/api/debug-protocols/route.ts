import { NextResponse } from 'next/server'

export const revalidate = 0

const BUNDLE_URL = 'https://www.kuru.io/_next/static/chunks/5651de16-c52e8051e429c794.js'

async function tryRest(label: string, url: string) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'Origin': 'https://www.kuru.io' },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    let data: any = null
    try { data = await res.json() } catch { data = await res.text().catch(() => '') }
    return { label, url, status: res.status, ok: res.ok, body: JSON.stringify(data)?.slice(0, 400) }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, body: e.message }
  }
}

export async function GET() {
  // 1. Fetch e analisa o bundle onde foi encontrado /v1/sdk/start
  let bundleAnalysis: any = {}
  try {
    const res = await fetch(BUNDLE_URL, { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
    const text = await res.text()

    // Extrair todas as URLs externas (https://)
    const externalUrls = [...new Set(
      [...text.matchAll(/["'`](https?:\/\/[^"'`\s\\]{8,})/g)].map(m => m[1])
    )].filter(u => !u.includes('w3.org') && !u.includes('svg'))

    // Procurar contexto ao redor de /v1/sdk/start e outros /v1/ endpoints
    const v1Contexts = [...text.matchAll(/.{0,120}\/v1\/[^"'`\s]{2,}.{0,120}/g)]
      .map(m => m[0].trim())
      .slice(0, 15)

    // Procurar por baseUrl, apiUrl, endpoint patterns
    const baseUrlPatterns = [...text.matchAll(/.{0,60}(?:baseUrl|apiUrl|apiBase|endpoint|backendUrl|kuruApi|KURU_API|API_URL).{0,80}/gi)]
      .map(m => m[0].trim())
      .slice(0, 20)

    // Procurar domínios kuru
    const kuruDomains = [...new Set(
      [...text.matchAll(/["'`](https?:\/\/[^"'`\s]*kuru[^"'`\s]*)/gi)].map(m => m[1])
    )]

    // Procurar por "pools", "markets", "apr" em contexto de fetch
    const fetchContexts = [...text.matchAll(/.{0,80}fetch\(.{0,120}/g)]
      .map(m => m[0].trim())
      .filter(s => s.includes('pool') || s.includes('market') || s.includes('apr') || s.includes('v1'))
      .slice(0, 15)

    bundleAnalysis = {
      size: text.length,
      externalUrls: externalUrls.slice(0, 20),
      kuruDomains,
      v1Contexts,
      baseUrlPatterns,
      fetchContexts,
    }
  } catch (e: any) {
    bundleAnalysis = { error: e.message }
  }

  // 2. Testar subdomínios e paths alternativos da Kuru
  const endpoints = await Promise.all([
    tryRest('kuru backend /v1/sdk/start', 'https://www.kuru.io/v1/sdk/start'),
    tryRest('api.kuru.io root',           'https://api.kuru.io/'),
    tryRest('api.kuru.io /v1',            'https://api.kuru.io/v1'),
    tryRest('backend.kuru.io',            'https://backend.kuru.io/'),
    tryRest('data.kuru.io',               'https://data.kuru.io/'),
    tryRest('kuru.io /v1/pools',          'https://kuru.io/v1/pools'),
    tryRest('kuru /api/v1/markets',       'https://www.kuru.io/api/v1/markets'),
  ])

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    bundleAnalysis,
    endpoints,
  })
}
