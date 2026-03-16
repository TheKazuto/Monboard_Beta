import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

// ─── Debug route — REMOVER antes do deploy final ─────────────────────────────
// GET /api/debug-upshift?address=0x...

const UPSHIFT_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}

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

  // 1. Fetch Upshift API
  let raw: any = null
  try {
    const res = await fetch('https://api.upshift.finance/metrics/vaults_summary', {
      headers: UPSHIFT_API_HEADERS, signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    trace.api_status = res.status
    trace.api_ok     = res.ok
    if (!res.ok) {
      trace.api_body = await res.text().catch(() => '')
      return NextResponse.json(trace)
    }
    raw = await res.json()
    trace.is_array    = Array.isArray(raw)
    trace.total_count = Array.isArray(raw) ? raw.length : 'NOT_ARRAY'
  } catch (e: any) {
    trace.api_error = e?.message
    return NextResponse.json(trace)
  }

  const all: any[] = Array.isArray(raw) ? raw : []

  // 2. Show all unique chain values
  trace.chains_found = [...new Set(all.map((v: any) => v.chain))]

  // 3. Filter for Monad (chain === 143) — also try string '143'
  const byNum = all.filter((v: any) => v.chain === 143)
  const byStr = all.filter((v: any) => v.chain === '143' || v.chain === 143)
  trace.monad_count_strict = byNum.length
  trace.monad_count_loose  = byStr.length

  // 4. Show first vault structure (all keys)
  const monadVaults = byStr.filter((v: any) => !/test|bugbash/i.test(v.vault_name ?? ''))
  trace.monad_vaults_count = monadVaults.length
  if (monadVaults[0]) {
    trace.first_vault_keys = Object.keys(monadVaults[0])
    trace.first_vault      = monadVaults[0]
  }

  if (monadVaults.length === 0) {
    trace.conclusion = 'No Monad vaults found'
    return NextResponse.json(trace)
  }

  // 5. Check balanceOf for each vault
  const calls = monadVaults.map((v: any, i: number) => ({
    jsonrpc: '2.0', id: i + 700, method: 'eth_call',
    params: [{ to: v.address, data: balanceOfData(address) }, 'latest'],
  }))
  const results = await rpcBatch(calls, 12_000).catch(() => [])

  trace.rpc_id_types = results.slice(0, 3).map((r: any) => ({ id: r.id, type: typeof r.id }))

  trace.balances = monadVaults.map((v: any, i: number) => {
    const byNum = results.find((r: any) => r.id === i + 700)
    const byCoerce = results.find((r: any) => Number(r.id) === i + 700)
    const raw = byNum?.result ?? byCoerce?.result ?? '0x'
    const shares = decodeUint(raw)
    const decimals = Number(v.decimals ?? 18)
    const sharesFloat = Number(shares) / Math.pow(10, decimals)
    const ratio = Number(v.asset_share_ratio ?? v.price_per_share ?? v.share_price ?? 1)
    const price = Number(v.underlying_price ?? v.asset_price ?? v.price ?? 0)
    const amountUSD = sharesFloat * ratio * price
    return {
      name:           v.vault_name,
      address:        v.address,
      shares:         shares.toString(),
      sharesFloat,
      hasBalance:     shares > 0n,
      found_by_strict: !!byNum,
      found_by_coerce: !!byCoerce,
      // Show all price-related fields
      asset_share_ratio: v.asset_share_ratio,
      underlying_price:  v.underlying_price,
      price_per_share:   v.price_per_share,
      share_price:       v.share_price,
      asset_price:       v.asset_price,
      price:             v.price,
      '7d_apy':          v['7d_apy'],
      '30d_apy':         v['30d_apy'],
      total_assets:      v.total_assets,
      amountUSD_calculated: amountUSD,
    }
  })

  trace.vaults_with_balance = trace.balances.filter((b: any) => b.hasBalance).length
  trace.conclusion = trace.vaults_with_balance > 0
    ? 'Has balance — check price fields for USD calculation'
    : 'No balance in any Upshift vault for this address'

  return NextResponse.json(trace)
}
