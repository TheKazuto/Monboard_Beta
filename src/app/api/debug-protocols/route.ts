import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

// ─── Rota de debug — REMOVER antes do deploy final ───────────────────────────
// Espelha exatamente o código do fetchUniswapV3 em defi/route.ts
// mas expõe todos os erros em vez de engoli-los

const PCAKE_NFT_PM  = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364'
const PCAKE_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'

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

// ── Test Buffer availability ─────────────────────────────────────────────────
function testBuffer(hex: string): { ok: boolean; result?: string; error?: string } {
  try {
    const d   = hex.startsWith('0x') ? hex.slice(2) : hex
    const len = parseInt(d.slice(64, 128), 16)
    const str = d.slice(128, 128 + len * 2)
    const res = Buffer.from(str, 'hex').toString('utf8').replace(/\0/g, '').trim()
    return { ok: true, result: res }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// ── Decodes ABI string (same logic as defi/route.ts) ─────────────────────────
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

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })
  }

  const result: Record<string, any> = { address }

  // ── Step 1: NFT balance ───────────────────────────────────────────────────
  let nftCount = 0
  try {
    const balRes = await rpcBatch([ethCall(PCAKE_NFT_PM, balanceOfData(address), 1)])
    nftCount = Number(decodeUint(balRes[0]?.result ?? '0x'))
    result.step1 = { nftCount, raw: balRes[0]?.result, error: balRes[0]?.error ?? null }
  } catch (e: any) {
    return NextResponse.json({ ...result, fatal: 'step1: ' + (e?.message ?? e) })
  }

  if (nftCount === 0) return NextResponse.json({ ...result, note: 'Sem posições' })

  // ── Step 2: tokenIds ──────────────────────────────────────────────────────
  let tokenIds: bigint[] = []
  try {
    const idCalls = Array.from({ length: Math.min(nftCount, 5) }, (_, i) =>
      ethCall(PCAKE_NFT_PM, '0x2f745c59' + address.slice(2).toLowerCase().padStart(64,'0') + i.toString(16).padStart(64,'0'), i + 10)
    )
    const idResults = await rpcBatch(idCalls)
    tokenIds = idResults.map((r: any) => decodeUint(r?.result ?? '0x')).filter(id => id > 0n)
    result.step2 = { tokenIds: tokenIds.map(String) }
  } catch (e: any) {
    return NextResponse.json({ ...result, fatal: 'step2: ' + (e?.message ?? e) })
  }

  // ── Step 3: positions() ───────────────────────────────────────────────────
  const parsedPositions: any[] = []
  const tokenAddressSet = new Set<string>()
  try {
    const posCalls = tokenIds.map((id, i) =>
      ethCall(PCAKE_NFT_PM, '0x99fbab88' + id.toString(16).padStart(64,'0'), i + 200)
    )
    const posResults = await rpcBatch(posCalls)
    result.step3_raw = posResults.map((r: any) => ({ result: r?.result?.slice(0,66), error: r?.error }))

    for (let i = 0; i < tokenIds.length; i++) {
      const hex = posResults[i]?.result
      if (!hex || hex === '0x' || hex.length < 10) continue
      const d = hex.slice(2)
      if (d.length < 64 * 8) { result.step3_short = `d.length=${d.length}`; continue }
      const w = Array.from({ length: 12 }, (_, j) => d.slice(j * 64, (j + 1) * 64))
      const token0 = '0x' + w[2].slice(24)
      const token1 = '0x' + w[3].slice(24)
      const fee    = parseInt(w[4], 16)
      const tL = parseInt(w[5], 16)
      const tU = parseInt(w[6], 16)
      const tickLower = tL > 0x7fffffff ? tL - 0x100000000 : tL
      const tickUpper = tU > 0x7fffffff ? tU - 0x100000000 : tU
      const liquidity = BigInt('0x' + w[7])
      tokenAddressSet.add(token0.toLowerCase())
      tokenAddressSet.add(token1.toLowerCase())
      parsedPositions.push({ token0, token1, fee, tickLower, tickUpper, liquidity: liquidity.toString(), hasLiq: liquidity > 0n })
    }
    result.step3 = parsedPositions
  } catch (e: any) {
    return NextResponse.json({ ...result, fatal: 'step3: ' + (e?.message ?? e) })
  }

  // ── Step 4: resolveTokens (replicate logic from defi/route.ts) ─────────────
  const TOKEN_CACHE: Record<string, any> = {
    '0x3bd359c1119da7da1d913d1c4d2b7c461115433a': { symbol: 'WMON', decimals: 18 },
  }
  const unknownAddrs = [...tokenAddressSet].filter(a => !TOKEN_CACHE[a])
  result.step4_unknown_tokens = unknownAddrs

  try {
    if (unknownAddrs.length > 0) {
      const calls: object[] = []
      unknownAddrs.forEach((addr, i) => {
        calls.push(ethCall(addr, '0x95d89b41', i * 2))      // symbol()
        calls.push(ethCall(addr, '0x313ce567', i * 2 + 1)) // decimals()
      })
      const results = await rpcBatch(calls).catch((e: any) => {
        result.step4_rpcBatch_error = e?.message ?? String(e)
        return [] as any[]
      })

      result.step4_rpc_results = unknownAddrs.map((addr, i) => {
        const symRaw = results.find((r: any) => r.id === i * 2)?.result     ?? ''
        const decRaw = results.find((r: any) => r.id === i * 2 + 1)?.result ?? ''
        const bufTest = symRaw ? testBuffer(symRaw) : null
        const decoded = decodeAbiString(symRaw)
        return { addr, symRaw: symRaw.slice(0, 40), decRaw, bufferTest: bufTest, decodedSymbol: decoded || `fallback:${addr.slice(2,8).toUpperCase()}` }
      })
    }
  } catch (e: any) {
    result.step4_error = e?.message ?? String(e)
    result.step4_stack = (e?.stack ?? '').slice(0, 400)
  }

  // ── Step 5: getPool() ─────────────────────────────────────────────────────
  try {
    const activePos = parsedPositions.filter(p => p.hasLiq)
    if (activePos.length === 0) {
      result.step5 = 'No active positions (liquidity=0)'
    } else {
      const poolCalls = activePos.map((pos, i) =>
        ethCall(PCAKE_FACTORY, '0x1698ee82'
          + pos.token0.slice(2).toLowerCase().padStart(64,'0')
          + pos.token1.slice(2).toLowerCase().padStart(64,'0')
          + pos.fee.toString(16).padStart(64,'0'), i + 500)
      )
      const poolResults = await rpcBatch(poolCalls)
      result.step5 = poolResults.map((r: any, i: number) => ({
        position: i,
        raw: r?.result,
        error: r?.error ?? null,
        poolAddr: r?.result ? decodeAddress(r.result) : null,
      }))

      // ── Step 6: slot0() ─────────────────────────────────────────────────
      const validPools = result.step5.filter((p: any) => p.poolAddr && p.poolAddr !== '0x0000000000000000000000000000000000000000')
      if (validPools.length > 0) {
        const slot0Calls = validPools.map((p: any, i: number) =>
          ethCall(p.poolAddr, '0x3850c7bd', i + 600)
        )
        const slot0Results = await rpcBatch(slot0Calls)
        result.step6_slot0 = slot0Results.map((r: any) => ({
          raw: r?.result?.slice(0, 66),
          error: r?.error ?? null,
        }))
      }
    }
  } catch (e: any) {
    result.step5_error = e?.message ?? String(e)
    result.step5_stack = (e?.stack ?? '').slice(0, 400)
  }

  result.conclusion = parsedPositions.filter(p => p.hasLiq).length > 0
    ? 'Pipeline completa — se posições ainda não aparecem, erro está no getTokenPricesUSD ou montagem final'
    : 'Nenhuma posição ativa encontrada'

  return NextResponse.json(result)
}
