/** @type {import('next').NextConfig} */

const CSP = [
  "default-src 'self'",

  "script-src 'self' 'unsafe-inline' https://*.effectivegatecpm.com https://*.highperformanceformat.com https://*.adsterra.com",

  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

  "font-src 'self' https://fonts.gstatic.com data:",

  "img-src 'self' data: blob: https:",

  [
    "connect-src 'self'",
    "https://rpc.monad.xyz",
    "https://api.coingecko.com",
    "https://pro-api.coingecko.com",
    "https://api.geckoterminal.com",
    "https://tokens.coingecko.com",
    "https://api.etherscan.io",
    "https://api-v2.rubic.exchange",
    "https://api.opensea.io",
    "https://open.er-api.com",
    "https://api.alternative.me",
    "https://api.lagoon.finance",
    "https://app.renzoprotocol.com",
    "https://*.effectivegatecpm.com",
    "https://*.highperformanceformat.com",
    "https://*.adsterra.com",
    "wss://relay.walletconnect.com",
    "wss://relay.walletconnect.org",
    "https://relay.walletconnect.com",
    "https://relay.walletconnect.org",
    "https://api.web3modal.com",
    "https://api.web3modal.org",
    "https://pulse.walletconnect.org",
    "https://rainbowkit.com",
    "https://ethereum-rpc.publicnode.com",
    "https://bsc-rpc.publicnode.com",
    "https://polygon-rpc.com",
    "https://arb1.arbitrum.io",
    "https://mainnet.optimism.io",
    "https://mainnet.base.org",
    "https://api.avax.network",
  ].join(' '),

  "frame-src https://*.effectivegatecpm.com https://*.highperformanceformat.com https://*.adsterra.com",

  "worker-src 'self' blob:",

  "object-src 'none'",

  "upgrade-insecure-requests",
].join('; ')

const nextConfig = {
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'assets.coingecko.com' },
      { protocol: 'https', hostname: 'coin-images.coingecko.com' },
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'api.geckoterminal.com' },
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: 'gateway.pinata.cloud' },
      { protocol: 'https', hostname: 'icons.llamao.fi' },
    ],
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
