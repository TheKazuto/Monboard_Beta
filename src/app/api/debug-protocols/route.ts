import { NextRequest, NextResponse } from 'next/server'

// ─── Debug route — REMOVER antes do deploy final ─────────────────────────────
// Testa o buildAprLookup e mostra o que o Merkl retorna
// GET /api/debug-apr?protocol=Curve&tokens=WMON,shMON,sMON,gMON

const MERKL_API = 'https://api.merkl.xyz/v4/opportunities?chainId=143&status=LIVE&items=300'

const PROTO_MAP: Record<string, string> = {
  curve: 'Curve', uniswap: 'Uniswap V3', pancakeswap: 'PancakeSwap V3',
  morpho: 'Morpho', kintsu: 'Kintsu', magma: 'Magma', shmonad: 'shMonad',
  lagoon: 'Lagoon', kuru: 'Kuru', gearbox: 'GearBox V3', curvance: 'Curvance',
  neverland: 'Neverland', euler: 'Euler V2', upshift: 'Upshift',
}

export async function GET(req: NextRequest) {
  const filterProto  = req.nextUrl.searchParams.get('protocol') ?? ''
  const filterTokens = req.nextUrl.searchParams.get('tokens')?.split(',') ?? []

  const trace: Record<string, any> = {}

  // 1. Fetch Merkl
  let rawData: any[] = []
  try {
    const res = await fetch(MERKL_API, {
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    trace.merkl_status = res.status
    trace.merkl_ok     = res.ok
    if (!res.ok) return NextResponse.json({ ...trace, error: 'Merkl fetch failed' })
    rawData = await res.json()
    trace.merkl_total_entries = Array.isArray(rawData) ? rawData.length : 'NOT_ARRAY'
  } catch (e: any) {
    trace.merkl_error = e?.message ?? String(e)
    return NextResponse.json(trace)
  }

  if (!Array.isArray(rawData)) {
    trace.error = 'Merkl response is not array'
    trace.raw_sample = rawData
    return NextResponse.json(trace)
  }

  // 2. Show all unique protocols in response
  const protocolsInResponse = [...new Set(rawData.map((o: any) =>
    (o.mainProtocol ?? o.protocol ?? 'UNKNOWN').toLowerCase()
  ))].sort()
  trace.protocols_in_response = protocolsInResponse

  // 3. Parse entries (same logic as defi_route.ts)
  const entries = rawData.flatMap((opp: any) => {
    const rawProto = ((opp.mainProtocol ?? opp.protocol) ?? '').toLowerCase()
    const proto    = PROTO_MAP[rawProto] ?? ''
    if (!proto) return []
    const apr = Number(opp.apr ?? 0)
    if (apr <= 0) return []
    const tokens: string[] = (opp.tokens ?? [])
      .filter((t: any) => t.type === 'TOKEN' && !String(t.symbol ?? '').endsWith('-gauge'))
      .map((t: any) => String(t.symbol ?? ''))
      .filter(Boolean)
    const label = String(opp.name ?? opp.identifier ?? tokens.join('/') ?? '')
    return [{ protocol: proto, tokens, label, apr, rawProto, identifier: opp.identifier }]
  })

  trace.parsed_entries_count = entries.length
  trace.parsed_entries_by_protocol = Object.entries(
    entries.reduce((acc: any, e: any) => {
      acc[e.protocol] = (acc[e.protocol] ?? 0) + 1
      return acc
    }, {})
  )

  // 4. Show entries matching the filter
  const proto  = filterProto || 'Curve'
  const matching = entries.filter(e => e.protocol === proto)
  trace[`entries_for_${proto}`] = matching.map(e => ({
    protocol: e.protocol,
    tokens:   e.tokens,
    label:    e.label,
    apr:      e.apr,
    identifier: e.identifier,
  }))

  // 5. Test the exact lookup that defi_route uses
  if (filterTokens.length > 0) {
    const lookupKey = proto + ':' + filterTokens.slice().sort().join('+')
    trace.lookup_key = lookupKey
    const match = matching.find(e =>
      (proto + ':' + e.tokens.slice().sort().join('+')) === lookupKey
    )
    trace.lookup_match = match ?? null
  }

  // 6. Show sample of unrecognised protocols (to expand PROTO_MAP if needed)
  const unrecognised = protocolsInResponse.filter(p => !PROTO_MAP[p])
  trace.unrecognised_protocols = unrecognised

  return NextResponse.json(trace)
}
