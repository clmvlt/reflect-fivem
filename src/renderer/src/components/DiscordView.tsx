import { useTranslation } from 'react-i18next'
import { useStore } from '../store'

// Invitation du serveur Discord (discord.gg/rtBZAxqtsu).
const INVITE = 'rtBZAxqtsu'

export function DiscordIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2.1a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  )
}

/** Sujets du serveur (clés discord.topics.*). */
const TOPICS = ['help', 'packs', 'ideas', 'news'] as const

/** Présentation du serveur Discord de Reflect FiveM, avec le lien d'invitation. */
export function DiscordView() {
  const { t } = useTranslation()
  const { run } = useStore()
  const join = (): void => void run(() => window.api.openDiscordInvite(INVITE))
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('discord.title')}</h1>
      </header>
      <div className="discord">
        <div className="discord-hero">
          <span className="discord-logo">
            <DiscordIcon size={32} />
          </span>
          <div className="discord-intro">
            <p>{t('discord.intro')}</p>
            <div className="discord-join">
              <button className="primary" onClick={join}>
                {t('discord.join')}
              </button>
              <span className="hint">{t('discord.joinHint')}</span>
            </div>
          </div>
        </div>
        <div className="discord-topics">
          {TOPICS.map((id) => (
            <section key={id} className="discord-topic">
              <h2>{t(`discord.topics.${id}.title`)}</h2>
              <p className="muted">{t(`discord.topics.${id}.text`)}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
