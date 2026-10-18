// Ambiance de « Créer ton pack », pensée pour un joueur qui ne connaît rien à ReShade : un choix rapide en trois cartes
// (Basique, Recommandé, Personnalisé) puis, en Personnalisé, un panneau par outil (ReShade, QuantV, NVE, ENB) avec
// trois modes : Aucun, Réglé par moi (un style tout prêt, puis quelques curseurs avec un aperçu en direct) et Importé
// d'un pack. Le détail effet par effet reste caché dans « Avancé », pour les connaisseurs.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adjustmentCount, cleanTools, noAdjustments, previewLook, styleOf, type AmbianceChoice, type LookAdjust, type ToolNote } from '@shared/ambiance'
import { costOnMachine } from '@shared/performance'
import type {
  BuilderAdjustments,
  BuilderCatalog,
  BuilderComponentCard,
  BuilderControlValue,
  BuilderStyle,
  BuilderTool,
  BuilderToolSettings,
  BuilderTools,
  BuilderToolView,
  ToolKey,
  ToolMode
} from '@shared/types'
import { cleanError } from '../store'
import { builderImageUrl, builderStyleImageUrl, num } from '../lib/format'
import { conflictsOf, missingBases, type CardRef } from '../lib/builder'
import { AdvancedSettings, SimpleControls, useStarts } from './BuilderReshade'
import { Check, ComponentTile, WeightBadge } from './BuilderParts'
import { msText, usePerformance } from './Performance'

const CHOICES: AmbianceChoice[] = ['basic', 'recommended', 'custom']
const NOTE_KEY = { 'reshade-on': 'reshadeOn', 'quantv-off': 'quantvOff', 'reshade-missing': 'reshadeMissing' } as const

/** Nom court d'un outil (« ReShade » pour « ReShade (filtres de l'image) »). */
export function toolName(tool: BuilderTool): string {
  return tool.label.replace(/\s*\(.*\)\s*$/, '') || tool.key
}

/** Choix d'un outil en quelques mots : « Cinéma, réglé par toi », « importé de BH 1960 », « aucun ». */
export function toolSummary(t: TFunction, tool: BuilderTool, s: BuilderToolSettings, index: Map<string, CardRef>): string {
  if (s.mode === 'none') return t('builder.tool.lineNone')
  const style = styleOf(tool, s)
  const line =
    s.mode === 'pack'
      ? t('builder.tool.linePack', { name: (s.component && index.get(s.component)?.card.name) || t('builder.tool.unknownPack') })
      : style
        ? t('builder.tool.lineCustom', { style: style.label })
        : t('builder.tool.lineCustomNoStyle')
  const n = adjustmentCount(s)
  return n ? t('builder.tool.lineChanged', { line, count: n, n: num(n) }) : line
}

/** Curseurs pris en compte par l'aperçu en direct (ceux de NVE et d'ENB portent le nom de leur outil). */
function lookAdjust(tool: ToolKey, controls: Record<string, BuilderControlValue>): LookAdjust {
  const pick = (name: string): number | undefined => {
    const v = controls[tool === 'reshade' ? name : `${tool}-${name}`]
    return typeof v === 'number' ? v : undefined
  }
  return { brightness: pick('brightness'), contrast: pick('contrast'), saturation: pick('saturation'), temperature: pick('temperature') }
}

/**
 * Aperçu d'un style : son image (qui le montre déjà : seuls les curseurs s'y ajoutent), sinon l'image de référence de
 * l'outil avec les filtres du style ; calques de couleur, de température, de vignettage et de grain par-dessus.
 */
export function StyleLook({ tool, style, adjust = {}, thumb = false }: { tool: BuilderTool; style: BuilderStyle | null; adjust?: LookAdjust; thumb?: boolean }) {
  const [failed, setFailed] = useState<string[]>([])
  const own = style?.imageVersion ? builderStyleImageUrl(style.id, style.imageVersion, thumb) : null
  const reference = tool.referenceComponent && tool.reference ? builderImageUrl(tool.referenceComponent, tool.reference.id, thumb) : null
  const src = [own, reference].find((u): u is string => !!u && !failed.includes(u)) ?? null
  const look = previewLook(src && src === own ? null : style?.preview, adjust)
  return (
    <span className="style-look" aria-hidden>
      {src ? (
        <img src={src} alt="" draggable={false} style={{ filter: look.filter }} onError={() => setFailed((f) => [...f, src])} />
      ) : (
        <span className="style-look-blank" style={{ filter: look.filter }} />
      )}
      {look.tint && <span className="look-layer look-tint" style={{ background: look.tint.color, opacity: look.tint.opacity }} />}
      {look.warmth && <span className="look-layer look-tint" style={{ background: look.warmth.color, opacity: look.warmth.opacity }} />}
      {look.vignette > 0 && <span className="look-layer look-vignette" style={{ opacity: look.vignette }} />}
      {look.grain > 0 && <span className="look-layer look-grain" style={{ opacity: look.grain * 0.6 }} />}
    </span>
  )
}

const CHOICE_ICONS: Record<AmbianceChoice, ReactNode> = {
  // Image d'origine, nette.
  basic: <path d="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" />,
  // Étoile : le choix tout prêt.
  recommended: <path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />,
  // Curseurs : chaque outil réglé.
  custom: <path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11M20 18h-1M16 4v4M10 10v4M18 16v4" />
}

export function AmbianceSection({
  catalog,
  index,
  tools,
  choice,
  note,
  focus,
  chosen,
  onChoice,
  onTool,
  onMode,
  onBase,
  onDetails,
  baseLabel
}: {
  catalog: BuilderCatalog
  index: Map<string, CardRef>
  tools: BuilderTools
  choice: AmbianceChoice
  /** Règle entre outils appliquée au dernier changement, expliquée dans le panneau de l'outil changé. */
  note: { tool: ToolKey; note: ToolNote } | null
  /** Outil à montrer (lien du récapitulatif, problème à régler) : son panneau défile jusqu'à l'écran. */
  focus: { tool: ToolKey; at: number } | null
  chosen: BuilderComponentCard[]
  onChoice: (choice: AmbianceChoice) => void
  onTool: (key: ToolKey, settings: BuilderToolSettings) => void
  onMode: (key: ToolKey, mode: ToolMode) => void
  onBase: (base: string) => void
  onDetails: (id: string) => void
  baseLabel: (base: string) => string
}) {
  const { t } = useTranslation()
  return (
    <section className="ambiance">
      <div className="section-head first">
        <h2>{t('builder.ambiance.title')}</h2>
      </div>
      <p className="hint ambiance-intro">{t('builder.ambiance.intro')}</p>
      <div className="ambiance-choices" role="radiogroup" aria-label={t('builder.ambiance.title')}>
        {CHOICES.map((c) => (
          <button key={c} role="radio" aria-checked={choice === c} className={`ambiance-choice ${choice === c ? 'is-selected' : ''}`} onClick={() => onChoice(c)}>
            <span className="ambiance-choice-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {CHOICE_ICONS[c]}
              </svg>
            </span>
            <span className="ambiance-choice-title">{t(`builder.ambiance.${c}.title`)}</span>
            <span className="ambiance-choice-text">{t(`builder.ambiance.${c}.text`)}</span>
            {choice === c && <Check />}
          </button>
        ))}
      </div>
      {choice === 'custom' ? (
        catalog.tools.map((tool) => (
          <ToolPanel
            key={tool.key}
            catalog={catalog}
            tool={tool}
            tools={tools}
            index={index}
            chosen={chosen}
            note={note?.tool === tool.key ? note.note : null}
            focus={focus?.tool === tool.key ? focus.at : null}
            onTool={onTool}
            onMode={onMode}
            onBase={onBase}
            onDetails={onDetails}
            baseLabel={baseLabel}
          />
        ))
      ) : (
        <ul className="ambiance-lines">
          {catalog.tools.map((tool) => (
            <li key={tool.key}>
              <span className="ambiance-line-name">{toolName(tool)}</span>
              <span className="muted">{toolSummary(t, tool, tools[tool.key], index)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Coût de l'outil choisi : celui du style (sur ce PC), ou le poids du pack importé. */
function ToolCost({ tool, settings, index }: { tool: BuilderTool; settings: BuilderToolSettings; index: Map<string, CardRef> }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  if (settings.mode === 'pack') {
    const card = settings.component ? index.get(settings.component)?.card : null
    return card ? <WeightBadge perf={card.performance} /> : null
  }
  const style = styleOf(tool, settings)
  if (!style) return null
  const ms = ctx ? costOnMachine(ctx.profile.model, ctx.machine, style.costMs) : style.costMs
  return <span className="builder-tier">{ms >= 0.05 ? t('builder.tool.cost', { label: style.costLabel, ms: msText(ms) }) : style.costLabel}</span>
}

function ToolPanel({
  catalog,
  tool,
  tools,
  index,
  chosen,
  note,
  focus,
  onTool,
  onMode,
  onBase,
  onDetails,
  baseLabel
}: {
  catalog: BuilderCatalog
  tool: BuilderTool
  tools: BuilderTools
  index: Map<string, CardRef>
  chosen: BuilderComponentCard[]
  note: ToolNote | null
  focus: number | null
  onTool: (key: ToolKey, settings: BuilderToolSettings) => void
  onMode: (key: ToolKey, mode: ToolMode) => void
  onBase: (base: string) => void
  onDetails: (id: string) => void
  baseLabel: (base: string) => string
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focus])
  const settings = tools[tool.key]
  const modes: ToolMode[] = ['none', ...(tool.custom ? (['custom'] as const) : []), ...(tool.packs > 0 ? (['pack'] as const) : [])]
  const category = catalog.categories.find((c) => c.tool === tool.key) ?? catalog.categories.find((c) => c.key === tool.category)
  // Autre style ou autre pack : les réglages simples sont gardés, le mode avancé (propre à l'ancien fichier) est oublié.
  const change = (next: Partial<BuilderToolSettings>): void => onTool(tool.key, { ...settings, ...next, techniques: {}, values: {} })
  return (
    <section ref={ref} className={`tool-panel ${settings.mode === 'none' ? 'is-off' : ''}`} id={`tool-${tool.key}`}>
      <header className="tool-head">
        <div className="tool-title">
          <h3>{tool.label}</h3>
          <p className="muted small">{tool.description}</p>
        </div>
        <ToolCost tool={tool} settings={settings} index={index} />
      </header>
      <div className="segmented tool-modes" role="radiogroup" aria-label={tool.label}>
        {modes.map((m) => (
          <button key={m} role="radio" aria-checked={settings.mode === m} className={settings.mode === m ? 'is-selected' : ''} onClick={() => onMode(tool.key, m)}>
            {t(`builder.tool.mode.${m}`)}
          </button>
        ))}
      </div>
      {note && <p className="tool-note">{t(`builder.tool.note.${NOTE_KEY[note]}`)}</p>}
      {settings.mode === 'custom' && <StyleGallery tool={tool} selected={styleOf(tool, settings)?.id ?? null} onSelect={(style) => change({ style })} />}
      {settings.mode === 'pack' && category && (
        <div className="grid builder-grid">
          {category.components.map((card) => {
            const selected = settings.component === card.id
            return (
              <ComponentTile
                key={card.id}
                card={card}
                selected={selected}
                conflicts={conflictsOf(card, chosen)}
                missing={selected ? missingBases(card, chosen, tools) : []}
                baseLabel={baseLabel}
                onChoose={() => !selected && change({ component: card.id })}
                onDetails={() => onDetails(card.id)}
                onBase={onBase}
              />
            )
          })}
        </div>
      )}
      {settings.mode !== 'none' && <ToolAdjust tool={tool} settings={settings} tools={tools} onChange={(s) => onTool(tool.key, s)} />}
    </section>
  )
}

/** Galerie des styles d'un outil : image ou aperçu dessiné, nom, coût ; description en info-bulle. */
function StyleGallery({ tool, selected, onSelect }: { tool: BuilderTool; selected: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  if (!tool.styles.length) return <p className="muted small">{t('builder.tool.noStyles')}</p>
  return (
    <div className="style-grid" role="radiogroup" aria-label={t('builder.tool.styles')}>
      {tool.styles.map((s) => (
        <button key={s.id} role="radio" aria-checked={selected === s.id} className={`style-card ${selected === s.id ? 'is-selected' : ''}`} title={s.description || undefined} onClick={() => onSelect(s.id)}>
          <StyleLook tool={tool} style={s} thumb />
          <span className="style-card-body">
            <span className="style-name">{s.label}</span>
            <span className="style-meta">
              {s.byDefault && <span className="badge">{t('builder.tool.byDefault')}</span>}
              {s.costLabel && <span className="builder-tier">{s.costLabel}</span>}
            </span>
          </span>
          {selected === s.id && <Check />}
        </button>
      ))}
    </div>
  )
}

/** État de l'outil pour les choix en cours, redemandé 300 ms après chaque changement (ses réglages en dépendent). */
function useToolView(tool: ToolKey, tools: BuilderTools): { view: BuilderToolView | null; fresh: boolean; error: string | null; retry: () => void } {
  const { i18n } = useTranslation()
  const key = JSON.stringify(cleanTools(tools))
  const [state, setState] = useState<{ key: string; view: BuilderToolView | null; error: string | null }>({ key: '', view: null, error: null })
  const [attempt, setAttempt] = useState(0)
  const first = useRef(true)
  useEffect(() => {
    let live = true
    const delay = first.current ? 0 : 300
    first.current = false
    const timer = setTimeout(() => {
      window.api.builderToolView(tool, JSON.parse(key) as BuilderTools).then(
        (view) => live && setState({ key, view, error: null }),
        (e) => live && setState((s) => ({ ...s, key, error: cleanError(e) }))
      )
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [tool, key, attempt, i18n.language])
  const current = state.key === key
  return { view: state.view, fresh: current && !state.error && !!state.view, error: current ? state.error : null, retry: () => setAttempt((a) => a + 1) }
}

/** « Ajuster » : aperçu en direct (réglé par moi) et réglages simples, puis le mode avancé, replié. */
function ToolAdjust({ tool, settings, tools, onChange }: { tool: BuilderTool; settings: BuilderToolSettings; tools: BuilderTools; onChange: (s: BuilderToolSettings) => void }) {
  const { t } = useTranslation()
  const { view, fresh, error, retry } = useToolView(tool.key, tools)
  const starts = useStarts(view, fresh, settings, `${tool.key}:${settings.mode}:${settings.component ?? ''}:${settings.style ?? ''}`)
  const adjust = (a: BuilderAdjustments): void => onChange({ ...settings, controls: a.controls, techniques: a.techniques, values: a.values })
  const custom = settings.mode === 'custom'
  const style = styleOf(tool, settings)
  return (
    <div className="tool-adjust">
      <div className="tool-adjust-head">
        <h4>{t('builder.tool.adjust')}</h4>
        <div className="spacer" />
        {adjustmentCount(settings) > 0 && (
          <button className="link small" onClick={() => adjust(noAdjustments())}>
            {custom ? t('builder.tool.backToStyle') : t('builder.tool.backToPack')}
          </button>
        )}
      </div>
      {error && (
        <div className="bar bar-error">
          <span className="bar-text">{error}</span>
          <button onClick={retry}>{t('common.retry')}</button>
        </div>
      )}
      {!view ? (
        !error && <p className="muted loading">{t('common.loading')}</p>
      ) : (
        <>
          <div className={`tool-adjust-body ${custom ? 'with-look' : ''}`}>
            {custom && (
              <figure className="tool-look">
                <StyleLook tool={tool} style={style} adjust={lookAdjust(tool.key, settings.controls)} />
                <figcaption className="muted small">{t('builder.tool.lookHint')}</figcaption>
              </figure>
            )}
            <div className="tool-controls">
              <SimpleControls controls={view.controls} adjustments={settings} starts={starts} onChange={adjust} />
            </div>
          </div>
          <details className="tool-expert">
            <summary>
              {t('builder.tool.advanced')}
              <span className="muted small">{t('builder.tool.advancedHint')}</span>
            </summary>
            <AdvancedSettings view={view} component={view.componentId ?? settings.component} adjustments={settings} starts={starts} onChange={adjust} />
          </details>
        </>
      )}
    </div>
  )
}
