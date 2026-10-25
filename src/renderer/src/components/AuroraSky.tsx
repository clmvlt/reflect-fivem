import { useEffect, useRef, useState } from 'react'
import { useWindowFocus } from '../lib/backdrop'
import { random } from '../lib/random'

// Fond du thème Aurore : ciel étoilé, voie lactée et aurore boréale, discrets, derrière toute la fenêtre. Tout est
// dessiné une fois (étoiles, voiles de l'aurore) ; seuls l'opacité et le déplacement des calques sont animés, sans
// repeindre la page, et l'animation s'arrête quand la fenêtre n'est pas au premier plan. Toujours le même ciel : tirages
// à graine fixe.

/** Entre -1 et 1, le plus souvent près de 0. */
function centered(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) / 1.5
}

interface Wave {
  f: number
  p: number
  a: number
}

/** Somme de sinusoïdes (fréquences en cycles sur la largeur), entre -1 et 1. */
function wave(waves: Wave[], u: number): number {
  let sum = 0
  let total = 0
  for (const w of waves) {
    sum += w.a * Math.sin(2 * Math.PI * w.f * u + w.p)
    total += w.a
  }
  return sum / total
}

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Teintes de l'aurore, du bas des rayons vers leur sommet (voir .aurora-sky dans styles.css). */
const BANDS = ['low', 'mid', 'high'] as const
type Veil = Record<(typeof BANDS)[number], string>

/**
 * Voile d'aurore : quelques rubans ondulés d'où montent des rayons verticaux, plus vifs sur leur bord inférieur et qui
 * s'effacent vers le haut. Un masque par teinte (seul l'alpha compte) : le bas des rayons, leur milieu, leur sommet,
 * pour que chaque ruban change de couleur en montant, quelle que soit sa hauteur. Dessiné petit, adouci, puis étiré à
 * la taille du ciel.
 */
function curtain(seed: number, ribbons: number): Veil {
  const w = 640
  const h = 320
  const rand = random(seed)
  const waves = (n: number, min: number, max: number): Wave[] =>
    Array.from({ length: n }, () => ({ f: min + rand() * (max - min), p: rand() * Math.PI * 2, a: 0.4 + rand() * 0.6 }))
  const shapes = Array.from({ length: ribbons }, (_, k) => {
    const start = rand() * 0.25
    return {
      start,
      end: 0.75 + rand() * 0.25,
      base: 0.66 - k * 0.12 + rand() * 0.06,
      tilt: (rand() - 0.6) * 0.25,
      edge: waves(3, 0.5, 2),
      folds: waves(4, 0.8, 3.5),
      rays: waves(6, 18, 60),
      fine: waves(6, 70, 180),
      reach: waves(4, 1, 8)
    }
  })
  const alpha = BANDS.map(() => new Float32Array(w * h))
  for (const r of shapes) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1)
      const bottom = h * (r.base + r.tilt * (u - 0.5) + 0.11 * wave(r.edge, u))
      const ends = smoothstep(r.start, r.start + 0.18, u) * smoothstep(r.end, r.end - 0.18, u)
      const folds = Math.pow(0.5 + 0.5 * wave(r.folds, u), 2)
      const rays = 0.45 + 0.35 * (0.5 + 0.5 * wave(r.rays, u)) + 0.2 * (0.5 + 0.5 * wave(r.fine, u))
      const strength = ends * (0.12 + 0.88 * folds) * rays
      const length = h * (0.42 + 0.14 * wave(r.reach, u) + 0.08 * wave(r.rays, u * 1.7))
      if (strength <= 0) continue
      for (let y = 0; y < h; y++) {
        // t : hauteur dans le rayon, 0 au bord inférieur, 1 au sommet ; sous le bord, une lueur brève.
        const t = (bottom - y) / length
        const a = t >= 0 ? strength * Math.pow(Math.max(0, 1 - t), 1.4) : strength * Math.exp(-(((y - bottom) / (h * 0.025)) ** 2))
        if (a <= 0.001) continue
        const low = 1 - smoothstep(0.05, 0.4, t)
        const high = smoothstep(0.35, 0.8, t)
        const share = [low, Math.max(0, 1 - low - high), high]
        const i = y * w + x
        for (let b = 0; b < 3; b++) alpha[b][i] = 1 - (1 - alpha[b][i]) * (1 - a * share[b])
      }
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const soft = document.createElement('canvas')
  soft.width = w
  soft.height = h
  const ctx = canvas.getContext('2d')
  const softCtx = soft.getContext('2d')
  const urls = BANDS.map((_, b) => {
    if (!ctx || !softCtx) return ''
    const data = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let i = 0; i < w * h; i++) data[i * 4 + 3] = Math.round(255 * alpha[b][i])
    ctx.putImageData(new ImageData(data, w, h), 0, 0)
    softCtx.clearRect(0, 0, w, h)
    softCtx.filter = 'blur(1px)'
    softCtx.drawImage(canvas, 0, 0)
    return soft.toDataURL()
  })
  return { low: urls[0], mid: urls[1], high: urls[2] }
}

/** Étoiles fixes et voie lactée (bande en diagonale, du bas à gauche vers le haut à droite), à la taille de la fenêtre. */
function drawStars(canvas: HTMLCanvasElement): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx || !w || !h) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const rand = random(11)
  const from = { x: -0.05 * w, y: 0.95 * h }
  const dx = 1.1 * w
  const dy = -0.85 * h
  const length = Math.hypot(dx, dy)
  const nx = -dy / length
  const ny = dx / length
  const spread = Math.min(w, h) * 0.13
  // Lueur de la voie lactée.
  for (let i = 0; i < 28; i++) {
    const t = rand()
    const off = centered(rand) * spread * 0.6
    const x = from.x + dx * t + nx * off
    const y = from.y + dy * t + ny * off
    const r = spread * (0.8 + rand() * 1.2)
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r)
    glow.addColorStop(0, 'rgba(150, 160, 255, 0.03)')
    glow.addColorStop(1, 'rgba(150, 160, 255, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  // Étoiles : un peu moins de la moitié dans la voie lactée, plus petites et plus pâles.
  const count = Math.round((w * h) / 4500)
  for (let i = 0; i < count; i++) {
    const inBand = rand() < 0.45
    const t = rand()
    const v = rand()
    const off = centered(rand) * spread
    const x = inBand ? from.x + dx * t + nx * off : t * w
    const y = inBand ? from.y + dy * t + ny * off : v * h
    const k = rand()
    const r = (k < 0.75 ? 0.4 : k < 0.96 ? 0.7 : 1.05) + rand() * 0.35
    const a = (inBand ? 0.2 : 0.3) + rand() * 0.5
    const tint = rand()
    ctx.fillStyle = tint < 0.15 ? `rgba(200, 215, 255, ${a})` : tint < 0.25 ? `rgba(255, 230, 205, ${a})` : `rgba(255, 255, 255, ${a})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Étoiles qui scintillent (chacune à son rythme), plutôt dans le haut du ciel. */
const TWINKLES = (() => {
  const rand = random(5)
  return Array.from({ length: 16 }, () => ({
    left: `${(rand() * 100).toFixed(2)}%`,
    top: `${(Math.pow(rand(), 1.4) * 90).toFixed(2)}%`,
    size: `${(1.5 + rand() * 1.2).toFixed(1)}px`,
    duration: `${(4 + rand() * 6).toFixed(1)}s`,
    delay: `${(-rand() * 10).toFixed(1)}s`
  }))
})()

export function AuroraSky() {
  const stars = useRef<HTMLCanvasElement>(null)
  // Voiles dessinés juste après le premier affichage (quelques dizaines de millisecondes), puis montrés en fondu.
  const [veils, setVeils] = useState<Veil[]>([])
  const awake = useWindowFocus()

  useEffect(() => {
    const canvas = stars.current
    if (!canvas) return
    let frame = 0
    const redraw = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => drawStars(canvas))
    }
    redraw()
    window.addEventListener('resize', redraw)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', redraw)
    }
  }, [])

  useEffect(() => setVeils([curtain(7, 2), curtain(23, 2)]), [])

  return (
    <div className={`aurora-sky ${awake ? '' : 'is-paused'}`} aria-hidden>
      <canvas ref={stars} className="aurora-sky-stars" />
      {TWINKLES.map((s, i) => (
        <span
          key={i}
          className="aurora-sky-twinkle"
          style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDuration: s.duration, animationDelay: s.delay }}
        />
      ))}
      <span className="aurora-sky-shooting" />
      {veils.map((veil, i) => (
        <span key={i} className={`aurora-veil aurora-veil-${i + 1}`}>
          {BANDS.map((band) => (
            <span key={band} className={`aurora-veil-${band}`} style={{ maskImage: `url(${veil[band]})` }} />
          ))}
        </span>
      ))}
    </div>
  )
}
