import { NextResponse } from 'next/server'

export const revalidate = 0

export async function GET() {
  const results: Record<string, any> = {}

  // ── 1. Raw Floppy API response ────────────────────────────────────────────
  try {
    const res = await fetch('https://api.floppy-backup.com/v1/monad/native_apy', {
      signal: AbortSignal.timeout(6_000),
      cache: 'no-store',
    })
    results.floppy_status = res.status
    if (res.ok) {
      const data = await res.json()
      results.floppy_raw = data

      // Build map and compute APR conversions
      const conversions: Record<string, any> = {}
      for (const entry of (data.native_apy ?? [])) {
        const sym = String(entry.symbol ?? '').toUpperCase()
        const apy = Number(entry.apy ?? 0)
        // apyToApr: original function expects decimal → result is decimal APR
        // usage: apyToApr(apy / 100) * 100 → APR in %
        const aprPct = apy > 0
          ? (365 * (Math.pow(1 + apy / 100, 1 / 365) - 1)) * 100
          : 0
        conversions[sym] = {
          apy_pct: apy,
          apr_pct: Number(aprPct.toFixed(4)),
        }
      }
      results.floppy_conversions = conversions
    } else {
      results.floppy_error = await res.text()
    }
  } catch (e: any) {
    results.floppy_exception = e?.message ?? String(e)
  }

  // ── 2. Merkl Curvance API ─────────────────────────────────────────────────
  try {
    const res = await fetch(
      'https://api.merkl.xyz/v4/opportunities?items=100&tokenTypes=TOKEN&mainProtocolId=curvance&action=LEND&chainId=143',
      { signal: AbortSignal.timeout(8_000), cache: 'no-store' }
    )
    results.merkl_status = res.status
    if (res.ok) {
      const data: any[] = await res.json()
      const live = data.filter((o: any) => o.status === 'LIVE' && Number(o.apr) > 0)
      results.merkl_live_count = live.length
      results.merkl_live = live.map((o: any) => ({
        name: o.name,
        apr: o.apr,
        status: o.status,
        tokens: (o.tokens ?? []).map((t: any) => ({ symbol: t.symbol, verified: t.verified })),
      }))
    }
  } catch (e: any) {
    results.merkl_exception = e?.message ?? String(e)
  }

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
