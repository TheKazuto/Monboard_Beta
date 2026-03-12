import { NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

export const revalidate = 0

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AprEntry {
  protocol:   string
  logo:       string
  url:        string
  tokens:     string[]      // symbols involved
  label:      string        // human-readable name
  apr:        number        // annual percentage rate (e.g. 8.5 = 8.5%)
  type:       'pool' | 'vault' | 'lend'
  isStable:   boolean       // true when ALL tokens are stablecoins
}

// ─── Stablecoin classification ────────────────────────────────────────────────
const STABLECOINS = new Set([
  'USDC', 'USDT', 'USDT0', 'AUSD', 'DAI', 'FRAX', 'BUSD',
  'USDC.e', 'mTBILL', 'crvUSD', 'TUSD', 'LUSD', 'MIM', 'USD1', 'LVUSD',
])

function isStable(sym: string): boolean { return STABLECOINS.has(sym) }
function allStable(tokens: string[]): boolean { return tokens.length > 0 && tokens.every(isStable) }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MONAD_RPC = 'https://rpc.monad.xyz'

function ethCall(to: string, data: string, id: number) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}

// Convert RAY (1e27) to percentage APR
function rayToApr(hex: string, wordIndex: number): number {
  if (!hex || hex === '0x' || hex.length < 2 + (wordIndex + 1) * 64) return 0
  try {
    const words = hex.slice(2).match(/.{64}/g) ?? []
    if (!words[wordIndex]) return 0
    const rate = BigInt('0x' + words[wordIndex])
    return Number(rate) / 1e27 * 100
  } catch { return 0 }
}

// ─── Server-side cache ────────────────────────────────────────────────────────
// Caches the full API response for CACHE_TTL ms. Deduplicates in-flight requests
// so concurrent visitors share one set of external API calls.
const CACHE_TTL = 3 * 60 * 1000 // 3 minutes

interface CacheEntry {
  data:      any
  fetchedAt: number
  promise:   Promise<any> | null
}

let serverCache: CacheEntry | null = null

// ─── MORPHO — markets (lend) + vaults ────────────────────────────────────────
// APY → APR conversion (daily compounding assumed)
function apyToApr(apy: number): number {
  if (apy <= 0) return 0
  return 365 * (Math.pow(1 + apy, 1 / 365) - 1)
}

async function fetchMorpho(): Promise<AprEntry[]> {
  // Note: supplyAssetsUsd is used to filter out test/garbage markets (permissionless protocol)
  // Markets with < $500 TVL are excluded — avoids "testwstETH/testWETH" style junk markets
  // APR cap at 200% guards against extreme utilization edge cases in tiny markets
  const query = `{
    markets(where:{chainId_in:[143]}, first:100) {
      items {
        uniqueKey
        loanAsset { symbol }
        collateralAsset { symbol }
        state { supplyApy borrowApy supplyAssetsUsd }
      }
    }
    vaults(where:{chainId_in:[143]}, first:50) {
      items {
        address
        name
        symbol
        asset { symbol }
        state { netApy totalAssetsUsd }
      }
    }
  }`
  try {
    const res = await fetch('https://api.morpho.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    const data = await res.json()
    const out: AprEntry[] = []

    for (const m of data?.data?.markets?.items ?? []) {
      const supplyApy    = Number(m.state?.supplyApy ?? 0)
      const supplyApr    = apyToApr(supplyApy) * 100
      const supplyUsd    = Number(m.state?.supplyAssetsUsd ?? 0)
      const loanSym      = m.loanAsset?.symbol ?? '?'
      const collSym      = m.collateralAsset?.symbol
      // Skip: zero APR, tiny markets (< $500 TVL = test/garbage), or absurdly high APR (> 200%)
      if (supplyApr < 0.01) continue
      if (supplyUsd < 500) continue
      if (supplyApr > 200) continue
      const tokens = collSym ? [collSym, loanSym] : [loanSym]
      const url = m.uniqueKey
        ? `https://app.morpho.org/monad/market?id=${m.uniqueKey}`
        : 'https://app.morpho.org/monad'
      out.push({
        protocol: 'Morpho', logo: '🦋', url,
        tokens, label: collSym ? `${collSym} / ${loanSym}` : loanSym,
        apr: supplyApr, type: 'lend', isStable: allStable(tokens),
      })
    }
    for (const v of data?.data?.vaults?.items ?? []) {
      const netApy    = Number(v.state?.netApy ?? 0)
      const netApr    = apyToApr(netApy) * 100
      const totalUsd  = Number(v.state?.totalAssetsUsd ?? 0)
      const sym       = v.asset?.symbol ?? '?'
      if (netApr < 0.01) continue
      if (totalUsd < 500) continue  // skip empty/test vaults
      const url = v.address
        ? `https://app.morpho.org/monad/vault?address=${v.address}`
        : 'https://app.morpho.org/monad'
      out.push({
        protocol: 'Morpho', logo: '🦋', url,
        tokens: [sym], label: v.name ?? v.symbol ?? sym,
        apr: netApr, type: 'vault', isStable: isStable(sym),
      })
    }
    return out
  } catch { return [] }
}

// ─── NEVERLAND (Aave V3 fork) — supply & borrow rates ────────────────────────
const NEVERLAND_POOL   = '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585'
const NEVERLAND_ASSETS = [
  { address: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a', symbol: 'WMON'  },
  { address: '0x0555e30da8f98308edb960aa94c0db47230d2b9c', symbol: 'WBTC'  },
  { address: '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242', symbol: 'WETH'  },
  { address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', symbol: 'AUSD'  },
  { address: '0x754704bc059f8c67012fed69bc8a327a5aafb603', symbol: 'USDC'  },
  { address: '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', symbol: 'USDT0' },
  { address: '0xa3227c5969757783154c60bf0bc1944180ed81b9', symbol: 'sMON'  },
  { address: '0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081', symbol: 'gMON'  },
  { address: '0x1b68626dca36c7fe922fd2d55e4f631d962de19c', symbol: 'shMON' },
]

async function fetchNeverland(): Promise<AprEntry[]> {
  try {
    const calls = NEVERLAND_ASSETS.map((a, i) =>
      ethCall(NEVERLAND_POOL, '0x35ea6a75' + a.address.slice(2).toLowerCase().padStart(64, '0'), i)
    )
    const results = await rpcBatch(calls)
    const out: AprEntry[] = []

    NEVERLAND_ASSETS.forEach((asset, i) => {
      const hex = results[i]?.result ?? ''
      const supplyApr = rayToApr(hex, 2)
      if (supplyApr < 0.01) return
      out.push({
        protocol: 'Neverland', logo: '🌙', url: 'https://app.neverland.money',
        tokens: [asset.symbol], label: asset.symbol,
        apr: supplyApr, type: 'lend', isStable: isStable(asset.symbol),
      })
    })
    return out
  } catch { return [] }
}

// ─── EULER V2 — vaults (supply APR) ──────────────────────────────────────────
async function fetchEulerV2(): Promise<AprEntry[]> {
  const query = `{
    vaults(where:{chainId:143},first:100) {
      name
      asset { symbol }
      state { supplyApy borrowApy }
    }
  }`
  try {
    const res = await fetch('https://api.euler.finance/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data?.data?.vaults ?? [])
      .filter((v: any) => Number(v.state?.supplyApy ?? 0) > 0)
      .map((v: any) => {
        const sym    = v.asset?.symbol ?? '?'
        const supApr = Number(v.state?.supplyApy ?? 0) * 100
        return {
          protocol: 'Euler V2', logo: '📐', url: 'https://app.euler.finance',
          tokens: [sym], label: v.name ?? sym,
          apr: supApr, type: 'lend' as const, isStable: isStable(sym),
        }
      })
  } catch { return [] }
}

// ─── CURVE — pool APRs via virtualPrice delta ────────────────────────────────
async function fetchCurve(): Promise<AprEntry[]> {
  const BASE       = 'https://api-core.curve.finance/v1'
  const BLOCKS_24H = 195_000 // Monad ~0.44s/block

  try {
    // Pool list + block number (parallel) — removed unused DeFiLlama fetch
    const [r1, r2, bnRes] = await Promise.all([
      fetch(`${BASE}/getPools/monad/factory-twocrypto`,  { signal: AbortSignal.timeout(10_000), cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${BASE}/getPools/monad/factory-stable-ng`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(MONAD_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(4_000),
      }).then(r => r.json()).catch(() => ({ result: '0x0' })),
    ])

    const allPools: any[] = [...(r1?.data?.poolData ?? []), ...(r2?.data?.poolData ?? [])]
    const livePools = allPools.filter(p => Number(p.usdTotalExcludingBasePool ?? p.usdTotal ?? 0) > 100)
    if (livePools.length === 0) return []

    const currentBlock = Number(BigInt(bnRes?.result ?? '0x0'))
    // virtualPrice grows as trading fees accumulate → reliable APR proxy
    const block24h = '0x' + Math.max(0, currentBlock - BLOCKS_24H).toString(16)
    const vpCalls: any[] = []
    livePools.forEach((p, i) => {
      vpCalls.push({ jsonrpc: '2.0', id: i * 2,     method: 'eth_call', params: [{ to: p.address, data: '0xbb7b8b80' }, 'latest']  })
      vpCalls.push({ jsonrpc: '2.0', id: i * 2 + 1, method: 'eth_call', params: [{ to: p.address, data: '0xbb7b8b80' }, block24h] })
    })
    const vpRes = await fetch(MONAD_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vpCalls),
      signal: AbortSignal.timeout(12_000),
    }).then(r => r.json()).then(d => Array.isArray(d) ? d : [d]).catch(() => [])

    const entries: AprEntry[] = []
    livePools.forEach((p, i) => {
      const tvl = Number(p.usdTotalExcludingBasePool ?? p.usdTotal ?? 0)
      if (tvl <= 0) return

      const vpNow = vpRes.find((r: any) => r.id === i * 2)?.result ?? '0x'
      const vpOld = vpRes.find((r: any) => r.id === i * 2 + 1)?.result ?? '0x'
      let apr = 0
      if (vpNow && vpNow !== '0x' && vpOld && vpOld !== '0x') {
        try {
          const now = Number(BigInt(vpNow)) / 1e18
          const old = Number(BigInt(vpOld)) / 1e18
          if (old > 0 && now > old) apr = (Math.pow(now / old, 365) - 1) * 100
        } catch { /* skip */ }
      }

      if (apr < 0.001) return
      const tokens = (p.coins ?? []).map((c: any) => c.symbol).filter(Boolean)
      const poolId = p.id ?? p.address
      entries.push({
        protocol: 'Curve', logo: '🌊',
        url: `https://curve.finance/dex/monad/pools/${poolId}/deposit`,
        tokens, label: p.name ?? tokens.join(' / '),
        apr, type: 'pool' as const, isStable: allStable(tokens),
      })
    })
    return entries
  } catch { return [] }
}

// ─── UPSHIFT — vaults via REST API (fallback: ERC4626 on-chain) ──────────────
const UPSHIFT_KNOWN_STABLECOINS = new Set(['AUSD', 'USDC', 'USDT', 'USDT0', 'DAI', 'FRAX'])

// ─── UPSHIFT — vaults via /api/proxy/vaults ──────────────────────────────────
// Source: https://app.upshift.finance/api/proxy/vaults
// Filtros: chainId=143, status=active, isVisible=true, tvl>1000, apy.apy>0
// APY field: apy.apy (já em %, ex: 14.0 = 14%) — target APY definido pela equipe
// campaignApy: incentivos extras em %, somamos ao base para APR total
// superMON (0x792C) ignorado — mesmo vault coberto pelo Kintsu
// Sem fallback on-chain: vaults usam ABI customizada (August protocol), não ERC4626

const UPSHIFT_PROXY_URL = 'https://app.upshift.finance/api/proxy/vaults'
const UPSHIFT_IGNORE    = new Set(['0x792c7c5fb5c996e588b9f4a5fb201c79974e267c']) // superMON = Kintsu

async function fetchUpshift(): Promise<AprEntry[]> {
  try {
    const res = await fetch(UPSHIFT_PROXY_URL, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    const vaults: any[] = data?.data ?? []
    if (!Array.isArray(vaults) || vaults.length === 0) return []

    const out: AprEntry[] = []
    for (const v of vaults) {
      // Filtros básicos
      if (v.chainId !== 143) continue
      if (v.status !== 'active') continue
      if (!v.isVisible) continue
      if ((v.latest_reported_tvl ?? 0) < 1_000) continue
      if (UPSHIFT_IGNORE.has((v.address ?? '').toLowerCase())) continue

      // APY em % (ex: 14.0 = 14%). null = sem dados → skip
      const baseApy = Number(v.apy?.apy ?? 0)
      if (baseApy <= 0) continue

      // campaignApy são incentivos extras (também em %)
      const campaignApy = Number(v.apy?.campaignApy ?? 0)
      const totalApy    = baseApy + (campaignApy > 0 ? campaignApy : 0)

      // APY % → APR % com daily compounding
      const apr = Math.min(apyToApr(totalApy / 100) * 100, 500)
      if (apr < 0.01) continue

      // Tokens de depósito
      const depositSymbols: string[] = (v.depositAssets ?? []).map((a: any) => a.symbol).filter(Boolean)
      const tokens = depositSymbols.length > 0 ? depositSymbols : ['?']
      const stable = tokens.every((t: string) => UPSHIFT_KNOWN_STABLECOINS.has(t))

      out.push({
        protocol: 'Upshift',
        logo:     '🔺',
        url:      `https://app.upshift.finance/vaults/${v.address ?? ''}`,
        tokens,
        label:    v.name ?? tokens.join(' / '),
        apr,
        type:     'vault',
        isStable: stable,
      })
    }
    return out
  } catch { return [] }
}
// ─── LAGOON — vaults ──────────────────────────────────────────────────────────
// API: GET /api/vaults?chainId=143&... → list vaults
//      GET /api/vault-apr?chainId=143&address=X → APR per vault
// APR preference: weeklyApr → monthlyApr → inceptionApr (linearNetApr)
async function fetchLagoon(): Promise<AprEntry[]> {
  try {
    const listRes = await fetch(
      'https://app.lagoon.finance/api/vaults?chainId=143&underlyingassetSymbol=0&curatorId=0&pageIndex=0&pageSize=50&includeApr=false',
      { signal: AbortSignal.timeout(8_000), cache: 'no-store' }
    )
    if (!listRes.ok) return []
    const listData = await listRes.json()
    const vaults: any[] = listData?.vaults ?? []
    if (!vaults.length) return []

    // Fetch APR for each vault in parallel
    const aprResults = await Promise.allSettled(
      vaults.map(v =>
        fetch(`https://app.lagoon.finance/api/vault-apr?chainId=143&address=${v.address}`, {
          signal: AbortSignal.timeout(8_000), cache: 'no-store',
        }).then(r => r.ok ? r.json() : null)
      )
    )

    const entries: AprEntry[] = []
    for (let i = 0; i < vaults.length; i++) {
      const vault = vaults[i]
      const aprResult = aprResults[i]
      const aprData = aprResult.status === 'fulfilled' ? (aprResult as PromiseFulfilledResult<any>).value : null
      if (!aprData) continue

      const s = aprData.state ?? {}
      const apr =
        s.weeklyApr?.linearNetApr ??
        s.monthlyApr?.linearNetApr ??
        s.inceptionApr?.linearNetApr ?? null

      if (!apr || apr <= 0) continue

      const token = vault.asset?.symbol ?? 'USDC'
      const curator = vault.curators?.[0]?.name ?? 'Lagoon'

      entries.push({
        protocol: 'Lagoon',
        logo: '🏝️',
        url: `https://app.lagoon.finance/vault/${vault.address}`,
        tokens: [token],
        label: `${vault.name} (${curator})`,
        apr,
        type: 'vault',
        isStable: ['USDC', 'USDT', 'AUSD', 'DAI', 'USDT0'].includes(token),
      })
    }
    return entries
  } catch { return [] }
}

// ─── KURU — pool APRs ─────────────────────────────────────────────────────────
async function fetchKuru(): Promise<AprEntry[]> {
  // Endpoint /v1/pools?chain=monad returns 404 — disabled until correct endpoint is found
  // TODO: re-enable when Kuru publishes correct API docs for Monad
  return []
}

// ─── CURVANCE — lending markets via Merkl API ────────────────────────────────
// API: GET https://api.merkl.xyz/v4/opportunities?items=100&tokenTypes=TOKEN&mainProtocolId=curvance&action=LEND
// Response: array of opportunities. Fields used: apr (already in %), status, tokens[], name, depositUrl, tvl
// Token structure: each opportunity has [cToken (wrapper), underlyingToken] or [underlying, cToken]
//   → underlying is the token whose symbol does NOT start with lowercase "c" (cAUSD, cWMON, cWETH, etc.)
//   → name format: "Supply <token> to Curvance <market> market" → extract market via regex
async function fetchCurvance(nativeApyMap: Map<string, number>): Promise<AprEntry[]> {
  try {
    const res = await fetch(
      'https://api.merkl.xyz/v4/opportunities?items=100&tokenTypes=TOKEN&mainProtocolId=curvance&action=LEND&chainId=143',
      { signal: AbortSignal.timeout(8_000), cache: 'no-store' }
    )
    if (!res.ok) return []
    const data: any[] = await res.json()
    const entries: AprEntry[] = []

    for (const opp of data) {
      if (opp.status !== 'LIVE') continue
      const apr = Number(opp.apr ?? 0)
      if (apr <= 0) continue

      // Curvance wrappers always start with lowercase 'c' + letter: cAUSD, cWMON, cearnAUSD, cYZM, cUSDC
      // Underlying tokens never start with 'c': AUSD, WMON, earnAUSD, YZM, USDC, WETH, syzUSD, etc.
      // Priority: (1) non-wrapper by symbol pattern, (2) verified=true among remaining, (3) first token
      const tokens: any[] = opp.tokens ?? []
      const underlying =
        tokens.find((t: any) => !/^c[A-Za-z]/.test(t.symbol ?? '')) ??
        tokens.find((t: any) => t.verified === true) ??
        tokens[0]
      const tokenSymbol = underlying?.symbol ?? 'TOKEN'
      const isStable = ['USDC','AUSD','USDT','USDT0','DAI','earnAUSD','sAUSD'].includes(tokenSymbol)

      // Extract market name from "Supply X to Curvance <MARKET> market"
      const marketMatch = (opp.name as string)?.match(/Curvance (.+?) market/)
      const label = marketMatch ? `Curvance ${marketMatch[1]}` : (opp.name ?? `Curvance ${tokenSymbol}`)

      // nativeApyMap from floppy-backup is empty (API returns 403 server-side)
      // keeping the param for future use when a working source is found
      const nativeApy = nativeApyMap.get(tokenSymbol.toUpperCase()) ?? 0
      const nativeApr = nativeApy > 0 ? apyToApr(nativeApy / 100) * 100 : 0

      entries.push({
        protocol: 'Curvance',
        logo: '🔵',
        url: opp.depositUrl ?? 'https://app.curvance.com',
        tokens: [tokenSymbol],
        label,
        apr: apr + nativeApr,
        type: 'lend',
        isStable,
      })
    }
    return entries
  } catch { return [] }
}

// ─── MIDAS — tokenized RWAs (known fixed APRs) ────────────────────────────────
// Last verified: 2025-05 — update if rates change on midas.app
function getMidas(): AprEntry[] {
  return [
    {
      protocol: 'Midas', logo: '🏛️', url: 'https://midas.app',
      tokens: ['mTBILL'], label: 'Tokenized US T-Bills',
      apr: 4.8, type: 'vault', isStable: true,
    },
    {
      protocol: 'Midas', logo: '🏛️', url: 'https://midas.app',
      tokens: ['mBASIS'], label: 'Basis Trading Strategy',
      apr: 7.2, type: 'vault', isStable: false,
    },
  ]
}

// ─── ON-CHAIN ERC4626 APR HELPER ─────────────────────────────────────────────
// Reads convertToAssets(1e18) at current and past blocks, annualises growth.
// Monad: ~2 blocks/sec → 7d ≈ 1_209_600 blocks, 3d ≈ 518_400, 1d ≈ 172_800
// Tries progressively smaller windows for new vaults with limited history.

const BLOCKS_PER_DAY = 172_800
const CONVERT_TO_ASSETS = '0x07a2d13a' + '0000000000000000000000000000000000000000000000000de0b6b3a7640000'

async function getBlockNumber(): Promise<number> {
  const res = await fetch(MONAD_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(5_000),
  }).then(r => r.json())
  return parseInt(res?.result ?? '0x0', 16)
}

async function getPricePerShare(vault: string, block: string): Promise<bigint> {
  const res = await fetch(MONAD_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: vault, data: CONVERT_TO_ASSETS }, block] }),
    signal: AbortSignal.timeout(6_000),
  }).then(r => r.json())
  const hex = res?.result ?? '0x0'
  try { return hex && hex !== '0x' && hex !== '0x0' ? BigInt(hex) : 0n } catch { return 0n }
}

// Annualise pricePerShare growth over `days` days
function ppsGrowthToApr(ppsNow: bigint, ppsPast: bigint, days: number): number {
  if (ppsPast === 0n || ppsNow <= ppsPast) return 0
  const growthPerDay = Number(ppsNow - ppsPast) / Number(ppsPast) / days
  const apr = growthPerDay * 365 * 100
  return apr > 0 && apr < 500 ? apr : 0
}

// Try 7d window first, then 3d, then 1d — handles new vaults with limited history
async function getVaultApr(vault: string, currentBlock: number): Promise<number> {
  const windows = [
    { days: 7, blocks: BLOCKS_PER_DAY * 7 },
    { days: 3, blocks: BLOCKS_PER_DAY * 3 },
    { days: 1, blocks: BLOCKS_PER_DAY * 1 },
  ]
  const ppsNow = await getPricePerShare(vault, 'latest')
  if (ppsNow === 0n) return 0

  for (const { days, blocks } of windows) {
    const pastBlock = '0x' + Math.max(1, currentBlock - blocks).toString(16)
    const ppsPast = await getPricePerShare(vault, pastBlock)
    const apr = ppsGrowthToApr(ppsNow, ppsPast, days)
    if (apr > 0) return apr
  }
  return 0
}

interface VaultMeta { name: string; address: string; tokens: string[]; isStable: boolean }

async function fetchERC4626Vaults<T extends VaultMeta>(
  vaults: T[],
  toEntry: (v: T, apr: number) => Omit<AprEntry, 'apr'>
): Promise<AprEntry[]> {
  try {
    const currentBlock = await getBlockNumber()
    const aprs = await Promise.all(vaults.map(v => getVaultApr(v.address, currentBlock)))

    return vaults
      .map((v, i) => {
        const apr = aprs[i]
        if (apr < 0.01) return null
        return { ...toEntry(v, apr), apr } as AprEntry
      })
      .filter((e): e is AprEntry => e !== null)
  } catch { return [] }
}

// ─── MAGMA — gMON APR via on-chain ERC4626 pricePerShare delta ───────────────
// gMON (0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081) implements convertToAssets
// and has enough block history for 7d delta. Confirmed working via debug route.
// GraphQL at magma-http-app.fly.dev/graphql returns 500 — not used.

async function fetchMagmaOnchain(): Promise<any> {
  try {
    const GMON = '0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081'
    const currentBlock = await getBlockNumber()
    const apr = await getVaultApr(GMON, currentBlock)
    return apr > 0 ? { apr } : null
  } catch { return null }
}

// ─── FLOPPY BACKUP — native APY for Monad LST/vault tokens ─────────────────────
// Source: https://api.floppy-backup.com/v1/monad/native_apy
// Returns APY (not APR) for: SHMON, SMON, GMON, USDC, SYZUSD, LOAZND, MUBOND
// Used by: fetchShMonad (SHMON), fetchKintsusMON (SMON), fetchCurvance (USDC + others)
// APY → APR conversion: daily compounding — APR = ((1 + APY/100)^(1/365) - 1) * 365 * 100
async function fetchFloppyNativeApy(): Promise<Map<string, number>> {
  try {
    const res = await fetch('https://api.floppy-backup.com/v1/monad/native_apy', {
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    })
    if (!res.ok) return new Map()
    const data = await res.json()
    const map = new Map<string, number>()
    for (const entry of (data.native_apy ?? [])) {
      const sym = String(entry.symbol ?? '').toUpperCase()
      const apy = Number(entry.apy ?? 0)
      if (sym && apy >= 0) map.set(sym, apy)
    }
    return map
  } catch { return new Map() }
}

// ─── KINTSU sMON — APR via Protocol_LST_Analytics_Day GraphQL ────────────────
// Source: https://kintsu.xyz/api/graphql (no auth required)
// APR = (totalRewards delta 7d / avg TVL 7d) / 7 * 365
// totalRewards is cumulative MON, totalPooledStaked is current TVL in MON.
// 7d window is more stable than 1d due to validator reward variance.

const KINTSU_LST_GQL = 'https://kintsu.xyz/api/graphql'
const KINTSU_LST_QUERY = `{
  Protocol_LST_Analytics_Day(
    where: { chainId: { _eq: 143 } }
    order_by: { date: desc }
    limit: 8
  ) {
    date
    totalRewards
    totalPooledStaked
  }
}`

async function fetchKintsusMON(_nativeApyMap: Map<string, number>): Promise<AprEntry | null> {
  // floppy-backup API is blocked server-side (403) — try GraphQL first, then hardcode
  try {
    const res = await fetch(KINTSU_LST_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: KINTSU_LST_QUERY }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = await res.json()
    const rows: any[] = json?.data?.Protocol_LST_Analytics_Day ?? []
    if (rows.length < 8) return null
    const rewardsDelta = Number(rows[0].totalRewards) - Number(rows[7].totalRewards)
    const tvlAvg = rows.slice(0, 7).reduce((s: number, r: any) => s + Number(r.totalPooledStaked), 0) / 7
    if (rewardsDelta <= 0 || tvlAvg <= 0) return null
    const apr = Math.min((rewardsDelta / tvlAvg) / 7 * 365 * 100, 100)
    if (apr < 0.01) return null
    return {
      protocol: 'Kintsu', logo: '🔵', url: 'https://kintsu.xyz',
      tokens: ['sMON'], label: 'Staked MON',
      apr, type: 'vault', isStable: false,
    }
  } catch { /* GraphQL blocked server-side */ }
  // Both floppy-backup (403) and kintsu.xyz/api/graphql (500) blocked server-side.
  // TODO: implement on-chain fallback once sMON contract ABI is confirmed via debug-smon
  return null
}

// ─── shMONAD — on-chain ERC4626 pricePerShare delta ─────────────────────────
// Confirmed working: convertToAssets(1e18) responds, 7d APR ~11.3%
// asset() = 0xeeee...ee (native MON). api.shmonad.xyz is offline (530).
const SHMON_ADDRESS = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c'

async function fetchShMonad(_nativeApyMap: Map<string, number>): Promise<AprEntry | null> {
  // floppy-backup API is blocked server-side (403) — use on-chain ERC4626 pricePerShare delta
  // Confirmed working: convertToAssets(1e18) responds, 7d APR ~11-15%
  try {
    const currentBlock = await getBlockNumber()
    const apr = await getVaultApr(SHMON_ADDRESS, currentBlock)
    if (apr <= 0) return null
    return {
      protocol: 'shMonad', logo: '⚡', url: 'https://shmonad.xyz',
      tokens: ['shMON'], label: 'Holistic Staked MON',
      apr, type: 'vault', isStable: false,
    }
  } catch { return null }
}

// ─── KINTSU, MAGMA, shMONAD — LST staking vaults (parallel) ─────────────────
async function fetchLSTVaults(nativeApyMap: Map<string, number>): Promise<AprEntry[]> {
  const [kintsuR, magmaR, shmonadR] = await Promise.allSettled([
    fetchKintsusMON(nativeApyMap),
    fetchMagmaOnchain(),
    fetchShMonad(nativeApyMap),
  ])

  const entries: AprEntry[] = []

  const kEntry = kintsuR.status === 'fulfilled' ? kintsuR.value : null
  if (kEntry) entries.push(kEntry)

  const mData = magmaR.status === 'fulfilled' ? magmaR.value : null
  if (mData) {
    const apr = Number(mData?.apr ?? 0)
    if (apr > 0) entries.push({
      protocol: 'Magma', logo: '🐲', url: 'https://magmastaking.xyz',
      tokens: ['gMON'], label: 'MEV-Optimized Staked MON',
      apr, type: 'vault', isStable: false,
    })
  }

  const sEntry = shmonadR.status === 'fulfilled' ? shmonadR.value : null
  if (sEntry) entries.push(sEntry)

  return entries
}

// ─── UNISWAP V3 + V4 — single GraphQL request for both ──────────────────────
function parseUniPools(pools: any[], version: string): AprEntry[] {
  const out: AprEntry[] = []
  for (const p of pools) {
    const tvl    = Number(p.totalLiquidity?.value ?? 0)
    const vol24h = Number(p.cumulativeVolume?.value ?? 0)
    const fee    = Number(p.feeTier ?? 0)
    if (tvl < 100 || vol24h < 1) continue
    const apr = (vol24h * (fee / 1_000_000)) / tvl * 365 * 100
    if (apr < 0.01) continue
    const t0 = p.token0?.symbol ?? '?'
    const t1 = p.token1?.symbol ?? '?'
    const tokens = [t0, t1]
    const feePct = fee / 10000
    const feeLabel = feePct >= 0.01 ? `${feePct}%` : `${fee / 100}bp`
    const poolRef = p.address ?? p.poolId ?? ''
    out.push({
      protocol: `Uniswap ${version}`, logo: '🦄',
      url: `https://app.uniswap.org/explore/pools/monad/${poolRef}`,
      tokens, label: `${t0}/${t1} ${feeLabel}`,
      apr, type: 'pool', isStable: allStable(tokens),
    })
  }
  return out
}

async function fetchUniswap(): Promise<AprEntry[]> {
  const GW = 'https://interface.gateway.uniswap.org/v1/graphql'
  const headers = { 'Content-Type': 'application/json', 'Origin': 'https://app.uniswap.org' }

  // Query V3 and V4 in one request; if GW rejects the combined query, each field is still optional
  const query = `{
    topV3Pools(chain: MONAD, first: 100) {
      address feeTier
      token0 { symbol }
      token1 { symbol }
      totalLiquidity { value }
      cumulativeVolume(duration: DAY) { value }
    }
    topV4Pools(chain: MONAD, first: 100) {
      poolId feeTier
      token0 { symbol }
      token1 { symbol }
      totalLiquidity { value }
      cumulativeVolume(duration: DAY) { value }
    }
  }`

  try {
    const res = await fetch(GW, {
      method: 'POST', headers,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000), cache: 'no-store',
    })
    if (!res.ok) return []
    const json = await res.json()
    // GraphQL may return partial data with errors — use whatever fields came back
    const v3 = json?.data?.topV3Pools ?? []
    const v4 = json?.data?.topV4Pools ?? []
    return [
      ...parseUniPools(v3, 'V3'),
      ...parseUniPools(v4, 'V4'),
    ]
  } catch { return [] }
}

// ─── MERKL — fetch reward APRs for Monad pools ──────────────────────────────
async function fetchMerklRewardMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const res = await fetch(
      'https://api.merkl.xyz/v4/opportunities?chainId=143&action=POOL&status=LIVE&items=100',
      { signal: AbortSignal.timeout(12_000), cache: 'no-store' },
    )
    if (!res.ok) return map
    const opps: any[] = await res.json()
    for (const o of opps) {
      const addr = (o.identifier ?? '').toLowerCase()
      const apr  = Number(o.apr ?? 0)
      if (addr && apr > 0) {
        map.set(addr, (map.get(addr) ?? 0) + apr)
      }
    }
  } catch { /* ignore */ }
  return map
}

// ─── PANCAKESWAP V3 — pools via explorer API + Merkl rewards ─────────────────
async function fetchPancakeswap(): Promise<AprEntry[]> {
  try {
    const [poolsRes, merklMap] = await Promise.all([
      fetch(
        'https://explorer.pancakeswap.com/api/cached/pools/list?protocols=v3&chains=monad&orderBy=tvlUSD',
        { signal: AbortSignal.timeout(15_000), cache: 'no-store' },
      ),
      fetchMerklRewardMap(),
    ])
    if (!poolsRes.ok) return []
    const data = await poolsRes.json()
    // API may return { rows: [...] } or just an array, or { data: { rows: [...] } }
    const rows: any[] = data?.rows ?? data?.data?.rows ?? (Array.isArray(data) ? data : [])
    const out: AprEntry[] = []
    for (const p of rows) {
      const tvl    = Number(p.tvlUSD ?? 0)
      const feeApr = Number(p.apr24h ?? 0) * 100
      if (tvl < 100) continue
      const poolAddr = (p.id ?? '').toLowerCase()
      const rewardApr = merklMap.get(poolAddr) ?? 0
      const apr = feeApr + rewardApr
      if (apr < 0.01) continue
      const t0 = p.token0?.symbol ?? '?'
      const t1 = p.token1?.symbol ?? '?'
      const tokens = [t0, t1]
      const fee = Number(p.feeTier ?? 0)
      const feePct = fee / 10000
      const feeLabel = feePct >= 0.01 ? `${feePct}%` : `${fee / 100}bp`
      out.push({
        protocol: 'PancakeSwap V3', logo: '🥞',
        url: `https://pancakeswap.finance/liquidity/pool/monad/${p.id ?? ''}`,
        tokens, label: `${t0}/${t1} ${feeLabel}`,
        apr, type: 'pool', isStable: allStable(tokens),
      })
    }
    return out
  } catch { return [] }
}

// ─── KINTSU — superMON vault ─────────────────────────────────────────────────
// superMON (0x792C) é gerido pela Kintsu mas listado na Upshift proxy API.
// historical_apy.7 = APY decimal (ex: 0.1077 = 10.77%). Usar 7d.
// Nota: Upshift pode retornar 429 — nesse caso retorna [].

const KINTSU_VAULT_ADDRESS = '0x792C7c5fB5C996E588b9F4A5FB201C79974e267C'
async function fetchKintsuVault(): Promise<AprEntry[]> {
  try {
    const res = await fetch('https://app.upshift.finance/api/proxy/vaults', {
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    const vaults: any[] = data?.data ?? []
    const vault = vaults.find(
      (v: any) => (v.address ?? '').toLowerCase() === KINTSU_VAULT_ADDRESS.toLowerCase()
    )
    if (!vault) return []

    const hist = vault.historical_apy ?? {}
    const apyDecimal = hist['7'] ?? hist['30'] ?? null
    if (typeof apyDecimal !== 'number' || apyDecimal <= 0) return []

    const apr = Math.min(365 * (Math.pow(1 + apyDecimal, 1 / 365) - 1) * 100, 200)
    return [buildKintsuEntry(apr)]
  } catch { return [] }
}

function buildKintsuEntry(apr: number): AprEntry {
  return {
    protocol: 'Kintsu',
    logo: '🔷',
    url: 'https://kintsu.xyz/vaults',
    tokens: ['WMON'],
    label: 'superMON Vault',
    apr,
    type: 'vault',
    isStable: false,
  }
}

// ─── GEARBOX V3 — lending pools ──────────────────────────────────────────────
// Source: static JSON updated by GearBox with each deployment.
// supplyRate is already annualised in RAY (1e27). APR = supplyRate / 1e27 * 100.

const GEARBOX_STATIC_URL   = 'https://state-cache.gearbox.foundation/Monad.json'
const GEARBOX_APY_URL      = 'https://state-cache.gearbox.foundation/apy-server/latest.json'

const GEARBOX_POOL_LIST = [
  { addr: '0x09cA6b76276eC0682adb896418b99CB7E44a58A0', token: 'WMON', isStable: false },
  { addr: '0x6B343F7B797f1488AA48C49d540690F2b2c89751', token: 'USDC', isStable: true  },
  { addr: '0xc4173359087CE643235420b7bC610d9B0CF2B82D', token: 'AUSD', isStable: true  },
  { addr: '0x164A35F31e4E0F6c45D500962a6978D2cbD5a16b', token: 'USDT', isStable: true  },
  { addr: '0x34752948B0dc28969485Df2066fFE86D5dc36689', token: 'WMON', isStable: false },
]

// Returns a map of pool address (lowercase) → total extraAPY from incentive programs
async function fetchGearboxExtraApy(): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const res = await fetch(GEARBOX_APY_URL, {
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!res.ok) return map
    const data = await res.json()
    const pools: any[] = data?.chains?.['143']?.pools?.data ?? []
    const now = Math.floor(Date.now() / 1000)

    for (const entry of pools) {
      const addr = (entry?.pool ?? '').toLowerCase()
      const extraAPY: any[] = entry?.rewards?.extraAPY ?? []
      // Sum all active incentive programs (filter expired by endTimestamp)
      const total = extraAPY
        .filter((e: any) => !e.endTimestamp || e.endTimestamp > now)
        .reduce((sum: number, e: any) => sum + (Number(e.apy) || 0), 0)
      if (total > 0) map.set(addr, total)
    }
  } catch { /* ignore, just no extra APY */ }
  return map
}

async function fetchGearbox(): Promise<AprEntry[]> {
  try {
    const [poolsRes, extraApyMap] = await Promise.all([
      fetch(GEARBOX_STATIC_URL, { signal: AbortSignal.timeout(8_000), cache: 'no-store' }),
      fetchGearboxExtraApy(),
    ])
    if (!poolsRes.ok) return []
    const data = await poolsRes.json()
    const markets: any[] = data?.markets ?? []

    const out: AprEntry[] = []
    for (const m of markets) {
      const pool = m?.pool
      if (!pool || pool.isPaused) continue

      const addr: string = pool?.baseParams?.addr ?? ''
      const meta = GEARBOX_POOL_LIST.find(p => p.addr.toLowerCase() === addr.toLowerCase())
      if (!meta) continue

      const supplyRayStr: string = pool?.supplyRate?.__value ?? '0'
      const supplyRay = BigInt(supplyRayStr)
      if (supplyRay === 0n) continue

      // supplyRate is annualised in RAY (1e27)
      const baseApr = Number(supplyRay) / 1e27 * 100
      if (baseApr < 0.01 || baseApr > 500) continue

      const extraApr = extraApyMap.get(addr.toLowerCase()) ?? 0
      const apr = baseApr + extraApr

      out.push({
        protocol: 'GearBox V3',
        logo: '⚙️',
        url: 'https://app.gearbox.fi/pools?chainId=143',
        tokens: [meta.token],
        label: pool.name ?? meta.token,
        apr,
        type: 'lend',
        isStable: meta.isStable,
      })
    }
    return out
  } catch { return [] }
}

// ─── Fetch all data (used by cache) ──────────────────────────────────────────
async function fetchAllData() {
  // Fetch native APY map first (fast, ~100ms) — shared by LST vaults + Curvance
  const nativeApyMap = await fetchFloppyNativeApy()

  const [morphoR, neverlandR, eulerR, curveR, lagoonR, kuruR, lstR, uniR, pancakeR, kintsuVaultR, upshiftR, gearboxR, curvanceR] =
    await Promise.allSettled([
      fetchMorpho(),
      fetchNeverland(),
      fetchEulerV2(),
      fetchCurve(),
      fetchLagoon(),
      fetchKuru(),
      fetchLSTVaults(nativeApyMap),
      fetchUniswap(),
      fetchPancakeswap(),
      fetchKintsuVault(),
      fetchUpshift(),
      fetchGearbox(),
      fetchCurvance(nativeApyMap),
    ])

  function unwrap(r: PromiseSettledResult<AprEntry[]>): AprEntry[] {
    return r.status === 'fulfilled' ? r.value : []
  }

  const all: AprEntry[] = [
    ...unwrap(morphoR),
    ...unwrap(neverlandR),
    ...unwrap(eulerR),
    ...unwrap(curveR),
    ...unwrap(lagoonR),
    ...unwrap(kuruR),
    ...unwrap(lstR),
    ...unwrap(uniR),
    ...unwrap(pancakeR),
    ...unwrap(kintsuVaultR),
    ...unwrap(upshiftR),
    ...unwrap(gearboxR),
    ...unwrap(curvanceR),
    ...getMidas(),
  ].filter(e => e.apr > 0)

  const byApr = (a: AprEntry, b: AprEntry) => b.apr - a.apr

  const stableAPRs = all.filter(e => e.isStable).sort(byApr).slice(0, 5)
  const pools  = all.filter(e => e.type === 'pool').sort(byApr).slice(0, 10)
  const vaults = all.filter(e => e.type === 'vault').sort(byApr).slice(0, 10)
  const lends  = all.filter(e => e.type === 'lend').sort(byApr).slice(0, 10)

  return {
    stableAPRs,
    pools,
    vaults,
    lends,
    lastUpdated: Date.now(),
    totalEntries: all.length,
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export async function GET() {
  const now = Date.now()

  if (serverCache && !serverCache.promise && now - serverCache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(serverCache.data)
  }

  if (serverCache?.promise) {
    try {
      const data = await serverCache.promise
      return NextResponse.json(data)
    } catch { /* fall through to retry */ }
  }

  const promise = fetchAllData()

  serverCache = {
    data:      serverCache?.data ?? null,
    fetchedAt: serverCache?.fetchedAt ?? 0,
    promise,
  }

  try {
    const data = await promise
    serverCache = { data, fetchedAt: Date.now(), promise: null }
    return NextResponse.json(data)
  } catch {
    if (serverCache) serverCache.promise = null
    if (serverCache?.data) {
      return NextResponse.json(serverCache.data)
    }
    return NextResponse.json({ error: 'Failed to fetch APR data' }, { status: 500 })
  }
}
