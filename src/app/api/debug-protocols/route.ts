import { NextResponse } from 'next/server'

export const revalidate = 0

// ─── DEBUG: testa api.upshift.finance do ambiente Cloudflare ─────────────────
// Deploy → src/app/api/debug-upshift/route.ts
// Acesse /api/debug-upshift para ver por que fetchUpshiftRaw falha em produção

async function probe(label: string, url: string, options: RequestInit = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
      ...options,
    })
    const timing = Date.now() - t0
    const ct = res.headers.get('content-type') ?? ''
    let body: any = null
    const text = await res.text().catch(() => '')

    if (res.ok) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) {
          const monad = parsed.filter((v: any) => v?.chain === 143)
          body = {
            type: 'array',
            total: parsed.length,
            monad_count: monad.length,
            monad_names: monad.map((v: any) => v?.vault_name),
            first_keys: parsed[0] ? Object.keys(parsed[0]) : [],
          }
        } else {
          body = { type: 'object', keys: Object.keys(parsed).slice(0, 10) }
        }
      } catch {
        body = { raw: text.slice(0, 300) }
      }
    } else {
      body = text.slice(0, 200)
    }

    return { label, url, status: res.status, ok: res.ok, content_type: ct, timing_ms: timing, body }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, error: e?.message ?? String(e), timing_ms: Date.now() - t0 }
  }
}

export async function GET() {
  const results = await Promise.all([
    // 1. Novo endpoint — sem headers
    probe('1_new_api_no_headers', 'https://api.upshift.finance/metrics/vaults_summary'),

    // 2. Novo endpoint — com Accept
    probe('2_new_api_accept_json', 'https://api.upshift.finance/metrics/vaults_summary', {
      headers: { 'Accept': 'application/json' },
    }),

    // 3. Novo endpoint — com User-Agent de browser
    probe('3_new_api_user_agent', 'https://api.upshift.finance/metrics/vaults_summary', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }),

    // 4. Health check — confirma que o domínio resolve
    probe('4_health_check', 'https://api.upshift.finance/health'),

    // 5. Old endpoint — ainda bloqueado?
    probe('5_old_proxy_vaults', 'https://app.upshift.finance/api/proxy/vaults', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://app.upshift.finance',
        'Referer': 'https://app.upshift.finance/',
      },
    }),

    // 6. DNS — verifica se o CF consegue resolver o domínio
    probe('6_openapi_schema', 'https://api.upshift.finance/openapi.json'),
  ])

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    results: Object.fromEntries(results.map(r => [r.label, r])),
  })
}
