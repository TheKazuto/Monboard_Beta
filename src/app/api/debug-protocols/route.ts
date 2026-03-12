import { NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

export const revalidate = 0

const SMON = '0xa3227c5969757783154c60bf0bc1944180ed81b9'
const ONE_E18 = '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000'

function call(to: string, data: string, id: number) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function decodeUint(hex: string): string {
  if (!hex || hex === '0x') return 'empty'
  try { return BigInt(hex).toString() } catch { return 'decode_error' }
}
function decodeAddr(hex: string): string {
  if (!hex || hex.length < 66) return 'empty'
  return '0x' + hex.slice(-40)
}

export async function GET() {
  const probes = [
    // Standard ERC4626
    { name: 'convertToAssets(1e18)',   data: '0x07a2d13a' + ONE_E18.slice(2) },
    { name: 'previewRedeem(1e18)',     data: '0x4cdad506' + ONE_E18.slice(2) },
    { name: 'pricePerShare()',         data: '0x99530b06' },
    { name: 'exchangeRate()',          data: '0x3ba0b9a9' },
    { name: 'getRate()',               data: '0x679aefce' },
    // Staking-style
    { name: 'totalStaked()',           data: '0x817b1cd2' },
    { name: 'totalDeposited()',        data: '0x7d7c2a1c' },
    { name: 'totalPooledMon()',        data: '0x8fdc0f37' },
    { name: 'totalSupply()',           data: '0x18160ddd' },
    { name: 'totalAssets()',           data: '0x01e1d114' },
    { name: 'asset()',                 data: '0x38d52e0f' },
    // Reward rate
    { name: 'rewardRate()',            data: '0x7b0a47ee' },
    { name: 'getRewardRate()',         data: '0xf1aa4b11' },
    { name: 'annualizedYield()',       data: '0x0748e136' },
    { name: 'stakingApr()',            data: '0x5fa96e24' },
    { name: 'apr()',                   data: '0x5a46b00a' },
    { name: 'apy()',                   data: '0x1f1fcd51' },
    // Analytics
    { name: 'getPooledMonByShares(1e18)', data: '0x7a28fb88' + ONE_E18.slice(2) },
    { name: 'sharesToAssets(1e18)',    data: '0xd29428b6' + ONE_E18.slice(2) },
    { name: 'assetsPerShare()',        data: '0xe6f1daf2' },
  ]

  const requests = probes.map((p, i) => call(SMON, p.data, i))
  const results = await rpcBatch(requests)

  const parsed: Record<string, any> = {}
  for (let i = 0; i < probes.length; i++) {
    const res = results[i]
    const raw = res?.result ?? null
    let decoded = null
    if (raw && raw !== '0x' && raw.length > 2) {
      if (raw.length === 66) {
        // Could be uint256 or address
        const asUint = decodeUint(raw)
        const asAddr = decodeAddr(raw)
        decoded = { raw, as_uint: asUint, as_addr: asAddr }
      } else {
        decoded = { raw: raw.slice(0, 130) + (raw.length > 130 ? '...' : '') }
      }
    }
    parsed[probes[i].name] = decoded ?? (res?.error ? `error: ${res.error.message}` : 'no_data')
  }

  // Also get current block for reference
  let blockNumber = 'unknown'
  try {
    const blockRes = await rpcBatch([{ jsonrpc: '2.0', id: 99, method: 'eth_blockNumber', params: [] }])
    blockNumber = String(parseInt(blockRes[0]?.result ?? '0x0', 16))
  } catch {}

  return NextResponse.json({ contract: SMON, block: blockNumber, probes: parsed }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
