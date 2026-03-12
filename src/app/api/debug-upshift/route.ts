import { NextResponse } from 'next/server'

export const revalidate = 0

const MONAD_RPC = 'https://rpc.monad.xyz'

async function tryFetch(label: string, url: string, opts?: RequestInit) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      ...opts,
    })
    let body: any = null
    try { body = await res.json() } catch { body = await res.text().catch(() => null) }
    return { label, url, status: res.status, ok: res.ok, body }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, body: null, error: e.message }
  }
}

// Tentar diferentes seletores no contrato do vault
async function probeSelectors(name: string, address: string) {
  const selectors: Record<string, string> = {
    'totalAssets()':           '0x01e1d114',
    'totalSupply()':           '0x18160ddd',
    'convertToAssets(1e18)':   '0x07a2d13a' + '0000000000000000000000000000000000000000000000000de0b6b3a7640000',
    'convertToAssets(1e6)':    '0x07a2d13a' + '00000000000000000000000000000000000000000000000000000000000f4240',
    'getPricePerFullShare()':  '0x77c7b8fc',
    'pricePerShare()':         '0x99530b06',
    'exchangeRate()':          '0x3ba0b9a9',
    'sharePrice()':            '0x6dd3d39f',
    'decimals()':              '0x313ce567',
    'asset()':                 '0x38d52e0f',
  }
  const results: Record<string, any> = {}
  for (const [label, data] of Object.entries(selectors)) {
    try {
      const res = await fetch(MONAD_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }),
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      }).then(r => r.json())
      const raw = res?.result
      results[label] = (raw && raw !== '0x' && raw.length > 2) ? raw : null
    } catch {
      results[label] = 'error'
    }
  }
  return { name, address, results }
}

export async function GET() {
  const [
    // Endpoints SDK públicos
    metadata,
    aprs,
    aprsChain,
    vaults,
    vaultsChain,
    yields,
    yieldsChain,
    stats,
    statsChain,
    tvl,
    tvlChain,
    performance,
    performanceChain,
    earnAUSDData,
    earnMONData,
  ] = await Promise.all([
    tryFetch('sdk/vaults-metadata',                   'https://app.upshift.finance/api/sdk/vaults-metadata'),
    tryFetch('sdk/aprs',                              'https://app.upshift.finance/api/sdk/aprs'),
    tryFetch('sdk/aprs?chainId=143',                  'https://app.upshift.finance/api/sdk/aprs?chainId=143'),
    tryFetch('sdk/vaults',                            'https://app.upshift.finance/api/sdk/vaults'),
    tryFetch('sdk/vaults?chainId=143',                'https://app.upshift.finance/api/sdk/vaults?chainId=143'),
    tryFetch('sdk/yields',                            'https://app.upshift.finance/api/sdk/yields'),
    tryFetch('sdk/yields?chainId=143',                'https://app.upshift.finance/api/sdk/yields?chainId=143'),
    tryFetch('sdk/stats',                             'https://app.upshift.finance/api/sdk/stats'),
    tryFetch('sdk/stats?chainId=143',                 'https://app.upshift.finance/api/sdk/stats?chainId=143'),
    tryFetch('sdk/tvl',                               'https://app.upshift.finance/api/sdk/tvl'),
    tryFetch('sdk/tvl?chainId=143',                   'https://app.upshift.finance/api/sdk/tvl?chainId=143'),
    tryFetch('sdk/performance',                       'https://app.upshift.finance/api/sdk/performance'),
    tryFetch('sdk/performance?chainId=143',           'https://app.upshift.finance/api/sdk/performance?chainId=143'),
    // Por endereço específico
    tryFetch('sdk/vault earnAUSD',                    'https://app.upshift.finance/api/sdk/vaults/0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA'),
    tryFetch('sdk/vault earnMON',                     'https://app.upshift.finance/api/sdk/vaults/0x5E7568bf8DF8792aE467eCf5638d7c4D18A1881C'),
  ])

  // Probe contratos on-chain com múltiplos seletores
  const contracts = await Promise.all([
    probeSelectors('earnAUSD', '0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA'),
    probeSelectors('earnMON',  '0x5E7568bf8DF8792aE467eCf5638d7c4D18A1881C'),
    probeSelectors('sAUSD',    '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E'),
  ])

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    sdk_endpoints: {
      metadata, aprs, aprsChain, vaults, vaultsChain,
      yields, yieldsChain, stats, statsChain,
      tvl, tvlChain, performance, performanceChain,
      earnAUSDData, earnMONData,
    },
    contracts,
  })
}
