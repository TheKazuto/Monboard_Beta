/** @type {import('next').NextConfig} */

// ─── Security Headers ─────────────────────────────────────────────────────────
// NOTA: script-src, connect-src e frame-src foram removidos do CSP.
// O AdsTerra rotaciona domínios dinamicamente a cada impressão — qualquer
// whitelist estática vai sempre bloquear os novos domínios gerados.
// Os demais headers de segurança (HSTS, X-Frame-Options, etc.) são mantidos.

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
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'X-XSS-Protection',          value: '0' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
          // X-Frame-Options: DENY mantido — protege contra clickjacking da
          // *nossa* página sendo embarcada em outros sites. Não afeta iframes
          // de terceiros que a nossa página carrega.
          { key: 'X-Frame-Options',           value: 'DENY' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
