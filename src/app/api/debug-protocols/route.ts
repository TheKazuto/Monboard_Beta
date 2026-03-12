import { NextResponse } from 'next/server'

export const revalidate = 0

const MONAD_RPC = 'https://rpc.monad.xyz'
const SHMON = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c'
const BLOCKS_PER_DAY = 172_800

async function rpc(method: string, params: any[]) {
  const res = await fetch(MONAD_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(6_000),
    cache: 'no-store',
  }).then(r => r.json())
  return res?.result ?? null
}

const PAD18 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000'

async function call(data: string, block = 'latest') {
  return rpc('eth_call', [{ to: SHMON, data }, block])
}

export async function GET() {
  const blockHex = await rpc('eth_blockNumber', [])
  const currentBlock = parseInt(blockHex, 16)

  const b1d = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY).toString(16)
  const b3d = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY * 3).toString(16)
  const b7d = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY * 7).toString(16)

  const SEL = '0x07a2d13a' + PAD18 // convertToAssets(1e18)

  const [
    ppsNow, pps1d, pps3d, pps7d,
    totalAssets, totalSupply, decimals, asset,
  ] = await Promise.all([
    call(SEL, 'latest'),
    call(SEL, b1d),
    call(SEL, b3d),
    call(SEL, b7d),
    call('0x01e1d114'), // totalAssets()
    call('0x18160ddd'), // totalSupply()
    call('0x313ce567'), // decimals()
    call('0x38d52e0f'), // asset()
  ])

  const toNum = (h: string | null) =>
    h && h !== '0x' && h.length > 2 ? Number(BigInt(h)) / 1e18 : null

  const now = toNum(ppsNow)
  const d1  = toNum(pps1d)
  const d3  = toNum(pps3d)
  const d7  = toNum(pps7d)

  const apr = (base: number | null, old: number | null, days: number) =>
    base && old && base !== old ? ((base - old) / old) / days * 365 * 100 : null

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    contract: SHMON,
    currentBlock,
    pps: { now, d1, d3, d7 },
    apr: {
      '1d': apr(now, d1, 1),
      '3d': apr(now, d3, 3),
      '7d': apr(now, d7, 7),
    },
    raw: {
      ppsNow, pps1d, pps3d, pps7d,
      totalAssets, totalSupply,
      decimals: decimals ? parseInt(decimals, 16) : null,
      asset,
    },
  })
}
