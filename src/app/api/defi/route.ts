import { NextRequest, NextResponse } from 'next/server'
import { MONAD_RPC as RPC, rpcBatch, getMonPrice } from '@/lib/monad'
import { getAllPrices } from '@/lib/priceCache'

export const revalidate = 0
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

// ─── Dynamic token info resolver ─────────────────────────────────────────────
// Tokens conhecidos pre-mapeados (zero custo de RPC).
// Qualquer endereco nao listado aqui e resolvido on-chain via symbol()+decimals()
// e cacheado no modulo — novos tokens aparecem automaticamente sem manutencao.

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

// Decodifica string ABI-encoded (symbol/name) — offset(32) + length(32) + data
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

/**
 * Resolve simbolo e decimals de tokens ERC-20 em batch.
 * Le do TOKEN_CACHE primeiro; desconhecidos sao buscados via RPC e cacheados.
 * Novos tokens do ecossistema Monad aparecem automaticamente.
 */
async function resolveTokens(addresses: string[]): Promise<Record<string, TokenInfo>> {
  const unique  = [...new Set(addresses.map(a => a.toLowerCase()))]
  const unknown = unique.filter(a => !TOKEN_CACHE[a])

  if (unknown.length > 0) {
    const calls: object[] = []
    unknown.forEach((addr, i) => {
      calls.push(ethCall(addr, '0x95d89b41', i * 2))      // symbol()
      calls.push(ethCall(addr, '0x313ce567', i * 2 + 1)) // decimals()
    })
    const results = await rpcBatch(calls).catch(() => [] as any[])
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

// ─── Multi-token prices from shared priceCache ────────────────────────────────
const SYMBOL_TO_COINGECKO: Record<string, string> = {
  WMON:   'monad',
  MON:    'monad',
  sMON:   'monad',
  gMON:   'monad',
  shMON:  'monad',
  aprMON: 'monad',
  WETH:   'ethereum',
  WBTC:   'wrapped-bitcoin',
  USDC:   'usd-coin',
  USDT0:  'tether',
  AUSD:   'agora-dollar',
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
  } catch {
    return stables
  }
}

// ─── NEVERLAND (Aave V3 fork) — supply & borrow positions ───────────────────
// Correcao: aTokens e debtTokens sao descobertos via getReserveData(underlying)
//   slot[8]  = aTokenAddress
//   slot[10] = variableDebtTokenAddress

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
    const reserveResults = await rpcBatch(reserveCalls)

    const discovered: Array<{
      underlying: typeof NEVERLAND_UNDERLYING[0]
      aToken:     string
      debtToken:  string
    }> = []

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
    const balResults = await rpcBatch(balCalls)
    const prices     = await getTokenPricesUSD(discovered.map(d => d.underlying.symbol))

    const supplyList: Array<{ symbol: string; amount: number; amountUSD: number }> = []
    const borrowList: Array<{ symbol: string; amount: number; amountUSD: number }> = []

    discovered.forEach(({ underlying }, i) => {
      const aBal   = decodeUint(balResults.find((r: any) => r.id === i * 2)?.result     ?? '0x')
      const dBal   = decodeUint(balResults.find((r: any) => r.id === i * 2 + 1)?.result ?? '0x')
      const price  = prices[underlying.symbol] ?? 0
      const factor = Math.pow(10, underlying.decimals)
      if (aBal > 0n) { const amount = Number(aBal) / factor; if (amount >= 0.0001) supplyList.push({ symbol: underlying.symbol, amount, amountUSD: amount * price }) }
      if (dBal > 0n) { const amount = Number(dBal) / factor; if (amount >= 0.0001) borrowList.push({ symbol: underlying.symbol, amount, amountUSD: amount * price }) }
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
  } catch { return [] }
}

// ─── MORPHO ───────────────────────────────────────────────────────────────────
async function fetchMorpho(user: string): Promise<any[]> {
  const query = `query($addr:String!,$cid:Int!){
    userByAddress(address:$addr,chainId:$cid){
      marketPositions{
        market{
          uniqueKey
          loanAsset{symbol decimals}
          collateralAsset{symbol decimals}
          state{supplyApy borrowApy}
        }
        supplyAssets supplyAssetsUsd
        borrowAssets borrowAssetsUsd
        collateral collateralUsd
        healthFactor
      }
      vaultPositions{
        vault{
          address name symbol
          asset{symbol decimals}
          state{netApy totalAssetsUsd}
        }
        assets assetsUsd
      }
    }
  }`
  try {
    const res  = await fetch('https://api.morpho.org/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { addr: user.toLowerCase(), cid: 143 } }),
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    const data = await res.json()
    const u    = data?.data?.userByAddress
    if (!u) return []
    const out: any[] = []

    for (const p of u.marketPositions ?? []) {
      const supUSD = Number(p.supplyAssetsUsd ?? 0), borUSD = Number(p.borrowAssetsUsd ?? 0), colUSD = Number(p.collateralUsd ?? 0)
      if (supUSD < 0.01 && borUSD < 0.01 && colUSD < 0.01) continue
      const loanSym = p.market?.loanAsset?.symbol ?? '?', collSym = p.market?.collateralAsset?.symbol
      const supplyApy = p.market?.state?.supplyApy ? Number(p.market.state.supplyApy) * 100 : 0
      const borrowApy = p.market?.state?.borrowApy ? Number(p.market.state.borrowApy) * 100 : 0
      const url = p.market?.uniqueKey ? `https://app.morpho.org/monad/market?id=${p.market.uniqueKey}` : 'https://app.morpho.org/monad'
      out.push({
        protocol: 'Morpho', type: 'lending', logo: '🦋', url, chain: 'Monad',
        label: collSym ? `${collSym} / ${loanSym}` : loanSym,
        supply:     supUSD > 0.01 ? [{ symbol: loanSym, amountUSD: supUSD, apy: supplyApy }] : [],
        collateral: colUSD > 0.01 ? [{ symbol: collSym, amountUSD: colUSD }] : [],
        borrow:     borUSD > 0.01 ? [{ symbol: loanSym, amountUSD: borUSD, apr: borrowApy }] : [],
        totalCollateralUSD: colUSD + supUSD, totalDebtUSD: borUSD,
        netValueUSD: colUSD + supUSD - borUSD,
        healthFactor: p.healthFactor ? Number(p.healthFactor) : null,
      })
    }
    for (const p of u.vaultPositions ?? []) {
      const usd = Number(p.assetsUsd ?? 0)
      if (usd < 0.01) continue
      const url = p.vault?.address ? `https://app.morpho.org/monad/vault?address=${p.vault.address}` : 'https://app.morpho.org/monad'
      out.push({
        protocol: 'Morpho', type: 'vault', logo: '🦋', url, chain: 'Monad',
        label: p.vault?.name ?? p.vault?.symbol, asset: p.vault?.asset?.symbol,
        amountUSD: usd, apy: p.vault?.state?.netApy ? Number(p.vault.state.netApy) * 100 : 0, netValueUSD: usd,
      })
    }
    return out
  } catch { return [] }
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

// Calcula amount0 e amount1 reais via math Uniswap V3
function calcV3Amounts(
  liquidity: bigint, sqrtPriceX96: bigint,
  tickLower: number, tickUpper: number, currentTick: number,
  decimals0: number, decimals1: number,
): { amount0: number; amount1: number } {
  const L     = Number(liquidity)
  const sqrtP = Number(sqrtPriceX96) / (2 ** 96)
  const sqrtA = Math.sqrt(Math.pow(1.0001, tickLower))
  const sqrtB = Math.sqrt(Math.pow(1.0001, tickUpper))
  let amount0 = 0, amount1 = 0
  if (currentTick < tickLower) {
    amount0 = L * (1 / sqrtA - 1 / sqrtB)
  } else if (currentTick >= tickUpper) {
    amount1 = L * (sqrtB - sqrtA)
  } else {
    amount0 = L * (1 / sqrtP - 1 / sqrtB)
    amount1 = L * (sqrtP - sqrtA)
  }
  return {
    amount0: amount0 / Math.pow(10, decimals0),
    amount1: amount1 / Math.pow(10, decimals1),
  }
}

async function fetchUniswapV3(user: string, protocol: string, nftPM: string, factory: string): Promise<any[]> {
  try {
    const balRes   = await rpcBatch([ethCall(nftPM, balanceOfData(user), 1)])
    const nftCount = Number(decodeUint(balRes[0]?.result ?? '0x'))
    if (nftCount === 0) return []

    const limit     = Math.min(nftCount, 20)
    const idCalls   = Array.from({ length: limit }, (_, i) =>
      ethCall(nftPM, tokenOfOwnerByIndex(user, BigInt(i)), i + 10))
    const idResults = await rpcBatch(idCalls)
    const tokenIds  = idResults.map((r: any) => decodeUint(r?.result ?? '0x')).filter((id: bigint) => id > 0n)
    if (!tokenIds.length) return []

    const posCalls   = tokenIds.map((id: bigint, i: number) => ethCall(nftPM, positionsData(id), i + 200))
    const posResults = await rpcBatch(posCalls)

    const tokenAddresses = new Set<string>()
    const parsedPositions: Array<{
      token0: string; token1: string; fee: number
      tickLower: number; tickUpper: number; liquidity: bigint
    }> = []

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

    // Resolve simbolos/decimals de todos os tokens em batch (com cache)
    const tokenInfoMap = await resolveTokens([...tokenAddresses])

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

    const poolAddrResults = await rpcBatch(poolCalls)

    const slot0Calls: object[] = []
    const slot0Meta: Record<number, any> = {}
    let s0Idx = 600

    for (const res of poolAddrResults) {
      const meta = poolMeta[res.id]
      if (!meta || !res.result || res.result === '0x') continue
      const poolAddr = decodeAddress(res.result)
      if (poolAddr === '0x0000000000000000000000000000000000000000') continue
      slot0Calls.push(ethCall(poolAddr, '0x3850c7bd', s0Idx))
      slot0Meta[s0Idx] = meta
      s0Idx++
    }
    if (!slot0Calls.length) return []
    const slot0Results = await rpcBatch(slot0Calls)

    const allSymbols = [...new Set(Object.values(slot0Meta).flatMap((m: any) => [m.t0sym, m.t1sym]))]
    const prices     = await getTokenPricesUSD(allSymbols)

    const positions: any[] = []
    for (const s0 of slot0Results) {
      const meta = slot0Meta[s0.id]
      if (!meta || !s0.result || s0.result === '0x' || s0.result.length < 10) continue
      const d  = s0.result.slice(2)
      const w  = Array.from({ length: 4 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const ct = parseInt(w[1], 16)
      const currentTick  = ct > 0x7fffffff ? ct - 0x100000000 : ct
      const sqrtPriceX96 = BigInt('0x' + w[0])
      const inRange      = currentTick >= meta.tickLower && currentTick <= meta.tickUpper

      const { amount0, amount1 } = calcV3Amounts(
        meta.liquidity, sqrtPriceX96,
        meta.tickLower, meta.tickUpper, currentTick,
        meta.t0dec, meta.t1dec
      )
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
  } catch { return [] }
}

// ─── CURVE ────────────────────────────────────────────────────────────────────
async function fetchCurve(user: string): Promise<any[]> {
  const BASE = 'https://api-core.curve.finance/v1'
  const addr = user.toLowerCase()
  const paddedAddr = addr.slice(2).padStart(64, '0')

  const poolTypes = ['factory-twocrypto', 'factory-stable-ng']
  const [bnRes, ...poolFetches] = await Promise.all([
    fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(4_000),
    }).then(r => r.json()).catch(() => ({ result: '0x0' })),
    ...poolTypes.map(t =>
      fetch(`${BASE}/getPools/monad/${t}`, { signal: AbortSignal.timeout(8_000), cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).catch(() => null)
    ),
  ])
  const currentBlockHex = bnRes?.result ?? '0x0'
  const BLOCKS_24H  = 195_000
  const currentBlock = Number(BigInt(currentBlockHex))
  const fromBlock24h = '0x' + Math.max(0, currentBlock - BLOCKS_24H).toString(16)

  const allPools: any[] = []
  for (const data of poolFetches) allPools.push(...(data?.data?.poolData ?? []))
  if (allPools.length === 0) return []

  const TE_CLASSIC = '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140'
  const TE_NG      = '0x143f1f8e861fbdeddd5b46e844b7d3ac7b86a122f36e8c463859ee6811b1f29c'

  const balanceCalls = allPools.map((pool, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_call',
    params: [{ to: pool.lpTokenAddress ?? pool.address, data: '0x70a08231' + paddedAddr }, 'latest'],
  }))
  const feeCalls = allPools.map((pool, i) => ({
    jsonrpc: '2.0', id: i + 1000, method: 'eth_call',
    params: [{ to: pool.address, data: '0xddca3f43' }, 'latest'],
  }))

  const [rpcRes, feeRes, logsRes] = await Promise.all([
    rpcBatch(balanceCalls, 10_000),
    rpcBatch(feeCalls, 8_000),
    rpcBatch([{
      jsonrpc: '2.0', id: 9999, method: 'eth_getLogs',
      params: [{ fromBlock: fromBlock24h, toBlock: 'latest', address: allPools.map(p => p.address), topics: [[TE_CLASSIC, TE_NG]] }],
    }], 15_000),
  ])

  const logs: any[] = logsRes.find((r: any) => r.id === 9999)?.result ?? []
  const volumeByPool: Record<string, number> = {}
  for (const log of logs) {
    const poolAddr = log.address?.toLowerCase()
    const pool = allPools.find(p => p.address.toLowerCase() === poolAddr)
    if (!pool) continue
    try {
      const d = log.data?.slice(2) ?? ''
      if (d.length < 128) continue
      const soldId     = Number(BigInt('0x' + d.slice(0, 64)))
      const tokensSold = BigInt('0x' + d.slice(64, 128))
      const decimals   = Number(pool.coins?.[soldId]?.decimals ?? 18)
      volumeByPool[poolAddr] = (volumeByPool[poolAddr] ?? 0) + Number(tokensSold) / Math.pow(10, decimals)
    } catch { /* skip */ }
  }

  const curveAprByPool: Record<string, number> = {}
  allPools.forEach((pool, i) => {
    const tvl = Number(pool.usdTotalExcludingBasePool ?? pool.usdTotal ?? 0)
    if (tvl <= 0) return
    const feeRaw  = decodeUint(feeRes.find((r: any) => r.id === i + 1000)?.result ?? '0x')
    const feeRate = Number(feeRaw) / 1e10
    const vol24h  = volumeByPool[pool.address?.toLowerCase()] ?? 0
    if (vol24h > 0 && feeRate > 0)
      curveAprByPool[pool.address?.toLowerCase()] = (vol24h * feeRate * 365 / tvl) * 100
  })

  const positions: any[] = []
  for (let i = 0; i < allPools.length; i++) {
    const result = rpcRes.find((r: any) => r.id === i)?.result ?? '0x'
    if (!result || result === '0x' || result === '0x' + '0'.repeat(64)) continue
    const balanceRaw = BigInt(result)
    if (balanceRaw === 0n) continue
    const pool           = allPools[i]
    const totalSupplyRaw = BigInt(pool.totalSupply ?? '0')
    const lpPrice        = Number(pool.lpTokenPrice ?? 0)
    const userBalanceFloat = Number(balanceRaw) / 1e18
    const netValueUSD = lpPrice > 0
      ? userBalanceFloat * lpPrice
      : totalSupplyRaw > 0n
        ? (Number(balanceRaw) / Number(totalSupplyRaw)) * Number(pool.usdTotalExcludingBasePool ?? pool.usdTotal ?? 0)
        : 0
    if (netValueUSD < 0.01) continue
    const coins  = pool.coins?.map((c: any) => c.symbol) ?? []
    const poolId = pool.id ?? pool.address
    positions.push({
      protocol: 'Curve', type: 'liquidity', logo: '🌊',
      url: `https://curve.finance/dex/monad/pools/${poolId}/deposit`, chain: 'Monad',
      label: pool.name ?? coins.join('/'), tokens: coins,
      amountUSD: netValueUSD, apy: curveAprByPool[pool.address?.toLowerCase()] ?? 0,
      netValueUSD, inRange: null,
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

async function fetchGearbox(user: string): Promise<any[]> {
  try {
    const res  = await fetch(GEARBOX_STATIC_URL, { signal: AbortSignal.timeout(8_000), cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    const markets: any[] = data?.markets ?? []
    if (!markets.length) return []

    const pools = markets.map((m: any) => m?.pool).filter((p: any) => {
      if (!p) return false
      return !!GEARBOX_TOKEN_MAP[(p?.baseParams?.addr ?? '').toLowerCase()]
    })
    if (!pools.length) return []

    const calls   = pools.map((p: any, i: number) => ethCall(p.baseParams.addr, balanceOfData(user), i + 200))
    const results = await rpcBatch(calls)

    const positions: any[] = []
    for (let i = 0; i < pools.length; i++) {
      const pool  = pools[i]
      const addr  = (pool?.baseParams?.addr ?? '').toLowerCase()
      const meta  = GEARBOX_TOKEN_MAP[addr]
      if (!meta) continue
      const shares = decodeUint(results.find((r: any) => r.id === i + 200)?.result ?? '0x')
      if (shares === 0n) continue
      const decimals     = Number(pool.decimals ?? 18)
      const sharesFloat  = Number(shares) / Math.pow(10, decimals)
      const expectedLiq  = BigInt(pool.expectedLiquidity?.__value ?? '0')
      const totalSupply  = BigInt(pool.totalSupply?.__value ?? pool.totalSupply ?? '0')
      let amountUSD = 0
      if (totalSupply > 0n) amountUSD = meta.isStable ? sharesFloat * (Number(expectedLiq) / Number(totalSupply)) : 0
      positions.push({
        protocol: 'GearBox V3', type: 'vault', logo: '⚙️',
        url: 'https://app.gearbox.fi/pools?chainId=143', chain: 'Monad',
        label: pool.name ?? meta.token, asset: meta.token,
        shares: sharesFloat, amountUSD, apy: 0, netValueUSD: amountUSD,
        _needsMonPrice: !meta.isStable,
        _expectedLiqPerShare: totalSupply > 0n ? Number(expectedLiq) / Number(totalSupply) / Math.pow(10, decimals) : 0,
      })
    }
    return positions
  } catch { return [] }
}

// ─── UPSHIFT ──────────────────────────────────────────────────────────────────
const UPSHIFT_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}

async function fetchUpshift(user: string): Promise<any[]> {
  try {
    const res = await fetch('https://api.upshift.finance/metrics/vaults_summary', {
      headers: UPSHIFT_API_HEADERS, signal: AbortSignal.timeout(8_000), cache: 'no-store',
    })
    if (!res.ok) return []
    const raw: any[] = await res.json()
    const vaults = (Array.isArray(raw) ? raw : []).filter(
      (v: any) => v.chain === 143 && !/test|bugbash/i.test(v.vault_name ?? '') && Number(v.total_assets ?? 0) > 0.001
    )
    if (!vaults.length) return []

    const calls   = vaults.map((v: any, i: number) => ethCall(v.address, balanceOfData(user), i + 700))
    const results = await rpcBatch(calls)

    const positions: any[] = []
    for (let i = 0; i < vaults.length; i++) {
      const v      = vaults[i]
      const shares = decodeUint(results.find((r: any) => r.id === i + 700)?.result ?? '0x')
      if (shares === 0n) continue
      const decimals    = Number(v.decimals ?? 18)
      const sharesFloat = Number(shares) / Math.pow(10, decimals)
      const ratio       = Number(v.asset_share_ratio ?? 1)
      const underlying  = sharesFloat * ratio
      const price       = Number(v.underlying_price ?? 0)
      const amountUSD   = underlying * price
      if (sharesFloat < 0.001 && amountUSD < 0.01) continue
      const name = v.vault_name ?? ''
      const asset = name.includes('MON') ? 'MON' : name.includes('AUSD') ? 'AUSD'
        : name.includes('USDC') ? 'USDC' : name.includes('BTC') ? 'WBTC' : 'unknown'
      const apy7d  = Number(v['7d_apy'] ?? 0)
      const apy30d = Number(v['30d_apy'] ?? 0)
      const apy    = (apy7d > 0 ? apy7d : apy30d) * 100
      positions.push({
        protocol: 'Upshift', type: 'vault', logo: '🔺',
        url: 'https://app.upshift.finance', chain: 'Monad',
        label: name, asset, amount: sharesFloat, amountUSD, apy, netValueUSD: amountUSD,
      })
    }
    return positions
  } catch { return [] }
}

// ─── KINTSU (sMON LST) ────────────────────────────────────────────────────────
const KINTSU_SMON = '0xA3227C5969757783154C60bF0bC1944180ed81B9'

async function fetchKintsu(user: string, monPrice: number): Promise<any[]> {
  try {
    const balRes = await rpcBatch([ethCall(KINTSU_SMON, balanceOfData(user), 800)])
    const shares = decodeUint(balRes[0]?.result ?? '0x')
    if (shares === 0n) return []
    const sharesFloat = Number(shares) / 1e18
    const redeemRes   = await rpcBatch([ethCall(KINTSU_SMON, '0x4cdad506' + shares.toString(16).padStart(64, '0'), 801)])
    const monAmt      = Number(decodeUint(redeemRes[0]?.result ?? '0x')) / 1e18 || sharesFloat
    const usd         = monAmt * monPrice
    if (sharesFloat < 0.001) return []
    return [{ protocol: 'Kintsu', type: 'vault', logo: '🔵', url: 'https://kintsu.xyz', chain: 'Monad', label: 'Staked MON', asset: 'sMON', amount: sharesFloat, amountUSD: usd, apy: 0, netValueUSD: usd }]
  } catch { return [] }
}

// ─── MAGMA (gMON LST) ─────────────────────────────────────────────────────────
const MAGMA_GMON = '0x8498312a6b3CBD158Bf0c93ABdcF29E6e4f55081'

async function fetchMagma(user: string, monPrice: number): Promise<any[]> {
  try {
    const balRes = await rpcBatch([ethCall(MAGMA_GMON, balanceOfData(user), 810)])
    const shares = decodeUint(balRes[0]?.result ?? '0x')
    if (shares === 0n) return []
    const sharesFloat = Number(shares) / 1e18
    const redeemRes   = await rpcBatch([ethCall(MAGMA_GMON, '0x07a2d13a' + shares.toString(16).padStart(64, '0'), 811)])
    const monAmt      = Number(decodeUint(redeemRes[0]?.result ?? '0x')) / 1e18 || sharesFloat
    const usd         = monAmt * monPrice
    if (sharesFloat < 0.001) return []
    return [{ protocol: 'Magma', type: 'vault', logo: '🐲', url: 'https://magmastaking.xyz', chain: 'Monad', label: 'MEV-Optimized Staked MON', asset: 'gMON', amount: sharesFloat, amountUSD: usd, apy: 0, netValueUSD: usd }]
  } catch { return [] }
}

// ─── shMONAD ──────────────────────────────────────────────────────────────────
const SHMONAD_ADDR = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c'

async function fetchShMonad(user: string, monPrice: number): Promise<any[]> {
  try {
    const balRes = await rpcBatch([ethCall(SHMONAD_ADDR, balanceOfData(user), 820)])
    const shares = decodeUint(balRes[0]?.result ?? '0x')
    if (shares === 0n) return []
    const sharesFloat = Number(shares) / 1e18
    const redeemRes   = await rpcBatch([ethCall(SHMONAD_ADDR, '0x4cdad506' + shares.toString(16).padStart(64, '0'), 821)])
    const monAmt      = Number(decodeUint(redeemRes[0]?.result ?? '0x')) / 1e18 || sharesFloat
    const usd         = monAmt * monPrice
    if (sharesFloat < 0.001) return []
    return [{ protocol: 'shMonad', type: 'vault', logo: '⚡', url: 'https://shmonad.xyz', chain: 'Monad', label: 'Holistic Staked MON', asset: 'shMON', amount: sharesFloat, amountUSD: usd, apy: 0, netValueUSD: usd }]
  } catch { return [] }
}

// ─── LAGOON FINANCE ───────────────────────────────────────────────────────────
async function fetchLagoon(user: string): Promise<any[]> {
  const paddedAddr = user.slice(2).toLowerCase().padStart(64, '0')
  try {
    const res = await fetch('https://app.lagoon.finance/api/vaults?chainId=143', {
      signal: AbortSignal.timeout(8_000), cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept': 'application/json' },
    })
    if (!res.ok) return []
    const data   = await res.json()
    const vaults: any[] = data?.vaults ?? data ?? []
    if (vaults.length === 0) return []

    const calls = vaults.flatMap((v: any, i: number) => [
      ethCall(v.address, '0x70a08231' + paddedAddr, i * 3),
      ethCall(v.address, '0x01e1d114', i * 3 + 1),
      ethCall(v.address, '0x18160ddd', i * 3 + 2),
    ])
    const results = await rpcBatch(calls)

    const positions: any[] = []
    for (let i = 0; i < vaults.length; i++) {
      const v = vaults[i]
      const shares      = decodeUint(results.find((r: any) => r.id === i * 3)?.result     ?? '0x')
      if (shares === 0n) continue
      const totalAssets = decodeUint(results.find((r: any) => r.id === i * 3 + 1)?.result ?? '0x')
      const totalSupply = decodeUint(results.find((r: any) => r.id === i * 3 + 2)?.result ?? '0x')
      const decimals    = Number(v.decimals ?? 18)
      const shareFloat  = Number(shares) / Math.pow(10, decimals)
      let amountUSD = 0
      if (totalSupply > 0n) amountUSD = shareFloat * (Number(totalAssets) / Number(totalSupply))
      if (amountUSD < 0.01 && shareFloat < 0.001) continue
      positions.push({
        protocol: 'Lagoon', type: 'vault', logo: '🏝️',
        url: `https://app.lagoon.finance/vault/143/${v.address}`, chain: 'Monad',
        label: v.name ?? v.symbol ?? 'Lagoon Vault', asset: v.symbol,
        amountUSD, apy: v.apy ? Number(v.apy) * 100 : 0, netValueUSD: amountUSD,
      })
    }
    return positions
  } catch { return [] }
}

// ─── KURU ─────────────────────────────────────────────────────────────────────
const KURU_VAULTS = [
  { address: '0x4869a4c7657cef5e5496c9ce56dde4cd593e4923', name: 'Kuru MON/AUSD', asset: 'AUSD', decimals: 6 },
  { address: '0xd0f8a6422ccdd812f29d8fb75cf5fcd41483badc', name: 'Kuru MON/USDC', asset: 'USDC', decimals: 6 },
]

async function fetchKuru(user: string): Promise<any[]> {
  try {
    const calls: any[] = []
    KURU_VAULTS.forEach((v, i) => {
      calls.push(ethCall(v.address, balanceOfData(user), 900 + i * 3))
      calls.push(ethCall(v.address, '0x01e1d114', 901 + i * 3))
      calls.push(ethCall(v.address, '0x18160ddd', 902 + i * 3))
    })
    const results = await rpcBatch(calls)
    const items: any[] = []
    KURU_VAULTS.forEach((v, i) => {
      const shares = decodeUint(results.find((r: any) => r.id === 900 + i * 3)?.result ?? '0x')
      if (shares === 0n) return
      const totalAssets = decodeUint(results.find((r: any) => r.id === 901 + i * 3)?.result ?? '0x')
      const totalSupply = decodeUint(results.find((r: any) => r.id === 902 + i * 3)?.result ?? '0x')
      if (totalSupply === 0n) return
      const assetAmount = Number(shares * totalAssets / totalSupply) / Math.pow(10, v.decimals)
      if (assetAmount < 0.01) return
      items.push({
        protocol: 'Kuru', type: 'liquidity', logo: '🌀',
        url: `https://www.kuru.io/vaults/${v.address}`, chain: 'Monad',
        label: v.name, tokens: ['MON', v.asset],
        amountUSD: assetAmount, apy: 0, netValueUSD: assetAmount, inRange: null,
      })
    })
    return items
  } catch { return [] }
}

// ─── CURVANCE ─────────────────────────────────────────────────────────────────
const CURVANCE_CTOKENS: Record<string, { underlying: string; decimals: number; market: string }> = {
  '0xD9E2025b907E95EcC963A5018f56B87575B4aB26': { underlying: 'aprMON', decimals: 18, market: 'aprMON/WMON' },
  '0x926C101Cf0a3dE8725Eb24a93E980f9FE34d6230': { underlying: 'shMON',  decimals: 18, market: 'shMON/WMON'  },
  '0x494876051B0E85dCe5ecd5822B1aD39b9660c928': { underlying: 'sMON',   decimals: 18, market: 'sMON/WMON'   },
  '0x5ca6966543c0786f547446234492d2f11c82f11f': { underlying: 'gMON',   decimals: 18, market: 'gMON/WMON'   },
}
const CURVANCE_DEBT_CTOKENS: Record<string, { underlying: string; decimals: number; market: string }> = {
  '0xf473568b26b8c5aadca9fbc0ea17e1728d5ec925': { underlying: 'WMON', decimals: 18, market: 'gMON/WMON'   },
  '0xF32B334042DC1EB9732454cc9bc1a06205d184f2': { underlying: 'WMON', decimals: 18, market: 'aprMON/WMON' },
  '0x0fcEd51b526BfA5619F83d97b54a57e3327eB183': { underlying: 'WMON', decimals: 18, market: 'shMON/WMON'  },
  '0xebE45A6ceA7760a71D8e0fa5a0AE80a75320D708': { underlying: 'WMON', decimals: 18, market: 'sMON/WMON'   },
}

async function fetchCurvance(user: string): Promise<any[]> {
  try {
    const collateralAddrs = Object.keys(CURVANCE_CTOKENS)
    const debtAddrs       = Object.keys(CURVANCE_DEBT_CTOKENS)
    const userPadded      = user.slice(2).toLowerCase().padStart(64, '0')
    const calls = [
      ...collateralAddrs.map((addr, i) => ethCall(addr, balanceOfData(user), i)),
      ...debtAddrs.map((addr, i) => ethCall(addr, '0x21570256' + userPadded, 100 + i)),
    ]
    const results = await rpcBatch(calls)
    const markets: Record<string, { collateral: any[]; debt: any[] }> = {}
    const allSymbols: string[] = []

    collateralAddrs.forEach((addr, i) => {
      const info   = CURVANCE_CTOKENS[addr]
      const balRaw = decodeUint(results.find((r: any) => r.id === i)?.result ?? '0x')
      if (balRaw === 0n) return
      if (!markets[info.market]) markets[info.market] = { collateral: [], debt: [] }
      const amount = Number(balRaw) / 1e18
      markets[info.market].collateral.push({ symbol: info.underlying, amount, amountUSD: 0 })
      if (!allSymbols.includes(info.underlying)) allSymbols.push(info.underlying)
    })
    debtAddrs.forEach((addr, i) => {
      const info = CURVANCE_DEBT_CTOKENS[addr]
      const raw  = results.find((r: any) => r.id === 100 + i)?.result ?? '0x'
      if (!raw || raw === '0x' || raw.length < 2 + 6 * 64) return
      const hex       = raw.slice(2)
      const borrowRaw = BigInt('0x' + hex.slice(5 * 64, 6 * 64))
      if (borrowRaw === 0n) return
      if (!markets[info.market]) markets[info.market] = { collateral: [], debt: [] }
      const amount = Number(borrowRaw) / 1e18
      markets[info.market].debt.push({ symbol: info.underlying, amount, amountUSD: 0 })
      if (!allSymbols.includes(info.underlying)) allSymbols.push(info.underlying)
    })
    if (!Object.keys(markets).length) return []

    const prices = await getTokenPricesUSD(allSymbols)
    return Object.entries(markets).map(([marketName, { collateral, debt }]) => {
      let totalCollateralUSD = 0
      for (const c of collateral) { c.amountUSD = c.amount * (prices[c.symbol] ?? 0); totalCollateralUSD += c.amountUSD }
      let totalDebtUSD = 0
      for (const d of debt) { d.amountUSD = d.amount * (prices[d.symbol] ?? 0); totalDebtUSD += d.amountUSD }
      const healthFactor = totalDebtUSD > 0 ? (totalCollateralUSD * 0.975) / totalDebtUSD : null
      return {
        protocol: 'Curvance', type: 'lending', logo: '💎',
        url: 'https://monad.curvance.com', chain: 'Monad', label: marketName,
        supply: collateral, borrow: debt, totalCollateralUSD, totalDebtUSD,
        netValueUSD: totalCollateralUSD - totalDebtUSD, healthFactor,
      }
    })
  } catch { return [] }
}

// ─── EULER V2 ─────────────────────────────────────────────────────────────────
async function fetchEulerV2(user: string): Promise<any[]> {
  const query = `query($account:String!,$chainId:Int!){
    userPositions(where:{account:$account,chainId:$chainId}){
      vault{address name asset{symbol decimals}}
      supplyShares supplyAssetsUsd
      borrowShares borrowAssetsUsd
      healthScore
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
        const sym = p.vault?.asset?.symbol ?? '?'
        return {
          protocol: 'Euler V2', type: 'lending', logo: '📐',
          url: 'https://app.euler.finance', chain: 'Monad', label: p.vault?.name ?? sym,
          supply: supUSD > 0.01 ? [{ symbol: sym, amountUSD: supUSD }] : [],
          collateral: [],
          borrow: borUSD > 0.01 ? [{ symbol: sym, amountUSD: borUSD }] : [],
          totalCollateralUSD: supUSD, totalDebtUSD: borUSD,
          netValueUSD: supUSD - borUSD,
          healthFactor: p.healthScore ? Number(p.healthScore) : null,
        }
      })
  } catch { return [] }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const debugMode = req.nextUrl.searchParams.get('debug') === '1'

  const [monPriceR] = await Promise.allSettled([getMonPrice()])
  const MON_PRICE = monPriceR.status === 'fulfilled' ? (monPriceR.value as number) : 0

  // Wraps each fetcher: in debug mode exposes errors, otherwise silently returns []
  async function safeFetch(name: string, fn: () => Promise<any[]>): Promise<any[]> {
    try {
      return await fn()
    } catch (e: any) {
      if (debugMode) {
        return [{ __debugError: true, protocol: name, error: e?.message ?? String(e), stack: (e?.stack ?? '').slice(0, 400) }]
      }
      return []
    }
  }

  const [nevR, morphoR, uniR, pcakeR, curveR, gearR, upshiftR, kintsuR, magmaR, shmonadR, lagoonR, kuruR, curvanceR, eulerR] =
    await Promise.allSettled([
      safeFetch('Neverland',     () => fetchNeverland(address)),
      safeFetch('Morpho',        () => fetchMorpho(address)),
      safeFetch('UniswapV3',     () => fetchUniswapV3(address, 'Uniswap V3',    UNI_NFT_PM, UNI_FACTORY)),
      safeFetch('PancakeswapV3', () => fetchUniswapV3(address, 'PancakeSwap V3', '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364', '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865')),
      safeFetch('Curve',         () => fetchCurve(address)),
      safeFetch('Gearbox',       () => fetchGearbox(address)),
      safeFetch('Upshift',       () => fetchUpshift(address)),
      safeFetch('Kintsu',        () => fetchKintsu(address, MON_PRICE)),
      safeFetch('Magma',         () => fetchMagma(address, MON_PRICE)),
      safeFetch('ShMonad',       () => fetchShMonad(address, MON_PRICE)),
      safeFetch('Lagoon',        () => fetchLagoon(address)),
      safeFetch('Kuru',          () => fetchKuru(address)),
      safeFetch('Curvance',      () => fetchCurvance(address)),
      safeFetch('EulerV2',       () => fetchEulerV2(address)),
    ])

  function unwrap(r: PromiseSettledResult<any[]>): any[] {
    return r.status === 'fulfilled' ? r.value : []
  }

  let allPositions = [
    ...unwrap(nevR), ...unwrap(morphoR), ...unwrap(uniR), ...unwrap(pcakeR),
    ...unwrap(curveR), ...unwrap(gearR), ...unwrap(upshiftR),
    ...unwrap(kintsuR), ...unwrap(magmaR), ...unwrap(shmonadR),
    ...unwrap(lagoonR), ...unwrap(kuruR), ...unwrap(curvanceR), ...unwrap(eulerR),
  ]

  // Pos-processamento: Gearbox WMON precisa do preco do MON
  allPositions = allPositions.map(p => {
    if (p._needsMonPrice && MON_PRICE > 0) {
      const usd = p._expectedLiqPerShare * p.shares * MON_PRICE
      return { ...p, amountUSD: usd, netValueUSD: usd, _needsMonPrice: undefined, _expectedLiqPerShare: undefined, shares: undefined }
    }
    const { _needsMonPrice, _expectedLiqPerShare, shares: _s, ...clean } = p
    return clean
  })

  const totalNetValueUSD = allPositions.reduce((s, p) => s + (p.netValueUSD ?? 0), 0)
  const totalDebtUSD     = allPositions.reduce((s, p) => s + (p.totalDebtUSD ?? 0), 0)
  const totalSupplyUSD   = allPositions.reduce((s, p) => s + (p.totalCollateralUSD ?? p.amountUSD ?? 0), 0)
  const activeProtocols  = [...new Set(allPositions.map(p => p.protocol))]

  return NextResponse.json({
    positions: allPositions,
    summary: { totalNetValueUSD, totalDebtUSD, totalSupplyUSD, netValueUSD: totalNetValueUSD, activeProtocols, monPrice: MON_PRICE },
  })
}
