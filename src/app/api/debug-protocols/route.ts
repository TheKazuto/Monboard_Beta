import { NextResponse } from 'next/server'

export async function GET() {
  const results: any = {}

  // Test 1: raw fetch sem headers
  try {
    const r = await fetch(
      'https://api.merkl.xyz/v4/opportunities?items=5&mainProtocolId=curvance&action=LEND&chainId=143',
      { cache: 'no-store', signal: AbortSignal.timeout(10_000) }
    )
    const text = await r.text()
    results.test1_no_headers = {
      status: r.status,
      ok: r.ok,
      bodyPreview: text.slice(0, 300),
      isJSON: text.startsWith('[') || text.startsWith('{'),
    }
  } catch (e: any) {
    results.test1_no_headers = { error: e.message }
  }

  // Test 2: com browser headers
  try {
    const r = await fetch(
      'https://api.merkl.xyz/v4/opportunities?items=5&mainProtocolId=curvance&action=LEND&chainId=143',
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      }
    )
    const text = await r.text()
    results.test2_browser_headers = {
      status: r.status,
      ok: r.ok,
      bodyPreview: text.slice(0, 300),
      isJSON: text.startsWith('[') || text.startsWith('{'),
    }
  } catch (e: any) {
    results.test2_browser_headers = { error: e.message }
  }

  // Test 3: parse JSON and count items
  try {
    const r = await fetch(
      'https://api.merkl.xyz/v4/opportunities?items=100&mainProtocolId=curvance&action=LEND&chainId=143',
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Accept': 'application/json' },
      }
    )
    const raw = await r.json()
    const items: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.opportunities ?? [])
    const live = items.filter((x: any) => x.status === 'LIVE' && Number(x.apr ?? 0) > 0)
    results.test3_parse = {
      status: r.status,
      rawType: Array.isArray(raw) ? 'array' : typeof raw,
      rawTopLevelKeys: Array.isArray(raw) ? null : Object.keys(raw).slice(0, 5),
      totalItems: items.length,
      liveWithApr: live.length,
      firstItem: live[0] ? {
        name: live[0].name,
        apr: live[0].apr,
        status: live[0].status,
        tokenCount: live[0].tokens?.length,
      } : null,
    }
  } catch (e: any) {
    results.test3_parse = { error: e.message }
  }

  // Test 4: check if issue is in the token-finding logic
  try {
    const r = await fetch(
      'https://api.merkl.xyz/v4/opportunities?items=100&mainProtocolId=curvance&action=LEND&chainId=143',
      { cache: 'no-store', signal: AbortSignal.timeout(10_000) }
    )
    const raw = await r.json()
    const data: any[] = Array.isArray(raw) ? raw : (raw?.data ?? [])
    const entries: any[] = []

    for (const opp of data) {
      if (opp.status !== 'LIVE') continue
      const apr = Number(opp.apr ?? 0)
      if (apr <= 0) continue

      const tokens: any[] = opp.tokens ?? []
      const underlying =
        tokens.find((t: any) => !/^c[A-Za-z]/.test(t.symbol ?? '')) ??
        tokens.find((t: any) => t.verified === true) ??
        tokens[0]
      const sym = underlying?.symbol ?? 'TOKEN'

      entries.push({ name: opp.name, apr, sym, tokenSymbols: tokens.map((t: any) => t.symbol) })
    }

    results.test4_full_logic = {
      entriesProduced: entries.length,
      entries: entries.slice(0, 5),
    }
  } catch (e: any) {
    results.test4_full_logic = { error: e.message }
  }

  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-store' } })
}
