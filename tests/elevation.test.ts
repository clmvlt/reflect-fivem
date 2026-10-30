// Attente du processus administrateur : demande UAC sans réponse, annulation, PowerShell qui ne rend pas la main.

import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PowerShell bloqué sur Start-Process -Wait : ne rend la main que lorsqu'on l'arrête.
const powershell = vi.hoisted(() => ({
  run: vi.fn(
    (_script: string, _timeout: number, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('arrêté')), { once: true }))
  )
}))
vi.mock('../src/main/util/win', () => ({ runPowerShell: powershell.run }))
vi.mock('electron', () => ({ app: { isPackaged: true } }))

const { executePlanElevated } = await import('../src/main/core/elevation')

const plan = { id: 'job', title: 'job', mode: 'atomic' as const, ops: [] }
let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-wait-'))
  powershell.run.mockClear()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('attente du processus administrateur', () => {
  it('annulé pendant la demande UAC : rend la main tout de suite, et un démarrage tardif verra la demande', async () => {
    const abort = new AbortController()
    const run = executePlanElevated(plan, dir, () => undefined, abort.signal)
    abort.abort()
    expect(await run).toMatchObject({ ok: false, rolledBack: true, cancelled: true })
    expect(existsSync(path.join(dir, 'job.plan.json'))).toBe(false)
    expect(existsSync(path.join(dir, 'job.plan.json.cancel'))).toBe(true)
  })

  it('sans réponse à la demande UAC : abandon au lieu de rester à 0 %', async () => {
    const run = executePlanElevated(plan, dir, () => undefined)
    let res: Awaited<typeof run> | undefined
    void run.then((r) => (res = r))
    const start = Date.now()
    await new Promise((r) => setTimeout(r, 400))
    expect(res).toBeUndefined()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => start + 6 * 60 * 1000)
    await vi.waitFor(() => expect(res).toMatchObject({ ok: false, rolledBack: true, error: expect.stringContaining('Pas de réponse') }))
    now.mockRestore()
  })

  it('résultat écrit alors que PowerShell attend encore : le plan est terminé', async () => {
    const result = { ok: true, results: [], rolledBack: false }
    const seen: number[] = []
    const run = executePlanElevated(plan, dir, (p) => seen.push(p.done))
    await vi.waitFor(() => expect(powershell.run).toHaveBeenCalled())
    await fs.writeFile(path.join(dir, 'job.plan.json.progress'), `${JSON.stringify({ done: 3, total: 4, bytes: 0, totalBytes: 0, current: '' })}\n`)
    await fs.writeFile(path.join(dir, 'job.plan.json.result.json'), JSON.stringify(result))
    expect(await run).toEqual(result)
    expect(seen).toContain(3)
    expect(existsSync(path.join(dir, 'job.plan.json.result.json'))).toBe(false)
  })

  it("annulé après le démarrage : le processus administrateur reçoit la demande et son résultat est attendu", async () => {
    const abort = new AbortController()
    const run = executePlanElevated(plan, dir, () => undefined, abort.signal)
    await vi.waitFor(() => expect(powershell.run).toHaveBeenCalled())
    await fs.writeFile(path.join(dir, 'job.plan.json.progress'), `${JSON.stringify({ done: 1, total: 4, bytes: 0, totalBytes: 0, current: '' })}\n`)
    await new Promise((r) => setTimeout(r, 400))
    abort.abort()
    await vi.waitFor(() => expect(existsSync(path.join(dir, 'job.plan.json.cancel'))).toBe(true), { timeout: 2000 })
    await fs.writeFile(path.join(dir, 'job.plan.json.result.json'), JSON.stringify({ ok: false, results: [], error: 'x', rolledBack: true, cancelled: true }))
    expect(await run).toMatchObject({ cancelled: true, rolledBack: true })
  })
})
