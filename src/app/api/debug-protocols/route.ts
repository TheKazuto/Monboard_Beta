import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

// ─── Debug route — REMOVER antes do deploy final ─────────────────────────────
// GET /api/debug-gearbox?address=0x...

const GEARBOX_URL = 'https://state-cache.gearbox.foundation/Monad.json'

function balanceOfData(addr: string) {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}
function decodeUint(hex: string): bigint {
  if (!hex || hex === '0x') return 0n
  try { return BigInt(hex.startsWith('0x') ? hex : '0x' + hex) } catch { return 0n }
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address) return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })

  const trace: Record<string, any> = {}

  // 1. Fetch Gearbox API
  let data: any = null
  try {
    const res = await fetch(GEARBOX_URL, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    trace.api_status = res.status
    trace.api_ok     = res.ok
    if (!res.ok) return NextResponse.json(trace)
    data = await res.json()
  } catch (e: any) {
    trace.api_error = e?.message
    return NextResponse.json(trace)
  }

  const markets: any[] = data?.markets ?? []
  trace.market_count = markets.length

  // 2. Show raw structure of first market
  if (markets[0]) {
    const p = markets[0]?.pool
    trace.first_market_pool_keys = p ? Object.keys(p) : null
    trace.first_pool_baseParams  = p?.baseParams
    trace.first_pool_decimals    = p?.decimals
    trace.first_pool_name        = p?.name
    trace.first_pool_isPaused    = p?.isPaused
    trace.first_pool_supplyRate  = p?.supplyRate
    trace.first_pool_expectedLiq = p?.expectedLiquidity
    trace.first_pool_totalSupply = p?.totalSupply
  }

  // 3. List all pool addresses
  trace.all_pools = markets.map((m: any) => ({
    name:    m?.pool?.name,
    addr:    m?.pool?.baseParams?.addr,
    paused:  m?.pool?.isPaused,
    decimals: m?.pool?.decimals,
    supplyRate: m?.pool?.supplyRate,
    expectedLiq_raw: m?.pool?.expectedLiquidity,
    totalSupply_raw: m?.pool?.totalSupply,
  }))

  // 4. Check balanceOf for each pool address
  const activePools = markets
    .map((m: any) => m?.pool)
    .filter((p: any) => p?.baseParams?.addr)

  if (activePools.length > 0) {
    const calls = activePools.map((p: any, i: number) => ({
      jsonrpc: '2.0', id: i, method: 'eth_call',
      params: [{ to: p.baseParams.addr, data: balanceOfData(address) }, 'latest'],
    }))
    const results = await rpcBatch(calls).catch(() => [])
    trace.balance_results = activePools.map((p: any, i: number) => {
      const r      = results.find((x: any) => Number(x.id) === i)
      const shares = decodeUint(r?.result ?? '0x')
      return {
        name:    p.name,
        addr:    p.baseParams.addr,
        raw:     r?.result,
        shares:  shares.toString(),
        hasBalance: shares > 0n,
      }
    })
  }

  return NextResponse.json(trace)
}
