import { NextResponse } from 'next/server'

export const revalidate = 0

function apyToApr(apy: number): number {
  return 365 * (Math.pow(1 + apy, 1 / 365) - 1)
}

const UPSHIFT_IGNORE = new Set(['0x792c7c5fb5c996e588b9f4a5fb201c79974e267c'])

export async function GET() {
  // 1. Fetch raw
  let raw: any = null
  let fetchError: string | null = null
  let fetchStatus = 0

  try {
    const res = await fetch('https://app.upshift.finance/api/proxy/vaults', {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    fetchStatus = res.status
    try { raw = await res.json() } catch { raw = await res.text() }
  } catch (e: any) {
    fetchError = e.message
  }

  if (fetchError || !raw) {
    return NextResponse.json({ fetchStatus, fetchError, raw })
  }

  const vaults: any[] = raw?.data ?? []

  // 2. Todos os vaults brutos
  const allVaults = vaults.map(v => ({
    name:        v.name,
    address:     v.address,
    chainId:     v.chainId,
    status:      v.status,
    isVisible:   v.isVisible,
    tvl:         v.latest_reported_tvl,
    apy:         v.apy,
    historical:  v.historical_apy,
    decimals:    v.decimals,
    depositAssets: (v.depositAssets ?? []).map((a: any) => a.symbol),
  }))

  // 3. Filtro passo a passo para Monad
  const step1_monad    = vaults.filter(v => v.chainId === 143)
  const step2_active   = step1_monad.filter(v => v.status === 'active')
  const step3_visible  = step2_active.filter(v => v.isVisible === true)
  const step4_tvl      = step3_visible.filter(v => (v.latest_reported_tvl ?? 0) >= 1_000)
  const step5_noIgnore = step4_tvl.filter(v => !UPSHIFT_IGNORE.has((v.address ?? '').toLowerCase()))
  const step6_hasApy   = step5_noIgnore.filter(v => Number(v.apy?.apy ?? 0) > 0)

  // 4. APR calculado para os que passam todos os filtros
  const results = step6_hasApy.map(v => {
    const baseApy    = Number(v.apy?.apy ?? 0)
    const campaignApy = Number(v.apy?.campaignApy ?? 0)
    const totalApy   = baseApy + (campaignApy > 0 ? campaignApy : 0)
    const apr        = Math.min(apyToApr(totalApy / 100) * 100, 500)
    return {
      name: v.name,
      address: v.address,
      baseApy,
      campaignApy,
      totalApy,
      apr,
      depositAssets: (v.depositAssets ?? []).map((a: any) => a.symbol),
    }
  })

  return NextResponse.json({
    fetchStatus,
    totalVaults: vaults.length,
    filters: {
      step1_monad:    step1_monad.map(v => ({ name: v.name, chainId: v.chainId })),
      step2_active:   step2_active.map(v => ({ name: v.name, status: v.status })),
      step3_visible:  step3_visible.map(v => ({ name: v.name, isVisible: v.isVisible })),
      step4_tvl:      step4_tvl.map(v => ({ name: v.name, tvl: v.latest_reported_tvl })),
      step5_noIgnore: step5_noIgnore.map(v => ({ name: v.name, address: v.address })),
      step6_hasApy:   step6_hasApy.map(v => ({ name: v.name, apy: v.apy?.apy })),
    },
    finalResults: results,
  })
}
