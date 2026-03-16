import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

// ─── Rota de debug — REMOVER antes do deploy final ───────────────────────────
// Acesso: GET /api/debug-uniswap?address=0x...
// Testa cada etapa da fetchUniswapV3 e mostra o resultado raw de cada chamada RPC

const UNI_NFT_PM  = '0x7197e214c0b767cfb76fb734ab638e2c192f4e53'
const UNI_FACTORY = '0x204faca1764b154221e35c0d20abb3c525710498'
const PCAKE_NFT_PM  = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364'
const PCAKE_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'

function ethCall(to: string, data: string, id: number | string) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function balanceOfData(addr: string) {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}
function tokenOfOwnerByIndex(owner: string, idx: number) {
  return '0x2f745c59' + owner.slice(2).toLowerCase().padStart(64, '0') + idx.toString(16).padStart(64, '0')
}
function positionsData(tokenId: bigint) {
  return '0x99fbab88' + tokenId.toString(16).padStart(64, '0')
}
function getPoolSelector(t0: string, t1: string, fee: number) {
  return '0x1698ee82'
    + t0.slice(2).toLowerCase().padStart(64, '0')
    + t1.slice(2).toLowerCase().padStart(64, '0')
    + fee.toString(16).padStart(64, '0')
}
function decodeUint(hex: string): string {
  if (!hex || hex === '0x') return '0'
  try { return BigInt(hex).toString() } catch { return 'decode_error' }
}

async function debugOneProtocol(label: string, nftPM: string, factory: string, user: string) {
  const result: Record<string, any> = { nftPM, factory }

  // ── STEP 1: balanceOf(user) no NFT Position Manager ───────────────────────
  try {
    const res = await rpcBatch([ethCall(nftPM, balanceOfData(user), 1)])
    const raw = res[0]?.result ?? null
    const count = raw && raw !== '0x' ? Number(BigInt(raw)) : 0
    result.step1_nftBalance = {
      raw,
      rpcError: res[0]?.error ?? null,
      nftCount: count,
      note: count === 0 ? 'Sem posições LP neste protocolo' : `${count} posições encontradas`,
    }
    if (count === 0) return result
  } catch (e: any) {
    result.step1_nftBalance = { error: e?.message ?? String(e) }
    return result
  }

  const nftCount = Number(BigInt(result.step1_nftBalance.raw))
  const limit = Math.min(nftCount, 5) // debug: apenas 5 primeiras

  // ── STEP 2: tokenOfOwnerByIndex para cada posição ─────────────────────────
  try {
    const idCalls = Array.from({ length: limit }, (_, i) =>
      ethCall(nftPM, tokenOfOwnerByIndex(user, i), i + 10)
    )
    const idResults = await rpcBatch(idCalls)
    result.step2_tokenIds = idResults.map((r: any, i: number) => ({
      index:    i,
      raw:      r?.result ?? null,
      rpcError: r?.error  ?? null,
      tokenId:  decodeUint(r?.result ?? '0x'),
    }))
  } catch (e: any) {
    result.step2_tokenIds = { error: e?.message ?? String(e) }
    return result
  }

  const tokenIds = result.step2_tokenIds
    .filter((t: any) => t.raw && t.raw !== '0x' && t.raw !== '0x' + '0'.repeat(64))
    .map((t: any) => BigInt(t.raw))

  if (tokenIds.length === 0) {
    result.step2_tokenIds_note = 'Nenhum tokenId válido retornado'
    return result
  }

  // ── STEP 3: positions(tokenId) para cada NFT ──────────────────────────────
  try {
    const posCalls = tokenIds.map((id: bigint, i: number) =>
      ethCall(nftPM, positionsData(id), i + 200)
    )
    const posResults = await rpcBatch(posCalls)

    result.step3_positions = posResults.map((r: any, i: number) => {
      const hex = r?.result ?? ''
      const d   = hex.slice(2)
      if (!d || d.length < 64 * 8) return {
        tokenId:  tokenIds[i].toString(),
        raw:      hex,
        rpcError: r?.error ?? null,
        note:     'Resposta muito curta ou vazia',
      }
      const w        = Array.from({ length: 12 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const token0   = '0x' + w[2].slice(24)
      const token1   = '0x' + w[3].slice(24)
      const fee      = parseInt(w[4], 16)
      const tickLRaw = parseInt(w[5], 16)
      const tickURaw = parseInt(w[6], 16)
      const tickL    = tickLRaw > 0x7fffffff ? tickLRaw - 0x100000000 : tickLRaw
      const tickU    = tickURaw > 0x7fffffff ? tickURaw - 0x100000000 : tickURaw
      const liq      = BigInt('0x' + w[7])
      return {
        tokenId:    tokenIds[i].toString(),
        rpcError:   r?.error ?? null,
        token0,
        token1,
        fee,
        tickLower:  tickL,
        tickUpper:  tickU,
        liquidity:  liq.toString(),
        hasLiquidity: liq > 0n,
        note: liq === 0n ? '⚠ Liquidity = 0 — posição fechada/removida' : '✓ Posição ativa',
      }
    })
  } catch (e: any) {
    result.step3_positions = { error: e?.message ?? String(e) }
    return result
  }

  const activePositions = result.step3_positions.filter((p: any) => p.hasLiquidity)
  if (activePositions.length === 0) {
    result.step3_note = 'Todas as posições têm liquidity = 0 (fechadas). Nada para mostrar.'
    return result
  }

  // ── STEP 4: getPool(t0, t1, fee) no factory para cada posição ativa ────────
  try {
    const poolCalls = activePositions.map((p: any, i: number) =>
      ethCall(factory, getPoolSelector(p.token0, p.token1, p.fee), i + 500)
    )
    const poolResults = await rpcBatch(poolCalls)

    result.step4_poolAddresses = poolResults.map((r: any, i: number) => {
      const raw = r?.result ?? null
      const poolAddr = raw && raw !== '0x' ? ('0x' + raw.slice(2).slice(-40)) : null
      const isZero = poolAddr === '0x0000000000000000000000000000000000000000'
      return {
        position: i,
        raw,
        rpcError: r?.error ?? null,
        poolAddress: poolAddr,
        valid: !!poolAddr && !isZero,
        note: isZero ? '⚠ Pool não encontrada no factory — endereços de token ou factory incorretos' : '✓',
      }
    })
  } catch (e: any) {
    result.step4_poolAddresses = { error: e?.message ?? String(e) }
    return result
  }

  const validPools = result.step4_poolAddresses.filter((p: any) => p.valid)
  if (validPools.length === 0) {
    result.step4_note = 'Nenhuma pool válida retornada pelo factory'
    return result
  }

  // ── STEP 5: slot0() em cada pool para obter currentTick ───────────────────
  try {
    const slot0Calls = validPools.map((p: any, i: number) =>
      ethCall(p.poolAddress, '0x3850c7bd', i + 600)
    )
    const slot0Results = await rpcBatch(slot0Calls)

    result.step5_slot0 = slot0Results.map((r: any, i: number) => {
      const hex = r?.result ?? ''
      const d   = hex.slice(2)
      if (!d || d.length < 64 * 2) return {
        pool: validPools[i].poolAddress,
        raw: hex, rpcError: r?.error ?? null, note: 'Resposta vazia',
      }
      const w      = Array.from({ length: 4 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const ctRaw  = parseInt(w[1], 16)
      const currentTick = ctRaw > 0x7fffffff ? ctRaw - 0x100000000 : ctRaw
      const pos    = activePositions[i]
      const inRange = pos
        ? (currentTick >= pos.tickLower && currentTick <= pos.tickUpper)
        : null
      return {
        pool:         validPools[i].poolAddress,
        rpcError:     r?.error ?? null,
        sqrtPriceX96: '0x' + w[0],
        currentTick,
        tickLower:    pos?.tickLower,
        tickUpper:    pos?.tickUpper,
        inRange,
        note: inRange === null ? '?' : inRange ? '✓ Em range' : '⚠ Fora do range',
      }
    })
  } catch (e: any) {
    result.step5_slot0 = { error: e?.message ?? String(e) }
  }

  return result
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })
  }

  const [uni, pcake] = await Promise.allSettled([
    debugOneProtocol('Uniswap V3',    UNI_NFT_PM,   UNI_FACTORY,   address),
    debugOneProtocol('PancakeSwap V3', PCAKE_NFT_PM, PCAKE_FACTORY, address),
  ])

  return NextResponse.json({
    address,
    uniswapV3:    uni.status    === 'fulfilled' ? uni.value    : { error: uni.reason },
    pancakeswapV3: pcake.status === 'fulfilled' ? pcake.value  : { error: pcake.reason },
  })
}
