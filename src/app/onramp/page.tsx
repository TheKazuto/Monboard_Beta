'use client'

import { useEffect, useState } from 'react'
import { Banknote, Shield, Globe, Zap } from 'lucide-react'
import { useWallet } from '@/contexts/WalletContext'
import { SORA } from '@/lib/styles'

// Onramper widget base URL
const ONRAMPER_BASE = 'https://buy.onramper.com'

// Default widget config
// API key is optional for basic use — get one free at onramper.com for revenue share
const ONRAMPER_API_KEY = process.env.NEXT_PUBLIC_ONRAMPER_API_KEY ?? ''

interface WidgetParams {
  walletAddress?: string
  defaultCrypto?: string
  defaultNetwork?: string
  defaultFiat?: string
  themeName?: string
  primaryColor?: string
  secondaryColor?: string
  fontFamily?: string
  borderRadius?: string
  wgd?: string // widget display: 'buy' | 'sell' | 'swap' | 'buy,sell' etc
  partnerContext?: string
}

function buildWidgetUrl(params: WidgetParams): string {
  const query = new URLSearchParams()

  if (ONRAMPER_API_KEY) query.set('apiKey', ONRAMPER_API_KEY)

  // Pre-fill wallet address if connected
  if (params.walletAddress) query.set('wallets', `MON:${params.walletAddress}`)

  // Default to MON on Monad
  query.set('defaultCrypto',   params.defaultCrypto   ?? 'MON')
  query.set('defaultNetwork',  params.defaultNetwork  ?? 'monad')
  query.set('defaultFiat',     params.defaultFiat     ?? 'USD')

  // Widget mode — buy only for simplicity
  query.set('onlyCryptos', 'MON,USDC,ETH,WBTC')

  // Theme — match MonBoard purple palette
  query.set('themeName',      'dark')
  query.set('primaryColor',   '836EF9')  // violet-500
  query.set('secondaryColor', '6d28d9')  // violet-700
  query.set('fontFamily',     'Inter')

  // Partner context for tracking (optional)
  query.set('partnerContext', 'monboard')

  return `${ONRAMPER_BASE}?${query.toString()}`
}

// Feature pills shown below the widget
const FEATURES = [
  {
    icon: Globe,
    title: '190+ countries',
    desc: '130+ local payment methods',
  },
  {
    icon: Shield,
    title: 'KYC handled',
    desc: 'Fully regulated & compliant',
  },
  {
    icon: Zap,
    title: 'Instant delivery',
    desc: 'Crypto sent to your wallet',
  },
  {
    icon: Banknote,
    title: 'Best rates',
    desc: '30+ onramps compared',
  },
]

export default function OnrampPage() {
  const { address, isConnected } = useWallet()
  const [widgetUrl, setWidgetUrl] = useState('')

  // Build URL client-side so wallet address is available
  useEffect(() => {
    setWidgetUrl(buildWidgetUrl({
      walletAddress: isConnected && address ? address : undefined,
    }))
  }, [address, isConnected])

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shadow-lg shadow-violet-200">
            <Banknote size={17} className="text-white" />
          </div>
          <h1 className="font-bold text-2xl text-gray-900" style={SORA}>
            Buy crypto with fiat money
          </h1>
        </div>
        <p className="text-sm text-gray-500 ml-12">
          Convert your local currency to MON and other tokens — directly to your wallet
        </p>
      </div>

      {/* Widget card */}
      <div className="card overflow-hidden">
        {widgetUrl ? (
          <iframe
            src={widgetUrl}
            title="Buy crypto with fiat"
            height="630"
            width="100%"
            className="border-0"
            allow="accelerometer; autoplay; camera; gyroscope; payment; microphone"
            style={{ display: 'block' }}
          />
        ) : (
          // Skeleton while URL builds (SSR / hydration)
          <div className="h-[630px] flex items-center justify-center bg-gray-50">
            <div className="flex flex-col items-center gap-3 text-gray-400">
              <div className="w-8 h-8 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
              <span className="text-sm">Loading payment widget…</span>
            </div>
          </div>
        )}
      </div>

      {/* Feature pills */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        {FEATURES.map(({ icon: Icon, title, desc }) => (
          <div key={title} className="card p-3 flex flex-col gap-1.5">
            <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center">
              <Icon size={14} className="text-violet-600" />
            </div>
            <p className="text-xs font-semibold text-gray-800">{title}</p>
            <p className="text-xs text-gray-400 leading-snug">{desc}</p>
          </div>
        ))}
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-gray-400 text-center mt-4 leading-relaxed">
        Powered by{' '}
        <a href="https://onramper.com" target="_blank" rel="noopener noreferrer" className="text-violet-500 hover:text-violet-700">
          Onramper
        </a>
        {' '}· MonBoard never holds your funds · Rates and availability vary by provider
      </p>
    </div>
  )
}
