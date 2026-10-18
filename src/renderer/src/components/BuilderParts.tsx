// Pièces communes de « Créer ton pack » : tuile d'un élément (photo, résumé, crédits, poids, base manquante ; désactivée
// quand il remplace la même chose qu'un élément déjà choisi),
// coche de sélection, badge de poids et fenêtre de détails d'un élément.
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
 * Raison pour laquelle un élément ne peut pas être choisi : il remplace la même chose qu'un élément déjà choisi (qu'il
 * faut retirer d'abord). `blockers` : ceux-là, sans l'élément qu'un choix unique remplacerait.
 */
export function blockedText(t: TFunction, blockers: BuilderComponentCard[]): string | null {
  return blockers.length ? t('builder.card.blocked', { count: blockers.length, names: blockers.map((c) => q(c.name)).join(', ') }) : null
}

/**
 * Élément à choisir : un clic le choisit ou le retire. `blockers` : éléments choisis qui remplacent les mêmes fichiers
 * (l'élément ne peut pas être choisi avec eux : clic désactivé, raison au survol) ; `missing` : bases (QuantV, NVE,
 * ReShade) qu'il demande et que rien ne fournit, avec de quoi les activer.
 */
export function ComponentTile({
  card,
  selected,
  blockers,
  missing,
  baseLabel,
  onChoose,
  onDetails,
  onBase
}: {
  card: BuilderComponentCard
  selected: boolean
  blockers: BuilderComponentCard[]
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
  // Un élément déjà choisi reste cliquable (pour le retirer), même s'il en gêne un autre.
  const blocked = selected ? null : blockedText(t, blockers)
  const choose = (): void => {
    if (!blocked) onChoose()
  }
  return (
    <article
      className={`card clickable builder-card ${selected ? 'is-selected' : ''} ${blocked ? 'is-blocked' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={blocked ?? undefined}
      onClick={choose}
      onKeyDown={(e) => activate(e, choose)}
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
        {card.unreadable && <div className="meta">{t('builder.card.unreadable')}</div>}
        <div className="card-foot">
          <WeightBadge perf={card.performance} />
          <span className="meta">{bytes(card.size)}</span>
          <div className="spacer" />
          {/* Toujours possible : sans la raison du blocage au survol. */}
          <button title="" onClick={stop(onDetails)}>
            {t('builder.card.details')}
          </button>
        </div>
      </div>
    </article>
  )
}

/**
 * Détails d'un élément : galerie, description, crédits, page d'origine, packs où il a été trouvé. `blocked` : raison
 * pour laquelle il ne peut pas être choisi (bouton « Choisir » désactivé, raison au survol).
 */
export function ComponentModal({
  id,
  card,
  selected,
  blocked,
  onToggle,
  onClose
}: {
  id: string
  card: BuilderComponentCard | null
  selected: boolean
  blocked: string | null
  onToggle: () => void
  onClose: () => void
}) {
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
              disabled={!selected && !!blocked}
              title={!selected && blocked ? blocked : undefined}
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
