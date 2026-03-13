import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

async function testEndpoint(label: string, url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      headers: { 'Accept': 'application/json', ...headers },
    })
    const text = await res.text()
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch {}

    return {
      label,
      status: res.status,
      ok: res.ok,
      bodySnippet: text.slice(0, 600),
      vaultCount: parsed?.data?.data?.length ?? null,
      vaults: parsed?.data?.data?.map((v: any) => ({
        vaultAddress: v.vaultAddress,
        apy: v.apy,
        tvl: v.tvl,
        baseToken: v.baseToken?.ticker ?? v.baseToken?.name,
        quoteToken: v.quoteToken?.ticker ?? v.quoteToken?.name,
        aprPct: v.apy
          ? `${((Math.pow(1 + Number(v.apy), 1 / 365) - 1) * 365 * 100).toFixed(2)}%`
          : null,
      })) ?? null,
    }
  } catch (e: any) {
    return { label, error: e?.message ?? String(e) }
  }
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Origin': 'https://www.kuru.io',
  'Referer': 'https://www.kuru.io/',
}

export async function GET() {
  const results = await Promise.allSettled([
    testEndpoint('v3/vaults — sem headers', 'https://api.kuru.io/api/v3/vaults'),
    testEndpoint('v3/vaults — browser headers', 'https://api.kuru.io/api/v3/vaults', BROWSER_HEADERS),
    testEndpoint('v2/vaults — browser headers', 'https://api.kuru.io/api/v2/vaults', BROWSER_HEADERS),
    testEndpoint('merkl — kuru chainId=143', 'https://api.merkl.xyz/v4/opportunities?mainProtocolId=kuru&chainId=143'),
  ])

  return NextResponse.json({
    ts: new Date().toISOString(),
    results: results.map(r => r.status === 'fulfilled' ? r.value : { error: (r as any).reason?.message }),
  })
}
