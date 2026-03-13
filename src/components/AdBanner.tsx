'use client'

// ─── AdsTerra — iframe srcdoc approach ───────────────────────────────────────
// Why not document.createElement('script') inside useEffect?
// Next.js App Router + Cloudflare Pages silently block or discard
// dynamically injected third-party scripts during hydration. The same
// applies to <Script strategy="lazyOnload"> for scripts that write to the
// DOM at the injection site (AdsTerra "Social Bar" / banner types do this).
//
// The iframe srcdoc approach creates a fully isolated browsing context.
// The ad script runs inside the iframe — completely outside React's
// reconciliation — and renders exactly where the iframe sits in the layout.
//
// sandbox flags used:
//   allow-scripts            — let the ad JS execute
//   allow-same-origin        — let the script read its own cookies/storage
//   allow-popups             — allow ad click-through in a new tab
//   allow-top-navigation-by-user-activation — allow redirects only on click

const ADSTERRA_SRC =
  'https://pl28909421.effectivegatecpm.com/41/89/9b/41899bde61439f8127439997b2421803.js'

function buildAdHTML(src: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;background:transparent}
    body{display:flex;align-items:center;justify-content:center}
  </style>
</head>
<body>
  <script type="text/javascript" src="${src}"></script>
</body>
</html>`
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────
export default function AdBanner({ className = '' }: { className?: string }) {
  return (
    <div
      className={`overflow-hidden rounded-xl ${className}`}
      style={{ minHeight: 80 }}
    >
      <iframe
        srcDoc={buildAdHTML(ADSTERRA_SRC)}
        title="Advertisement"
        scrolling="no"
        sandbox="allow-scripts allow-same-origin allow-popups allow-top-navigation-by-user-activation"
        style={{
          width: '100%',
          height: '100%',
          minHeight: 80,
          border: 'none',
          display: 'block',
        }}
      />
    </div>
  )
}
