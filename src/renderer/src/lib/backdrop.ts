// Fonds dessinés des thèmes (AuroraSky) : ce qu'ils partagent.

import { useEffect, useState } from 'react'

/** Fenêtre au premier plan. Sinon (FiveM au premier plan...), les animations du fond s'arrêtent : rien à calculer. */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  return focused
}
