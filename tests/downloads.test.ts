// File des téléchargements de la Marketplace : un à la fois dans l'ordre demandé, annulation (en attente ou en cours,
// jamais pendant l'ajout à la bibliothèque), débit moyenné sur les dernières secondes.
import { describe, expect, it } from 'vitest'
import { DownloadQueue, type DownloadContext, type DownloadJob } from '../src/main/core/downloads'
import type { DownloadDone, DownloadItem } from '@shared/types'

const job = (id: string): DownloadJob => ({ id, kind: 'pack', name: `Pack ${id}`, coverId: null, claim: false, title: `Téléchargement de ${id}` })

/** Téléchargement piloté par le test : il se termine quand le test le décide, ou s'arrête quand il est annulé. */
function setup() {
  const started: { job: DownloadJob; ctx: DownloadContext; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
  const done: DownloadDone[] = []
  let items: DownloadItem[] = []
  let clock = 0
  const queue = new DownloadQueue({
    run: (j, ctx) =>
      new Promise((resolve, reject) => {
        started.push({ job: j, ctx, resolve, reject })
        ctx.signal.addEventListener('abort', () => reject(new Error('Annulé.')))
      }),
    onChange: (list) => (items = list),
    onDone: (d) => done.push(d),
    now: () => clock
  })
  return {
    queue,
    started,
    done,
    items: () => items,
    tick: (ms: number) => (clock += ms)
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('file des téléchargements', () => {
  it('télécharge un pack à la fois, dans l’ordre demandé', async () => {
    const t = setup()
    expect(t.queue.add(job('a'))).toBe(true)
    expect(t.queue.add(job('b'))).toBe(true)
    // Déjà dans la file : pas de doublon.
    expect(t.queue.add(job('a'))).toBe(false)
    expect(t.started.map((s) => s.job.id)).toEqual(['a'])
    expect(t.items().map((d) => [d.id, d.status])).toEqual([
      ['a', 'downloading'],
      ['b', 'queued']
    ])

    t.started[0].resolve({ status: 'added' })
    await flush()
    expect(t.done).toEqual([{ id: 'a', kind: 'pack', name: 'Pack a', ok: true, result: { status: 'added' } }])
    expect(t.started.map((s) => s.job.id)).toEqual(['a', 'b'])
    expect(t.items().map((d) => d.id)).toEqual(['b'])

    t.started[1].reject(new Error('Serveur injoignable.'))
    await flush()
    expect(t.done[1]).toMatchObject({ id: 'b', ok: false, error: 'Serveur injoignable.' })
    expect(t.queue.busy).toBe(false)
  })

  it('retire un pack en attente sans toucher au téléchargement en cours', async () => {
    const t = setup()
    t.queue.add(job('a'))
    t.queue.add(job('b'))
    t.queue.add(job('c'))
    expect(t.queue.cancel('b')).toBe(true)
    expect(t.done).toEqual([{ id: 'b', kind: 'pack', name: 'Pack b', ok: false, cancelled: true }])
    expect(t.items().map((d) => d.id)).toEqual(['a', 'c'])
    expect(t.started[0].ctx.signal.aborted).toBe(false)

    t.started[0].resolve(null)
    await flush()
    expect(t.started.map((s) => s.job.id)).toEqual(['a', 'c'])
  })

  it('interrompt le téléchargement en cours puis passe au suivant', async () => {
    const t = setup()
    t.queue.add(job('a'))
    t.queue.add(job('b'))
    expect(t.queue.cancel('a')).toBe(true)
    expect(t.started[0].ctx.signal.aborted).toBe(true)
    await flush()
    expect(t.done).toEqual([{ id: 'a', kind: 'pack', name: 'Pack a', ok: false, cancelled: true }])
    expect(t.started.map((s) => s.job.id)).toEqual(['a', 'b'])
  })

  it('refuse d’annuler pendant l’ajout à la bibliothèque', () => {
    const t = setup()
    t.queue.add(job('a'))
    t.started[0].ctx.setStatus('waiting')
    expect(t.items()[0].status).toBe('waiting')
    t.started[0].ctx.setStatus('installing')
    expect(t.queue.cancel('a')).toBe(false)
    expect(t.started[0].ctx.signal.aborted).toBe(false)
    expect(t.queue.cancel('inconnu')).toBe(false)
  })

  it('calcule le débit sur les dernières secondes', async () => {
    const t = setup()
    t.queue.add(job('a'))
    const { report } = t.started[0].ctx
    const MB = 1024 * 1024
    report('Téléchargement', 0, 100 * MB, undefined, true)
    for (let i = 1; i <= 10; i++) {
      t.tick(1000)
      // 2 Mo/s pendant 5 s, puis 4 Mo/s.
      report('Téléchargement', (i <= 5 ? 2 * i : 10 + 4 * (i - 5)) * MB, 100 * MB, undefined, true)
    }
    await new Promise((r) => setTimeout(r, 300))
    const item = t.items()[0]
    expect(item).toMatchObject({ bytes: true, current: 30 * MB, total: 100 * MB })
    expect(item.speed).toBe(4 * MB)

    // Reprise après une coupure : le débit repart de zéro ; étape sans octets : pas de débit.
    t.tick(1000)
    report('Téléchargement', 10 * MB, 100 * MB, undefined, true)
    report('Vérification', 0, 0)
    await new Promise((r) => setTimeout(r, 300))
    expect(t.items()[0]).toMatchObject({ phase: 'Vérification', bytes: false, speed: 0 })
  })
})
