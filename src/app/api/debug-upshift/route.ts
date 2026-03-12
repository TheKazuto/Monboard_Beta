import { NextResponse } from 'next/server'

export const revalidate = 0

// Usando earnAUSD como subgraph de referência para descobrir o schema
const REF_SUBGRAPH = 'https://api.goldsky.com/api/private/project_cm9g0xy3o4j6v01vd34r3hvv9/subgraphs/august-monad-earnAUSD/1.0.0/gn'

async function gql(url: string, query: string, label: string) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    const data = await res.json()
    return { label, ok: res.ok, status: res.status, data }
  } catch (e: any) {
    return { label, ok: false, status: 0, data: null, error: e.message }
  }
}

export async function GET() {
  const SUB = REF_SUBGRAPH

  const results = await Promise.all([

    // 1. Introspect: quais entities existem?
    gql(SUB, `{
      __schema {
        queryType {
          fields { name }
        }
      }
    }`, 'introspect_entities'),

    // 2. Vault básico
    gql(SUB, `{
      vaults(first: 5) {
        id name symbol
        totalValueLockedUSD
        inputTokens { symbol }
        outputToken { symbol }
        rewardTokens { token { symbol } }
        rates { id rate side type duration }
      }
    }`, 'vault_with_rates'),

    // 3. vaultDailySnapshots — normalmente contém APR/pricePerShare
    gql(SUB, `{
      vaultDailySnapshots(first: 5, orderBy: timestamp, orderDirection: desc) {
        id timestamp vault { id name }
        totalValueLockedUSD
        pricePerShare
        dailyReturnRate
        cumulativeReturnRate
        dailyTotalRevenueUSD
      }
    }`, 'vaultDailySnapshots'),

    // 4. financialsDailySnapshots
    gql(SUB, `{
      financialsDailySnapshots(first: 5, orderBy: timestamp, orderDirection: desc) {
        id timestamp
        totalValueLockedUSD
        dailyTotalRevenueUSD
        dailySupplySideRevenueUSD
        cumulativeTotalRevenueUSD
      }
    }`, 'financialsDailySnapshots'),

    // 5. vaultHourlySnapshots
    gql(SUB, `{
      vaultHourlySnapshots(first: 5, orderBy: timestamp, orderDirection: desc) {
        id timestamp
        pricePerShare
        hourlyReturnRate
        totalValueLockedUSD
      }
    }`, 'vaultHourlySnapshots'),

    // 6. Tentar yields diretamente
    gql(SUB, `{
      yields(first: 5, orderBy: timestamp, orderDirection: desc) {
        id timestamp apr apy tvl
      }
    }`, 'yields'),

    // 7. events/deposits para calcular manualmente
    gql(SUB, `{
      deposits(first: 3, orderBy: timestamp, orderDirection: desc) {
        id timestamp amount amountUSD
        sharesMinted
      }
    }`, 'deposits'),

  ])

  // Também testar earnMON para ver se o schema é consistente
  const earnMonVault = await gql(
    'https://api.goldsky.com/api/private/project_cm9g0xy3o4j6v01vd34r3hvv9/subgraphs/august-monad-earnMON/1.0.0/gn',
    `{
      vaults(first: 3) {
        id name symbol totalValueLockedUSD
        rates { id rate side type duration }
      }
      vaultDailySnapshots(first: 3, orderBy: timestamp, orderDirection: desc) {
        id timestamp pricePerShare dailyReturnRate cumulativeReturnRate
      }
    }`,
    'earnMON_vault_and_snapshots'
  )

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    ref_subgraph: 'august-monad-earnAUSD',
    queries: results,
    earnMON_cross_check: earnMonVault,
  })
}
