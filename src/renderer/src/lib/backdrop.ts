// Fonds dessinés des thèmes (AuroraSky, NightScene) : ce qu'ils partagent.

import { useEffect, useState, type RefObject } from 'react'

/** Fenêtre au premier plan. Sinon (FiveM au premier plan...), les animations du fond s'arrêtent : rien à calculer. */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  return focused
}

/**
 * Scène de width × height agrandie pour couvrir la fenêtre, calée en bas (le haut du ciel se perd), avec une marge pour
 * la parallaxe.
 */
export function useStageFit(stage: RefObject<HTMLElement | null>, width: number, height: number): void {
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = (): void => {
      const w = window.innerWidth
      const h = window.innerHeight
      const scale = Math.max(w / width, h / height) * 1.04
      el.style.transform = `translate(${Math.round((w - width * scale) / 2)}px, ${Math.round(h - height * scale)}px) scale(${scale.toFixed(4)})`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [stage, width, height])
}

/**
 * Parallaxe : les plans glissent quand la souris bouge, d'autant plus qu'ils sont proches (depths : déplacement, en
 * points de la scène, d'un bord de la fenêtre à l'autre), en la suivant avec un peu de retard.
 */
export function useParallax(layers: RefObject<(HTMLElement | null)[]>, depths: readonly number[]): void {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const target = { x: 0, y: 0 }
    const current = { x: 0, y: 0 }
    let frame = 0
    const step = (): void => {
      current.x += (target.x - current.x) * 0.05
      current.y += (target.y - current.y) * 0.05
      depths.forEach((depth, i) => {
        const el = layers.current[i]
        if (el) el.style.transform = `translate3d(${(-current.x * depth).toFixed(2)}px, ${(-current.y * depth * 0.4).toFixed(2)}px, 0)`
      })
      frame = Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > 0.002 ? requestAnimationFrame(step) : 0
    }
    const move = (e: MouseEvent): void => {
      target.x = (e.clientX / window.innerWidth) * 2 - 1
      target.y = (e.clientY / window.innerHeight) * 2 - 1
      if (!frame) frame = requestAnimationFrame(step)
    }
    window.addEventListener('mousemove', move)
    return () => {
      window.removeEventListener('mousemove', move)
      cancelAnimationFrame(frame)
    }
  }, [layers, depths])
}
