// Lecture et modification des réglages de Windows touchés par les optimisations (voir core/optimizations.ts) : valeurs du
// registre, mode d'alimentation, mémoire virtuelle, exclusions de l'antivirus. Tout passe par PowerShell, en une seule
// exécution pour la lecture et une par niveau de droits pour les changements (une seule demande UAC).

import { runPowerShell } from '../util/win'

export type Hive = 'HKCU' | 'HKLM'

/** Valeur du registre. */
export interface RegRef {
  hive: Hive
  key: string
  name: string
}

/** DWORD (entier sans signe), chaîne, ou null : valeur absente. */
export type RegData = number | string | null

export interface RegValue {
  type: 'dword' | 'string'
  data: number | string
}

/** Changement du système. `data: null` supprime la valeur du registre. */
export type SystemOp =
  | { t: 'reg'; hive: Hive; key: string; name: string; type: 'dword' | 'string'; data: RegData }
  | { t: 'power'; scheme: string }
  | { t: 'powermode'; mode: string }
  | { t: 'defender'; add: string[]; remove: string[] }
  | { t: 'pagefile'; auto: boolean; files: PageFile[] }

export interface PageFile {
  name: string
  /** Mo ; 0 et 0 : taille gérée par Windows pour ce fichier. */
  initial: number
  maximum: number
}

export interface OpResult {
  ok: boolean
  error?: string
  /** Exclusions de l'antivirus vraiment ajoutées (celles déjà présentes ne sont pas comptées). */
  added?: string[]
}

/** Carte graphique d'après son pilote. */
export interface DriverInfo {
  name: string
  version: string | null
  /** Date du pilote (AAAA-MM-JJ). */
  date: string | null
  /** Mémoire dédiée en octets (null : non indiquée). */
  memory: number | null
}

export interface SystemProbe {
  /** Valeurs demandées, dans l'ordre de la demande (null : absente). */
  reg: (RegValue | null)[]
  power: { active: string | null; schemes: { guid: string; name: string }[] }
  /** Mode d'alimentation de Windows 11 sur secteur (null : non lu, ou Windows 10). */
  powerModeAc: string | null
  pagefile: { auto: boolean | null; files: PageFile[]; allocatedMb: number }
  /** Antivirus déclarés à Windows : nom et protection active. */
  antivirus: { name: string; enabled: boolean }[]
  drivers: DriverInfo[]
  /** Type du disque de chaque lettre demandée (« SSD », « HDD », null : inconnu). */
  disks: Record<string, string | null>
  /** Intégrité de la mémoire (HVCI) en marche (null : inconnu). */
  memoryIntegrity: boolean | null
  /** Batterie présente (PC portable). */
  battery: boolean
  /** Nombre de barrettes de mémoire (null : inconnu). */
  memorySticks: number | null
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** Plan « Performances élevées ». */
const POWER_HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

/** Modes d'alimentation de `powercfg /list` (texte dans la langue de Windows : seuls les GUID comptent). */
export function parsePowerList(text: string): { guid: string; name: string; active: boolean }[] {
  const out: { guid: string; name: string; active: boolean }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`(${GUID.source})\\s*\\(([^)]*)\\)\\s*(\\*)?`, 'i').exec(line)
    if (m) out.push({ guid: m[1].toLowerCase(), name: m[2].trim(), active: !!m[3] })
  }
  return out
}

/** GUID du mode actif dans la sortie de `powercfg /getactivescheme`. */
export function parseActiveScheme(text: string): string | null {
  return GUID.exec(text)?.[0].toLowerCase() ?? null
}

/** Chaîne PowerShell entre apostrophes. */
const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** Fonctions communes aux scripts. */
const HELPERS = String.raw`
function Hive($h) { if ($h -eq 'HKLM') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser } }
function PowerMode() {
  if (-not ('ReflectFiveM.PowerMode' -as [type])) {
    Add-Type -Namespace ReflectFiveM -Name PowerMode -MemberDefinition '[DllImport("powrprof.dll")] public static extern uint PowerGetUserConfiguredACPowerMode(out Guid mode); [DllImport("powrprof.dll")] public static extern uint PowerSetUserConfiguredACPowerMode(ref Guid mode);' -ErrorAction Stop
  }
  [ReflectFiveM.PowerMode]
}
`

/**
 * Script de lecture : registre, alimentation, mémoire virtuelle, antivirus, pilotes graphiques, type des disques,
 * intégrité de la mémoire, batterie, barrettes de mémoire. `powerMode` : lit aussi le mode d'alimentation de Windows 11
 * (seulement si le plan « Performances élevées » n'est pas proposé).
 */
export function probeScript(reg: RegRef[], driveLetters: string[], powerMode = false): string {
  const request = JSON.stringify({ reg, drives: driveLetters, powerMode })
  return `${HELPERS}
$req = ConvertFrom-Json ${ps(request)}
$reg = @()
foreach ($r in @($req.reg)) {
  $v = $null
  $k = $null
  try { $k = (Hive $r.hive).OpenSubKey($r.key) } catch {}
  if ($k) {
    try {
      $raw = $k.GetValue($r.name, $null, 'DoNotExpandEnvironmentNames')
      if ($raw -ne $null) {
        $kind = [string]$k.GetValueKind($r.name)
        if ($kind -eq 'DWord') { $v = @{ type = 'dword'; data = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$raw), 0) } }
        elseif ($kind -eq 'String' -or $kind -eq 'ExpandString') { $v = @{ type = 'string'; data = [string]$raw } }
      }
    } catch {}
    $k.Close()
  }
  $reg += ,$v
}
$power = @{ active = ((powercfg /getactivescheme) -join ' '); list = ((powercfg /list) -join [char]10); mode = $null }
if ($req.powerMode -and ($power.list -notmatch '${POWER_HIGH}')) {
  try { $g = [Guid]::Empty; if ((PowerMode)::PowerGetUserConfiguredACPowerMode([ref]$g) -eq 0) { $power.mode = $g.ToString() } } catch {}
}
$pf = @{ auto = $null; files = @(); allocated = 0 }
try { $pf.auto = [bool](Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile } catch {}
try { $pf.files = @(Get-CimInstance Win32_PageFileSetting | ForEach-Object { @{ name = [string]$_.Name; initial = [int]$_.InitialSize; maximum = [int]$_.MaximumSize } }) } catch {}
try { $pf.allocated = [int](Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize -Sum).Sum } catch {}
$av = @()
try { $av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { @{ name = [string]$_.displayName; enabled = ((([int]$_.productState) -shr 12) -band 0xF) -eq 1 } }) } catch {}
$drivers = @()
$root = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}')
if ($root) {
  foreach ($name in $root.GetSubKeyNames()) {
    if ($name -notmatch '^\\d{4}$') { continue }
    $k = $null
    try { $k = $root.OpenSubKey($name) } catch { continue }
    if (-not $k) { continue }
    $mem = $k.GetValue('HardwareInformation.qwMemorySize')
    if ($mem -eq $null) { $mem = $k.GetValue('HardwareInformation.MemorySize') }
    if ($mem -is [byte[]]) {
      if ($mem.Length -ge 8) { $mem = [BitConverter]::ToUInt64($mem, 0) } elseif ($mem.Length -ge 4) { $mem = [BitConverter]::ToUInt32($mem, 0) } else { $mem = $null }
    } elseif ($mem -is [int]) { $mem = [BitConverter]::ToUInt32([BitConverter]::GetBytes($mem), 0) }
    $m = $null
    if ($mem -ne $null) { $m = [string]$mem }
    $drivers += @{ name = [string]$k.GetValue('DriverDesc'); version = [string]$k.GetValue('DriverVersion'); date = [string]$k.GetValue('DriverDate'); memory = $m }
    $k.Close()
  }
  $root.Close()
}
$disks = @{}
foreach ($d in @($req.drives)) {
  $type = $null
  try {
    $disk = Get-Partition -DriveLetter $d -ErrorAction Stop | Get-Disk -ErrorAction Stop
    $pd = Get-PhysicalDisk -ErrorAction Stop | Where-Object { [string]$_.DeviceId -eq [string]$disk.Number } | Select-Object -First 1
    if ($pd) { $type = [string]$pd.MediaType }
  } catch {}
  $disks[$d] = $type
}
$hvci = $null
try { $dg = Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop; $hvci = @($dg.SecurityServicesRunning) -contains 2 } catch {}
$battery = $false
try { $battery = @(Get-CimInstance Win32_Battery -ErrorAction Stop).Count -gt 0 } catch {}
$sticks = $null
try { $sticks = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop).Count } catch {}
ConvertTo-Json -InputObject @{ reg = @($reg); power = $power; pagefile = $pf; antivirus = @($av); drivers = @($drivers); disks = $disks; hvci = $hvci; battery = $battery; sticks = $sticks } -Depth 5 -Compress
`
}

/** Date d'un pilote, « 3-12-2022 » (mois-jour-année) dans le registre, en AAAA-MM-JJ. */
export function driverDate(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec((raw ?? '').trim())
  if (!m) return null
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

const arr = <T>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x])

/** Réponse du script de lecture ; `count` : nombre de valeurs du registre demandées. */
export function parseProbe(out: string, count: number): SystemProbe {
  const json = JSON.parse(out.trim() || '{}') as Record<string, unknown>
  const reg = arr(json.reg as unknown[])
    .slice(0, count)
    .map((v): RegValue | null => {
      const x = v as { type?: unknown; data?: unknown } | null
      if (x?.type === 'dword' && typeof x.data === 'number') return { type: 'dword', data: x.data }
      if (x?.type === 'string' && typeof x.data === 'string') return { type: 'string', data: x.data }
      return null
    })
  while (reg.length < count) reg.push(null)
  const power = (json.power ?? {}) as { active?: string; list?: string; mode?: unknown }
  const pf = (json.pagefile ?? {}) as { auto?: unknown; files?: unknown; allocated?: unknown }
  return {
    reg,
    power: {
      active: parseActiveScheme(power.active ?? ''),
      schemes: parsePowerList(power.list ?? '').map(({ guid, name }) => ({ guid, name }))
    },
    powerModeAc: typeof power.mode === 'string' && GUID.test(power.mode) ? power.mode.toLowerCase() : null,
    pagefile: {
      auto: typeof pf.auto === 'boolean' ? pf.auto : null,
      files: arr(pf.files as PageFile[])
        .filter((f) => f && typeof f.name === 'string')
        .map((f) => ({ name: f.name, initial: Number(f.initial) || 0, maximum: Number(f.maximum) || 0 })),
      allocatedMb: Number(pf.allocated) || 0
    },
    antivirus: arr(json.antivirus as { name?: unknown; enabled?: unknown }[])
      .filter((a) => a && typeof a.name === 'string' && a.name.trim())
      .map((a) => ({ name: (a.name as string).trim(), enabled: a.enabled === true })),
    drivers: arr(json.drivers as { name?: unknown; version?: unknown; date?: unknown; memory?: unknown }[])
      .filter((d) => d && typeof d.name === 'string' && d.name.trim())
      .map((d) => {
        const memory = Number(d.memory)
        return {
          name: (d.name as string).trim(),
          version: typeof d.version === 'string' && d.version ? d.version : null,
          date: driverDate(typeof d.date === 'string' ? d.date : null),
          memory: Number.isFinite(memory) && memory > 0 ? memory : null
        }
      }),
    disks: Object.fromEntries(
      Object.entries((json.disks ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toUpperCase(), typeof v === 'string' && v ? v : null])
    ),
    memoryIntegrity: typeof json.hvci === 'boolean' ? json.hvci : null,
    battery: json.battery === true,
    memorySticks: typeof json.sticks === 'number' && json.sticks > 0 ? json.sticks : null
  }
}

/** Script des changements : un résultat par changement, dans l'ordre (JSON). */
export function opsScript(ops: SystemOp[]): string {
  return `${HELPERS}
$ops = ConvertFrom-Json ${ps(JSON.stringify(ops))}
$results = @()
foreach ($op in @($ops)) {
  $r = @{ ok = $false }
  try {
    switch ($op.t) {
      'reg' {
        $root = Hive $op.hive
        if ($op.data -eq $null) {
          $k = $root.OpenSubKey($op.key, $true)
          if ($k) { $k.DeleteValue($op.name, $false); $k.Close() }
        } else {
          $k = $root.CreateSubKey($op.key)
          if ($op.type -eq 'dword') {
            $k.SetValue($op.name, [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$op.data), 0), [Microsoft.Win32.RegistryValueKind]::DWord)
          } else {
            $k.SetValue($op.name, [string]$op.data, [Microsoft.Win32.RegistryValueKind]::String)
          }
          $k.Close()
        }
        $r.ok = $true
      }
      'power' {
        $out = powercfg /setactive $op.scheme 2>&1
        $r.ok = ($LASTEXITCODE -eq 0)
        if (-not $r.ok) { $r.error = ($out -join ' ') }
      }
      'powermode' {
        $g = [Guid]$op.mode
        $rc = (PowerMode)::PowerSetUserConfiguredACPowerMode([ref]$g)
        $r.ok = ($rc -eq 0)
        if (-not $r.ok) { $r.error = "PowerSetUserConfiguredACPowerMode: $rc" }
      }
      'defender' {
        $before = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)
        $added = @()
        foreach ($p in @($op.add)) {
          if ($before -notcontains $p) { Add-MpPreference -ExclusionPath $p -ErrorAction Stop; $added += $p }
        }
        foreach ($p in @($op.remove)) { Remove-MpPreference -ExclusionPath $p -ErrorAction Stop }
        $r.added = @($added)
        $r.ok = $true
      }
      'pagefile' {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = [bool]$op.auto } -ErrorAction Stop
        if (-not $op.auto) {
          Get-CimInstance Win32_PageFileSetting | Remove-CimInstance -ErrorAction SilentlyContinue
          foreach ($f in @($op.files)) {
            New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = $f.name; InitialSize = [uint32]$f.initial; MaximumSize = [uint32]$f.maximum } -ErrorAction Stop | Out-Null
          }
        }
        $r.ok = $true
      }
    }
  } catch { $r.error = $_.Exception.Message }
  $results += ,$r
}
ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
`
}

/** Résultats du script des changements ; un résultat manquant compte comme un échec. */
export function parseOpResults(out: string, count: number): OpResult[] {
  let json: unknown
  try {
    json = JSON.parse(out.trim() || '[]')
  } catch {
    json = []
  }
  const list = arr(json as unknown[])
  return Array.from({ length: count }, (_, i) => {
    const r = list[i] as { ok?: unknown; error?: unknown; added?: unknown } | undefined
    if (!r) return { ok: false }
    return {
      ok: r.ok === true,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
      ...(r.added !== undefined ? { added: arr(r.added as string[]).filter((p) => typeof p === 'string') } : {})
    }
  })
}

/** Lit le système (droits de l'utilisateur). */
export async function probeSystem(reg: RegRef[], driveLetters: string[], powerMode = false): Promise<SystemProbe> {
  return parseProbe(await runPowerShell(probeScript(reg, driveLetters, powerMode), 60_000), reg.length)
}

/**
 * Fait les changements. `elevated` : exécute le script avec les droits administrateur (une demande UAC) et renvoie ce
 * qu'il a écrit, null si l'autorisation est refusée (null est alors renvoyé ici aussi).
 */
export async function runSystemOps(ops: SystemOp[], elevated: ((script: string) => Promise<string | null>) | null): Promise<OpResult[] | null> {
  if (!ops.length) return []
  const script = opsScript(ops)
  const out = elevated ? await elevated(script) : await runPowerShell(script, 60_000)
  return out === null ? null : parseOpResults(out, ops.length)
}

/** Fixe la priorité des processus du jeu en cours (noms d'exécutables), sans droits administrateur. */
export async function setPriority(exes: string[], priority: 'High' | 'AboveNormal' | 'Normal'): Promise<void> {
  if (!exes.length) return
  const names = exes.map((e) => ps(e.replace(/\.exe$/i, ''))).join(',')
  await runPowerShell(`Get-Process -Name ${names} -ErrorAction SilentlyContinue | ForEach-Object { try { $_.PriorityClass = '${priority}' } catch {} }`)
}
