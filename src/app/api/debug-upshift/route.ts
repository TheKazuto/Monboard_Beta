import { NextResponse } from 'next/server'

export const revalidate = 0

async function tryHeaders(label: string, headers: Record<string, string>) {
  try {
    const res = await fetch('https://app.upshift.finance/api/proxy/vaults', {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      headers,
    })
    let body: any = null
    try { body = await res.json() } catch { body = await res.text().catch(() => null) }
    return { label, status: res.status, ok: res.ok, bodyPreview: JSON.stringify(body)?.slice(0, 200) }
  } catch (e: any) {
    return { label, status: 0, ok: false, bodyPreview: e.message }
  }
}

export async function GET() {
  const results = await Promise.all([
    tryHeaders('no headers', {}),

    tryHeaders('user-agent only', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    }),

    tryHeaders('referer + origin', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer':    'https://app.upshift.finance/',
      'Origin':     'https://app.upshift.finance',
    }),

    tryHeaders('full browser headers', {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept':          'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         'https://app.upshift.finance/',
      'Origin':          'https://app.upshift.finance',
      'sec-fetch-site':  'same-origin',
      'sec-fetch-mode':  'cors',
    }),

    // Tentar outros endpoints com os mesmos headers
    tryHeaders('sdk/vaults-metadata with headers', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer':    'https://app.upshift.finance/',
      'Origin':     'https://app.upshift.finance',
    }),
  ])

  // Ultimo item foi o vaults-metadata, separar
  const vaultsMetadata = results.pop()

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    proxyVaults: results,
    sdkMetadata: { ...vaultsMetadata, url: 'https://app.upshift.finance/api/sdk/vaults-metadata' },
  })
}
