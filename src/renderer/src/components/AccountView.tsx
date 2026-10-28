import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccountMe, AccountProfile, ProfileInput, ProfileLink, ServerTagProgress, ServerTagStatus } from '@shared/types'
import { formatDuration } from '@shared/intl'
import { nextCreditProgress, rewardState } from '@shared/serverTag'
import { apiError, cleanError, useStore } from '../store'
import { longDate, num, q } from '../lib/format'
import { Avatar } from './common'
import { confirmDialog } from './Confirm'
import { DiscordIcon } from './DiscordView'
import { notifyBilling, PurchaseList } from './Purchase'

const BIO_MAX = 2000
const LINKS_MAX = 8
/** Temps avec le tag du serveur Discord relu chaque minute tant que la fenêtre est visible. */
const SERVER_TAG_REFRESH = 60_000

/** Compte reflect-fivem.com : connexion, puis profil public, mot de passe et déconnexion. */
export function AccountView({
  onOpenAuthor,
  onBack,
  backTo = 'pack'
}: {
  onOpenAuthor: (slug: string) => void
  onBack?: () => void
  backTo?: 'pack' | 'builder'
}) {
  const { t } = useTranslation()
  const { account } = useStore()
  return (
    <div className="page">
      {/* Connexion demandée depuis la fiche d'un pack ou « Créer ton pack » : on peut y revenir sans se connecter. */}
      {onBack && (
        <div className="back-row">
          <button className="link" onClick={onBack}>
            {t(backTo === 'builder' ? 'accountView.backToBuilder' : 'accountView.backToPack')}
          </button>
        </div>
      )}
      <header className="page-head">
        <h1>{t('accountView.title')}</h1>
      </header>
      {account === undefined ? null : !account ? (
        <SignIn />
      ) : account.mustChangePassword ? (
        <ForcedPassword me={account} />
      ) : (
        <Profile me={account} onOpenAuthor={onOpenAuthor} />
      )}
    </div>
  )
}

/** Erreur d'un formulaire (message de l'API). */
function FormError({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <div className="bar bar-error form-error" role="alert">
      <span className="bar-text">{text}</span>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

// ------------------------------------------------------------------ connexion

function SignIn() {
  const { t } = useTranslation()
  const { setAccount } = useStore()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState<'form' | 'google' | 'discord' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const discordApp = useDiscordApp()

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy('form')
    setError(null)
    try {
      setAccount(mode === 'login' ? await window.api.accountLogin(email, password) : await window.api.accountRegister(email, password, displayName))
    } catch (err) {
      setError(cleanError(err))
      setBusy(null)
    }
  }
  /** Connexion dans le navigateur (Google ou Discord, ou l'application Discord). */
  const browser = async (provider: 'google' | 'discord'): Promise<void> => {
    setBusy(provider)
    setError(null)
    if (provider === 'discord') discordApp.check()
    try {
      setAccount(await (provider === 'google' ? window.api.accountLoginGoogle() : window.api.accountLoginDiscord()))
    } catch (err) {
      setError(cleanError(err))
      setBusy(null)
    }
  }
  const switchMode = (m: 'login' | 'register'): void => {
    setMode(m)
    setError(null)
  }

  const submitLabel = (): string => {
    if (busy === 'form') return mode === 'login' ? t('accountView.signIn.loggingIn') : t('accountView.signIn.registering')
    return mode === 'login' ? t('accountView.signIn.login') : t('accountView.signIn.submitRegister')
  }

  return (
    <div className="auth">
      <p className="muted auth-intro">{t('accountView.signIn.intro')}</p>

      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-selected' : ''} onClick={() => switchMode('login')}>
          {t('accountView.signIn.login')}
        </button>
        <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-selected' : ''} onClick={() => switchMode('register')}>
          {t('accountView.signIn.register')}
        </button>
      </div>

      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <Field label={t('accountView.fields.email')}>
          <input className="input" type={mode === 'login' ? 'text' : 'email'} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        {mode === 'register' && (
          <Field label={t('accountView.fields.displayName')} hint={t('accountView.fields.displayNameHint')}>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={2} maxLength={40} required />
          </Field>
        )}
        <Field label={t('accountView.fields.password')} hint={mode === 'register' ? t('accountView.fields.passwordHint') : undefined}>
          <input
            className="input"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'register' ? 8 : undefined}
            maxLength={128}
            required
          />
        </Field>
        <FormError text={error} />
        <button type="submit" className="primary wide" disabled={!!busy}>
          {submitLabel()}
        </button>
      </form>

      <div className="divider">{t('accountView.signIn.or')}</div>

      <div className="auth-providers">
        {busy === 'google' ? (
          <BrowserWait text={t('accountView.signIn.googleWait')} onCancel={() => void window.api.accountCancelGoogle()} />
        ) : (
          <button className="wide google" onClick={() => void browser('google')} disabled={!!busy}>
            <GoogleLogo />
            {t('accountView.signIn.google')}
          </button>
        )}
        {busy === 'discord' ? (
          <BrowserWait
            text={discordApp.inApp ? t('account.discord.appWait') : t('account.discord.wait')}
            onCancel={() => void window.api.accountCancelDiscord()}
            onBrowser={discordApp.inApp ? discordApp.toBrowser : undefined}
          />
        ) : (
          <button className="wide discord-brand" onClick={() => void browser('discord')} disabled={!!busy}>
            <DiscordIcon size={18} />
            {t('accountView.signIn.discord')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Attente du retour d'une page ouverte dans le navigateur (ou l'application Discord : `onBrowser`), avec « Annuler ». */
function BrowserWait({ text, onCancel, onBrowser }: { text: string; onCancel: () => void; onBrowser?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="browser-wait">
      <span>{text}</span>
      <span className="browser-wait-actions">
        {onBrowser && (
          <button className="link" onClick={onBrowser}>
            {t('account.discord.openInBrowser')}
          </button>
        )}
        <button className="link" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </span>
    </div>
  )
}

/**
 * Application Discord ouverte sur ce PC : la page d'autorisation Discord s'y affiche au lieu du navigateur. Lu à
 * l'affichage et à chaque essai (`check`) ; `toBrowser` rouvre la page en attente dans le navigateur.
 */
function useDiscordApp(): { inApp: boolean; check: () => void; toBrowser: () => void } {
  const [inApp, setInApp] = useState(false)
  const check = useCallback((): void => {
    window.api.accountDiscordApp().then(setInApp, () => setInApp(false))
  }, [])
  useEffect(check, [check])
  const toBrowser = (): void => {
    setInApp(false)
    void window.api.accountDiscordInBrowser()
  }
  return { inApp, check, toBrowser }
}

/**
 * Temps avec le tag du serveur Discord : lu à l'affichage, chaque minute tant que la fenêtre est visible, et par
 * `reload` (liaison ou retrait). Échec (hors ligne, maintenance...) : null, le bloc est masqué sans erreur.
 */
function useServerTag(): { status: ServerTagStatus | null; reload: () => void } {
  const [status, setStatus] = useState<ServerTagStatus | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((a) => a + 1), [])
  useEffect(() => {
    let live = true
    const read = (): void => {
      window.api.accountServerTag().then(
        (s) => live && setStatus(s),
        () => live && setStatus(null)
      )
    }
    read()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') read()
    }, SERVER_TAG_REFRESH)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [attempt])
  return { status, reload }
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

// ------------------------------------------------------------------ mot de passe

function PasswordForm({ me, onDone }: { me: AccountMe; onDone?: () => void }) {
  const { t } = useTranslation()
  const { setMessage } = useStore()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (next !== confirm) return setError(t('accountView.password.mismatch'))
    setBusy(true)
    setError(null)
    try {
      await window.api.accountChangePassword(me.hasPassword ? current : null, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setMessage({ kind: 'info', text: me.hasPassword ? t('accountView.password.changed') : t('accountView.password.added') })
      onDone?.()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form-panel" onSubmit={(e) => void submit(e)}>
      {!me.hasPassword && (
        <p className="muted">{!me.googleLinked && me.discordLinked ? t('accountView.password.discordOnly') : t('accountView.password.googleOnly')}</p>
      )}
      {me.hasPassword && (
        <Field label={t('accountView.password.current')}>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
      )}
      <div className="field-pair">
        <Field label={t('accountView.password.new')} hint={t('accountView.fields.passwordHint')}>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} maxLength={128} required />
        </Field>
        <Field label={t('accountView.password.confirm')}>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={128} required />
        </Field>
      </div>
      <FormError text={error} />
      <div className="form-actions">
        {me.hasPassword && <span className="hint">{t('accountView.password.othersSignedOut')}</span>}
        <div className="spacer" />
        <button type="submit" className="primary" disabled={busy}>
          {me.hasPassword ? t('accountView.password.change') : t('accountView.password.add')}
        </button>
      </div>
    </form>
  )
}

function LogoutButton() {
  const { t } = useTranslation()
  const { run } = useStore()
  return <button onClick={() => void run(() => window.api.accountLogout())}>{t('accountView.logout')}</button>
}

/** Mot de passe imposé (initial ou fixé par l'administrateur) : à changer avant tout le reste. */
function ForcedPassword({ me }: { me: AccountMe }) {
  const { t } = useTranslation()
  return (
    <div className="account">
      <AccountHead me={me} actions={<LogoutButton />} />
      <div className="bar bar-warning form-error">
        <span className="bar-text">{t('accountView.password.forced')}</span>
      </div>
      <PasswordForm me={me} />
    </div>
  )
}

// ------------------------------------------------------------------ profil

function AccountHead({ me, actions }: { me: AccountMe; actions?: ReactNode }) {
  const { t } = useTranslation()
  const badges = [
    me.admin && t('accountView.badges.admin'),
    me.canPublish && t('accountView.badges.author'),
    me.canPublishMods && !me.admin && t('accountView.badges.modAuthor'),
    me.googleLinked && 'Google',
    me.discordLinked && 'Discord'
  ].filter(Boolean) as string[]
  return (
    <div className="profile-head">
      <Avatar url={me.avatarUrl} name={me.displayName} size={72} />
      <div className="profile-id">
        <div className="profile-name">{me.displayName}</div>
        <div className="muted ellipsis">{me.email ?? me.username}</div>
        {badges.length > 0 && (
          <div className="badges">
            {badges.map((b) => (
              <span key={b} className="badge">
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

/** Comptes liés : Discord (photo, nom, @username), lié dans le navigateur (ou l'application Discord) ou retiré. */
function LinkedAccounts({ me, onChoosePassword }: { me: AccountMe; onChoosePassword: () => void }) {
  const { t } = useTranslation()
  const { setMessage } = useStore()
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null)
  /** `noPassword` : retrait refusé (409), le compte n'aurait plus aucun moyen de connexion. */
  const [error, setError] = useState<{ text: string; noPassword: boolean } | null>(null)
  const discordApp = useDiscordApp()
  const serverTag = useServerTag()
  const discord = me.discordLinked ? me.discord : null
  const discordName = discord ? (discord.displayName ?? discord.username) : ''

  const link = async (): Promise<void> => {
    setBusy('link')
    setError(null)
    discordApp.check()
    try {
      await window.api.accountLinkDiscord()
      setMessage({ kind: 'info', text: t('accountView.linked.linked') })
      // Crédits déjà gagnés avec le tag donnés à la liaison : temps et crédits « Créer ton pack » relus.
      serverTag.reload()
      notifyBilling()
    } catch (err) {
      setError({ text: cleanError(err), noPassword: false })
    } finally {
      setBusy(null)
    }
  }
  const unlink = async (): Promise<void> => {
    const ok = await confirmDialog(t('accountView.linked.unlinkTitle'), t('accountView.linked.unlinkDetail', { name: q(discordName) }), t('accountView.linked.unlink'))
    if (!ok) return
    setBusy('unlink')
    setError(null)
    try {
      await window.api.accountUnlinkDiscord()
      setMessage({ kind: 'info', text: t('accountView.linked.unlinked') })
      serverTag.reload()
    } catch (err) {
      const e = apiError(err)
      setError({ text: e.message, noPassword: e.status === 409 && !me.hasPassword })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="linked">
      <ul className="list">
        <li className="row">
          {discord ? (
            <Avatar url={discord.avatarUrl} name={discordName} size={32} />
          ) : (
            <span className="linked-logo discord-brand">
              <DiscordIcon size={18} />
            </span>
          )}
          <div className="row-main">
            <div className="name">{discord ? discordName : 'Discord'}</div>
            <div className="meta">
              {busy === 'link'
                ? discordApp.inApp
                  ? t('account.discord.appLinkWait')
                  : t('account.discord.linkWait')
                : discord
                  ? `Discord · @${discord.username}`
                  : t('accountView.linked.discordHelp')}
            </div>
          </div>
          <div className="actions">
            {busy === 'link' ? (
              <>
                {discordApp.inApp && (
                  <button className="link" onClick={discordApp.toBrowser}>
                    {t('account.discord.openInBrowser')}
                  </button>
                )}
                <button className="link" onClick={() => void window.api.accountCancelDiscord()}>
                  {t('common.cancel')}
                </button>
              </>
            ) : discord ? (
              <button onClick={() => void unlink()} disabled={!!busy}>
                {t('accountView.linked.unlink')}
              </button>
            ) : (
              <button className="discord-brand" onClick={() => void link()} disabled={!!busy}>
                <DiscordIcon size={16} />
                {t('accountView.linked.link')}
              </button>
            )}
          </div>
        </li>
        <ServerTagRow status={serverTag.status} />
      </ul>
      {error && (
        <div className="bar bar-error form-error" role="alert">
          <span className="bar-text">{error.text}</span>
          {error.noPassword && <button onClick={onChoosePassword}>{t('accountView.linked.choosePassword')}</button>}
        </div>
      )}
    </div>
  )
}

/** Badge du tag de serveur, affiché à côté du nom sur Discord. */
function ServerTagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 4v6.6a2 2 0 0 0 .6 1.4l8 8a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8l-8-8A2 2 0 0 0 10.6 3H4a1 1 0 0 0-1 1Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  )
}

/** Coche du crédit obtenu. */
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  )
}

/**
 * Tag du serveur Reflect, sous la ligne Discord. Compte Discord lié : tag affiché ou non, puis le crédit « Créer ton
 * pack » qu'il rapporte (un seul aujourd'hui, voir OneCredit) et le temps cumulé avec le tag. Pas lié : ce que le tag
 * rapporte. Dans les deux cas, un bouton pour rejoindre le serveur Discord. Rien quand la récompense est désactivée ou
 * que l'état n'a pas pu être lu.
 */
function ServerTagRow({ status }: { status: ServerTagStatus | null }) {
  const { t } = useTranslation()
  const { links, openLink } = useStore()
  if (!status?.enabled) return null
  const logo = (
    <span className="linked-logo server-tag-logo">
      <ServerTagIcon />
    </span>
  )
  const join = links.discord ? (
    <div className="actions">
      <button onClick={() => openLink('discord')}>{t('accountView.serverTag.join')}</button>
    </div>
  ) : null
  const p = status.progress
  if (!p) {
    const every = status.creditEverySeconds
    return (
      <li className="row top server-tag">
        {logo}
        <div className="row-main">
          <div className="name">{t('accountView.serverTag.title')}</div>
          <div className="meta meta-wrap">
            {every ? t('accountView.serverTag.unlinkedEvery', { duration: formatDuration(every, 'long') }) : t('accountView.serverTag.unlinked')}
          </div>
        </div>
        {join}
      </li>
    )
  }

  const state = !p.wearing
    ? t('accountView.serverTag.notWearing')
    : p.wearingSince
      ? t('accountView.serverTag.wearingSince', { date: longDate(p.wearingSince) })
      : t('accountView.serverTag.wearing')
  return (
    <li className="row top server-tag">
      {logo}
      <div className="row-main">
        <div className="name">{t('accountView.serverTag.title')}</div>
        <div className={`meta server-tag-state ${p.wearing ? 'is-on' : ''}`}>{state}</div>
        {p.maxCredits === 1 ? <OneCredit p={p} /> : <Credits p={p} />}
        {!p.wearing && <div className="meta meta-wrap">{t('accountView.serverTag.help')}</div>}
      </div>
      {join}
    </li>
  )
}

/** Barre d'avancée vers le crédit, avec le temps de tag qui manque à côté. */
function ServerTagBar({ progress, label, remaining }: { progress: number; label: string; remaining: string }) {
  return (
    <div className="server-tag-progress">
      <div className="track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <div className="fill" style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="meta">{remaining}</span>
    </div>
  )
}

/**
 * Un seul crédit (maxCredits 1, la règle de l'API) : l'objectif et l'avancée tant qu'il n'est pas gagné, puis le
 * crédit obtenu. Le temps cumulé avec le tag est encore compté, seulement pour être affiché : c'est alors
 * l'information principale du bloc.
 */
function OneCredit({ p }: { p: ServerTagProgress }) {
  const { t } = useTranslation()
  const reward = rewardState(p)
  const total = formatDuration(p.totalSeconds)
  if (reward === 'earning') {
    const progress = nextCreditProgress(p)
    return (
      <>
        <div className="meta meta-wrap">{t('accountView.serverTag.goal', { duration: formatDuration(p.creditEverySeconds, 'long') })}</div>
        {progress !== null && (
          <ServerTagBar
            progress={progress}
            label={t('accountView.serverTag.creditProgress')}
            remaining={t('accountView.serverTag.remaining', { duration: formatDuration(p.nextCreditInSeconds ?? 0) })}
          />
        )}
        <div className="meta">{t('accountView.serverTag.total', { duration: total })}</div>
      </>
    )
  }
  return (
    <>
      <div className="server-tag-total">
        <span className="meta">{t('accountView.serverTag.totalWorn')}</span>
        <span className="server-tag-total-value">{total}</span>
      </div>
      {reward === 'done' ? (
        <div className="meta server-tag-done">
          <CheckIcon />
          {t('accountView.serverTag.creditDone')}
        </div>
      ) : (
        <div className="meta server-tag-waiting">{t('accountView.serverTag.creditWaiting')}</div>
      )}
    </>
  )
}

/** Plusieurs crédits (maxCredits plus de 1) ou sans limite (0) : avancée vers le prochain, crédits gagnés. */
function Credits({ p }: { p: ServerTagProgress }) {
  const { t } = useTranslation()
  const progress = nextCreditProgress(p)
  const earned =
    p.maxCredits > 0
      ? t('accountView.serverTag.earnedOf', { count: p.creditsEarned, n: num(p.creditsEarned), max: num(p.maxCredits) })
      : t('accountView.serverTag.earned', { count: p.creditsEarned, n: num(p.creditsEarned) })
  return (
    <>
      {progress === null ? (
        <div className="server-tag-progress">
          <span className="meta">{t('accountView.serverTag.capped')}</span>
        </div>
      ) : (
        <ServerTagBar
          progress={progress}
          label={t('accountView.serverTag.progress')}
          remaining={t('accountView.serverTag.next', { duration: formatDuration(p.nextCreditInSeconds ?? 0) })}
        />
      )}
      <div className="meta">
        {t('accountView.serverTag.total', { duration: formatDuration(p.totalSeconds) })} · {earned}
      </div>
      {p.creditsWaiting > 0 && <div className="meta server-tag-waiting">{t('accountView.serverTag.waiting', { count: p.creditsWaiting, n: num(p.creditsWaiting) })}</div>}
    </>
  )
}

const toInput = (p: AccountProfile): ProfileInput =>({ displayName: p.displayName, bio: p.bio, links: p.links.map((l) => ({ ...l })) })

function Profile({ me, onOpenAuthor }: { me: AccountMe; onOpenAuthor: (slug: string) => void }) {
  const { t } = useTranslation()
  const { setMessage } = useStore()
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [draft, setDraft] = useState<ProfileInput | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'avatar' | null>(null)
  const passwordRef = useRef<HTMLDivElement>(null)

  /** Retrait de Discord refusé faute d'autre moyen de connexion : vers le formulaire du mot de passe. */
  const choosePassword = (): void => {
    passwordRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    passwordRef.current?.nextElementSibling?.querySelector('input')?.focus({ preventScroll: true })
  }

  const load = useCallback(async () => {
    try {
      const p = await window.api.accountProfile()
      setProfile(p)
      setDraft(toInput(p))
      setLoadError(null)
    } catch (err) {
      setLoadError(cleanError(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const avatar = async (fn: () => Promise<AccountProfile | null>): Promise<void> => {
    setBusy('avatar')
    try {
      const p = await fn()
      if (p) setProfile(p)
    } catch (err) {
      setMessage({ kind: 'error', text: cleanError(err) })
    } finally {
      setBusy(null)
    }
  }

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!draft) return
    setBusy('save')
    setError(null)
    try {
      const p = await window.api.accountSaveProfile(draft)
      setProfile(p)
      setDraft(toInput(p))
      setMessage({ kind: 'info', text: t('accountView.profile.saved') })
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(null)
    }
  }

  const setLink = (i: number, patch: Partial<ProfileLink>): void =>
    setDraft((d) => (d ? { ...d, links: d.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : d))
  const dirty = !!profile && !!draft && JSON.stringify(toInput(profile)) !== JSON.stringify(draft)
  const hasAvatar = !!(profile?.avatarUrl ?? me.avatarUrl)
  const avatarLabel = (): string => {
    if (busy === 'avatar') return t('accountView.profile.uploading')
    return hasAvatar ? t('accountView.profile.changePhoto') : t('accountView.profile.addPhoto')
  }

  return (
    <div className="account">
      <AccountHead
        me={me}
        actions={
          <>
            <button onClick={() => void avatar(() => window.api.accountPickAvatar())} disabled={!!busy}>
              {avatarLabel()}
            </button>
            {hasAvatar && (
              <button onClick={() => void avatar(() => window.api.accountRemoveAvatar())} disabled={!!busy}>
                {t('accountView.profile.removePhoto')}
              </button>
            )}
          </>
        }
      />

      {me.muted && (
        <div className="bar bar-warning form-error">
          <span className="bar-text">{t('accountView.profile.muted')}</span>
        </div>
      )}

      <div className="section-head">
        <h2>{t('accountView.profile.title')}</h2>
        {(me.canPublish || me.canPublishMods) && (
          <div className="head-actions">
            {/* Pas d'espace auteur dans l'application : publication des packs et des mods sur le site. */}
            <button onClick={() => void window.api.openSite('/studio/').catch((e: unknown) => setMessage({ kind: 'error', text: cleanError(e) }))}>
              {t('accountView.profile.publish')}
            </button>
            {me.slug && <button onClick={() => onOpenAuthor(me.slug)}>{t('accountView.profile.authorPage')}</button>}
          </div>
        )}
      </div>
      {loadError ? (
        <div className="form-panel">
          <p className="muted">{loadError}</p>
          <div>
            <button onClick={() => void load()}>{t('common.retry')}</button>
          </div>
        </div>
      ) : !draft ? (
        <p className="muted loading">{t('common.loading')}</p>
      ) : (
        <form className="form-panel" onSubmit={(e) => void save(e)}>
          <Field label={t('accountView.fields.displayName')} hint={t('accountView.fields.displayNameHint')}>
            <input className="input" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} minLength={2} maxLength={40} required />
          </Field>
          <Field label={t('accountView.profile.bio')} hint={`${num(draft.bio.length)} / ${num(BIO_MAX)}`}>
            <textarea className="input" rows={5} value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} maxLength={BIO_MAX} />
          </Field>
          <div className="field">
            <span className="field-label">{t('accountView.profile.links')}</span>
            {draft.links.map((l, i) => (
              <div key={i} className="link-row">
                <input
                  className="input"
                  placeholder={t('accountView.profile.linkLabelPlaceholder')}
                  aria-label={t('accountView.profile.linkLabel')}
                  value={l.label}
                  maxLength={40}
                  onChange={(e) => setLink(i, { label: e.target.value })}
                />
                <input className="input" placeholder="https://…" aria-label={t('accountView.profile.linkUrl')} value={l.url} maxLength={300} onChange={(e) => setLink(i, { url: e.target.value })} />
                <button
                  type="button"
                  className="close"
                  aria-label={t('accountView.profile.removeLink')}
                  title={t('accountView.profile.removeLink')}
                  onClick={() => setDraft({ ...draft, links: draft.links.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button type="button" onClick={() => setDraft({ ...draft, links: [...draft.links, { label: '', url: '' }] })} disabled={draft.links.length >= LINKS_MAX}>
                {t('accountView.profile.addLink')}
              </button>
              {draft.links.length >= LINKS_MAX && <span className="hint inline">{t('accountView.profile.linksMax', { n: num(LINKS_MAX) })}</span>}
            </div>
          </div>
          <FormError text={error} />
          <div className="form-actions">
            <div className="spacer" />
            {dirty && (
              <button type="button" onClick={() => profile && setDraft(toInput(profile))}>
                {t('accountView.profile.discard')}
              </button>
            )}
            <button type="submit" className="primary" disabled={!dirty || busy === 'save'}>
              {t('common.save')}
            </button>
          </div>
        </form>
      )}

      <div className="section-head" ref={passwordRef}>
        <h2>{t('accountView.fields.password')}</h2>
      </div>
      <PasswordForm me={me} />

      <div className="section-head">
        <h2>{t('accountView.linked.title')}</h2>
      </div>
      <LinkedAccounts me={me} onChoosePassword={choosePassword} />

      {/* Tous les achats : packs et mods payants du catalogue, et « Créer ton pack ». */}
      <div className="section-head">
        <h2>{t('accountView.purchases.title')}</h2>
      </div>
      <PurchaseList />

      <div className="section-head">
        <h2>{t('accountView.session.title')}</h2>
      </div>
      <ul className="list">
        <li className="row">
          <div className="row-main">
            <div className="name">{t('accountView.session.device')}</div>
            <div className="meta">{t('accountView.session.deviceHelp')}</div>
          </div>
          <div className="actions">
            <LogoutButton />
          </div>
        </li>
      </ul>
    </div>
  )
}
