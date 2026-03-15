// Gerado por: npm run cf-typegen
// Editado manualmente para incluir o binding PRICE_KV.
//
// Para regenerar automaticamente após adicionar novos bindings:
//   npm run cf-typegen

interface CloudflareEnv {
  ASSETS: Fetcher
  WORKER_SELF_REFERENCE: Fetcher
  /** KV namespace compartilhado para cache de preços CoinGecko e dados de API. */
  PRICE_KV: KVNamespace
}
