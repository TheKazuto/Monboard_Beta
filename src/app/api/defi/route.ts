import { NextRequest, NextResponse } from 'next/server'
import { MONAD_RPC as RPC, rpcBatch, getMonPrice } from '@/lib/monad'
import { getAllPrices } from '@/lib/priceCache'
import { getAprEntries } from '@/lib/aprCache'

export const revalidate = 0

// ─── RPC helpers ─────────────────────────────────────────────────────────────
function ethCall(to: string, data: string, id: number) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function decodeUint(hex: string): bigint {
  if (!hex || hex === '0x') return 0n
  try { return BigInt(hex.startsWith('0x') ? hex : '0x' + hex) } catch { return 0n }
}
function balanceOfData(addr: string): string {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}
function decodeAddress(hex: string): string {
  if (!hex || hex === '0x') return '0x0000000000000000000000000000000000000000'
  return '0x' + hex.slice(2).slice(-40)
}

// ─── RPC semaphore ───────────────────────────────────────────────────────────
// Limits concurrent connections to rpc.monad.xyz to MAX_RPC_CONCURRENT.
// When 12+ fetchers run in parallel they all fire rpcBatch simultaneously,
// causing connection failures / rate limits. The semaphore serializes them.
const MAX_RPC_CONCURRENT = 3
let rpcActive = 0
const rpcQueue: Array<() => void> = []

function rpcAcquire(): Promise<void> {
  if (rpcActive < MAX_RPC_CONCURRENT) { rpcActive++; return Promise.resolve() }
  return new Promise(resolve => rpcQueue.push(() => { rpcActive++; resolve() }))
}
function rpcRelease(): void {
  rpcActive--
  const next = rpcQueue.shift()
  if (next) next()
}

async function rpcBatchThrottled(calls: object[], timeoutMs = 15_000): Promise<any[]> {
  await rpcAcquire()
  try { return await rpcBatch(calls, timeoutMs) }
  finally { rpcRelease() }
}

// ─── Token info resolver ──────────────────────────────────────────────────────
interface TokenInfo { symbol: string; decimals: number }

const TOKEN_CACHE: Record<string, TokenInfo> = {
  '0x3bd359c1119da7da1d913d1c4d2b7c461115433a': { symbol: 'WMON',  decimals: 18 },
  '0x0555e30da8f98308edb960aa94c0db47230d2b9c': { symbol: 'WBTC',  decimals: 8  },
  '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242': { symbol: 'WETH',  decimals: 18 },
  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': { symbol: 'AUSD',  decimals: 18 },
  '0x754704bc059f8c67012fed69bc8a327a5aafb603': { symbol: 'USDC',  decimals: 6  },
  '0xe7cd86e13ac4309349f30b3435a9d337750fc82d': { symbol: 'USDT0', decimals: 6  },
  '0xa3227c5969757783154c60bf0bc1944180ed81b9': { symbol: 'sMON',  decimals: 18 },
  '0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081': { symbol: 'gMON',  decimals: 18 },
  '0x1b68626dca36c7fe922fd2d55e4f631d962de19c': { symbol: 'shMON', decimals: 18 },
}

function decodeAbiString(hex: string): string {
  try {
    const d = hex.startsWith('0x') ? hex.slice(2) : hex
    if (d.length < 128) return ''
    const len = parseInt(d.slice(64, 128), 16)
    if (len === 0 || len > 100) return ''
    const str = d.slice(128, 128 + len * 2)
    return Buffer.from(str, 'hex').toString('utf8').replace(/\0/g, '').trim()
  } catch { return '' }
}

async function resolveTokens(addresses: string[]): Promise<Record<string, TokenInfo>> {
  const unique  = [...new Set(addresses.map(a => a.toLowerCase()))]
  const unknown = unique.filter(a => !TOKEN_CACHE[a])
  if (unknown.length > 0) {
    const calls: object[] = []
    unknown.forEach((addr, i) => {
      calls.push(ethCall(addr, '0x95d89b41', i * 2))
      calls.push(ethCall(addr, '0x313ce567', i * 2 + 1))
    })
    const results = await rpcBatchThrottled(calls).catch(() => [] as any[])
    unknown.forEach((addr, i) => {
      const symRaw   = results.find((r: any) => r.id === i * 2)?.result     ?? ''
      const decRaw   = results.find((r: any) => r.id === i * 2 + 1)?.result ?? ''
      const symbol   = decodeAbiString(symRaw) || addr.slice(2, 8).toUpperCase()
      const decimals = decRaw && decRaw !== '0x' ? Number(BigInt(decRaw)) : 18
      TOKEN_CACHE[addr] = { symbol, decimals }
    })
  }
  const out: Record<string, TokenInfo> = {}
  for (const addr of addresses) {
    out[addr.toLowerCase()] = TOKEN_CACHE[addr.toLowerCase()] ?? { symbol: addr.slice(2, 8).toUpperCase(), decimals: 18 }
  }
  return out
}

// ─── Price lookup ─────────────────────────────────────────────────────────────
const SYMBOL_TO_COINGECKO: Record<string, string> = {
  WMON: 'monad', MON: 'monad', sMON: 'monad', gMON: 'monad', shMON: 'monad',
  aprMON: 'monad', APR: 'monad',
  WETH: 'ethereum', WBTC: 'wrapped-bitcoin',
  USDC: 'usd-coin', USDT0: 'tether', AUSD: 'agora-dollar',
}

async function getTokenPricesUSD(symbols: string[]): Promise<Record<string, number>> {
  const stables: Record<string, number> = { USDC: 1, USDT0: 1, AUSD: 1 }
  const needed = symbols.filter(s => !stables[s])
  if (!needed.length) return stables
  try {
    const { prices } = await getAllPrices()
    const out: Record<string, number> = { ...stables }
    for (const sym of needed) {
      const id = SYMBOL_TO_COINGECKO[sym]
      if (id && prices[id]) out[sym] = prices[id]
    }
    return out
  } catch { return stables }
}

// ─── NEVERLAND ────────────────────────────────────────────────────────────────
const NEVERLAND_POOL = '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585'
const NEVERLAND_UNDERLYING: Array<{ address: string; symbol: string; decimals: number }> = [
  { address: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a', symbol: 'WMON',  decimals: 18 },
  { address: '0x0555e30da8f98308edb960aa94c0db47230d2b9c', symbol: 'WBTC',  decimals: 8  },
  { address: '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242', symbol: 'WETH',  decimals: 18 },
  { address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', symbol: 'AUSD',  decimals: 18 },
  { address: '0x754704bc059f8c67012fed69bc8a327a5aafb603', symbol: 'USDC',  decimals: 6  },
  { address: '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', symbol: 'USDT0', decimals: 6  },
  { address: '0xa3227c5969757783154c60bf0bc1944180ed81b9', symbol: 'sMON',  decimals: 18 },
  { address: '0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081', symbol: 'gMON',  decimals: 18 },
  { address: '0x1b68626dca36c7fe922fd2d55e4f631d962de19c', symbol: 'shMON', decimals: 18 },
]

async function fetchNeverland(user: string): Promise<any[]> {
  const paddedUser = user.slice(2).toLowerCase().padStart(64, '0')
  try {
    const reserveCalls = NEVERLAND_UNDERLYING.map((a, i) =>
      ethCall(NEVERLAND_POOL, '0x35ea6a75' + a.address.slice(2).toLowerCase().padStart(64, '0'), i)
    )
    reserveCalls.push(ethCall(NEVERLAND_POOL, '0xbf92857c' + paddedUser, 999))
    const reserveResults = await rpcBatchThrottled(reserveCalls)

    const discovered: Array<{ underlying: typeof NEVERLAND_UNDERLYING[0]; aToken: string; debtToken: string }> = []
    for (let i = 0; i < NEVERLAND_UNDERLYING.length; i++) {
      const hex = (reserveResults[i]?.result ?? '').slice(2)
      if (!hex || hex.length < 11 * 64) continue
      const slots    = Array.from({ length: 12 }, (_, j) => hex.slice(j * 64, (j + 1) * 64))
      const aToken    = '0x' + slots[8].slice(24)
      const debtToken = '0x' + slots[10].slice(24)
      if (aToken === '0x0000000000000000000000000000000000000000') continue
      discovered.push({ underlying: NEVERLAND_UNDERLYING[i], aToken, debtToken })
    }
    if (discovered.length === 0) return []

    let totalCollateralUSD = 0, totalDebtUSD = 0, healthFactor: number | null = null
    const acctRaw = reserveResults.find((r: any) => r.id === 999)?.result ?? null
    if (acctRaw && acctRaw !== '0x' && acctRaw.length > 10) {
      const hex = acctRaw.slice(2)
      const w   = Array.from({ length: 6 }, (_, i) => hex.slice(i * 64, (i + 1) * 64))
      totalCollateralUSD = Number(BigInt('0x' + w[0])) / 1e8
      totalDebtUSD       = Number(BigInt('0x' + w[1])) / 1e8
      const hfRaw    = BigInt('0x' + w[5])
      const MAX_U256 = BigInt('0x' + 'f'.repeat(64))
      healthFactor   = hfRaw === MAX_U256 ? null : Number(hfRaw) / 1e18
    }
    if (totalCollateralUSD < 0.01 && totalDebtUSD < 0.01) return []

    const balCalls: object[] = []
    discovered.forEach(({ aToken, debtToken }, i) => {
      balCalls.push(ethCall(aToken,    balanceOfData(user), i * 2))
      balCalls.push(ethCall(debtToken, balanceOfData(user), i * 2 + 1))
    })
    const balResults = await rpcBatchThrottled(balCalls)
    const prices     = await getTokenPricesUSD(discovered.map(d => d.underlying.symbol))

    const supplyList: Array<{ symbol: string; amount: number; amountUSD: number }> = []
    const borrowList: Array<{ symbol: string; amount: number; amountUSD: number }> = []
    discovered.forEach(({ underlying }, i) => {
      const aBal   = decodeUint(balResults.find((r: any) => r.id === i * 2)?.result     ?? '0x')
      const dBal   = decodeUint(balResults.find((r: any) => r.id === i * 2 + 1)?.result ?? '0x')
      const price  = prices[underlying.symbol] ?? 0
      const factor = Math.pow(10, underlying.decimals)
      if (aBal > 0n) { const amt = Number(aBal) / factor; if (amt >= 0.0001) supplyList.push({ symbol: underlying.symbol, amount: amt, amountUSD: amt * price }) }
      if (dBal > 0n) { const amt = Number(dBal) / factor; if (amt >= 0.0001) borrowList.push({ symbol: underlying.symbol, amount: amt, amountUSD: amt * price }) }
    })
    if (supplyList.length === 0 && totalCollateralUSD > 0.01)
      supplyList.push({ symbol: '?', amount: 0, amountUSD: totalCollateralUSD })
    if (supplyList.length === 0 && borrowList.length === 0) return []

    return [{
      protocol: 'Neverland', type: 'lending', logo: '🧚',
      url: 'https://app.neverland.money', chain: 'Monad', label: 'Neverland Position',
      supply: supplyList, borrow: borrowList,
      totalCollateralUSD, totalDebtUSD,
      netValueUSD: totalCollateralUSD - totalDebtUSD, healthFactor,
    }]
  } catch (e: any) { console.error('[defi][Neverland]', e?.message ?? e); return [] }
}

// ─── MORPHO ───────────────────────────────────────────────────────────────────
// Hybrid approach: Morpho API provides vault metadata/APR, on-chain detects actual balances.
// The Morpho API on Monad (chainId=143) doesn't yet index all deployed vaults.
// MORPHO_EXTRA_VAULTS contains known vaults not indexed by the API.
const MORPHO_API_URL = 'https://api.morpho.org/graphql'
const MORPHO_EXTRA_VAULTS = [
  '0x78999cc96d2ba0341588c60ccb0e91c6c33cf371',  // Hyperithm USDC Degen (not in API)
]

async function fetchMorpho(user: string): Promise<any[]> {
  const upad = user.slice(2).toLowerCase().padStart(64, '0')

  // Step 1: fetch vault list from Morpho API
  let apiVaults: Array<{ address: string; name: string; symbol: string; assetSymbol: string; assetDecimals: number; apy: number }> = []
  try {
    const res = await fetch(MORPHO_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query{vaults(first:100,where:{chainId_in:[143]}){items{address name symbol asset{symbol decimals} state{netApy}}}}` }),
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      apiVaults = (data?.data?.vaults?.items ?? []).map((v: any) => ({
        address:      (v.address ?? '').toLowerCase(),
        name:         v.name ?? v.symbol ?? '',
        symbol:       v.symbol ?? '',
        assetSymbol:  v.asset?.symbol ?? 'USDC',
        assetDecimals: Number(v.asset?.decimals ?? 6),
        apy:          Number(v.state?.netApy ?? 0) * 100,
      })).filter((v: any) => v.address)
    }
  } catch { /* fall through to on-chain only */ }

  // Merge API vaults with extra known vaults (deduplicated)
  const apiAddrs = new Set(apiVaults.map(v => v.address))
  const allAddrs = [
    ...apiVaults.map(v => v.address),
    ...MORPHO_EXTRA_VAULTS.map(a => a.toLowerCase()).filter(a => !apiAddrs.has(a)),
  ]
  if (!allAddrs.length) return []

  // Step 2: on-chain — balanceOf + totalAssets + totalSupply + asset() for each vault
  const calls: any[] = []
  allAddrs.forEach((addr, i) => {
    calls.push(ethCall(addr, balanceOfData(user), i * 4))
    calls.push(ethCall(addr, '0x01e1d114',         i * 4 + 1))  // totalAssets()
    calls.push(ethCall(addr, '0x18160ddd',         i * 4 + 2))  // totalSupply()
    calls.push(ethCall(addr, '0x38d52e0f',         i * 4 + 3))  // asset()
  })
  const results = await rpcBatchThrottled(calls, 12_000)
  const getR = (n: number) => results.find((r: any) => Number(r.id) === n)?.result ?? '0x'

  const positions: any[] = []
  for (let i = 0; i < allAddrs.length; i++) {
    const addr    = allAddrs[i]
    const shares  = decodeUint(getR(i * 4))
    if (shares === 0n) continue
    const taRaw   = decodeUint(getR(i * 4 + 1))
    const tsRaw   = decodeUint(getR(i * 4 + 2))
    if (tsRaw === 0n || taRaw === 0n) continue

    // Get metadata from API if available, otherwise resolve from chain
    const meta = apiVaults.find(v => v.address === addr)
    const assetDec   = meta?.assetDecimals ?? 6
    const assetSym   = meta?.assetSymbol ?? 'USDC'
    const vaultName  = meta?.name ?? ''
    const apy        = meta?.apy ?? 0

    // ERC4626: user assets = (shares / totalSupply) * totalAssets
    const userAssets = Number(shares) / Number(tsRaw) * Number(taRaw) / Math.pow(10, assetDec)
    if (userAssets < 0.001) continue

    // Price: stables = $1 (USDC, USDT, AUSD), others need lookup
    const STABLES = new Set(['USDC', 'USDT', 'USDT0', 'AUSD'])
    const amountUSD = STABLES.has(assetSym) ? userAssets : userAssets  // extend for non-stables if needed
    if (amountUSD < 0.01) continue

    const url = `https://app.morpho.org/monad/vault?address=${addr}`
    positions.push({
      protocol: 'Morpho', type: 'vault', logo: '🦋', url, chain: 'Monad',
      label: vaultName || assetSym, asset: assetSym,
      amountUSD, apy, netValueUSD: amountUSD,
    })
  }
  return positions
}


// ─── UNISWAP V3 / PANCAKESWAP V3 ─────────────────────────────────────────────
const UNI_NFT_PM  = '0x7197e214c0b767cfb76fb734ab638e2c192f4e53'
const UNI_FACTORY = '0x204faca1764b154221e35c0d20abb3c525710498'

function tokenOfOwnerByIndex(owner: string, idx: bigint): string {
  return '0x2f745c59' + owner.slice(2).toLowerCase().padStart(64, '0') + idx.toString(16).padStart(64, '0')
}
function positionsData(tokenId: bigint): string {
  return '0x99fbab88' + tokenId.toString(16).padStart(64, '0')
}
function getPoolData(t0: string, t1: string, fee: number): string {
  return '0x1698ee82'
    + t0.slice(2).toLowerCase().padStart(64, '0')
    + t1.slice(2).toLowerCase().padStart(64, '0')
    + fee.toString(16).padStart(64, '0')
}

function calcV3Amounts(
  liquidity: bigint, sqrtPriceX96: bigint,
  tickLower: number, tickUpper: number, currentTick: number,
  decimals0: number, decimals1: number,
): { amount0: number; amount1: number } {
  const L = Number(liquidity), sqrtP = Number(sqrtPriceX96) / (2 ** 96)
  const sqrtA = Math.sqrt(Math.pow(1.0001, tickLower))
  const sqrtB = Math.sqrt(Math.pow(1.0001, tickUpper))
  let amount0 = 0, amount1 = 0
  if (currentTick < tickLower)       { amount0 = L * (1 / sqrtA - 1 / sqrtB) }
  else if (currentTick >= tickUpper) { amount1 = L * (sqrtB - sqrtA) }
  else                               { amount0 = L * (1 / sqrtP - 1 / sqrtB); amount1 = L * (sqrtP - sqrtA) }
  return { amount0: amount0 / Math.pow(10, decimals0), amount1: amount1 / Math.pow(10, decimals1) }
}

async function fetchUniswapV3(user: string, protocol: string, nftPM: string, factory: string): Promise<any[]> {
  try {
    const balRes   = await rpcBatchThrottled([ethCall(nftPM, balanceOfData(user), 1)])
    const nftCount = Number(decodeUint(balRes[0]?.result ?? '0x'))
    if (nftCount === 0) return []

    const limit     = Math.min(nftCount, 20)
    const idCalls   = Array.from({ length: limit }, (_, i) => ethCall(nftPM, tokenOfOwnerByIndex(user, BigInt(i)), i + 10))
    const idResults = await rpcBatchThrottled(idCalls)
    const tokenIds  = idResults.map((r: any) => decodeUint(r?.result ?? '0x')).filter((id: bigint) => id > 0n)
    if (!tokenIds.length) return []

    const posCalls   = tokenIds.map((id: bigint, i: number) => ethCall(nftPM, positionsData(id), i + 200))
    const posResults = await rpcBatchThrottled(posCalls)

    const tokenAddresses = new Set<string>()
    const parsedPositions: Array<{ token0: string; token1: string; fee: number; tickLower: number; tickUpper: number; liquidity: bigint }> = []

    for (let i = 0; i < tokenIds.length; i++) {
      const hex = posResults[i]?.result
      if (!hex || hex === '0x' || hex.length < 10) continue
      const d = hex.slice(2)
      if (d.length < 64 * 8) continue
      const w         = Array.from({ length: 12 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const token0    = '0x' + w[2].slice(24)
      const token1    = '0x' + w[3].slice(24)
      const fee       = parseInt(w[4], 16)
      const tL        = parseInt(w[5], 16)
      const tU        = parseInt(w[6], 16)
      const tickLower = tL > 0x7fffffff ? tL - 0x100000000 : tL
      const tickUpper = tU > 0x7fffffff ? tU - 0x100000000 : tU
      const liquidity = BigInt('0x' + w[7])
      if (liquidity === 0n) continue
      tokenAddresses.add(token0.toLowerCase())
      tokenAddresses.add(token1.toLowerCase())
      parsedPositions.push({ token0, token1, fee, tickLower, tickUpper, liquidity })
    }
    if (!parsedPositions.length) return []

    const tokenInfoMap = await resolveTokens([...tokenAddresses]).catch(() => ({} as Record<string, TokenInfo>))

    const poolCalls: object[] = []
    const poolMeta: Record<number, any> = {}
    let pcIdx = 500
    for (const pos of parsedPositions) {
      const t0 = tokenInfoMap[pos.token0.toLowerCase()] ?? { symbol: pos.token0.slice(2, 8).toUpperCase(), decimals: 18 }
      const t1 = tokenInfoMap[pos.token1.toLowerCase()] ?? { symbol: pos.token1.slice(2, 8).toUpperCase(), decimals: 18 }
      poolCalls.push(ethCall(factory, getPoolData(pos.token0, pos.token1, pos.fee), pcIdx))
      poolMeta[pcIdx] = { ...pos, t0sym: t0.symbol, t1sym: t1.symbol, t0dec: t0.decimals, t1dec: t1.decimals }
      pcIdx++
    }

    const poolAddrResults = await rpcBatchThrottled(poolCalls)
    const slot0Calls: object[] = []
    const slot0Meta: Record<number, any> = {}
    let s0Idx = 600
    for (const res of poolAddrResults) {
      const meta = poolMeta[Number(res.id)]
      if (!meta || !res.result || res.result === '0x') continue
      const poolAddr = decodeAddress(res.result)
      if (poolAddr === '0x0000000000000000000000000000000000000000') continue
      slot0Calls.push(ethCall(poolAddr, '0x3850c7bd', s0Idx))
      slot0Meta[s0Idx] = meta
      s0Idx++
    }
    if (!slot0Calls.length) return []

    const slot0Results = await rpcBatchThrottled(slot0Calls)
    const allSymbols = [...new Set(Object.values(slot0Meta).flatMap((m: any) => [m.t0sym, m.t1sym]))]
    const prices     = await getTokenPricesUSD(allSymbols)

    const positions: any[] = []
    for (const s0 of slot0Results) {
      const meta = slot0Meta[Number(s0.id)]
      if (!meta || !s0.result || s0.result === '0x' || s0.result.length < 10) continue
      const d  = s0.result.slice(2)
      const w  = Array.from({ length: 4 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const ct = parseInt(w[1], 16)
      const currentTick  = ct > 0x7fffffff ? ct - 0x100000000 : ct
      const sqrtPriceX96 = BigInt('0x' + w[0])
      const inRange      = currentTick >= meta.tickLower && currentTick <= meta.tickUpper
      const { amount0, amount1 } = calcV3Amounts(meta.liquidity, sqrtPriceX96, meta.tickLower, meta.tickUpper, currentTick, meta.t0dec, meta.t1dec)
      const amountUSD = amount0 * (prices[meta.t0sym] ?? 0) + amount1 * (prices[meta.t1sym] ?? 0)
      positions.push({
        protocol, type: 'liquidity',
        logo:    protocol === 'PancakeSwap V3' ? '🥞' : '🦄',
        url:     protocol === 'PancakeSwap V3' ? 'https://pancakeswap.finance' : 'https://app.uniswap.org',
        chain:   'Monad',
        label:   `${meta.t0sym}/${meta.t1sym} ${meta.fee / 10000}%`,
        tokens:  [meta.t0sym, meta.t1sym],
        amounts: { [meta.t0sym]: amount0, [meta.t1sym]: amount1 },
        inRange, tickLower: meta.tickLower, tickUpper: meta.tickUpper, currentTick,
        amountUSD, netValueUSD: amountUSD,
      })
    }
    return positions
  } catch (e: any) { console.error('[defi][UniswapV3]', e?.message ?? e); return [] }
}

// ─── CURVE ────────────────────────────────────────────────────────────────────
async function fetchCurve(user: string): Promise<any[]> {
  const BASE       = 'https://api-core.curve.finance/v1'
  const paddedAddr = user.slice(2).toLowerCase().padStart(64, '0')

  const poolResults = await Promise.allSettled(
    ['factory-twocrypto', 'factory-stable-ng'].map(t =>
      fetch(`${BASE}/getPools/monad/${t}`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).catch(() => null)
    )
  )
  const allPools: any[] = []
  for (const r of poolResults) {
    if (r.status === 'fulfilled' && r.value?.data?.poolData) allPools.push(...r.value.data.poolData)
  }
  if (allPools.length === 0) return []

  const CHUNK = 15
  const rpcResults: any[] = []
  for (let start = 0; start < allPools.length; start += CHUNK) {
    const chunk = allPools.slice(start, start + CHUNK)
    const calls = chunk.map((pool, j) => ({
      jsonrpc: '2.0', id: start + j, method: 'eth_call',
      params: [{ to: pool.lpTokenAddress ?? pool.address, data: '0x70a08231' + paddedAddr }, 'latest'],
    }))
    try {
      const res = await rpcBatchThrottled(calls, 12_000)
      rpcResults.push(...res)
    } catch { /* chunk failed — skip */ }
  }

  const positions: any[] = []
  for (let i = 0; i < allPools.length; i++) {
    const r = rpcResults.find((x: any) => Number(x.id) === i)
    const raw = r?.result ?? '0x'
    if (!raw || raw === '0x' || raw === '0x' + '0'.repeat(64)) continue
    let balanceRaw: bigint
    try { balanceRaw = BigInt(raw) } catch { continue }
    if (balanceRaw === 0n) continue

    const pool           = allPools[i]
    const totalSupplyRaw = (() => { try { return BigInt(pool.totalSupply ?? '0') } catch { return 0n } })()
    const lpPrice        = Number(pool.lpTokenPrice ?? 0)
    const userBal        = Number(balanceRaw) / 1e18
    const netValueUSD    = lpPrice > 0
      ? userBal * lpPrice
      : totalSupplyRaw > 0n
        ? (Number(balanceRaw) / Number(totalSupplyRaw)) * Number(pool.usdTotalExcludingBasePool ?? pool.usdTotal ?? 0)
        : 0
    if (netValueUSD < 0.01) continue

    const coins = pool.coins?.map((c: any) => c.symbol) ?? []
    positions.push({
      protocol: 'Curve', type: 'liquidity', logo: '🌊',
      url: `https://curve.finance/dex/monad/pools/${pool.id ?? pool.address}/deposit`, chain: 'Monad',
      label: pool.name ?? coins.join('/'), tokens: coins,
      amountUSD: netValueUSD, apy: 0, netValueUSD, inRange: null,
    })
  }
  return positions
}

// ─── GEARBOX ──────────────────────────────────────────────────────────────────
const GEARBOX_STATIC_URL = 'https://state-cache.gearbox.foundation/Monad.json'
const GEARBOX_TOKEN_MAP: Record<string, { token: string; isStable: boolean }> = {
  '0x34752948b0dc28969485df2066ffe86d5dc36689': { token: 'WMON', isStable: false },
  '0x09ca6b76276ec0682adb896418b99cb7e44a58a0': { token: 'WMON', isStable: false },
  '0x6b343f7b797f1488aa48c49d540690f2b2c89751': { token: 'USDC', isStable: true  },
  '0xc4173359087ce643235420b7bc610d9b0cf2b82d': { token: 'AUSD', isStable: true  },
  '0x164a35f31e4e0f6c45d500962a6978d2cbd5a16b': { token: 'USDT', isStable: true  },
}

async function fetchGearbox(user: string, monPrice: number): Promise<any[]> {
  try {
    const res = await fetch(GEARBOX_STATIC_URL, { signal: AbortSignal.timeout(8_000), cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    const pools = (data?.markets ?? [])
      .map((m: any) => m?.pool)
      .filter((p: any) => p && !!GEARBOX_TOKEN_MAP[(p?.baseParams?.addr ?? '').toLowerCase()])
    if (!pools.length) return []

    const calls   = pools.map((p: any, i: number) => ethCall(p.baseParams.addr, balanceOfData(user), i + 200))
    const results = await rpcBatchThrottled(calls)

    const positions: any[] = []
    for (let i = 0; i < pools.length; i++) {
      const pool  = pools[i]
      const addr  = (pool?.baseParams?.addr ?? '').toLowerCase()
      const meta  = GEARBOX_TOKEN_MAP[addr]
      if (!meta) continue
      const shares = decodeUint(results.find((r: any) => Number(r.id) === i + 200)?.result ?? '0x')
      if (shares === 0n) continue

      const decimals    = Number(pool.decimals ?? 18)
      const sharesFloat = Number(shares) / Math.pow(10, decimals)
      const expectedLiq = BigInt(pool.expectedLiquidity?.__value ?? '0')
      const totalSupply = BigInt(pool.totalSupply?.__value ?? pool.totalSupply ?? '0')
      if (totalSupply === 0n) continue

      // Exchange rate = expectedLiq / totalSupply (both in raw decimals)
      const exchangeRate = Number(expectedLiq) / Number(totalSupply)
      // For stables: amountUSD = shares * exchangeRate (already in USD)
      // For MON pools: amountUSD = shares * exchangeRate * monPrice
      const amountUSD = meta.isStable
        ? sharesFloat * exchangeRate
        : sharesFloat * exchangeRate * monPrice

      if (amountUSD < 0.01) continue
      positions.push({
        protocol: 'GearBox V3', type: 'vault', logo: '⚙️',
        url: 'https://app.gearbox.fi/pools?chainId=143', chain: 'Monad',
        label: pool.name ?? meta.token, asset: meta.token,
        amount: sharesFloat, amountUSD, apy: 0, netValueUSD: amountUSD,
      })
    }
    return positions
  } catch (e: any) { console.error('[defi][Gearbox]', e?.message ?? e); return [] }
}

// ─── UPSHIFT ──────────────────────────────────────────────────────────────────
const UPSHIFT_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}
const UPSHIFT_IGNORE       = new Set(['0x792c7c5fb5c996e588b9f4a5fb201c79974e267c'])
const UPSHIFT_SHARE_TOKEN_SEL = '0xf5ae497a'

function upshiftTokenFromName(name: string): string {
  if (/AUSD/i.test(name))      return 'AUSD'
  if (/USDC/i.test(name))      return 'USDC'
  if (/USDT/i.test(name))      return 'USDT'
  if (/BTC|wBTC/i.test(name)) return 'WBTC'
  if (/MON/i.test(name))       return 'MON'
  return '?'
}

async function fetchUpshift(user: string): Promise<any[]> {
  try {
    const res = await fetch('https://api.upshift.finance/metrics/vaults_summary', {
      headers: UPSHIFT_API_HEADERS, signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    if (!res.ok) return []
    const raw: any[] = await res.json()
    const vaults = (Array.isArray(raw) ? raw : []).filter((v: any) => {
      if (v.chain !== 143) return false
      if (/test|bugbash/i.test(v.vault_name ?? '')) return false
      if (UPSHIFT_IGNORE.has((v.address ?? '').toLowerCase())) return false
      return Number(v.total_assets ?? 0) * Number(v.underlying_price ?? 0) >= 1
    })
    if (!vaults.length) return []

    // Resolve share tokens in one batch
    const shareTokenResults = await rpcBatchThrottled(vaults.map((v: any, i: number) => ethCall(v.address, UPSHIFT_SHARE_TOKEN_SEL, i)))
    const shareTokenAddrs = vaults.map((v: any, i: number) => {
      const addr = decodeAddress(shareTokenResults.find((x: any) => Number(x.id) === i)?.result ?? '')
      return (addr && addr !== '0x0000000000000000000000000000000000000000') ? addr : v.address.toLowerCase()
    })

    const results = await rpcBatchThrottled(shareTokenAddrs.map((addr: string, i: number) => ethCall(addr, balanceOfData(user), i + 700)))

    const positions: any[] = []
    for (let i = 0; i < vaults.length; i++) {
      const v      = vaults[i]
      const shares = decodeUint(results.find((r: any) => Number(r.id) === i + 700)?.result ?? '0x')
      if (shares === 0n) continue
      const sharesFloat = Number(shares) / 1e18
      const amountUSD   = sharesFloat * Number(v.asset_share_ratio ?? 1) * Number(v.underlying_price ?? 0)
      if (amountUSD < 0.01) continue
      positions.push({
        protocol: 'Upshift', type: 'vault', logo: '🔺',
        url: `https://app.upshift.finance/vaults/${v.address}`, chain: 'Monad',
        label: v.vault_name ?? '', asset: upshiftTokenFromName(v.vault_name ?? ''),
        amount: sharesFloat, amountUSD, apy: 0, netValueUSD: amountUSD,
      })
    }
    return positions
  } catch (e: any) { console.error('[defi][Upshift]', e?.message ?? e); return [] }
}

// ─── MON LSTs (Kintsu + Magma + shMonad) ─────────────────────────────────────
// Consolidated fetcher: single balanceOf batch, then previewRedeem only for non-zero balances.
// Replaces 3 separate fetchers with up to 6 sequential rpcBatch calls.
const MON_LSTS = [
  { addr: '0xA3227C5969757783154C60bF0bC1944180ed81B9', protocol: 'Kintsu',  logo: '🔵', url: 'https://kintsu.xyz',      label: 'Staked MON',              asset: 'sMON',  redeemSel: '0x4cdad506' },
  { addr: '0x8498312a6b3CBD158Bf0c93ABdcF29E6e4f55081', protocol: 'Magma',   logo: '🐲', url: 'https://magmastaking.xyz', label: 'MEV-Optimized Staked MON', asset: 'gMON',  redeemSel: '0x07a2d13a' },
  { addr: '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c', protocol: 'shMonad', logo: '⚡', url: 'https://shmonad.xyz',     label: 'Holistic Staked MON',      asset: 'shMON', redeemSel: '0x4cdad506' },
]

async function fetchMonLSTs(user: string, monPrice: number): Promise<any[]> {
  try {
    // Step 1: balanceOf for all three in one batch
    const balResults = await rpcBatchThrottled(MON_LSTS.map((lst, i) => ethCall(lst.addr, balanceOfData(user), i)))
    const withBalance = MON_LSTS.map((lst, i) => ({
      ...lst,
      shares: decodeUint(balResults.find((r: any) => Number(r.id) === i)?.result ?? '0x'),
    })).filter(lst => lst.shares > 0n && Number(lst.shares) / 1e18 >= 0.001)

    if (!withBalance.length) return []

    // Step 2: previewRedeem only for LSTs with balance
    const redeemResults = await rpcBatchThrottled(withBalance.map((lst, i) =>
      ethCall(lst.addr, lst.redeemSel + lst.shares.toString(16).padStart(64, '0'), i + 10)
    ))

    return withBalance.map((lst, i) => {
      const sharesFloat = Number(lst.shares) / 1e18
      const monAmt      = Number(decodeUint(redeemResults.find((r: any) => Number(r.id) === i + 10)?.result ?? '0x')) / 1e18 || sharesFloat
      const amountUSD   = monAmt * monPrice
      return {
        protocol: lst.protocol, type: 'vault', logo: lst.logo, url: lst.url, chain: 'Monad',
        label: lst.label, asset: lst.asset, amount: sharesFloat, amountUSD, apy: 0, netValueUSD: amountUSD,
      }
    })
  } catch (e: any) { console.error('[defi][MonLSTs]', e?.message ?? e); return [] }
}

// ─── LAGOON ───────────────────────────────────────────────────────────────────
async function fetchLagoon(user: string): Promise<any[]> {
  const paddedAddr = user.slice(2).toLowerCase().padStart(64, '0')
  try {
    const res = await fetch(
      'https://app.lagoon.finance/api/vaults?chainId=143&underlyingassetSymbol=0&curatorId=0&pageIndex=0&pageSize=50&includeApr=true',
      {
        signal: AbortSignal.timeout(8_000), cache: 'no-store',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept': 'application/json' },
      }
    )
    if (!res.ok) return []
    const data   = await res.json()
    const vaults: any[] = data?.vaults ?? data ?? []
    if (!vaults.length) return []

    const calls = vaults.flatMap((v: any, i: number) => [
      ethCall(v.address, '0x70a08231' + paddedAddr, i * 3),
      ethCall(v.address, '0x01e1d114', i * 3 + 1),
      ethCall(v.address, '0x18160ddd', i * 3 + 2),
    ])
    const results = await rpcBatchThrottled(calls)

    const positions: any[] = []
    for (let i = 0; i < vaults.length; i++) {
      const v           = vaults[i]
      const shares      = decodeUint(results.find((r: any) => Number(r.id) === i * 3)?.result     ?? '0x')
      if (shares === 0n) continue
      const totalAssets = decodeUint(results.find((r: any) => Number(r.id) === i * 3 + 1)?.result ?? '0x')
      const totalSupply = decodeUint(results.find((r: any) => Number(r.id) === i * 3 + 2)?.result ?? '0x')
      if (totalSupply === 0n) continue

      const shareDec   = Number(v.decimals ?? 18)
      const assetDec   = Number(v.asset?.decimals ?? 18)
      const assetPrice = Number(v.asset?.priceUsd ?? 1)
      const shareFloat = Number(shares)      / Math.pow(10, shareDec)
      const assetsUSD  = Number(totalAssets) / Math.pow(10, assetDec)
      const supplyFlt  = Number(totalSupply) / Math.pow(10, shareDec)
      const amountUSD  = shareFloat * (assetsUSD / supplyFlt) * assetPrice
      if (amountUSD < 0.01) continue

      const s   = v.state ?? {}
      const apr = s.weeklyApr?.linearNetApr ?? s.monthlyApr?.linearNetApr ?? s.inceptionApr?.linearNetApr ?? 0
      const sym = v.asset?.symbol ?? v.symbol ?? 'USDC'
      positions.push({
        protocol: 'Lagoon', type: 'vault', logo: '🏝️',
        url: `https://app.lagoon.finance/vault/143/${v.address}`, chain: 'Monad',
        label: v.name ?? v.symbol ?? 'Lagoon Vault', asset: sym, tokens: [sym],
        amountUSD, apy: apr, netValueUSD: amountUSD,
      })
    }
    return positions
  } catch (e: any) { console.error('[defi][Lagoon]', e?.message ?? e); return [] }
}

// ─── KURU ─────────────────────────────────────────────────────────────────────
const KURU_API     = 'https://api.kuru.io/api/v3/vaults'
const KURU_NAV_SEL = '0xe04d89da'
const KURU_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Origin': 'https://www.kuru.io',
  'Referer': 'https://www.kuru.io/',
}
const KURU_LEGACY_VAULTS = [
  { address: '0x4869a4c7657cef5e5496c9ce56dde4cd593e4923', name: 'Kuru MON/AUSD', base: 'MON', quote: 'AUSD', quoteDec: 6 },
  { address: '0xd0f8a6422ccdd812f29d8fb75cf5fcd41483badc', name: 'Kuru MON/USDC', base: 'MON', quote: 'USDC', quoteDec: 6 },
]

async function fetchKuru(user: string): Promise<any[]> {
  try {
    type VaultMeta = { address: string; name: string; base: string; quote: string; quoteDec: number }
    let apiMetas: VaultMeta[] = []
    try {
      const apiRes = await fetch(KURU_API, { signal: AbortSignal.timeout(8_000), cache: 'no-store', headers: KURU_HEADERS })
      if (apiRes.ok) {
        const apiData  = await apiRes.json()
        const vaultList = apiData?.data?.data ?? apiData?.data ?? []
        apiMetas = (Array.isArray(vaultList) ? vaultList : []).map((v: any) => ({
          address:  (v.vaultAddress ?? v.vaultaddress ?? '').toLowerCase(),
          name:     `Kuru ${v.baseToken?.ticker ?? v.basetoken?.ticker ?? '?'}/${v.quoteToken?.ticker ?? v.quotetoken?.ticker ?? '?'}`,
          base:     v.baseToken?.ticker  ?? v.basetoken?.ticker  ?? '?',
          quote:    v.quoteToken?.ticker ?? v.quotetoken?.ticker ?? '?',
          quoteDec: Number(v.quoteToken?.decimal ?? v.quotetoken?.decimal ?? 6),
        })).filter((m: VaultMeta) => m.address)
      }
    } catch { /* use legacy only */ }

    const seen  = new Set(apiMetas.map((m: VaultMeta) => m.address))
    const metas = [...apiMetas, ...KURU_LEGACY_VAULTS.filter(v => !seen.has(v.address.toLowerCase()))]
    if (!metas.length) return []

    const calls: any[] = []
    metas.forEach((m, i) => {
      calls.push(ethCall(m.address, balanceOfData(user), 900 + i * 3))
      calls.push(ethCall(m.address, '0x18160ddd',        901 + i * 3))
      calls.push(ethCall(m.address, KURU_NAV_SEL,        902 + i * 3))
    })
    const results = await rpcBatchThrottled(calls)

    const items: any[] = []
    metas.forEach((m, i) => {
      const shares      = decodeUint(results.find((r: any) => Number(r.id) === 900 + i * 3)?.result ?? '0x')
      if (shares === 0n) return
      const totalSupply = decodeUint(results.find((r: any) => Number(r.id) === 901 + i * 3)?.result ?? '0x')
      if (totalSupply === 0n) return
      const navRaw_res = results.find((r: any) => Number(r.id) === 902 + i * 3)?.result ?? '0x'
      const navRaw = navRaw_res && navRaw_res.length >= 130
        ? BigInt('0x' + navRaw_res.slice(66, 130))
        : decodeUint(navRaw_res)
      if (navRaw === 0n) return
      const amountUSD = (Number(shares) / Number(totalSupply)) * (Number(navRaw) / Math.pow(10, m.quoteDec))
      if (amountUSD < 0.01) return
      items.push({
        protocol: 'Kuru', type: 'liquidity', logo: '🌀',
        url: `https://www.kuru.io/vaults/${m.address}`, chain: 'Monad',
        label: m.name, tokens: [m.base, m.quote],
        amountUSD, apy: 0, netValueUSD: amountUSD, inRange: null,
      })
    })
    return items
  } catch (e: any) { console.error('[defi][Kuru]', e?.message ?? e); return [] }
}

// ─── CURVANCE ─────────────────────────────────────────────────────────────────
// Supply cTokens: supply shares in slot[4] of 0x21570256(user) struct.
//                 convert via (shares / totalSupply) * totalAssets * assetPrice
// Debt cTokens:   borrow balance via selector 0x11005b07(user) in asset decimals.
// Health Factor:  totalSupplyUSD / totalBorrowUSD (simple collateral/debt ratio).
// New markets: add cToken address to SUPPLY or DEBT list below.
const CURVANCE_SUPPLY_CTOKENS: Array<{ addr: string; symbol: string; underlying: string; assetDec: number }> = [
  { addr: '0x1e240e30e51491546dec3af16b0b4eac8dd110d4', symbol: 'cWMON',   underlying: 'WMON', assetDec: 18 },
  { addr: '0xd9e2025b907e95ecc963a5018f56b87575b4ab26', symbol: 'caprMON', underlying: 'aprMON', assetDec: 18 },
  { addr: '0x926c101cf0a3de8725eb24a93e980f9fe34d6230', symbol: 'cshMON',  underlying: 'shMON', assetDec: 18 },
  { addr: '0x494876051b0e85dce5ecd5822b1ad39b9660c928', symbol: 'csMON',   underlying: 'sMON', assetDec: 18 },
  { addr: '0x5ca6966543c0786f547446234492d2f11c82f11f', symbol: 'cgMON',   underlying: 'gMON', assetDec: 18 },
]
const CURVANCE_DEBT_CTOKENS: Array<{ addr: string; symbol: string; underlying: string; assetDec: number }> = [
  { addr: '0x8ee9fc28b8da872c38a496e9ddb9700bb7261774', symbol: 'dUSDC', underlying: 'USDC', assetDec: 6 },
]
const CURVANCE_MARKET_MGR  = '0x1310f352f1389969ece6741671c4b919523912ff'
const CURVANCE_BORROW_SEL  = '0x11005b07'  // borrowDebt(address) → uint256 in asset decimals

async function fetchCurvance(user: string, monPrice: number): Promise<any[]> {
  try {
    const STABLES = new Set(['USDC', 'AUSD', 'USDT'])
    const upad    = user.slice(2).toLowerCase().padStart(64, '0')

    // Single batch: supply struct+totalAssets+totalSupply, debt balance, oracle prices
    const calls: any[] = []
    let id = 0

    CURVANCE_SUPPLY_CTOKENS.forEach(ct => {
      calls.push(ethCall(ct.addr, '0x21570256' + upad, id++))  // position struct — slot[4]=shares
      calls.push(ethCall(ct.addr, '0x01e1d114',        id++))  // totalAssets()
      calls.push(ethCall(ct.addr, '0x18160ddd',        id++))  // totalSupply()
    })
    const debtStartId = id
    CURVANCE_DEBT_CTOKENS.forEach(ct => {
      calls.push(ethCall(ct.addr, CURVANCE_BORROW_SEL + upad, id++))
    })
    const results = await rpcBatchThrottled(calls, 12_000)
    const getR = (n: number) => results.find((r: any) => Number(r.id) === n)?.result ?? '0x'

    // Price: stables = $1, everything else = monPrice from CoinGecko
    const price = (sym: string): number => STABLES.has(sym) ? 1 : (monPrice || 0.024)

    const supplyItems: Array<{ symbol: string; underlying: string; amount: number; amountUSD: number }> = []
    const borrowItems: Array<{ symbol: string; underlying: string; amount: number; amountUSD: number }> = []
    let baseId = 0

    CURVANCE_SUPPLY_CTOKENS.forEach(ct => {
      const structRaw = getR(baseId++)
      const assetsRaw = decodeUint(getR(baseId++))
      const supplyRaw = decodeUint(getR(baseId++))
      if (!structRaw || structRaw === '0x' || structRaw.length < 2 + 6 * 64) return
      const sharesRaw = BigInt('0x' + structRaw.slice(2).slice(4 * 64, 5 * 64))
      if (sharesRaw === 0n || supplyRaw === 0n || assetsRaw === 0n) return
      const userAssets = Number(sharesRaw) / Number(supplyRaw) * Number(assetsRaw) / Math.pow(10, ct.assetDec)
      if (userAssets < 0.001) return
      const amountUSD = userAssets * price(ct.underlying)
      if (amountUSD < 0.01) return
      supplyItems.push({ symbol: ct.symbol, underlying: ct.underlying, amount: userAssets, amountUSD })
    })

    CURVANCE_DEBT_CTOKENS.forEach((ct, i) => {
      const debtRaw = decodeUint(getR(debtStartId + i))
      if (debtRaw === 0n) return
      const amount    = Number(debtRaw) / Math.pow(10, ct.assetDec)
      const amountUSD = amount * price(ct.underlying)
      if (amountUSD < 0.01) return
      borrowItems.push({ symbol: ct.symbol, underlying: ct.underlying, amount, amountUSD })
    })

    if (supplyItems.length === 0 && borrowItems.length === 0) return []

    const totalSupplyUSD = supplyItems.reduce((s, x) => s + x.amountUSD, 0)
    const totalBorrowUSD = borrowItems.reduce((s, x) => s + x.amountUSD, 0)
    const netValueUSD    = totalSupplyUSD - totalBorrowUSD
    // Health Factor: totalSupplyUSD / totalBorrowUSD (standard convention: 1.0 = liquidation threshold).
    // Curvance's UI shows (1 - borrow/collateral)*100% which maps to the same scale.
    // e.g. HF=1.92 → (1 - 1/1.92)*100 ≈ 48% remaining buffer — same position, different display.
    const healthFactor   = totalBorrowUSD > 0 && totalSupplyUSD > 0
      ? totalSupplyUSD / totalBorrowUSD
      : null

    return [{
      protocol: 'Curvance', type: 'lending', logo: '💎',
      url: 'https://monad.curvance.com', chain: 'Monad', label: 'Curvance Position',
      supply:   supplyItems.map(x => ({ symbol: x.underlying, amount: x.amount, amountUSD: x.amountUSD })),
      borrow:   borrowItems.map(x => ({ symbol: x.underlying, amount: x.amount, amountUSD: x.amountUSD })),
      totalCollateralUSD: totalSupplyUSD,
      totalDebtUSD:       totalBorrowUSD,
      netValueUSD,
      healthFactor,
    }]
  } catch (e: any) { console.error('[defi][Curvance]', e?.message ?? e); return [] }
}

// ─── EULER V2 ─────────────────────────────────────────────────────────────────
async function fetchEulerV2(user: string): Promise<any[]> {
  const query = `query($account:String!,$chainId:Int!){
    userPositions(where:{account:$account,chainId:$chainId}){
      vault{address name asset{symbol decimals}}
      supplyShares supplyAssetsUsd borrowShares borrowAssetsUsd healthScore
    }
  }`
  try {
    const res = await fetch('https://api.euler.finance/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: user.toLowerCase(), chainId: 143 } }),
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    if (!res.ok) return []
    const data      = await res.json()
    const positions = data?.data?.userPositions ?? []
    return positions
      .filter((p: any) => Number(p.supplyAssetsUsd ?? 0) + Number(p.borrowAssetsUsd ?? 0) > 0.01)
      .map((p: any) => {
        const supUSD = Number(p.supplyAssetsUsd ?? 0)
        const borUSD = Number(p.borrowAssetsUsd ?? 0)
        const sym    = p.vault?.asset?.symbol ?? '?'
        return {
          protocol: 'Euler V2', type: 'lending', logo: '📐',
          url: 'https://app.euler.finance', chain: 'Monad', label: p.vault?.name ?? sym,
          supply: supUSD > 0.01 ? [{ symbol: sym, amountUSD: supUSD }] : [],
          collateral: [], borrow: borUSD > 0.01 ? [{ symbol: sym, amountUSD: borUSD }] : [],
          totalCollateralUSD: supUSD, totalDebtUSD: borUSD,
          netValueUSD: supUSD - borUSD,
          healthFactor: p.healthScore ? Number(p.healthScore) : null,
        }
      })
  } catch (e: any) { console.error('[defi][EulerV2]', e?.message ?? e); return [] }
}

// ─── APR INJECTION ────────────────────────────────────────────────────────────
type AprLookup = Map<string, number>

function entriesToLookup(entries: Array<{ protocol: string; tokens: string[]; label: string; apr: number }>): AprLookup {
  const map = new Map<string, number>()
  for (const e of entries) {
    const proto = String(e.protocol ?? '')
    const apr   = Number(e.apr ?? 0)
    if (!proto || apr <= 0) continue
    if (Array.isArray(e.tokens) && e.tokens.length > 0) {
      const k = proto + ':' + e.tokens.slice().sort().join('+')
      if ((map.get(k) ?? 0) < apr) map.set(k, apr)
    }
    const labelKey = proto + ':' + String(e.label ?? '').toLowerCase().trim()
    if (labelKey.length > proto.length + 1 && (map.get(labelKey) ?? 0) < apr) map.set(labelKey, apr)
    if ((map.get(proto) ?? 0) < apr) map.set(proto, apr)
  }
  return map
}

const MERKL_BASE      = 'https://api.merkl.xyz/v4/opportunities?chainId=143&status=LIVE&items=100'
const MERKL_TTL       = 3 * 60 * 1000
const MERKL_PROTO_MAP: Record<string, string> = {
  curve: 'Curve', uniswap: 'Uniswap V3', pancakeswap: 'PancakeSwap V3',
  morpho: 'Morpho', kintsu: 'Kintsu', magma: 'Magma', shmonad: 'shMonad',
  lagoon: 'Lagoon', kuru: 'Kuru', gearbox: 'GearBox V3', curvance: 'Curvance',
  neverland: 'Neverland', euler: 'Euler V2', upshift: 'Upshift',
}
let merklAprCache: { map: AprLookup; ts: number } | null = null

async function fetchMerklAprs(): Promise<AprLookup> {
  if (merklAprCache && Date.now() - merklAprCache.ts < MERKL_TTL) return merklAprCache.map
  try {
    const pages = await Promise.all([1, 2, 3].map(page =>
      fetch(`${MERKL_BASE}&page=${page}`, {
        signal: AbortSignal.timeout(12_000), cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ))
    const raw: any[] = pages.flatMap(r => !r ? [] : (Array.isArray(r) ? r : (r?.data ?? r?.opportunities ?? [])))
    if (!raw.length) return new Map()
    const entries = raw.flatMap((opp: any) => {
      const proto = MERKL_PROTO_MAP[((opp.mainProtocol ?? opp.protocol) ?? '').toLowerCase()] ?? ''
      if (!proto) return []
      const apr = Number(opp.apr ?? 0)
      if (apr <= 0) return []
      const tokens: string[] = (opp.tokens ?? [])
        .filter((t: any) => t.type === 'TOKEN' && !String(t.symbol ?? '').endsWith('-gauge'))
        .map((t: any) => String(t.symbol ?? '')).filter(Boolean)
      return [{ protocol: proto, tokens, label: String(opp.name ?? opp.identifier ?? ''), apr }]
    })
    const map = entriesToLookup(entries)
    merklAprCache = { map, ts: Date.now() }
    return map
  } catch { return new Map() }
}

async function buildAprLookup(): Promise<AprLookup> {
  const cached = getAprEntries()
  if (cached) return entriesToLookup(cached)
  return fetchMerklAprs()
}

function lookupApr(map: AprLookup, pos: any): number {
  const proto  = String(pos.protocol ?? '')
  const tokens: string[] = pos.tokens ?? (pos.asset ? [pos.asset] : [])
  if (tokens.length > 0) {
    const k = proto + ':' + tokens.slice().sort().join('+')
    if (map.has(k)) return map.get(k)!
  }
  const label = String(pos.label ?? pos.asset ?? '').toLowerCase().trim()
  if (label) { const k = proto + ':' + label; if (map.has(k)) return map.get(k)! }
  return map.get(proto) ?? 0
}

function injectBestAprs(positions: any[], map: AprLookup): any[] {
  return positions.map(pos => {
    if ((pos.apy ?? 0) > 0) return pos
    const apr = lookupApr(map, pos)
    return apr > 0 ? { ...pos, apy: apr } : pos
  })
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const debugMode = req.nextUrl.searchParams.get('debug') === '1'

  const [monPriceR] = await Promise.allSettled([getMonPrice()])
  const MON_PRICE   = monPriceR.status === 'fulfilled' ? (monPriceR.value as number) : 0

  async function safeFetch(name: string, fn: () => Promise<any[]>): Promise<any[]> {
    try {
      return await fn()
    } catch (e: any) {
      console.error(`[defi][${name}]`, e?.message ?? e)
      if (debugMode) return [{ __debugError: true, protocol: name, error: e?.message ?? String(e), stack: (e?.stack ?? '').slice(0, 400) }]
      return []
    }
  }

  const [nevR, morphoR, uniR, pcakeR, curveR, gearR, upshiftR, lstsR, lagoonR, kuruR, curvanceR, eulerR] =
    await Promise.allSettled([
      safeFetch('Neverland',     () => fetchNeverland(address)),
      safeFetch('Morpho',        () => fetchMorpho(address)),
      safeFetch('UniswapV3',     () => fetchUniswapV3(address, 'Uniswap V3',    UNI_NFT_PM, UNI_FACTORY)),
      safeFetch('PancakeswapV3', () => fetchUniswapV3(address, 'PancakeSwap V3', '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364', '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865')),
      safeFetch('Curve',         () => fetchCurve(address)),
      safeFetch('Gearbox',       () => fetchGearbox(address, MON_PRICE)),
      safeFetch('Upshift',       () => fetchUpshift(address)),
      safeFetch('MonLSTs',       () => fetchMonLSTs(address, MON_PRICE)),
      safeFetch('Lagoon',        () => fetchLagoon(address)),
      safeFetch('Kuru',          () => fetchKuru(address)),
      safeFetch('Curvance',      () => fetchCurvance(address, MON_PRICE)),
      safeFetch('EulerV2',       () => fetchEulerV2(address)),
    ])

  function unwrap(r: PromiseSettledResult<any[]>): any[] {
    return r.status === 'fulfilled' ? r.value : []
  }

  // Split MonLSTs back into individual protocols for display
  const lstPositions = unwrap(lstsR)
  const kintsuR_pos  = lstPositions.filter(p => p.protocol === 'Kintsu')
  const magmaR_pos   = lstPositions.filter(p => p.protocol === 'Magma')
  const shmonadR_pos = lstPositions.filter(p => p.protocol === 'shMonad')

  if (debugMode) {
    const named: [string, PromiseSettledResult<any[]>][] = [
      ['Neverland', nevR], ['Morpho', morphoR], ['UniswapV3', uniR], ['PancakeswapV3', pcakeR],
      ['Curve', curveR], ['Gearbox', gearR], ['Upshift', upshiftR],
      ['Kintsu',  { status: 'fulfilled', value: kintsuR_pos  }],
      ['Magma',   { status: 'fulfilled', value: magmaR_pos   }],
      ['ShMonad', { status: 'fulfilled', value: shmonadR_pos }],
      ['Lagoon', lagoonR], ['Kuru', kuruR], ['Curvance', curvanceR], ['EulerV2', eulerR],
    ]
    return NextResponse.json({
      __debug: true, monPrice: MON_PRICE,
      fetchers: named.map(([name, r]) => ({
        name, status: r.status,
        count:     r.status === 'fulfilled' ? r.value.length : 0,
        positions: r.status === 'fulfilled' ? r.value : [],
        error:     r.status === 'rejected'  ? String(r.reason) : null,
      })),
    })
  }

  let allPositions = [
    ...unwrap(nevR), ...unwrap(morphoR), ...unwrap(uniR), ...unwrap(pcakeR),
    ...unwrap(curveR), ...unwrap(gearR), ...unwrap(upshiftR), ...lstPositions,
    ...unwrap(lagoonR), ...unwrap(kuruR), ...unwrap(curvanceR), ...unwrap(eulerR),
  ]

  const bestAprsMap = await buildAprLookup()
  allPositions = injectBestAprs(allPositions, bestAprsMap)

  const totalNetValueUSD = allPositions.reduce((s, p) => s + (p.netValueUSD ?? 0), 0)
  const totalDebtUSD     = allPositions.reduce((s, p) => s + (p.totalDebtUSD ?? 0), 0)
  const totalSupplyUSD   = allPositions.reduce((s, p) => s + (p.totalCollateralUSD ?? p.amountUSD ?? 0), 0)
  const activeProtocols  = [...new Set(allPositions.map(p => p.protocol))]

  return NextResponse.json({
    positions: allPositions,
    summary: { totalNetValueUSD, totalDebtUSD, totalSupplyUSD, netValueUSD: totalNetValueUSD, activeProtocols, monPrice: MON_PRICE },
  })
}
