import { NextRequest, NextResponse } from 'next/server'
import { MONAD_RPC as RPC, rpcBatch, getMonPrice } from '@/lib/monad'
import { getAllPrices } from '@/lib/priceCache'

// ─── Rota de debug — REMOVER antes do deploy final ───────────────────────────
// Acesso: GET /api/debug-defi?address=0x...
// Testa cada fetcher individualmente e expoe erros reais em vez de swallow silencioso

function ethCall(to: string, data: string, id: number) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function balanceOfData(addr: string) {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}

// ── Teste 1: RPC basico ───────────────────────────────────────────────────────
async function testRPC() {
  const res = await rpcBatch([{
    jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: []
  }])
  return { blockNumber: res[0]?.result ?? null, error: res[0]?.error ?? null }
}

// ── Teste 2: priceCache / getAllPrices ────────────────────────────────────────
async function testPriceCache() {
  try {
    const data = await getAllPrices()
    return {
      ok: true,
      monadPrice: data.prices['monad'] ?? null,
      fetchedAt: new Date(data.fetchedAt).toISOString(),
      coinCount: Object.keys(data.prices).length,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), stack: e?.stack?.slice(0, 300) }
  }
}

// ── Teste 3: resolveTokens (Buffer / symbol() RPC) ───────────────────────────
async function testResolveTokens() {
  const WMON    = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a' // should hit cache
  const GMONAD  = '0x7db552eeb6b77a6babe6e0a739b5382cd653cc3e' // unknown, needs RPC
  try {
    // Test Buffer availability
    let bufferTest = 'unknown'
    try {
      bufferTest = Buffer.from('474d4f4e4144', 'hex').toString('utf8')
    } catch (be: any) {
      bufferTest = 'Buffer ERROR: ' + be.message
    }

    // Test symbol() call directly
    const calls = [
      ethCall(GMONAD, '0x95d89b41', 0), // symbol()
      ethCall(GMONAD, '0x313ce567', 1), // decimals()
    ]
    const results = await rpcBatch(calls)
    const symRaw = results[0]?.result ?? ''
    const decRaw = results[1]?.result ?? ''

    // Try decoding symbol
    let decodedSymbol = 'failed'
    try {
      const d = symRaw.startsWith('0x') ? symRaw.slice(2) : symRaw
      if (d.length >= 128) {
        const len = parseInt(d.slice(64, 128), 16)
        if (len > 0 && len <= 100) {
          const str = d.slice(128, 128 + len * 2)
          decodedSymbol = Buffer.from(str, 'hex').toString('utf8').replace(/\0/g, '').trim()
        } else {
          decodedSymbol = `len=${len} out of range`
        }
      } else {
        decodedSymbol = `raw too short: ${d.length} chars`
      }
    } catch (de: any) {
      decodedSymbol = 'decode ERROR: ' + de.message
    }

    return {
      bufferAvailable: bufferTest,
      WMON_inCache: true,
      GMONAD_symbolRaw: symRaw,
      GMONAD_decimalsRaw: decRaw,
      GMONAD_decodedSymbol: decodedSymbol,
      GMONAD_rpcError0: results[0]?.error ?? null,
      GMONAD_rpcError1: results[1]?.error ?? null,
    }
  } catch (e: any) {
    return { error: e?.message ?? String(e), stack: e?.stack?.slice(0, 300) }
  }
}

// ── Teste 4: Neverland (getUserAccountData + getReserveData) ─────────────────
async function testNeverland(user: string) {
  const POOL = '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585'
  const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a'
  try {
    const paddedUser = user.slice(2).toLowerCase().padStart(64, '0')
    const results = await rpcBatch([
      ethCall(POOL, '0xbf92857c' + paddedUser, 998),
      ethCall(POOL, '0x35ea6a75' + WMON.slice(2).padStart(64, '0'), 999),
    ])
    const acctRaw    = results.find((r: any) => r.id === 998)?.result  ?? null
    const reserveRaw = results.find((r: any) => r.id === 999)?.result ?? null

    let totalCollateralUSD = 0
    if (acctRaw && acctRaw !== '0x') {
      totalCollateralUSD = Number(BigInt('0x' + acctRaw.slice(2, 66))) / 1e8
    }

    let aTokenFromReserve = null
    if (reserveRaw && reserveRaw !== '0x' && reserveRaw.length >= 2 + 11 * 64) {
      const slots = Array.from({ length: 12 }, (_, j) => reserveRaw.slice(2 + j * 64, 2 + (j + 1) * 64))
      aTokenFromReserve = '0x' + slots[8].slice(24)
    }

    return {
      acctRaw_first64: acctRaw?.slice(0, 66) ?? null,
      totalCollateralUSD,
      aTokenFromReserve,
      acctError: results.find((r: any) => r.id === 998)?.error ?? null,
      reserveError: results.find((r: any) => r.id === 999)?.error ?? null,
    }
  } catch (e: any) {
    return { error: e?.message ?? String(e), stack: e?.stack?.slice(0, 300) }
  }
}

// ── Teste 5: Uniswap V3 passo a passo ────────────────────────────────────────
async function testUniswap(user: string) {
  const NFT_PM  = '0x7197e214c0b767cfb76fb734ab638e2c192f4e53'
  const FACTORY = '0x204faca1764b154221e35c0d20abb3c525710498'
  try {
    // balanceOf
    const balRes = await rpcBatch([ethCall(NFT_PM, balanceOfData(user), 1)])
    const nftCountRaw = balRes[0]?.result ?? '0x0'
    const nftCount = Number(BigInt(nftCountRaw))

    if (nftCount === 0) return { nftCount: 0, note: 'Sem posicoes' }

    // tokenOfOwnerByIndex(0)
    const idCall = ethCall(
      NFT_PM,
      '0x2f745c59' + user.slice(2).toLowerCase().padStart(64, '0') + '0'.padStart(64, '0'),
      10
    )
    const idRes   = await rpcBatch([idCall])
    const tokenId = idRes[0]?.result ?? null
    const tokenIdNum = tokenId ? Number(BigInt(tokenId)) : null

    if (!tokenIdNum) return { nftCount, tokenId: null, error: 'tokenId invalido' }

    // positions(tokenId)
    const posCall = ethCall(NFT_PM, '0x99fbab88' + tokenIdNum.toString(16).padStart(64, '0'), 200)
    const posRes  = await rpcBatch([posCall])
    const posRaw  = posRes[0]?.result ?? null
    const d       = posRaw?.slice(2) ?? ''

    let parsedPos: any = { raw_length: d.length }
    if (d.length >= 64 * 8) {
      const w         = Array.from({ length: 12 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const token0    = '0x' + w[2].slice(24)
      const token1    = '0x' + w[3].slice(24)
      const fee       = parseInt(w[4], 16)
      const tL        = parseInt(w[5], 16)
      const tU        = parseInt(w[6], 16)
      const tickLower = tL > 0x7fffffff ? tL - 0x100000000 : tL
      const tickUpper = tU > 0x7fffffff ? tU - 0x100000000 : tU
      const liquidity = BigInt('0x' + w[7])
      parsedPos = { token0, token1, fee, tickLower, tickUpper, liquidity: liquidity.toString(), hasLiquidity: liquidity > 0n }

      // getPool
      const poolCall = ethCall(
        FACTORY,
        '0x1698ee82' + token0.slice(2).toLowerCase().padStart(64, '0') + token1.slice(2).toLowerCase().padStart(64, '0') + fee.toString(16).padStart(64, '0'),
        500
      )
      const poolRes     = await rpcBatch([poolCall])
      const poolAddrRaw = poolRes[0]?.result ?? null
      const poolAddr    = poolAddrRaw ? '0x' + poolAddrRaw.slice(2).slice(-40) : null
      parsedPos.poolAddress = poolAddr
      parsedPos.poolError   = poolRes[0]?.error ?? null

      if (poolAddr && poolAddr !== '0x0000000000000000000000000000000000000000') {
        // slot0
        const s0Res = await rpcBatch([ethCall(poolAddr, '0x3850c7bd', 600)])
        const s0Raw = s0Res[0]?.result ?? null
        if (s0Raw && s0Raw.length >= 10) {
          const s0d = s0Raw.slice(2)
          const s0w = Array.from({ length: 4 }, (_, j) => s0d.slice(j * 64, (j + 1) * 64))
          const ct  = parseInt(s0w[1], 16)
          const currentTick = ct > 0x7fffffff ? ct - 0x100000000 : ct
          parsedPos.currentTick = currentTick
          parsedPos.inRange     = currentTick >= tickLower && currentTick <= tickUpper
          parsedPos.sqrtPriceX96_prefix = '0x' + s0w[0].slice(0, 16)
        }
        parsedPos.slot0Error = s0Res[0]?.error ?? null
      }
    }

    return { nftCount, tokenId: tokenIdNum, position: parsedPos }
  } catch (e: any) {
    return { error: e?.message ?? String(e), stack: e?.stack?.slice(0, 300) }
  }
}

// ── Teste 6: getTokenPricesUSD com simbolos conhecidos e desconhecidos ────────
async function testPrices() {
  const SYMBOL_TO_COINGECKO: Record<string, string> = {
    WMON: 'monad', WETH: 'ethereum', WBTC: 'wrapped-bitcoin',
    USDC: 'usd-coin', USDT0: 'tether', AUSD: 'agora-dollar',
  }
  try {
    const { prices } = await getAllPrices()
    const symbolsToTest = ['WMON', 'USDC', 'UNKNOWNSYMBOL']
    const result: Record<string, any> = {}
    for (const sym of symbolsToTest) {
      const id = SYMBOL_TO_COINGECKO[sym]
      result[sym] = {
        coingeckoId: id ?? 'not mapped',
        price: id ? (prices[id] ?? 'not in prices') : 'no mapping',
      }
    }
    return result
  } catch (e: any) {
    return { error: e?.message ?? String(e) }
  }
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })
  }

  const [rpc, priceCache, tokens, neverland, uniswap, prices] = await Promise.allSettled([
    testRPC(),
    testPriceCache(),
    testResolveTokens(),
    testNeverland(address),
    testUniswap(address),
    testPrices(),
  ])

  const unwrap = (r: PromiseSettledResult<any>) =>
    r.status === 'fulfilled' ? r.value : { PROMISE_REJECTED: r.reason?.message ?? String(r.reason) }

  return NextResponse.json({
    address,
    test1_rpc:        unwrap(rpc),
    test2_priceCache: unwrap(priceCache),
    test3_resolveTokens: unwrap(tokens),
    test4_neverland:  unwrap(neverland),
    test5_uniswap:    unwrap(uniswap),
    test6_prices:     unwrap(prices),
  })
}
