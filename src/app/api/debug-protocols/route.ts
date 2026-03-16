import { NextRequest, NextResponse } from 'next/server'
import { MONAD_RPC as RPC, rpcBatch } from '@/lib/monad'

// ─── Rota de debug — REMOVER antes do deploy final ───────────────────────────
// Acesso: GET /api/debug-curve?address=0x...

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })
  }

  const paddedAddr = address.slice(2).toLowerCase().padStart(64, '0')
  const trace: Record<string, any> = {}

  // ── Step 1: Curve API ────────────────────────────────────────────────────────
  const BASE = 'https://api-core.curve.finance/v1'
  const poolTypes = ['factory-twocrypto', 'factory-stable-ng']

  const poolFetches = await Promise.all(
    poolTypes.map(async t => {
      try {
        const res = await fetch(`${BASE}/getPools/monad/${t}`, {
          signal: AbortSignal.timeout(10_000), cache: 'no-store'
        })
        const json = res.ok ? await res.json() : null
        return { type: t, ok: res.ok, status: res.status, json }
      } catch (e: any) {
        return { type: t, ok: false, error: e?.message ?? String(e) }
      }
    })
  )

  trace.step1_api = poolFetches.map(f => ({
    type:       f.type,
    ok:         f.ok,
    status:     (f as any).status,
    error:      (f as any).error ?? null,
    poolCount:  f.json?.data?.poolData?.length ?? 0,
    // Show first pool structure to verify field names
    firstPool:  f.json?.data?.poolData?.[0]
      ? {
          id:            f.json.data.poolData[0].id,
          name:          f.json.data.poolData[0].name,
          address:       f.json.data.poolData[0].address,
          lpTokenAddress:f.json.data.poolData[0].lpTokenAddress,
          usdTotal:      f.json.data.poolData[0].usdTotal,
          totalSupply:   f.json.data.poolData[0].totalSupply,
          lpTokenPrice:  f.json.data.poolData[0].lpTokenPrice,
          coins:         f.json.data.poolData[0].coins?.map((c: any) => ({ symbol: c.symbol, decimals: c.decimals })),
        }
      : null,
  }))

  const allPools: any[] = []
  for (const f of poolFetches) allPools.push(...(f.json?.data?.poolData ?? []))
  trace.step1_totalPools = allPools.length

  if (allPools.length === 0) {
    return NextResponse.json({ ...trace, done: 'No pools from API' })
  }

  // ── Step 2: balanceOf for each pool's LP token ───────────────────────────────
  const balanceCalls = allPools.map((pool, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_call',
    params: [{ to: pool.lpTokenAddress ?? pool.address, data: '0x70a08231' + paddedAddr }, 'latest'],
  }))

  const rpcRes = await rpcBatch(balanceCalls, 10_000).catch((e: any) => {
    trace.step2_rpc_error = e?.message ?? String(e)
    return [] as any[]
  })

  trace.step2_id_types = rpcRes.slice(0, 3).map((r: any) => ({ id: r.id, id_type: typeof r.id }))

  // Check with both number and string id lookup
  trace.step2_balances = allPools.map((pool, i) => {
    const byNum = rpcRes.find((r: any) => r.id === i)
    const byStr = rpcRes.find((r: any) => r.id === String(i))
    const result = byNum?.result ?? byStr?.result ?? '0x'
    let balance = '0'
    try { balance = result && result !== '0x' ? BigInt(result).toString() : '0' } catch {}
    return {
      pool:           pool.name ?? pool.address,
      lpToken:        pool.lpTokenAddress ?? pool.address,
      found_by_num:   !!byNum,
      found_by_str:   !!byStr,
      raw:            result?.slice(0, 20),
      balance,
      hasBalance:     balance !== '0',
    }
  })

  const poolsWithBalance = allPools.filter((pool, i) => {
    const byNum = rpcRes.find((r: any) => r.id === i)
    const byStr = rpcRes.find((r: any) => r.id === String(i))
    const result = byNum?.result ?? byStr?.result ?? '0x'
    try { return result && result !== '0x' && BigInt(result) > 0n } catch { return false }
  })

  trace.step2_poolsWithBalance = poolsWithBalance.length

  if (poolsWithBalance.length === 0) {
    trace.conclusion = 'No LP balance found in any Curve pool for this address'
    return NextResponse.json(trace)
  }

  // ── Step 3: compute USD value for pools with balance ─────────────────────────
  trace.step3_positions = poolsWithBalance.map((pool, idx) => {
    const i = allPools.indexOf(pool)
    const byNum = rpcRes.find((r: any) => r.id === i)
    const byStr = rpcRes.find((r: any) => r.id === String(i))
    const result = byNum?.result ?? byStr?.result ?? '0x'
    let balanceRaw = 0n
    try { balanceRaw = BigInt(result) } catch {}
    const totalSupplyRaw = BigInt(pool.totalSupply ?? '0')
    const lpPrice        = Number(pool.lpTokenPrice ?? 0)
    const userFloat      = Number(balanceRaw) / 1e18
    const netValueUSD    = lpPrice > 0
      ? userFloat * lpPrice
      : totalSupplyRaw > 0n
        ? (Number(balanceRaw) / Number(totalSupplyRaw)) * Number(pool.usdTotalExcludingBasePool ?? pool.usdTotal ?? 0)
        : 0
    return {
      pool:         pool.name ?? pool.address,
      address:      pool.address,
      balance:      userFloat,
      lpTokenPrice: lpPrice,
      totalSupply:  totalSupplyRaw.toString(),
      usdTotal:     pool.usdTotal,
      netValueUSD,
      coins:        pool.coins?.map((c: any) => c.symbol),
      aboveThreshold: netValueUSD >= 0.01,
    }
  })

  trace.conclusion = trace.step3_positions.some((p: any) => p.aboveThreshold)
    ? 'Has positions above $0.01 threshold'
    : 'All positions below $0.01 threshold (check netValueUSD calculation)'

  return NextResponse.json(trace)
}
