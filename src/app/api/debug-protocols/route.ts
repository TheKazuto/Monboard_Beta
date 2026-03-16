import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

// GET /api/debug-kuru?address=0x...
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address) return NextResponse.json({ error: 'Pass ?address=0x...' })
  const upad = address.slice(2).toLowerCase().padStart(64, '0')
  const trace: any = {}

  // 1. Test Kuru API accessibility
  try {
    const r = await fetch('https://api.kuru.io/api/v2/vaults', {
      signal: AbortSignal.timeout(8_000), cache: 'no-store',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    })
    trace.api_status = r.status
    trace.api_ok = r.ok
    if (r.ok) {
      const d = await r.json()
      trace.api_vault_count = d?.data?.data?.length ?? 0
      trace.api_vault_addrs = (d?.data?.data ?? []).map((v: any) => v.vaultaddress)
    } else {
      trace.api_body = await r.text().catch(() => '')
    }
  } catch (e: any) {
    trace.api_error = e?.message
  }

  // 2. Test legacy vaults directly
  const legacyVaults = [
    { address: '0x4869a4c7657cef5e5496c9ce56dde4cd593e4923', name: 'MON/AUSD' },
    { address: '0xd0f8a6422ccdd812f29d8fb75cf5fcd41483badc', name: 'MON/USDC' },
  ]

  const calls = legacyVaults.flatMap((v, i) => [
    { jsonrpc: '2.0', id: i*3,   method: 'eth_call', params: [{ to: v.address, data: '0x70a08231' + upad }, 'latest'] },
    { jsonrpc: '2.0', id: i*3+1, method: 'eth_call', params: [{ to: v.address, data: '0x18160ddd' },         'latest'] },
    { jsonrpc: '2.0', id: i*3+2, method: 'eth_call', params: [{ to: v.address, data: '0xe04d89da' },         'latest'] },
  ])
  const results = await rpcBatch(calls)
  const id_map: Record<number, string> = {}
  for (const r of results) id_map[Number((r as any).id)] = (r as any).result ?? ''

  trace.legacy_vaults = legacyVaults.map((v, i) => {
    const bal = id_map[i*3] ?? ''; const sup = id_map[i*3+1] ?? ''; const nav = id_map[i*3+2] ?? ''
    const shares = bal && bal !== '0x' ? parseInt(bal, 16) : 0
    const supply = sup && sup !== '0x' ? parseInt(sup, 16) : 0
    const navSlot1 = nav && nav.length >= 130 ? parseInt(nav.slice(66, 130), 16) : 0
    const usd = supply > 0 ? (shares / supply) * navSlot1 / 1e6 : 0
    return { name: v.name, address: v.address, shares, supply, navRaw: nav, navSlot1, usd }
  })

  return NextResponse.json(trace)
}
