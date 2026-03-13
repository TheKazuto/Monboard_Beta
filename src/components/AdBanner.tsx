'use client'

import { useEffect, useRef } from 'react'

// ─── AdsTerra banner (invoke.js format) ──────────────────────────────────────
// Este formato funciona com um div container específico + script invoke.js.
// O script lê o div pelo ID e injeta o banner dentro dele.
//
// Usamos useEffect para injetar o script manualmente após a montagem,
// garantindo que o div container já exista no DOM quando o script executar.
// O atributo data-cfasync="false" instrui o Cloudflare a não interferir.

const AD_SCRIPT_SRC = 'https://pl28909561.effectivegatecpm.com/ff4f26cf6832320f8139de3639dc511c/invoke.js'
const AD_CONTAINER_ID = 'container-ff4f26cf6832320f8139de3639dc511c'

export default function AdBanner({ className = '' }: { className?: string }) {
  const injected = useRef(false)

  useEffect(() => {
    // Garante injeção única mesmo em Strict Mode (duplo useEffect no dev)
    if (injected.current) return
    injected.current = true

    const script = document.createElement('script')
    script.src = AD_SCRIPT_SRC
    script.async = true
    script.setAttribute('data-cfasync', 'false')

    // Injeta logo após o container div para que o invoke.js o encontre
    const container = document.getElementById(AD_CONTAINER_ID)
    if (container) {
      container.insertAdjacentElement('afterend', script)
    } else {
      document.body.appendChild(script)
    }

    return () => {
      // Cleanup no unmount (HMR / navegação)
      script.parentNode?.removeChild(script)
      injected.current = false
    }
  }, [])

  return (
    <div className={`overflow-hidden ${className}`}>
      <div id={AD_CONTAINER_ID} />
    </div>
  )
}
