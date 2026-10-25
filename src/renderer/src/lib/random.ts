// Tirages pseudo-aléatoires reproductibles (mulberry32) : les fonds dessinés des thèmes (étoiles, montagnes...) sont
// les mêmes à chaque lancement.

/** Suite de nombres entre 0 et 1, toujours la même pour une graine donnée. */
export function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
