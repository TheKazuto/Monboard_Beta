import { NextResponse } from 'next/server'

export const revalidate = 0

const MONAD_RPC = 'https://rpc.monad.xyz'
const CONVERT_TO_ASSETS = '0x07a2d13a' + '0000000000000000000000000000000000000000000000000de0b6b3a7640000'
const BLOCKS_PER_DAY = 172_800

async function rpc(method: string, params: any[], id = 1) {
  const res = await fetch(MONAD_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  }).then(r => r.json())
  return res?.result
}

async function tryFetch(label: string, url: string, opts?: RequestInit) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store', ...opts })
    let body: any = null
    try { body = await res.json() } catch { body = await res.text().catch(() => null) }
    return { label, url, status: res.status, ok: res.ok, body, error: null }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, body: null, error: e.message }
  }
}

async function checkVaultOnchain(name: string, address: string) {
  try {
    const blockHex = await rpc('eth_blockNumber', [])
    const currentBlock = parseInt(blockHex, 16)

    const ppsNow = await rpc('eth_call', [{ to: address, data: CONVERT_TO_ASSETS }, 'latest'])

    const block1d  = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY).toString(16)
    const block3d  = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY * 3).toString(16)
    const block7d  = '0x' + Math.max(1, currentBlock - BLOCKS_PER_DAY * 7).toString(16)

    const [pps1d, pps3d, pps7d] = await Promise.all([
      rpc('eth_call', [{ to: address, data: CONVERT_TO_ASSETS }, block1d]),
      rpc('eth_call', [{ to: address, data: CONVERT_TO_ASSETS }, block3d]),
      rpc('eth_call', [{ to: address, data: CONVERT_TO_ASSETS }, block7d]),
    ])

    const toNum = (hex: string) => hex && hex !== '0x' && hex !== '0x0' ? Number(BigInt(hex)) / 1e18 : null

    return {
      name,
      address,
      currentBlock,
      ppsNow:  toNum(ppsNow),
      pps1d:   toNum(pps1d),
      pps3d:   toNum(pps3d),
      pps7d:   toNum(pps7d),
      rawPpsNow: ppsNow,
      rawPps1d:  pps1d,
    }
  } catch (e: any) {
    return { name, address, error: e.message }
  }
}

export async function GET() {
  const [
    upshiftApi,
    upshiftApi2,
    lagoonApi,
    lagoonApi2,
    kuruApi,
    magmaGql,
    kintsuApi,
    kintsuVaultApi,
    shmonadApi,
  ] = await Promise.all([
    tryFetch('Upshift /api/vaults',           'https://app.upshift.finance/api/vaults?chainId=143'),
    tryFetch('Upshift /api/vaults (no param)', 'https://app.upshift.finance/api/vaults'),
    tryFetch('Lagoon /v1/vaults',             'https://api.lagoon.finance/v1/vaults?chainId=143'),
    tryFetch('Lagoon /v1/vaults (no param)',  'https://api.lagoon.finance/v1/vaults'),
    tryFetch('Kuru pools',                    'https://api.kuru.io/v1/pools?chain=monad'),
    tryFetch('Magma GraphQL',                 'https://magma-http-app.fly.dev/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ tvlMats { sum } }' }),
    }),
    tryFetch('Kintsu APR',   'https://api.kintsu.xyz/v1/apr?chainId=143'),
    tryFetch('Kintsu Vault', 'https://kintsu.xyz/api/vaults/get-vault?address=0x792C7c5fB5C996E588b9F4A5FB201C79974e267C'),
    tryFetch('shMonad APR',  'https://api.shmonad.xyz/v1/apr'),
  ])

  // On-chain ERC4626 check for all known vaults
  const onchain = await Promise.all([
    checkVaultOnchain('Upshift earnAUSD',     '0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA'),
    checkVaultOnchain('Upshift earnMON',      '0x5E7568bf8DF8792aE467eCf5638d7c4D18A1881C'),
    checkVaultOnchain('Kintsu superMON',      '0x792C7c5fB5C996E588b9F4A5FB201C79974e267C'),
    checkVaultOnchain('Magma gMON',           '0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081'),
  ])

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    apis: {
      upshiftApi,
      upshiftApi2,
      lagoonApi,
      lagoonApi2,
      kuruApi,
      magmaGql,
      kintsuApi,
      kintsuVaultApi,
      shmonadApi,
    },
    onchain,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
