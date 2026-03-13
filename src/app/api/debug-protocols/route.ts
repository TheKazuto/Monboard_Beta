import { NextResponse } from 'next/server'

export const revalidate = 0

function apyToApr(apy: number): number {
  if (apy <= 0) return 0
  return 365 * (Math.pow(1 + apy, 1 / 365) - 1)
}

export async function GET() {
  const result: any = {}

  // ── Step 1: raw fetch ────────────────────────────────────────────────────
  let rawBody: any = null
  let fetchStatus = 0
  let fetchOk = false
  let fetchError: string | null = null

  try {
    const res = await fetch('https://api.kuru.io/api/v3/vaults', {
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Origin': 'https://www.kuru.io',
        'Referer': 'https://www.kuru.io/',
      },
    })
    fetchStatus = res.status
    fetchOk = res.ok
    try {
      rawBody = await res.json()
    } catch (e: any) {
      fetchError = 'JSON parse failed: ' + e.message
    }
  } catch (e: any) {
    fetchError = 'fetch threw: ' + e.message
  }

  result.step1_fetch = {
    status: fetchStatus,
    ok: fetchOk,
    error: fetchError,
    topLevelKeys: rawBody ? Object.keys(rawBody) : null,
    successField: rawBody?.success,
    dataKeys: rawBody?.data ? Object.keys(rawBody.data) : null,
  }

  // ── Step 2: extract vaults array ─────────────────────────────────────────
  const vaults: any[] = rawBody?.data?.data ?? []
  result.step2_vaults = {
    path: 'raw.data.data',
    count: vaults.length,
    firstVaultKeys: vaults[0] ? Object.keys(vaults[0]) : null,
  }

  // ── Step 3: parse each vault ─────────────────────────────────────────────
  result.step3_parsed = vaults.map((vault: any, i: number) => {
    const apyRaw = vault.apy
    const apyDecimal = parseFloat(String(apyRaw ?? '0'))
    const apyValid = isFinite(apyDecimal) && apyDecimal > 0
    const apr = apyValid ? apyToApr(apyDecimal) * 100 : 0

    const baseSymbol  = String(vault.baseToken?.ticker  ?? vault.baseToken?.name  ?? 'MON')
    const quoteSymbol = String(vault.quoteToken?.ticker ?? vault.quoteToken?.name ?? '')
    const tvl = Number(vault.tvl ?? 0)

    return {
      index: i,
      vaultAddress: vault.vaultAddress,
      apyRaw,
      apyRawType: typeof apyRaw,
      apyDecimal,
      apyValid,
      aprPct: apr > 0 ? `${apr.toFixed(2)}%` : 'ZERO/INVALID',
      tvl,
      baseSymbol,
      quoteSymbol,
      wouldBeIncluded: apyValid && apr > 0,
    }
  })

  // ── Step 4: simulate the filter chain in fetchAllData ────────────────────
  // Simulates: all.filter(e => e.apr > 0) → filter pools → sort → slice(0,10)
  const fakeEntries = result.step3_parsed
    .filter((v: any) => v.wouldBeIncluded)
    .map((v: any) => ({
      protocol: 'Kuru',
      apr: parseFloat(v.aprPct),
      label: `Kuru ${v.baseSymbol} / ${v.quoteSymbol}`,
      type: 'pool',
      isStable: false,
    }))

  result.step4_would_appear = {
    entriesProduced: fakeEntries.length,
    entries: fakeEntries,
    note: fakeEntries.length === 0
      ? 'fetchKuru returns [] — nothing to show'
      : 'fetchKuru produces entries — if not showing, issue is in sort/slice or cache',
  }

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
