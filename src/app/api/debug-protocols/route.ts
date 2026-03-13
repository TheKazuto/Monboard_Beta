import { NextResponse } from 'next/server'

// ─── DEBUG ROUTE — Upshift Pools API Discovery ───────────────────────────────
// Arquivo temporário para investigar o endpoint /api/proxy/pools do Upshift.
// Deploy → acesse /api/debug-upshift para ver os resultados.
// Remova este arquivo após a investigação.

const UPSHIFT_PROXY_URL = 'https://app.upshift.finance/api/proxy/vaults'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://app.upshift.finance',
  'Referer': 'https://app.upshift.finance/pools',
}

type EndpointResult = {
  url: string
  status: number | string
  ok: boolean
  bodyPreview?: any
  error?: string
  timing_ms?: number
}

async function probeEndpoint(url: string, method = 'GET', body?: object): Promise<EndpointResult> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...HEADERS,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    })
    const timing_ms = Date.now() - t0
    const contentType = res.headers.get('content-type') ?? ''
    let bodyPreview: any = null

    if (res.ok) {
      try {
        const text = await res.text()
        // Try to parse as JSON
        const parsed = JSON.parse(text)
        // Summarize the structure instead of returning everything
        if (Array.isArray(parsed)) {
          bodyPreview = {
            type: 'array',
            length: parsed.length,
            first_item_keys: parsed[0] ? Object.keys(parsed[0]) : [],
            first_item_sample: parsed[0] ? summarize(parsed[0]) : null,
          }
        } else if (typeof parsed === 'object' && parsed !== null) {
          bodyPreview = {
            type: 'object',
            keys: Object.keys(parsed),
            data_array_length: Array.isArray(parsed.data) ? parsed.data.length : undefined,
            first_data_item_keys: Array.isArray(parsed.data) && parsed.data[0] ? Object.keys(parsed.data[0]) : undefined,
            first_data_item_sample: Array.isArray(parsed.data) && parsed.data[0] ? summarize(parsed.data[0]) : undefined,
          }
        } else {
          bodyPreview = { raw: text.slice(0, 500) }
        }
      } catch {
        bodyPreview = { content_type: contentType, raw_preview: '(não é JSON)' }
      }
    } else {
      // For errors, just capture a short preview
      try {
        const text = await res.text()
        bodyPreview = text.slice(0, 200)
      } catch {
        bodyPreview = null
      }
    }

    return { url, status: res.status, ok: res.ok, bodyPreview, timing_ms }
  } catch (err: any) {
    return {
      url,
      status: 'TIMEOUT/ERROR',
      ok: false,
      error: err?.message ?? String(err),
      timing_ms: Date.now() - t0,
    }
  }
}

// Recursively summarize nested objects for readability
function summarize(obj: any, depth = 0): any {
  if (depth > 2) return '...'
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) {
    return obj.slice(0, 2).map(i => summarize(i, depth + 1))
  }
  const result: any = {}
  for (const [k, v] of Object.entries(obj)) {
    result[k] = summarize(v, depth + 1)
  }
  return result
}

export async function GET() {
  const results: Record<string, any> = {}

  // ── 1. Endpoint conhecido que funcionava antes ───────────────────────────────
  results['1_proxy_vaults_GET'] = await probeEndpoint(UPSHIFT_PROXY_URL)

  // ── 2. Novo endpoint a descobrir: /api/proxy/pools ───────────────────────────
  results['2_proxy_pools_GET'] = await probeEndpoint('https://app.upshift.finance/api/proxy/pools')

  // ── 3. Variações com chainId na query string ─────────────────────────────────
  results['3_proxy_pools_chainId'] = await probeEndpoint('https://app.upshift.finance/api/proxy/pools?chainId=143')

  // ── 4. Endpoint público alternativo sem /proxy ───────────────────────────────
  results['4_api_pools_chainId'] = await probeEndpoint('https://app.upshift.finance/api/pools?chainId=143')

  // ── 5. Endpoint de vaults com chainId ────────────────────────────────────────
  results['5_proxy_vaults_chainId'] = await probeEndpoint(`${UPSHIFT_PROXY_URL}?chainId=143`)

  // ── 6. Probe de URL base da API backend (fora do app.) ───────────────────────
  results['6_api_subdomain_pools'] = await probeEndpoint('https://api.upshift.finance/pools')
  results['7_api_subdomain_vaults'] = await probeEndpoint('https://api.upshift.finance/vaults?chainId=143')

  // ── 8. Probe com POST no /proxy/pools (alguns proxies aceitam POST) ──────────
  results['8_proxy_pools_POST'] = await probeEndpoint(
    'https://app.upshift.finance/api/proxy/pools',
    'POST',
    { chainId: 143 }
  )

  // ── 9. Se /proxy/vaults retornou dados, extrair amostra completa de 1 vault ──
  const vaultsResult = results['1_proxy_vaults_GET']
  if (vaultsResult.ok && vaultsResult.bodyPreview?.first_data_item_sample) {
    results['9_vault_full_sample'] = vaultsResult.bodyPreview.first_data_item_sample
  }

  // ── 10. Se /proxy/pools retornou dados, extrair amostra completa de 1 pool ───
  const poolsResult = results['2_proxy_pools_GET']
  if (poolsResult.ok && poolsResult.bodyPreview?.first_data_item_sample) {
    results['10_pool_full_sample'] = poolsResult.bodyPreview.first_data_item_sample
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    note: 'Debug temporário para descoberta de API de pools do Upshift. Remover após investigação.',
    results,
  })
}
