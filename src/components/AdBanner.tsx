'use client'

import { useEffect, useRef } from 'react'

// ─── AdsTerra script URL ──────────────────────────────────────────────────────
// Provided by AdsTerra. Injects the ad unit when loaded.
const ADSTERRA_SRC = 'https://pl28909421.effectivegatecpm.com/41/89/9b/41899bde61439f8127439997b2421803.js'

// ─── COMPONENT ────────────────────────────────────────────────────────────────
export default function AdBanner({ className = '' }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const injected     = useRef(false)

  useEffect(() => {
    // Inject only once per mount; avoid duplicate scripts on re-renders
    if (injected.current || !containerRef.current) return
    injected.current = true

    const script = document.createElement('script')
    script.src   = ADSTERRA_SRC
    script.async = true
    script.type  = 'text/javascript'
    containerRef.current.appendChild(script)

    return () => {
      // Cleanup on unmount — remove the script to avoid leaks during HMR
      if (containerRef.current && script.parentNode === containerRef.current) {
        containerRef.current.removeChild(script)
      }
      injected.current = false
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden ${className}`}
      style={{ minHeight: 80 }}
    />
  )
}
