import { NextRequest, NextResponse } from 'next/server'
import { rpcBatch } from '@/lib/monad'

// ─── Rota de debug — REMOVER antes do deploy final ───────────────────────────
// Acesso: GET /api/debug-neverland?address=0x...
// Mostra exatamente o que o RPC retorna em cada etapa da fetchNeverland

const NEVERLAND_POOL = '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585'

function ethCall(to: string, data: string, id: number | string) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function balanceOfData(addr: string): string {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}
function decodeUint(hex: string): string {
  if (!hex || hex === '0x') return '0'
  try { return BigInt(hex).toString() } catch { return 'decode_error' }
}

// aToken addresses (supply positions)
const NEVERLAND_NTOKENS: Record<string, string> = {
  '0xFDE1d58a35EB78D84571D2cd99A04d6f91B51aD5': 'aWMON',
  '0x1a9f2B5f8cA3951bCDA51C0B3FceFEd4C3Dbe56b': 'aWBTC',
  '0x93Dd76d3c24Aa0A3f2d5d44693c3B4DfF800B8fD': 'aWETH',
  '0x36d0E7B9CbD6dd3Ec0aCcB27B54EF0A03e7a1E50': 'aAUSD',
  '0xF0f7e3F3b09B45a13cBDfaDD88dbBf0dc59B8A53': 'aUSDC',
  '0xf9a56d43dB6cFDe71d4b43b450E7a7A7e691e11F': 'aUSDT0',
  '0xdFC14d336aea9E49113b1356333FD374e646Bf85': 'asMON',
  '0x7f81779736968836582D31D36274Ed82053aD1AE': 'agMON',
  '0xC64d73Bb8748C6fA7487ace2D0d945B6fBb2EcDe': 'ashMON',
}

// Debt token addresses (borrow positions)
const NEVERLAND_DEBT_TOKENS: Record<string, string> = {
  '0x3acA285b9F57832fF55f1e6835966890845c1526': 'debtWMON',
  '0x544a5fF071090F4eE3AD879435f4dC1C1eeC1873': 'debtWBTC',
  '0xdE6C157e43c5d9B713C635f439a93CA3BE2156B6': 'debtWETH',
  '0x54fC077EAe1006FE3C5d01f1614802eAFCbEe57E': 'debtAUSD',
  '0xb26FB5e35f6527d6f878F7784EA71774595B249C': 'debtUSDC',
  '0xa2d753458946612376ce6e5704Ab1cc79153d272': 'debtUSDT0',
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Pass ?address=0x...' }, { status: 400 })
  }

  const result: Record<string, any> = { address, steps: {} }

  // ── STEP 1: getUserAccountData ─────────────────────────────────────────────
  try {
    const paddedAddr = address.slice(2).toLowerCase().padStart(64, '0')
    const acctRes = await rpcBatch([
      ethCall(NEVERLAND_POOL, '0xbf92857c' + paddedAddr, 'getUserAccountData')
    ])
    const raw = acctRes[0]?.result ?? null
    result.steps.getUserAccountData = {
      contract: NEVERLAND_POOL,
      selector: '0xbf92857c',
      raw,
      error: acctRes[0]?.error ?? null,
      decoded: raw && raw !== '0x' ? (() => {
        const hex = raw.slice(2)
        const words = Array.from({ length: 6 }, (_, i) => hex.slice(i * 64, (i + 1) * 64))
        return {
          totalCollateralBase_raw: '0x' + words[0],
          totalDebtBase_raw:       '0x' + words[1],
          availableBorrowsBase_raw:'0x' + words[2],
          liquidationThreshold_raw:'0x' + words[3],
          ltv_raw:                 '0x' + words[4],
          healthFactor_raw:        '0x' + words[5],
          totalCollateralUSD: (Number(BigInt('0x' + words[0])) / 1e8).toFixed(4),
          totalDebtUSD:       (Number(BigInt('0x' + words[1])) / 1e8).toFixed(4),
        }
      })() : 'empty_or_zero',
    }
  } catch (e: any) {
    result.steps.getUserAccountData = { error: e?.message ?? String(e) }
  }

  // ── STEP 2: balanceOf em cada aToken ───────────────────────────────────────
  try {
    const aAddrs = Object.keys(NEVERLAND_NTOKENS)
    const calls  = aAddrs.map((a, i) => ethCall(a, balanceOfData(address), i))
    const res    = await rpcBatch(calls)
    result.steps.aTokenBalances = aAddrs.map((addr, i) => ({
      token:   NEVERLAND_NTOKENS[addr],
      address: addr,
      raw:     res[i]?.result ?? null,
      rpcError:res[i]?.error  ?? null,
      balance: decodeUint(res[i]?.result ?? '0x'),
      hasBalance: res[i]?.result && res[i].result !== '0x' && BigInt(res[i].result || '0') > 0n,
    }))
  } catch (e: any) {
    result.steps.aTokenBalances = { error: e?.message ?? String(e) }
  }

  // ── STEP 3: balanceOf em cada debt token ──────────────────────────────────
  try {
    const dAddrs = Object.keys(NEVERLAND_DEBT_TOKENS)
    const calls  = dAddrs.map((a, i) => ethCall(a, balanceOfData(address), i + 100))
    const res    = await rpcBatch(calls)
    result.steps.debtTokenBalances = dAddrs.map((addr, i) => ({
      token:   NEVERLAND_DEBT_TOKENS[addr],
      address: addr,
      raw:     res[i]?.result ?? null,
      rpcError:res[i]?.error  ?? null,
      balance: decodeUint(res[i]?.result ?? '0x'),
      hasBalance: res[i]?.result && res[i].result !== '0x' && BigInt(res[i].result || '0') > 0n,
    }))
  } catch (e: any) {
    result.steps.debtTokenBalances = { error: e?.message ?? String(e) }
  }

  // ── STEP 4: verificar se o Pool responde a outras chamadas básicas ─────────
  try {
    // getAddressesProvider() — seletor Aave V3: 0x0261bf8b
    // Se retornar 0x → pool não é Aave V3 compatível ou endereço errado
    const provRes = await rpcBatch([
      ethCall(NEVERLAND_POOL, '0x0261bf8b', 'getAddressesProvider')
    ])
    result.steps.poolSanityCheck = {
      getAddressesProvider_raw: provRes[0]?.result ?? null,
      error: provRes[0]?.error ?? null,
      valid: !!provRes[0]?.result && provRes[0].result !== '0x',
    }
  } catch (e: any) {
    result.steps.poolSanityCheck = { error: e?.message ?? String(e) }
  }

  // ── Diagnóstico final ─────────────────────────────────────────────────────
  const hasAnyBalance =
    Array.isArray(result.steps.aTokenBalances) &&
    result.steps.aTokenBalances.some((t: any) => t.hasBalance)
  const hasAnyDebt =
    Array.isArray(result.steps.debtTokenBalances) &&
    result.steps.debtTokenBalances.some((t: any) => t.hasBalance)

  result.diagnosis = {
    poolResponds:       result.steps.poolSanityCheck?.valid ?? false,
    hasSupplyPositions: hasAnyBalance,
    hasDebtPositions:   hasAnyDebt,
    conclusion: (() => {
      if (!result.steps.poolSanityCheck?.valid)
        return 'Pool não responde — endereço do pool pode estar errado'
      if (!hasAnyBalance && !hasAnyDebt)
        return 'Nenhum saldo encontrado — verifique se a carteira tem posição na Neverland'
      return 'Saldos encontrados — problema pode estar na decodificação ou nos preços'
    })(),
  }

  return NextResponse.json(result, { status: 200 })
}
