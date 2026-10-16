import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { CHANGELOG_SECTIONS, type ChangelogSection, type ReleaseNotes, type WhatsNew as WhatsNewData } from '@shared/changelog'
import { longDate } from '../lib/format'
import { Markdown } from './Markdown'
import { Modal } from './Modal'

/**
 * Fenêtre « Nouveautés » : pour chaque version, son numéro et sa date, l'introduction puis une liste par rubrique non
 * vide. Montrée au premier lancement et après une mise à jour (OK l'enregistre comme vue), ou depuis le panneau de mise
 * à jour pour une version qui arrive.
 */
export function WhatsNew({ whatsNew, onClose }: { whatsNew: WhatsNewData; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Modal
      className="whatsnew"
      title={t('whatsNew.title', { version: whatsNew.version })}
      onClose={onClose}
      actions={
        <button className="primary" data-autofocus onClick={onClose}>
          {t('common.ok')}
        </button>
      }
    >
      {whatsNew.releases.map((release) => (
        <Release key={release.version} release={release} />
      ))}
    </Modal>
  )
}

function Release({ release }: { release: ReleaseNotes }) {
  const { t } = useTranslation()
  const { changelog } = release
  return (
    <section className="whatsnew-release">
      <div className="whatsnew-head">
        <h3>{t('whatsNew.version', { version: release.version })}</h3>
        {release.prerelease && <span className="whatsnew-tag">{t('whatsNew.prerelease')}</span>}
        {release.publishedAt && <span className="muted">{t('whatsNew.date', { date: longDate(release.publishedAt) })}</span>}
      </div>
      <Markdown text={changelog.summary} />
      {CHANGELOG_SECTIONS.filter((s) => changelog[s].length).map((section) => (
        <div key={section} className="whatsnew-section">
          <h4>
            <span className="whatsnew-icon" aria-hidden>
              {ICONS[section]}
            </span>
            {t(`whatsNew.sections.${section}`)}
          </h4>
          {/* Un point par ligne ; le Markdown en ligne de l'admin (gras, liens) est gardé. */}
          <Markdown text={changelog[section].map((item) => `- ${item}`).join('\n')} />
        </div>
      ))}
    </section>
  )
}

const svg = (children: ReactElement): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)

/** Icône discrète de chaque rubrique. */
const ICONS: Record<ChangelogSection, ReactElement> = {
  // Étincelle
  features: svg(<path d="M8 1.75 9.4 6.6l4.85 1.4L9.4 9.4 8 14.25 6.6 9.4 1.75 8 6.6 6.6z" />),
  // Courbe qui monte
  improvements: svg(
    <>
      <path d="M2 11.5 6 7.5l2.5 2.5L14 4.5" />
      <path d="M10 4.5h4v4" />
    </>
  ),
  // Coche
  fixes: svg(
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.25 8.25 1.9 1.9 3.6-3.9" />
    </>
  ),
  // Points de suite
  other: svg(
    <>
      <circle cx="3.5" cy="8" r="0.6" />
      <circle cx="8" cy="8" r="0.6" />
      <circle cx="12.5" cy="8" r="0.6" />
    </>
  )
}
