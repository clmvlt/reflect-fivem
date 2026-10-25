import { useRef, type CSSProperties, type ReactNode } from 'react'
import { useParallax, useStageFit, useWindowFocus } from '../lib/backdrop'
import { random } from '../lib/random'

// Fond du thème Nuit : un paysage dessiné en plans successifs (ciel et lune, montagnes au loin, montagne du loup,
// collines de sapins, prairie avec le feu de camp et la tente), du plus clair au plus sombre pour la profondeur. Les
// plans glissent légèrement avec la souris (parallaxe) ; le feu, les étincelles, les lucioles, les étoiles, les nuages et
// la brume sont animés par l'opacité et le déplacement seulement, sans repeindre la page, et s'arrêtent quand la fenêtre
// n'est pas au premier plan (voir lib/backdrop). Scène de 1600 × 900, agrandie pour couvrir la fenêtre (calée en bas).
// Toujours le même paysage : tirages à graine fixe.

const W = 1600
const H = 900
/** Marge dessinée autour de la scène : rien ne se découvre quand les plans glissent. */
const LEFT = -140
const RIGHT = W + 140
const BOTTOM = H + 90

const bump = (x: number, center: number, width: number): number => Math.exp(-(((x - center) / width) ** 2))
/** Sommet pointu. */
const peak = (x: number, center: number, width: number): number => Math.pow(Math.max(0, 1 - Math.abs(x - center) / width), 1.4)

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Crête : profil donné, plus un relief irrégulier (déplacement du point milieu). */
function ridge(seed: number, profile: (x: number) => number, roughness: number): [number, number][] {
  const rand = random(seed)
  const n = 256
  const noise = new Array<number>(n + 1).fill(0)
  let amplitude = roughness
  for (let size = n; size > 1; size /= 2) {
    for (let i = size / 2; i < n; i += size) noise[i] = (noise[i - size / 2] + noise[i + size / 2]) / 2 + (rand() * 2 - 1) * amplitude
    amplitude *= 0.55
  }
  return noise.map((d, i) => {
    const x = LEFT + ((RIGHT - LEFT) * i) / n
    return [x, profile(x) + d]
  })
}

const line = (points: [number, number][]): string => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
/** Crête fermée jusqu'en bas de la scène. */
const shape = (points: [number, number][]): string => `${line(points)}L${RIGHT},${BOTTOM}L${LEFT},${BOTTOM}Z`
/** Hauteur d'une crête à l'abscisse x (le point le plus bas autour, pour poser quelque chose dessus sans qu'il flotte). */
const groundAt = (points: [number, number][], from: number, to: number): number => Math.max(...points.filter(([x]) => x >= from - 8 && x <= to + 8).map(([, y]) => y))

/** Sapin en silhouette : étages en dents de scie qui retombent, de la base (x, y) jusqu'à la pointe. */
function pine(rand: () => number, x: number, y: number, height: number): string {
  const tiers = 5 + Math.floor(rand() * 3)
  const trunk = height * 0.1
  const step = (height - trunk) / (tiers + 0.6)
  const left: string[] = []
  const right: string[] = []
  for (let k = 0; k < tiers; k++) {
    const base = y - trunk - k * step
    const width = height * 0.3 * (1 - k / (tiers + 0.4)) * (0.9 + rand() * 0.2)
    const join = width * 0.3
    left.push(`L${(x - width).toFixed(1)},${base.toFixed(1)}L${(x - join).toFixed(1)},${(base - step * 1.25).toFixed(1)}`)
    right.unshift(`L${(x + join).toFixed(1)},${(base - step * 1.25).toFixed(1)}L${(x + width * (0.9 + rand() * 0.2)).toFixed(1)},${base.toFixed(1)}`)
  }
  const half = Math.max(1.2, height * 0.025)
  return `M${(x - half).toFixed(1)},${y.toFixed(1)}L${(x - half).toFixed(1)},${(y - trunk).toFixed(1)}${left.join('')}L${x.toFixed(1)},${(y - height).toFixed(1)}${right.join('')}L${(x + half).toFixed(1)},${(y - trunk).toFixed(1)}L${(x + half).toFixed(1)},${y.toFixed(1)}Z`
}

// Plans, du plus lointain au plus proche.
const FAR = ridge(
  3,
  (x) => 545 - 230 * peak(x, 190, 330) - 290 * peak(x, 560, 360) - 200 * peak(x, 1010, 300) - 150 * peak(x, 1500, 280) - 40 * bump(x, 800, 300),
  42
)
/** Rocher du loup : la montagne monte doucement jusqu'à une falaise tournée vers la lune, devant un sommet lointain. */
const ROCK = { from: 990, to: 1045 }
const MID = ridge(
  8,
  (x) => 622 - 90 * peak(x, 60, 260) - 80 * peak(x, 380, 300) - 55 * peak(x, 1380, 260) - 150 * smoothstep(720, ROCK.to - 10, x) * (1 - smoothstep(ROCK.to, ROCK.to + 45, x)),
  26
)
const HILLS = ridge(21, (x) => 728 - 28 * bump(x, 250, 220) - 22 * bump(x, 900, 260) - 30 * bump(x, 1400, 240), 12)
const front = (x: number): number => 834 - 70 * bump(x, 40, 260) - 22 * bump(x, 1560, 200) + 5 * Math.sin(x / 70)

const FIRE = { x: 1130, y: front(1130) }
const TENT = { x: 1300, y: front(1300) + 2 }
const MOON = { x: 1235, y: 165, r: 46 }

const WOLF_ROCK = groundAt(MID, ROCK.from, ROCK.to - 4)
/** Loup assis qui hurle vers la lune, de profil (boîte de 80 × 122, base en bas). */
const WOLF =
  'M0,120C3,112 12,106 24,105C27,105 29,104 30,103C22,96 21,82 29,73C35,66 39,58 42,50C44,44 46,38 49,33C50,30 50,27 50,24L48,12L55,17C58,15 61,13 64,11L74,3C75,4 75,5 74,6L69,10L66,13L73,12C71,15 68,17 65,19C64,21 63,22 62,23C64,27 67,31 68,37C70,43 70,51 68,58L69,114C70,117 72,118 74,120L62,120L62,104C59,106 56,110 55,116L56,120Z'

const STARS = (() => {
  const rand = random(17)
  return Array.from({ length: 170 }, () => {
    const x = LEFT + rand() * (RIGHT - LEFT)
    const y = Math.pow(rand(), 1.3) * 560
    return { x, y, r: 0.5 + Math.pow(rand(), 3) * 1.3, o: 0.3 + rand() * 0.6 }
  }).filter((s) => Math.hypot(s.x - MOON.x, s.y - MOON.y) > MOON.r * 2.2)
})()

const TWINKLES = (() => {
  const rand = random(29)
  return Array.from({ length: 12 }, () => ({ x: rand() * W, y: Math.pow(rand(), 1.4) * 380, size: 1.8 + rand() * 1.2, duration: 3.5 + rand() * 5, delay: -rand() * 8 }))
})()

/** Sapins des collines, en bouquets, et les deux grands sapins qui encadrent la scène. */
const FOREST = (() => {
  const rand = random(41)
  const trees: string[] = []
  for (let x = LEFT; x < RIGHT; x += 10 + rand() * 26) {
    const cluster = 0.5 + 0.5 * Math.sin(x / 140 + 1.3) * Math.sin(x / 61)
    if (rand() > 0.35 + cluster * 0.6) continue
    const y = groundAt(HILLS, x, x) + 6
    trees.push(pine(rand, x, y, 38 + rand() * 50 + cluster * 45))
  }
  return trees.join('')
})()
const BIG_PINES = (() => {
  const rand = random(43)
  return pine(rand, 1500, front(1500) + 12, 400) + pine(rand, 120, front(120) + 12, 340)
})()

/** Prairie : le sol et une frange d'herbe en dents de scie, plus courte autour du feu. */
const MEADOW = (() => {
  const rand = random(57)
  let d = `M${LEFT},${BOTTOM}L${LEFT},${front(LEFT).toFixed(1)}`
  for (let x = LEFT; x < RIGHT; ) {
    const width = 3 + rand() * 4
    const trampled = smoothstep(40, 110, Math.abs(x - FIRE.x)) * smoothstep(20, 70, Math.abs(x - TENT.x - 10))
    const height = (5 + rand() * 13) * (0.35 + 0.65 * trampled) * (rand() < 0.08 ? 1.8 : 1)
    const lean = (rand() - 0.5) * 7
    d += `L${(x + width / 2 + lean).toFixed(1)},${(front(x) - height).toFixed(1)}L${(x + width).toFixed(1)},${front(x + width).toFixed(1)}`
    x += width
  }
  return `${d}L${RIGHT},${BOTTOM}Z`
})()

const SPARKS = (() => {
  const rand = random(61)
  return Array.from({ length: 8 }, () => ({ dx: (rand() - 0.5) * 70, rise: 110 + rand() * 90, duration: 2 + rand() * 1.8, delay: -rand() * 4 }))
})()

const FIREFLIES = (() => {
  const rand = random(67)
  return Array.from({ length: 9 }, () => {
    const x = 300 + rand() * 1200
    return { x, y: front(x) - 20 - rand() * 60, dx: (rand() - 0.5) * 60, dy: -10 - rand() * 30, duration: 7 + rand() * 6, delay: -rand() * 10 }
  })
})()

/** Profondeur de chaque plan : déplacement (en points de la scène) quand la souris va d'un bord à l'autre. */
const DEPTHS = [4, 8, 12, 18, 26]

const px = (n: number): string => `${n.toFixed(1)}px`
const place = (x: number, y: number, width: number, height: number, more?: Record<string, string | number>): CSSProperties =>
  ({ left: px(x), top: px(y), width: px(width), height: px(height), ...more }) as CSSProperties

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {children}
    </svg>
  )
}

export function NightScene() {
  const stage = useRef<HTMLDivElement>(null)
  const layers = useRef<(HTMLDivElement | null)[]>([])
  const awake = useWindowFocus()
  useStageFit(stage, W, H)
  useParallax(layers, DEPTHS)

  const layer = (i: number) => (el: HTMLDivElement | null) => {
    layers.current[i] = el
  }

  return (
    <div className={`night-scene ${awake ? '' : 'is-paused'}`} aria-hidden>
      <div ref={stage} className="night-stage">
        {/* Ciel : étoiles, lune et son halo, nuages qui passent. */}
        <div ref={layer(0)} className="night-layer">
          <Svg>
            <defs>
              <radialGradient id="night-halo">
                <stop offset="0" stopColor="rgb(200, 212, 255)" stopOpacity="0.22" />
                <stop offset="0.35" stopColor="rgb(170, 185, 255)" stopOpacity="0.08" />
                <stop offset="1" stopColor="rgb(150, 165, 255)" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="night-moon" cx="0.38" cy="0.35" r="0.75">
                <stop offset="0" stopColor="#fffdf2" />
                <stop offset="0.7" stopColor="#ece8d6" />
                <stop offset="1" stopColor="#cfcbb8" />
              </radialGradient>
            </defs>
            {STARS.map((s, i) => (
              <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} fill="#ffffff" opacity={s.o.toFixed(2)} />
            ))}
            <circle cx={MOON.x} cy={MOON.y} r={MOON.r * 10} fill="url(#night-halo)" />
            <circle cx={MOON.x} cy={MOON.y} r={MOON.r * 1.25} fill="rgb(255, 250, 225)" opacity="0.08" />
            <circle cx={MOON.x} cy={MOON.y} r={MOON.r} fill="url(#night-moon)" />
            <g fill="#b9b49e" opacity="0.35">
              <circle cx={MOON.x - 14} cy={MOON.y - 8} r="9" />
              <circle cx={MOON.x + 12} cy={MOON.y + 14} r="6" />
              <circle cx={MOON.x + 16} cy={MOON.y - 16} r="4" />
              <circle cx={MOON.x - 6} cy={MOON.y + 22} r="4.5" />
            </g>
          </Svg>
          {TWINKLES.map((s, i) => (
            <span
              key={i}
              className="night-twinkle"
              style={place(s.x, s.y, s.size, s.size, { animationDuration: `${s.duration.toFixed(1)}s`, animationDelay: `${s.delay.toFixed(1)}s` })}
            />
          ))}
          <span className="night-cloud night-cloud-1" style={place(MOON.x - 380, MOON.y - 30, 420, 70)} />
          <span className="night-cloud night-cloud-2" style={place(420, 120, 520, 80)} />
        </div>

        {/* Montagnes au loin, éclairées par la lune sur leurs crêtes, et la brume à leur pied. */}
        <div ref={layer(1)} className="night-layer">
          <Svg>
            <defs>
              <linearGradient id="night-far" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0.3" stopColor="#26315e" />
                <stop offset="0.7" stopColor="#1a2347" />
              </linearGradient>
            </defs>
            <path d={shape(FAR)} fill="url(#night-far)" />
            <path d={line(FAR)} fill="none" stroke="rgb(200, 215, 255)" strokeOpacity="0.3" strokeWidth="1.5" />
          </Svg>
          <span className="night-mist night-mist-1" style={place(-200, 470, 2000, 120)} />
        </div>

        {/* Montagne du loup. */}
        <div ref={layer(2)} className="night-layer">
          <Svg>
            <defs>
              <linearGradient id="night-mid" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0.45" stopColor="#151d3d" />
                <stop offset="0.75" stopColor="#0f152e" />
              </linearGradient>
            </defs>
            <path d={shape(MID)} fill="url(#night-mid)" />
            <path d={line(MID)} fill="none" stroke="rgb(185, 200, 255)" strokeOpacity="0.22" strokeWidth="1.2" />
            <path d={WOLF} fill="#0b1027" transform={`translate(${ROCK.from} ${(WOLF_ROCK - 72).toFixed(1)}) scale(0.6)`} />
          </Svg>
          <span className="night-mist night-mist-2" style={place(-200, 600, 2000, 130)} />
        </div>

        {/* Collines et forêt de sapins. */}
        <div ref={layer(3)} className="night-layer">
          <Svg>
            <path d={shape(HILLS)} fill="#0b1127" />
            <path d={FOREST} fill="#090e21" />
          </Svg>
        </div>

        {/* Prairie, feu de camp, tente, grands sapins ; la lueur du feu, ses flammes et ses étincelles, les lucioles. */}
        <div ref={layer(4)} className="night-layer">
          <Svg>
            <defs>
              <linearGradient id="night-tent" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#3a2a2a" />
                <stop offset="0.55" stopColor="#1a1a2c" />
                <stop offset="1" stopColor="#0f1426" />
              </linearGradient>
            </defs>
            <path d={MEADOW} fill="#060a17" />
            {/* Tente : côté tourné vers le feu éclairé, entrée entrouverte. */}
            <g transform={`translate(${TENT.x} ${TENT.y})`}>
              <path d="M-62,0L4,-92L78,0Z" fill="url(#night-tent)" />
              <path d="M4,-92L18,0L-14,0Z" fill="#05070f" />
              <path d="M4,-92L-6,-104M4,-92L14,-103" stroke="#2a2430" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M-62,0L-78,6M78,0L92,6" stroke="#1a1d2c" strokeWidth="1.5" />
            </g>
            {/* Foyer : pierres et bûches croisées, lisérés orangés côté flammes. */}
            <g transform={`translate(${FIRE.x} ${FIRE.y.toFixed(1)})`}>
              <path d="M-26,-2L22,-14" stroke="#2b1a12" strokeWidth="8" strokeLinecap="round" />
              <path d="M-22,-14L26,-2" stroke="#24150f" strokeWidth="8" strokeLinecap="round" />
              <path d="M-24,-5L20,-16M-20,-16L24,-5" stroke="#ff9a4a" strokeOpacity="0.35" strokeWidth="1.5" strokeLinecap="round" />
              <g fill="#121522">
                <ellipse cx="-34" cy="-1" rx="9" ry="6" />
                <ellipse cx="-18" cy="3" rx="8" ry="5" />
                <ellipse cx="2" cy="4" rx="9" ry="5" />
                <ellipse cx="20" cy="3" rx="8" ry="5" />
                <ellipse cx="35" cy="-1" rx="9" ry="6" />
              </g>
              <g fill="#ff9a4a" opacity="0.25">
                <ellipse cx="-33" cy="-5" rx="6" ry="2" />
                <ellipse cx="34" cy="-5" rx="6" ry="2" />
              </g>
            </g>
            {/* Bûche pour s'asseoir, à gauche du feu. */}
            <g transform={`translate(${FIRE.x - 120} ${front(FIRE.x - 120).toFixed(1)})`}>
              <rect x="-42" y="-16" width="84" height="16" rx="8" fill="#1c1410" />
              <rect x="20" y="-14" width="20" height="3" rx="1.5" fill="#ff9a4a" opacity="0.3" />
              <ellipse cx="40" cy="-8" rx="4" ry="8" fill="#3a2618" />
            </g>
            <path d={BIG_PINES} fill="#04070f" />
          </Svg>
          <span className="night-glow" style={place(FIRE.x - 330, FIRE.y - 280, 660, 400)} />
          <span className="night-fire" style={place(FIRE.x - 24, FIRE.y - 74, 48, 70)}>
            <svg viewBox="0 0 48 70" className="night-flame">
              <path d="M24,70C8,69 2,56 7,44C10,36 14,32 13,20C19,27 21,33 22,38C24,28 28,20 26,6C34,18 40,30 41,42C46,54 40,69 24,70Z" fill="#ff7a2a" />
              <path d="M24,69C13,68 10,59 13,51C15,46 18,43 18,36C22,41 23,45 24,48C26,42 29,37 29,28C34,37 37,46 36,54C38,62 33,68 24,69Z" fill="#ffae45" />
              <path d="M24,68C18,67 16,62 18,57C19,54 22,52 22,48C24,51 25,54 26,56C27,53 29,51 29,48C32,53 32,58 31,61C31,65 28,68 24,68Z" fill="#ffe7a3" />
            </svg>
            <svg viewBox="0 0 48 70" className="night-flame night-flame-alt">
              <path d="M24,70C9,69 3,58 8,47C11,40 16,36 17,24C21,31 22,36 23,40C26,31 31,25 33,12C37,24 41,34 40,46C44,57 38,69 24,70Z" fill="#ff7a2a" />
              <path d="M24,69C14,68 11,60 14,52C16,47 19,44 21,38C23,42 24,46 25,49C28,44 30,40 31,33C34,41 36,48 35,55C37,63 32,68 24,69Z" fill="#ffae45" />
              <path d="M24,68C19,67 17,63 18,59C19,55 22,53 23,49C25,52 26,55 26,57C28,55 29,53 30,50C32,55 32,59 31,62C30,66 28,68 24,68Z" fill="#ffe7a3" />
            </svg>
          </span>
          {SPARKS.map((s, i) => (
            <span
              key={i}
              className="night-spark"
              style={place(FIRE.x - 1.5, FIRE.y - 50, 3, 3, {
                '--dx': px(s.dx),
                '--rise': px(-s.rise),
                animationDuration: `${s.duration.toFixed(2)}s`,
                animationDelay: `${s.delay.toFixed(2)}s`
              })}
            />
          ))}
          {FIREFLIES.map((f, i) => (
            <span
              key={i}
              className="night-firefly"
              style={place(f.x, f.y, 4, 4, { '--dx': px(f.dx), '--dy': px(f.dy), animationDuration: `${f.duration.toFixed(1)}s`, animationDelay: `${f.delay.toFixed(1)}s` })}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
