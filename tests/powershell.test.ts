// PowerShell lancé sans le script en ligne de commande (pas de -EncodedCommand ni de -ExecutionPolicy Bypass, que les
// antivirus surveillent), et script administrateur exécuté par l'application relancée.

import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

const { runPowerShell } = await import('../src/main/util/win')
const { runElevatedScript, SCRIPT_FLAG, HASH_FLAG } = await import('../src/main/core/elevation')

describe.skipIf(process.platform !== 'win32')('PowerShell par l’entrée standard', () => {
  it('exécute un script de plusieurs lignes, avec des chemins accentués', async () => {
    const out = await runPowerShell(String.raw`
function Twice($x) { $x * 2 }
$req = ConvertFrom-Json '{"path":"C:\\Jeux\\Éléphant ç à"}'
if ($true)
{
  $n = Twice 21
}
ConvertTo-Json -InputObject @{ path = $req.path; n = $n } -Compress
`)
    expect(JSON.parse(out)).toEqual({ path: 'C:\\Jeux\\Éléphant ç à', n: 42 })
  })

  it('script administrateur : exécuté si son empreinte correspond, refusé s’il a été modifié', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-ps-'))
    const scriptFile = path.join(dir, 'job.ps1')
    const body = "Write-Output 'Réglé'"
    await fs.writeFile(scriptFile, body, 'utf8')
    const sha = createHash('sha256').update(body).digest('hex')
    expect(await runElevatedScript([`${SCRIPT_FLAG}${scriptFile}`, `${HASH_FLAG}${sha}`])).toBe(0)
    expect((await fs.readFile(`${scriptFile}.out.txt`, 'utf8')).trim()).toBe('Réglé')
    await fs.rm(`${scriptFile}.out.txt`)
    await fs.writeFile(scriptFile, "Write-Output 'pirate'", 'utf8')
    expect(await runElevatedScript([`${SCRIPT_FLAG}${scriptFile}`, `${HASH_FLAG}${sha}`])).toBe(3)
    expect(existsSync(`${scriptFile}.out.txt`)).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
