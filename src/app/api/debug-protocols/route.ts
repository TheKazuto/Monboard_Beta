import { NextResponse } from 'next/server'

export const revalidate = 0

const KINTSU_LST_GQL = 'https://kintsu.xyz/api/graphql'
const KINTSU_VAULT_ADDRESS = '0x792C7c5fB5C996E588b9F4A5FB201C79974e267C'

export async function GET() {
  // 1. sMON — GraphQL
  let gqlRaw: any = null
  let gqlStatus = 0
  let gqlError: string | null = null
  try {
    const res = await fetch(KINTSU_LST_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{
        Protocol_LST_Analytics_Day(
          where: { chainId: { _eq: 143 } }
          order_by: { date: desc }
          limit: 8
        ) { date totalRewards totalPooledStaked }
      }` }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    gqlStatus = res.status
    gqlRaw = await res.json()
  } catch (e: any) { gqlError = e.message }

  // Calcular APR se tiver dados
  let sMonApr: number | null = null
  const rows: any[] = gqlRaw?.data?.Protocol_LST_Analytics_Day ?? []
  if (rows.length >= 8) {
    const delta = Number(rows[0].totalRewards) - Number(rows[7].totalRewards)
    const tvlAvg = rows.slice(0, 7).reduce((s: number, r: any) => s + Number(r.totalPooledStaked), 0) / 7
    sMonApr = (delta / tvlAvg) / 7 * 365 * 100
  }

  // 2. superMON vault — Upshift proxy
  let proxyRaw: any = null
  let proxyStatus = 0
  let proxyError: string | null = null
  let vaultFound: any = null
  try {
    const res = await fetch('https://app.upshift.finance/api/proxy/vaults', {
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    proxyStatus = res.status
    if (res.ok) {
      const data = await res.json()
      const vaults: any[] = data?.data ?? []
      vaultFound = vaults.find(
        (v: any) => (v.address ?? '').toLowerCase() === KINTSU_VAULT_ADDRESS.toLowerCase()
      ) ?? null
      proxyRaw = { totalVaults: vaults.length, monadVaults: vaults.filter((v:any) => v.chainId === 143).map((v:any) => ({ name: v.name, address: v.address, historical_apy: v.historical_apy })) }
    }
  } catch (e: any) { proxyError = e.message }

  let superMonApr: number | null = null
  if (vaultFound) {
    const hist = vaultFound.historical_apy ?? {}
    const apyDecimal = hist['7'] ?? hist['30'] ?? null
    if (typeof apyDecimal === 'number' && apyDecimal > 0) {
      superMonApr = Math.min(365 * (Math.pow(1 + apyDecimal, 1 / 365) - 1) * 100, 200)
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    sMON: {
      gqlStatus, gqlError,
      rowsReturned: rows.length,
      first: rows[0] ?? null,
      last: rows[7] ?? null,
      calculatedApr: sMonApr,
    },
    superMON: {
      proxyStatus, proxyError,
      proxyRaw,
      vaultFound: vaultFound ? { name: vaultFound.name, address: vaultFound.address, historical_apy: vaultFound.historical_apy } : null,
      calculatedApr: superMonApr,
    },
  })
}
