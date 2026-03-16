import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'
import { getAllPrices } from '@/lib/priceCache'

// ─── Rota de debug inline — REMOVER antes do deploy final ────────────────────
// Executa fetchUniswapV3 para PancakeSwap passo a passo
// retornando TODAS as variáveis intermediárias no response

const NFT_PM  = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364'
const FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'

function ethCall(to: string, data: string, id: number) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function decodeUint(hex: string): bigint {
  if (!hex || hex === '0x') return 0n
  try { return BigInt(hex.startsWith('0x') ? hex : '0x' + hex) } catch { return 0n }
}
function balanceOfData(addr: string) {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}
function decodeAddress(hex: string): string {
  if (!hex || hex === '0x') return '0x0000000000000000000000000000000000000000'
  return '0x' + hex.slice(2).slice(-40)
}

function decodeAbiString(hex: string): string {
  try {
    const d = hex.startsWith('0x') ? hex.slice(2) : hex
    if (d.length < 128) return ''
    const len = parseInt(d.slice(64, 128), 16)
    if (len === 0 || len > 100) return ''
    const str = d.slice(128, 128 + len * 2)
    return Buffer.from(str, 'hex').toString('utf8').replace(/\0/g, '').trim()
  } catch (e: any) {
    return 'DECODE_ERR:' + (e?.message ?? e)
  }
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })
  }

  const trace: Record<string, any> = {}

  // ── 1. balanceOf ────────────────────────────────────────────────────────────
  const balRes = await rpcBatch([ethCall(NFT_PM, balanceOfData(address), 1)])
  const nftCount = Number(decodeUint(balRes[0]?.result ?? '0x'))
  trace.step1_nftCount = nftCount
  if (nftCount === 0) return NextResponse.json({ ...trace, done: 'no nfts' })

  // ── 2. tokenIds ─────────────────────────────────────────────────────────────
  const idCalls = Array.from({ length: Math.min(nftCount, 5) }, (_, i) =>
    ethCall(NFT_PM, '0x2f745c59' + address.slice(2).toLowerCase().padStart(64,'0') + i.toString(16).padStart(64,'0'), i + 10)
  )
  const idResults = await rpcBatch(idCalls)
  const tokenIds = idResults.map((r: any) => decodeUint(r?.result ?? '0x')).filter(id => id > 0n)
  trace.step2_tokenIds = tokenIds.map(String)
  trace.step2_id_types = idResults.map((r: any) => ({ id: r.id, id_type: typeof r.id }))

  // ── 3. positions() ──────────────────────────────────────────────────────────
  const posCalls = tokenIds.map((id, i) =>
    ethCall(NFT_PM, '0x99fbab88' + id.toString(16).padStart(64,'0'), i + 200)
  )
  const posResults = await rpcBatch(posCalls)
  trace.step3_pos_id_types = posResults.map((r: any) => ({ id: r.id, id_type: typeof r.id }))

  const tokenAddresses = new Set<string>()
  const parsedPositions: any[] = []
  for (let i = 0; i < tokenIds.length; i++) {
    const hex = posResults[i]?.result
    if (!hex || hex === '0x' || hex.length < 10) { trace['step3_skip_' + i] = 'bad hex len:' + hex?.length; continue }
    const d = hex.slice(2)
    if (d.length < 64 * 8) { trace['step3_skip_' + i] = 'short d:' + d.length; continue }
    const w = Array.from({ length: 12 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
    const token0 = '0x' + w[2].slice(24)
    const token1 = '0x' + w[3].slice(24)
    const fee = parseInt(w[4], 16)
    const tL = parseInt(w[5], 16), tU = parseInt(w[6], 16)
    const tickLower = tL > 0x7fffffff ? tL - 0x100000000 : tL
    const tickUpper = tU > 0x7fffffff ? tU - 0x100000000 : tU
    const liquidity = BigInt('0x' + w[7])
    if (liquidity === 0n) { trace['step3_skip_' + i] = 'liquidity=0'; continue }
    tokenAddresses.add(token0.toLowerCase())
    tokenAddresses.add(token1.toLowerCase())
    parsedPositions.push({ token0, token1, fee, tickLower, tickUpper, liquidity: liquidity.toString() })
  }
  trace.step3_parsedPositions = parsedPositions
  trace.step3_tokenAddresses = [...tokenAddresses]
  if (!parsedPositions.length) return NextResponse.json({ ...trace, done: 'no parsed positions' })

  // ── 4. resolveTokens ────────────────────────────────────────────────────────
  const TOKEN_CACHE_INLINE: Record<string, any> = {
    '0x3bd359c1119da7da1d913d1c4d2b7c461115433a': { symbol: 'WMON', decimals: 18 },
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c': { symbol: 'WBTC', decimals: 8  },
    '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242': { symbol: 'WETH', decimals: 18 },
    '0x754704bc059f8c67012fed69bc8a327a5aafb603': { symbol: 'USDC', decimals: 6  },
  }
  const unknown = [...tokenAddresses].filter(a => !TOKEN_CACHE_INLINE[a])
  trace.step4_unknown = unknown
  if (unknown.length > 0) {
    const sCalls: object[] = []
    unknown.forEach((addr, i) => {
      sCalls.push(ethCall(addr, '0x95d89b41', i * 2))
      sCalls.push(ethCall(addr, '0x313ce567', i * 2 + 1))
    })
    const sResults = await rpcBatch(sCalls).catch((e: any) => {
      trace.step4_rpc_error = e?.message ?? String(e)
      return [] as any[]
    })
    trace.step4_sResults = sResults.map((r: any) => ({
      id: r.id, id_type: typeof r.id, result_prefix: r.result?.slice(0,10), error: r.error
    }))
    unknown.forEach((addr, i) => {
      // Test BOTH number and string key lookup
      const byNum = sResults.find((r: any) => r.id === i * 2)
      const byStr = sResults.find((r: any) => r.id === String(i * 2))
      const symRaw = byNum?.result ?? byStr?.result ?? ''
      const decRaw = sResults.find((r: any) => r.id === i * 2 + 1 || r.id === String(i * 2 + 1))?.result ?? ''
      trace['step4_token_' + addr.slice(2,8)] = {
        symRaw_prefix: symRaw.slice(0,20),
        decoded: decodeAbiString(symRaw),
        decRaw_prefix: decRaw.slice(0,20),
        decimals: decRaw && decRaw !== '0x' ? String(BigInt(decRaw)) : '18(fallback)',
        found_by_num: !!byNum,
        found_by_str: !!byStr,
      }
      TOKEN_CACHE_INLINE[addr] = {
        symbol:   decodeAbiString(symRaw) || addr.slice(2, 8).toUpperCase(),
        decimals: decRaw && decRaw !== '0x' ? Number(BigInt(decRaw)) : 18,
      }
    })
  }

  // ── 5. getPool ──────────────────────────────────────────────────────────────
  const poolCalls: object[] = []
  const poolMeta: Record<number, any> = {}
  let pcIdx = 500
  for (const pos of parsedPositions) {
    const t0 = TOKEN_CACHE_INLINE[pos.token0.toLowerCase()] ?? { symbol: pos.token0.slice(2,8).toUpperCase(), decimals: 18 }
    const t1 = TOKEN_CACHE_INLINE[pos.token1.toLowerCase()] ?? { symbol: pos.token1.slice(2,8).toUpperCase(), decimals: 18 }
    poolCalls.push(ethCall(FACTORY, '0x1698ee82'
      + pos.token0.slice(2).toLowerCase().padStart(64,'0')
      + pos.token1.slice(2).toLowerCase().padStart(64,'0')
      + pos.fee.toString(16).padStart(64,'0'), pcIdx))
    poolMeta[pcIdx] = { ...pos, t0sym: t0.symbol, t1sym: t1.symbol, t0dec: t0.decimals, t1dec: t1.decimals }
    pcIdx++
  }
  const poolAddrResults = await rpcBatch(poolCalls)
  trace.step5_poolMeta_keys = Object.keys(poolMeta)
  trace.step5_poolAddrResults = poolAddrResults.map((r: any) => ({
    id: r.id,
    id_type: typeof r.id,
    matches_meta_by_num: !!poolMeta[r.id],
    matches_meta_by_str: !!poolMeta[Number(r.id)],
    poolAddr: r.result ? decodeAddress(r.result) : 'NULL',
    error: r.error,
  }))

  // ── 6. slot0 ────────────────────────────────────────────────────────────────
  const slot0Calls: object[] = []
  const slot0Meta: Record<number, any> = {}
  let s0Idx = 600
  for (const res of poolAddrResults) {
    // Try both numeric and string key to detect the bug
    const meta = poolMeta[res.id] ?? poolMeta[Number(res.id)]
    if (!meta) continue
    if (!res.result || res.result === '0x') continue
    const poolAddr = decodeAddress(res.result)
    if (poolAddr === '0x0000000000000000000000000000000000000000') continue
    slot0Calls.push(ethCall(poolAddr, '0x3850c7bd', s0Idx))
    slot0Meta[s0Idx] = meta
    s0Idx++
  }
  trace.step6_slot0Calls_count = slot0Calls.length

  if (!slot0Calls.length) {
    trace.conclusion = 'BLOCKED at slot0Calls — poolAddrResults id type mismatch or empty pool'
    return NextResponse.json(trace)
  }

  const slot0Results = await rpcBatch(slot0Calls)
  trace.step6_slot0Results = slot0Results.map((r: any) => ({
    id: r.id, id_type: typeof r.id,
    result_len: r.result?.length, result_prefix: r.result?.slice(0,66),
    error: r.error,
  }))

  // ── 7. prices ───────────────────────────────────────────────────────────────
  const allSymbols = [...new Set(Object.values(slot0Meta).flatMap((m: any) => [m.t0sym, m.t1sym]))]
  let prices: Record<string, number> = {}
  try {
    const pd = await getAllPrices()
    const SYMBOL_TO_CG: Record<string,string> = { WMON:'monad', APR:'monad', aprMON:'monad', USDC:'usd-coin', USDT0:'tether', AUSD:'agora-dollar', WETH:'ethereum', WBTC:'wrapped-bitcoin' }
    for (const sym of allSymbols) {
      const id = SYMBOL_TO_CG[sym]
      if (id && pd.prices[id]) prices[sym] = pd.prices[id]
    }
  } catch (e: any) {
    trace.step7_prices_error = e?.message ?? String(e)
  }
  trace.step7_symbols = allSymbols
  trace.step7_prices = prices

  // ── 8. build positions ──────────────────────────────────────────────────────
  const positions: any[] = []
  for (const s0 of slot0Results) {
    const meta = slot0Meta[s0.id]
    if (!meta) { trace['step8_skip_nometa_' + s0.id] = true; continue }
    if (!s0.result || s0.result === '0x' || s0.result.length < 10) { trace['step8_skip_badresult_' + s0.id] = s0.result?.length; continue }
    const d  = s0.result.slice(2)
    const w  = Array.from({ length: 4 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
    trace['step8_w0'] = w[0].slice(0, 20)
    trace['step8_w1'] = w[1].slice(0, 20)
    let sqrtPriceX96: bigint, ct: number
    try { sqrtPriceX96 = BigInt('0x' + w[0]) } catch (e: any) { trace.step8_sqrt_err = e?.message; continue }
    try { ct = parseInt(w[1], 16) } catch (e: any) { trace.step8_ct_err = e?.message; continue }
    const currentTick = ct > 0x7fffffff ? ct - 0x100000000 : ct
    const inRange = currentTick >= meta.tickLower && currentTick <= meta.tickUpper
    const L = Number(meta.liquidity)
    const sqrtP = Number(sqrtPriceX96) / (2 ** 96)
    const sqrtA = Math.sqrt(Math.pow(1.0001, meta.tickLower))
    const sqrtB = Math.sqrt(Math.pow(1.0001, meta.tickUpper))
    let amount0 = 0, amount1 = 0
    if (currentTick < meta.tickLower)       { amount0 = L * (1/sqrtA - 1/sqrtB) }
    else if (currentTick >= meta.tickUpper) { amount1 = L * (sqrtB - sqrtA) }
    else { amount0 = L * (1/sqrtP - 1/sqrtB); amount1 = L * (sqrtP - sqrtA) }
    amount0 /= Math.pow(10, meta.t0dec)
    amount1 /= Math.pow(10, meta.t1dec)
    const amountUSD = amount0 * (prices[meta.t0sym] ?? 0) + amount1 * (prices[meta.t1sym] ?? 0)
    trace.step8_amounts = { amount0, amount1, amountUSD, t0sym: meta.t0sym, t1sym: meta.t1sym, inRange, currentTick }
    positions.push({ protocol: 'PancakeSwap V3', label: `${meta.t0sym}/${meta.t1sym}`, amountUSD, inRange })
  }

  trace.step8_positions_count = positions.length
  trace.step8_positions = positions
  trace.conclusion = positions.length > 0 ? 'SUCCESS — positions found' : 'EMPTY — check step8 details'

  return NextResponse.json(trace)
}
