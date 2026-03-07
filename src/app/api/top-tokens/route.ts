import { NextResponse } from 'next/server'
import { cached } from '@/lib/serverCache'

export const dynamic = 'force-dynamic'

const CACHE_TTL = 60_000 // 60 seconds

export async function GET() {
  try {
    const data = await cached('top-tokens', async () => {
      const apiKey   = process.env.COINGECKO_API_KEY
      const baseUrl  = apiKey ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com'
      const keyParam = apiKey ? `&x_cg_pro_api_key=${apiKey}` : ''

      const res = await fetch(
        `${baseUrl}/api/v3/coins/markets?vs_currency=usd&category=monad-ecosystem&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h${keyParam}`,
        { cache: 'no-store' }
      )
      if (!res.ok) throw new Error(`CoinGecko error ${res.status}`)
      return await res.json()
    }, CACHE_TTL)

    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}
