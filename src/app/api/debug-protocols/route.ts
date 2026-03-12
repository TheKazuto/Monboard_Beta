import { NextResponse } from 'next/server'

export const revalidate = 0

const BUNDLE_URL = 'https://shmonad.xyz/_next/static/chunks/9815-ef1543b76deda353.js'

async function tryFetch(label: string, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    let body: any = null
    try { body = await res.json() } catch { body = await res.text().catch(() => null) }
    return { label, url, status: res.status, ok: res.ok, body: typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300) }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, body: e.message }
  }
}

export async function GET() {
  // 1. Fetch e analisa o bundle principal
  let bundleAnalysis: any = {}
  try {
    const res = await fetch(BUNDLE_URL, { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
    const text = await res.text()

    // Extrair URLs/endpoints
    const urlMatches = [...text.matchAll(/["'`](https?:\/\/[^"'`\s]{10,})/g)].map(m => m[1])
    const relativeApi = [...text.matchAll(/["'`](\/api\/[^"'`\s]{3,})/g)].map(m => m[1])
    const contracts   = [...text.matchAll(/0x[0-9a-fA-F]{40}/g)].map(m => m[0])

    // Procurar por strings relevantes: apr, apy, staking, rate, reward
    const aprMatches = [...text.matchAll(/.{0,60}(?:apr|apy|staking|stakingRate|reward|yield).{0,60}/gi)]
      .map(m => m[0].trim())
      .filter(s => s.length > 10)
      .slice(0, 20)

    // Procurar function selectors (4 bytes hex)
    const selectors = [...new Set([...text.matchAll(/0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/g)].map(m => m[0]))]

    bundleAnalysis = {
      size: text.length,
      externalUrls: [...new Set(urlMatches)].slice(0, 30),
      relativeApis: [...new Set(relativeApi)].slice(0, 30),
      contracts: [...new Set(contracts)],
      aprRelatedSnippets: aprMatches,
      selectors: selectors.slice(0, 30),
    }
  } catch (e: any) {
    bundleAnalysis = { error: e.message }
  }

  // 2. Testar endpoints REST prováveis do shMonad
  const endpoints = await Promise.all([
    tryFetch('shmonad /api/apr',           'https://shmonad.xyz/api/apr'),
    tryFetch('shmonad /api/stats',         'https://shmonad.xyz/api/stats'),
    tryFetch('shmonad /api/staking',       'https://shmonad.xyz/api/staking'),
    tryFetch('shmonad /api/yield',         'https://shmonad.xyz/api/yield'),
    tryFetch('shmonad /api/v1/apr',        'https://shmonad.xyz/api/v1/apr'),
    tryFetch('api.shmonad.xyz /apr',       'https://api.shmonad.xyz/apr'),
    tryFetch('api.shmonad.xyz /v1/stats',  'https://api.shmonad.xyz/v1/stats'),
    tryFetch('api.shmonad.xyz /v2/apr',    'https://api.shmonad.xyz/v2/apr'),
  ])

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    bundle: bundleAnalysis,
    endpoints,
  })
}
