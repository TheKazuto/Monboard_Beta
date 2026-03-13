'use client'

// AdBanner — carrega o banner AdsTerra via iframe apontando para /api/ad-frame.
//
// Por que iframe em vez de injetar o script diretamente?
// O invoke.js da AdsTerra usa document.currentScript para localizar o
// container div adjacente. Quando um script é injetado dinamicamente via
// createElement (useEffect), document.currentScript retorna null e o script
// não encontra onde renderizar o banner.
//
// A rota /api/ad-frame serve o HTML exato que a AdsTerra espera — script
// imediatamente seguido do div container — em contexto HTML puro, sem React.
// Por ser same-origin, o iframe não é bloqueado por CSP nem por X-Frame-Options.

export default function AdBanner({ className = '' }: { className?: string }) {
  return (
    <div className={`overflow-hidden ${className}`} style={{ minHeight: 90 }}>
      <iframe
        src="/api/ad-frame"
        title="Advertisement"
        scrolling="no"
        style={{
          width: '100%',
          height: '100%',
          minHeight: 90,
          border: 'none',
          display: 'block',
          background: 'transparent',
        }}
      />
    </div>
  )
}
