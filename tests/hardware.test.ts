// Configuration de la machine : choix de la carte graphique, cache de la détection, résolution ; modèle de comparaison
// de l'API gardé en cache, avec la copie embarquée hors ligne.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseGpu, Hardware, type HardwareSources } from '../src/main/core/hardware'
import { PerformanceModels } from '../src/main/core/performance'
import { screenSize } from '../src/main/core/graphics'
import { EMBEDDED_PERFORMANCE_MODEL } from '../src/shared/performance'

const GB = 1024 * 1024 * 1024

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fpm-hw-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('choix de la carte graphique', () => {
  it('celle qui a le plus de mémoire vidéo, d’après le registre', () => {
    const gpu = chooseGpu(
      [
        { name: 'AMD Radeon(TM) Graphics', memory: 0.5 * GB },
        { name: 'NVIDIA GeForce RTX 3080', memory: 10 * GB }
      ],
      []
    )
    expect(gpu).toEqual({ name: 'NVIDIA GeForce RTX 3080', vramMb: 10240, source: 'registry' })
  })

  it('pilote de base et cartes virtuelles ignorés', () => {
    const gpu = chooseGpu(
      [
        { name: 'Microsoft Basic Display Adapter', memory: 16 * GB },
        { name: 'Parsec Virtual Display Adapter', memory: 16 * GB },
        { name: 'Intel(R) UHD Graphics 630', memory: 1 * GB }
      ],
      []
    )
    expect(gpu?.name).toBe('Intel(R) UHD Graphics 630')
  })

  it('registre sans mémoire : Win32_VideoController en dernier recours', () => {
    expect(chooseGpu([{ name: 'NVIDIA GeForce GTX 1060 6GB', memory: null }], [{ name: 'NVIDIA GeForce GTX 1060 6GB', memory: 4 * GB - 1 }])).toEqual({
      name: 'NVIDIA GeForce GTX 1060 6GB',
      vramMb: 4096,
      source: 'wmi'
    })
  })

  it('aucune mémoire lisible : le nom seul', () => {
    expect(chooseGpu([{ name: 'NVIDIA GeForce RTX 4070', memory: null }], [])).toEqual({ name: 'NVIDIA GeForce RTX 4070', vramMb: null, source: 'registry' })
    expect(chooseGpu([], [])).toBeNull()
  })
})

describe('détection gardée en cache', () => {
  const sources = (adapters: HardwareSources['adapters']): HardwareSources => ({
    adapters,
    gameScreen: async () => ({ width: 2560, height: 1440 }),
    displayScreen: () => ({ width: 1920, height: 1080 })
  })

  it('carte détectée une fois, puis lue sur le disque ; nouvelle détection à la demande', async () => {
    const adapters = vi.fn(async () => ({ registry: [{ name: 'NVIDIA GeForce RTX 3080', memory: 10 * GB }], wmi: [] }))
    const file = path.join(dir, 'hardware.json')
    const first = await new Hardware(file, sources(adapters)).info()
    expect(first.gpu?.name).toBe('NVIDIA GeForce RTX 3080')
    expect(first.screen).toEqual({ width: 2560, height: 1440, source: 'game' })
    expect(first.ramMb).toBeGreaterThan(0)

    // Lancement suivant : rien n'est redétecté.
    const next = new Hardware(file, sources(adapters))
    await next.info()
    await next.info()
    expect(adapters).toHaveBeenCalledTimes(1)
    await next.info(true)
    expect(adapters).toHaveBeenCalledTimes(2)
  })

  it('échec de la détection : pas gardé, retenté ensuite', async () => {
    const adapters = vi
      .fn<HardwareSources['adapters']>()
      .mockRejectedValueOnce(new Error('PowerShell trop lent'))
      .mockResolvedValue({ registry: [{ name: 'NVIDIA GeForce RTX 3060', memory: 12 * GB }], wmi: [] })
    const hw = new Hardware(path.join(dir, 'hardware.json'), sources(adapters))
    expect((await hw.info()).gpu).toBeNull()
    expect((await hw.info()).gpu?.name).toBe('NVIDIA GeForce RTX 3060')
  })

  it('réglages du jeu introuvables : taille de l’écran principal', async () => {
    const hw = new Hardware(path.join(dir, 'hardware.json'), {
      adapters: async () => ({ registry: [], wmi: [] }),
      gameScreen: async () => null,
      displayScreen: () => ({ width: 3840, height: 2160 })
    })
    expect((await hw.info()).screen).toEqual({ width: 3840, height: 2160, source: 'display' })
  })

  it('résolution lue dans gta5_settings.xml', () => {
    expect(screenSize('<video>\n<ScreenWidth value="2560" />\n<ScreenHeight value="1440" />\n</video>')).toEqual({ width: 2560, height: 1440 })
    expect(screenSize('<video><ScreenWidth value="0" /></video>')).toBeNull()
  })
})

describe('modèle de comparaison', () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const apiModel = { ...EMBEDDED_PERFORMANCE_MODEL, version: 2, targetFrameMs: 16 }

  it('lu à l’API, gardé une heure, puis relu', async () => {
    let now = 1_000_000
    const fetch = vi.fn(async (_url: string, _init: { signal: AbortSignal }) => json(200, apiModel))
    const models = new PerformanceModels('https://api.test/api', path.join(dir, 'm.json'), fetch, () => now)
    expect((await models.get()).version).toBe(2)
    await models.get()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://api.test/api/app/performance')
    now += 61 * 60 * 1000
    await models.get()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('hors ligne : la dernière copie reçue, sinon celle embarquée', async () => {
    const file = path.join(dir, 'm.json')
    let now = 1_000_000
    await new PerformanceModels('https://api.test/api', file, async () => json(200, apiModel), () => now).get()
    now += 3 * 60 * 60 * 1000
    const offline = async (): Promise<Response> => Promise.reject(new Error('hors ligne'))
    expect((await new PerformanceModels('https://api.test/api', file, offline, () => now).get()).version).toBe(2)
    expect(await new PerformanceModels('https://api.test/api', path.join(dir, 'aucun.json'), offline).get()).toEqual(EMBEDDED_PERFORMANCE_MODEL)
  })

  it('API plus ancienne (404) ou réponse inattendue : copie embarquée', async () => {
    expect(await new PerformanceModels('https://api.test/api', path.join(dir, 'a.json'), async () => json(404, {})).get()).toEqual(EMBEDDED_PERFORMANCE_MODEL)
    expect(await new PerformanceModels('https://api.test/api', path.join(dir, 'b.json'), async () => json(200, { version: 3 })).get()).toEqual(EMBEDDED_PERFORMANCE_MODEL)
  })
})
