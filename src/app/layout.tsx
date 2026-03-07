import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import Navbar from '@/components/Navbar'
import BottomBar from '@/components/BottomBar'
import Providers from '@/components/Providers'

const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT ?? ''

export const metadata: Metadata = {
  title: 'MonBoard — Your Monad Portfolio Dashboard',
  description: 'The ultimate dashboard for Monad ecosystem. Track your portfolio, DeFi positions, NFTs and get real-time alerts.',
  keywords: ['monad', 'blockchain', 'portfolio', 'defi', 'nft', 'dashboard'],
  openGraph: {
    title: 'MonBoard',
    description: 'Your Monad Portfolio Dashboard',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen" style={{ background: 'var(--monad-bg)' }}>
        {ADSENSE_CLIENT && (
          <Script
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
            crossOrigin="anonymous"
            strategy="lazyOnload"
          />
        )}
        <Providers>
          <Navbar />
          <main className="page-content pt-16">
            {children}
          </main>
          <BottomBar />
        </Providers>
      </body>
    </html>
  )
}
