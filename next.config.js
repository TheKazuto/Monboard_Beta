/** @type {import('next').NextConfig} */

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
        // Headers gerais para todas as rotas
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'X-XSS-Protection',          value: '0' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
          // SAMEORIGIN em vez de DENY — permite iframes same-origin.
          // /api/ad-frame é carregado via iframe do próprio domínio,
          // por isso SAMEORIGIN funciona correctamente e não precisa de override.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      // Fix #11 (BAIXO): Removido o bloco que definia X-Frame-Options: '' para
      // /api/ad-frame. Definir um header como string vazia tem comportamento
      // inconsistente entre browsers. Como o iframe é same-origin, o valor
      // global SAMEORIGIN já é suficiente e correcto para esta rota.
    ]
  },
}

module.exports = nextConfig
