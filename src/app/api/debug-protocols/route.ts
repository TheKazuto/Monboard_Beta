import { NextResponse } from 'next/server'

export const revalidate = 0

const MONAD_RPC = 'https://rpc.monad.xyz'
const BLOCKS_PER_DAY = 172_800

async function rpcCall(to: string, data: string, block: string = 'latest') {
  const res = await fetch(MONAD_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, block] }),
    signal: AbortSignal.timeout(6_000),
    cache: 'no-store',
  }).then(r => r.json())
  return res?.result ?? null
}

async function getBlockNumber() {
  const res = await fetch(MONAD_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  }).then(r => r.json())
  return parseInt(res?.result, 16)
}

const PAD18 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000'
const PAD6  = '00000000000000000000000000000000000000000000000000000000000f4240'

const SELECTORS: Record<string, string> = {
  'convertToAssets(1e18)': '0x07a2d13a' + PAD18,
  'convertToAssets(1e6)':  '0x07a2d13a' + PAD6,
  'totalAssets()':         '0x01e1d114',
  'totalSupply()':         '0x18160ddd',
  'decimals()':            '0x313ce567',
  'asset()':               '0x38d52e0f',
  'getPooledEtherByShares(1e18)': '0x47b714e0' + PAD18, // Lido-style
  'getRate()':             '0x679aefce', // some LSTs
}

async function probeAndDelta(name: string, address: string) {
  const currentBlock = await getBlockNumber()
  const b1d  = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY).toString(16)
  const b7d  = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY * 7).toString(16)

  const probeResults: Record<string, any> = {}
  for (const [label, data] of Object.entries(SELECTORS)) {
    const raw = await rpcCall(address, data)
    if (raw && raw !== '0x' && raw.length > 2) {
      try {
        const val18 = Number(BigInt(raw)) / 1e18
        const val6  = Number(BigInt(raw)) / 1e6
        probeResults[label] = { raw, as18: val18, as6: val6 }
      } catch {
        probeResults[label] = { raw }
      }
    } else {
      probeResults[label] = null
    }
  }

  // Delta para convertToAssets(1e18) — o seletor mais provável
  const sel = '0x07a2d13a' + PAD18
  const [ppsNow, pps1d, pps7d] = await Promise.all([
    rpcCall(address, sel, 'latest'),
    rpcCall(address, sel, b1d),
    rpcCall(address, sel, b7d),
  ])

  const toNum = (h: string | null) => (h && h !== '0x' && h.length > 2) ? Number(BigInt(h)) / 1e18 : null
  const now = toNum(ppsNow), d1 = toNum(pps1d), d7 = toNum(pps7d)

  let apr7d = null, apr1d = null
  if (now && d7) apr7d = ((now - d7) / d7) / 7 * 365 * 100
  if (now && d1 && now !== d1) apr1d = ((now - d1) / d1) * 365 * 100

  return { name, address, currentBlock, probeResults, delta: { ppsNow: now, pps1d: d1, pps7d: d7, apr7d, apr1d } }
}

export async function GET() {
  const [sMon, superMon] = await Promise.all([
    probeAndDelta('sMON',     '0xa3227c5969757783154c60bf0bc1944180ed81b9'),
    probeAndDelta('superMON', '0x792C7c5fB5C996E588b9F4A5FB201C79974e267C'),
  ])

  return NextResponse.json({ timestamp: new Date().toISOString(), sMon, superMon })
}
