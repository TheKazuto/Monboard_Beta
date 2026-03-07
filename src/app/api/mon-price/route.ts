import { NextResponse } from 'next/server'
import { cached } from '@/lib/serverCache'

export const dynamic = 'force-dynamic'

const COINGECKO_ID = 'monad'
const CACHE_TTL = 30_000 // 30 seconds

export async function GET() {
  try {
    const data = await cached('mon-price', async () => {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd&include_24hr_change=true`,
        { cache: 'no-store' }
      )
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`)
      const json = await res.json()
      const d = json[COINGECKO_ID]
      if (!d) throw new Error('Token not in response')

      const price     = d.usd as number
      const change24h = (d.usd_24h_change ?? 0) as number
      const prevPrice = price / (1 + change24h / 100)
      return { price, change24h, changeAmount: price - prevPrice }
    }, CACHE_TTL)

    return NextResponse.json(data)
  } catch (err) {
    console.error('[mon-price]', err)
    return NextResponse.json({ error: 'Failed to fetch price' }, { status: 502 })
  }
}
