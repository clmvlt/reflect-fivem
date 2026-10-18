// Pièces communes de « Créer ton pack » : tuile d'un élément (photo, résumé, crédits, poids, conflits, base manquante),
// coche de sélection, badge de poids et fenêtre de détails d'un élément.
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { BuilderComponentCard, BuilderComponentDetail, BuilderPerformance } from '@shared/types'
import { EMBEDDED_PERFORMANCE_MODEL, tierLabel } from '@shared/performance'
import { cleanError, useStore } from '../store'
import { builderImageUrl, bytes, num, q } from '../lib/format'
import { Gallery } from './Gallery'
import { Markdown } from './Markdown'
import { Modal } from './Modal'
import { memText, usePerformance } from './Performance'

/** Entrée ou Espace sur une carte : comme un clic. */
export function activate(e: KeyboardEvent, fn: () => void): void {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
  e.preventDefault()
  fn()
}

export function Check() {
  return (
    <span className="builder-check" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
    </span>
  )
}

/** Poids sur les performances : niveau et mémoire vidéo. */
export function WeightBadge({ perf }: { perf: BuilderPerformance | null }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  if (!perf) return <span className="meta">{t('builder.card.notAnalyzed')}</span>
  const model = ctx?.profile.model ?? EMBEDDED_PERFORMANCE_MODEL
  return (
    <span className={`builder-tier tier-${perf.tier}`} title={t('builder.card.weightTitle')}>
      {tierLabel(model, perf.tier)}
      {perf.vramMb ? ` · ${memText(perf.vramMb)}` : ''}
    </span>
  )
}

/**
 * Élément à choisir : un clic le choisit ou le retire. `conflicts` : éléments choisis qui remplacent les mêmes fichiers ;
 * `missing` : bases (QuantV, NVE, ReShade) qu'il demande et que rien ne fournit, avec de quoi les activer.
 */
export function ComponentTile({
  card,
  selected,
  conflicts,
  missing,
  baseLabel,
  onChoose,
  onDetails,
  onBase
}: {
  card: BuilderComponentCard
  selected: boolean
  conflicts: BuilderComponentCard[]
  missing: string[]
  baseLabel: (base: string) => string
  onChoose: () => void
  onDetails: () => void
  onBase: (base: string) => void
}) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <article
      className={`card clickable builder-card ${selected ? 'is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onChoose}
      onKeyDown={(e) => activate(e, onChoose)}
    >
      <div className="cover">
        {card.cover && !failed ? (
          <img className="cover-img" src={builderImageUrl(card.id, card.cover.id, true)} alt="" draggable={false} onError={() => setFailed(true)} />
        ) : (
          <div className="cover-empty">{card.name}</div>
        )}
        {selected && <Check />}
      </div>
      <div className="card-body">
        <div className="name" title={card.name}>
          {card.name}
        </div>
        {card.summary && <p className="builder-text">{card.summary}</p>}
        {card.credits && (
          <div className="meta" title={card.credits}>
            {t('builder.card.credits', { credits: card.credits })}
          </div>
        )}
        {card.requires.length > 0 && !missing.length && <div className="meta">{t('builder.card.requires', { bases: card.requires.map(baseLabel).join(', ') })}</div>}
        {missing.map((b) => (
          <div key={b} className="builder-note warn-text">
            {t('builder.card.missing', { base: baseLabel(b) })}{' '}
            <button className="link" onClick={stop(() => onBase(b))}>
              {t('builder.card.enableBase')}
            </button>
          </div>
        ))}
        {conflicts.length > 0 && <div className="builder-note warn-text">{t('builder.card.conflict', { names: conflicts.map((c) => q(c.name)).join(', ') })}</div>}
        {card.unreadable && <div className="meta">{t('builder.card.unreadable')}</div>}
        <div className="card-foot">
          <WeightBadge perf={card.performance} />
          <span className="meta">{bytes(card.size)}</span>
          <div className="spacer" />
          <button onClick={stop(onDetails)}>{t('builder.card.details')}</button>
        </div>
      </div>
    </article>
  )
}

/** Détails d'un élément : galerie, description, crédits, page d'origine, packs où il a été trouvé. */
export function ComponentModal({ id, card, selected, onToggle, onClose }: { id: string; card: BuilderComponentCard | null; selected: boolean; onToggle: () => void; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const { run } = useStore()
  const [detail, setDetail] = useState<BuilderComponentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.api.builderComponent(id).then(
      (d) => live && setDetail(d),
      (e) => live && setError(cleanError(e))
    )
    return () => {
      live = false
    }
  }, [id, i18n.language])
  const name = detail?.name ?? card?.name ?? ''
  return (
    <Modal
      className="builder-modal"
      title={name}
      onClose={onClose}
      actions={
        <>
          {card && (
            <button
              className={selected ? '' : 'primary'}
              data-autofocus
              onClick={() => {
                onToggle()
                onClose()
              }}
            >
              {selected ? t('builder.details.remove') : t('builder.details.choose')}
            </button>
          )}
          <button onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      {error ? (
        <p>{error}</p>
      ) : !detail ? (
        <p className="muted loading">{t('common.loading')}</p>
      ) : (
        <div className="builder-detail">
          <Gallery
            key={detail.id}
            images={detail.images.map((i) => i.id)}
            image={(imageId) => <img className="cover-img contain" src={builderImageUrl(detail.id, imageId)} alt="" draggable={false} />}
            thumb={(imageId) => builderImageUrl(detail.id, imageId, true)}
            empty={<div className="cover-empty">{detail.name}</div>}
          />
          {detail.summary && <p className="summary">{detail.summary}</p>}
          <dl className="facts">
            <dt>{t('builder.details.size')}</dt>
            <dd>{bytes(detail.size)}</dd>
            <dt>{t('builder.details.files')}</dt>
            <dd>{num(detail.fileCount)}</dd>
            <dt>{t('builder.details.weight')}</dt>
            <dd>
              <WeightBadge perf={detail.performance} />
            </dd>
            {detail.credits && (
              <>
                <dt>{t('builder.details.credits')}</dt>
                <dd className="builder-credits">{detail.credits}</dd>
              </>
            )}
            {detail.tags.length > 0 && (
              <>
                <dt>{t('builder.details.tags')}</dt>
                <dd>{detail.tags.join(', ')}</dd>
              </>
            )}
          </dl>
          {detail.unreadable && <p className="hint">{t('builder.details.unreadable')}</p>}
          {detail.description.trim() && <Markdown text={detail.description} />}
          {detail.sourceUrl && (
            <div className="side-links">
              <button onClick={() => void run(() => window.api.openLink(detail.sourceUrl!))}>{t('builder.details.source')}</button>
            </div>
          )}
          {detail.foundIn.length > 0 && (
            <>
              <div className="section-head">
                <h2>{t('builder.details.foundIn')}</h2>
              </div>
              <ul className="list compact">
                {detail.foundIn.map((s, i) => (
                  <li key={`${s.packId}-${i}`} className="row">
                    <span className="row-main">
                      <span>{s.packName}</span>
                      {s.packAuthor && <span className="meta"> · {t('packDetail.byAuthor', { author: s.packAuthor })}</span>}
                    </span>
                    {s.packSlug && (
                      <button className="link" onClick={() => void run(() => window.api.openSite(`/packs/${s.packSlug}/`))}>
                        {t('builder.details.viewPack')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
