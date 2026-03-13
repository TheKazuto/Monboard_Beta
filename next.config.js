/** @type {import('next').NextConfig} */

// ─── Strict Content-Security-Policy ──────────────────────────────────────────
const CSP = [
  "default-src 'self'",

  // Scripts: self + unsafe-inline (Next.js 14 SSR) + AdsTerra CDN domains.
  // Wildcards needed: AdsTerra script loads sub-scripts from other subdomains.
  "script-src 'self' 'unsafe-inline' https://*.effectivegatecpm.com https://*.highperformanceformat.com https://*.adsterra.com",

  // Styles
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

  // Fonts
  "font-src 'self' https://fonts.gstatic.com data:",

  // Images: allow all HTTPS — NFT images come from unpredictable hosts
  "img-src 'self' data: blob: https:",

  // Connections
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
    // AdsTerra CDN + tracking
    "https://*.effectivegatecpm.com",
    "https://*.highperformanceformat.com",
    "https://*.adsterra.com",
    // WalletConnect
    "wss://relay.walletconnect.com",
    "wss://relay.walletconnect.org",
    "https://relay.walletconnect.com",
    "https://relay.walletconnect.org",
    "https://api.web3modal.com",
    "https://api.web3modal.org",
    "https://pulse.walletconnect.org",
    "https://rainbowkit.com",
    // Public RPC nodes
    "https://ethereum-rpc.publicnode.com",
    "https://bsc-rpc.publicnode.com",
    "https://polygon-rpc.com",
    "https://arb1.arbitrum.io",
    "https://mainnet.optimism.io",
    "https://mainnet.base.org",
    "https://api.avax.network",
  ].join(' '),

  // Frames: AdsTerra iframes spawned by the ad script inside our srcdoc iframe.
  // 'self' needed because our iframe srcdoc is same-origin.
  "frame-src 'self' https://*.effectivegatecpm.com https://*.highperformanceformat.com https://*.adsterra.com",

  // Workers
  "worker-src 'self' blob:",

  // Block plugins
  "object-src 'none'",

  // Force HTTPS
  "upgrade-insecure-requests",
].join('; ')

const nextConfig = {
  images: {
    // Cloudflare Pages does not support Next.js Image Optimization API.
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
