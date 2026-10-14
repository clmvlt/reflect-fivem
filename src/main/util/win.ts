import { execFile } from 'node:child_process'
import { t } from 'i18next'

/** Exécute un script PowerShell (sortie forcée en UTF-8 pour les chemins accentués). */
export function runPowerShell(script: string, timeoutMs = 20_000): Promise<string> {
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'SilentlyContinue'\n${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))
    )
  })
}

export interface RegistrySnapshot {
  /** Chemins GTA V trouvés dans les clés Rockstar (InstallFolder, InstallFolderSteam, InstallFolderEpic...). */
  rockstarPaths: { path: string; source: string; enhanced: boolean }[]
  steamPath: string | null
  fivemLastRun: string | null
  /** Commande du protocole fivem:// (réécrite par FiveM à chaque lancement : pointe vers le FiveM.exe utilisé). */
  fivemProtocol: string | null
  uninstall: { name: string; location: string; key: string }[]
}

/**
 * Lit en une seule fois toutes les clés de registre utiles à la détection des jeux. Par l'API .NET plutôt que par
 * Get-ItemProperty / Get-ChildItem : bien plus rapide sur les centaines de clés « Uninstall ».
 */
export async function readRegistry(): Promise<RegistrySnapshot> {
  const script = String.raw`
$LM = [Microsoft.Win32.Registry]::LocalMachine
$CU = [Microsoft.Win32.Registry]::CurrentUser
function Val($hive, $key, $name) {
  $k = $hive.OpenSubKey($key)
  if (-not $k) { return $null }
  try { return $k.GetValue($name) } finally { $k.Close() }
}
$r = @{}
$paths = @()
$keys = @(
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\Grand Theft Auto V'; e = $false },
  @{ k = 'SOFTWARE\Rockstar Games\Grand Theft Auto V'; e = $false },
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\GTAV'; e = $false },
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\GTAV Enhanced'; e = $true },
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\GTA V Enhanced'; e = $true }
)
foreach ($entry in $keys) {
  $k = $LM.OpenSubKey($entry.k)
  if (-not $k) { continue }
  foreach ($v in 'InstallFolder','InstallFolderSteam','InstallFolderEpic','InstallFolderXboxPc') {
    $val = [string]$k.GetValue($v)
    if ($val) {
      if ($v -eq 'InstallFolderSteam') { $val = $val -replace '\\GTAV$','' }
      $paths += @{ path = $val; source = $v; enhanced = $entry.e }
    }
  }
  $k.Close()
}
$r.rockstarPaths = $paths
$s = Val $CU 'Software\Valve\Steam' 'SteamPath'
if (-not $s) { $s = Val $LM 'SOFTWARE\WOW6432Node\Valve\Steam' 'InstallPath' }
$r.steamPath = $s
$r.fivemLastRun = Val $CU 'Software\CitizenFX\FiveM' 'Last Run Location'
$r.fivemProtocol = Val $CU 'Software\Classes\FiveM.ProtocolHandler\shell\open\command' ''
$u = @()
foreach ($root in @(@($LM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'), @($LM, 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'), @($CU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall'))) {
  $k = $root[0].OpenSubKey($root[1])
  if (-not $k) { continue }
  foreach ($name in $k.GetSubKeyNames()) {
    $sub = $k.OpenSubKey($name)
    if (-not $sub) { continue }
    $dn = [string]$sub.GetValue('DisplayName')
    if ($dn -match 'Grand Theft Auto|FiveM|GTA V' -or $name -match 'Steam App (271590|3240220)|CitizenFX') {
      $u += @{ name = $dn; location = [string]$sub.GetValue('InstallLocation'); key = $name }
    }
    $sub.Close()
  }
  $k.Close()
}
$r.uninstall = $u
$r | ConvertTo-Json -Depth 4 -Compress
`
  const arr = <T>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x ? [x] : [])
  try {
    const out = await runPowerShell(script)
    const json = JSON.parse(out.trim() || '{}')
    return {
      // Source : nom de la valeur lue (InstallFolder...), présentée dans la langue affichée.
      rockstarPaths: arr<RegistrySnapshot['rockstarPaths'][number]>(json.rockstarPaths).map((p) => ({ ...p, source: t('system.rockstarRegistry', { value: p.source }) })),
      steamPath: json.steamPath || null,
      fivemLastRun: json.fivemLastRun || null,
      fivemProtocol: json.fivemProtocol || null,
      uninstall: arr(json.uninstall)
    }
  } catch {
    return { rockstarPaths: [], steamPath: null, fivemLastRun: null, fivemProtocol: null, uninstall: [] }
  }
}

/** Liste des processus en cours (noms d'exécutables). */
export function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const names = stdout
        .split(/\r?\n/)
        .map((l) => /^"([^"]+)"/.exec(l)?.[1])
        .filter((x): x is string => !!x)
      resolve([...new Set(names)])
    })
  })
}

const GAME_PROCESS = /^(fivem(_.*)?|gta5(_enhanced)?|gta5_be|playgtav|gtavlauncher|fivem_.*gtaprocess)\.exe$/i

export async function runningGameProcesses(): Promise<string[]> {
  return (await listProcesses()).filter((n) => GAME_PROCESS.test(n))
}
