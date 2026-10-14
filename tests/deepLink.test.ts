// Liens « fivem-pack-manager://pack/<id> » et « …://mod/<id> » du site : seule une adresse de fiche valide est acceptée.
import { describe, expect, it } from 'vitest'
import { describeLink, findDeepLink, parseMarketLink } from '../src/main/core/deepLink'

const ID = '3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c'

describe('findDeepLink', () => {
  it('trouve le lien dans la ligne de commande', () => {
    expect(findDeepLink(['C:\app\Reflect FiveM.exe', `fivem-pack-manager://pack/${ID}`])).toBe(`fivem-pack-manager://pack/${ID}`)
    expect(findDeepLink(['C:\app\Reflect FiveM.exe', `fivem-pack-manager://mod/${ID}`])).toBe(`fivem-pack-manager://mod/${ID}`)
    // second-instance : Chromium ajoute ses propres options avant le lien.
    expect(findDeepLink(['electron.exe', '--allow-file-access-from-files', 'D:\app', `FIVEM-PACK-MANAGER://pack/${ID}`])).toBe(
      `FIVEM-PACK-MANAGER://pack/${ID}`
    )
  })

  it('ignore une ligne de commande sans lien', () => {
    expect(findDeepLink(['app.exe'])).toBeNull()
    expect(findDeepLink(['app.exe', 'https://reflect-fivem.com/', 'fivem-pack-manager:pack'])).toBeNull()
  })
})

describe('parseMarketLink', () => {
  it('accepte une fiche de pack', () => {
    const pack = { kind: 'pack', id: ID }
    expect(parseMarketLink(`fivem-pack-manager://pack/${ID}`)).toEqual(pack)
    expect(parseMarketLink(`fivem-pack-manager://pack/${ID}/`)).toEqual(pack)
    expect(parseMarketLink(`fivem-pack-manager://PACK/${ID.toUpperCase()}`)).toEqual(pack)
    expect(parseMarketLink(`fivem-pack-manager://pack/${ID}?source=site#x`)).toEqual(pack)
  })

  it('accepte une fiche de mod', () => {
    const mod = { kind: 'mod', id: ID }
    expect(parseMarketLink(`fivem-pack-manager://mod/${ID}`)).toEqual(mod)
    expect(parseMarketLink(`fivem-pack-manager://mod/${ID}/`)).toEqual(mod)
    expect(parseMarketLink(`fivem-pack-manager://MOD/${ID.toUpperCase()}`)).toEqual(mod)
    expect(parseMarketLink(`fivem-pack-manager://mod/${ID}?source=site#x`)).toEqual(mod)
  })

  it('refuse toute autre adresse', () => {
    for (const host of ['pack', 'mod'])
      for (const link of [
        `fivem-pack-manager://${host}/`,
        `fivem-pack-manager://${host}/bh-1960`,
        `fivem-pack-manager://${host}/${ID}x`,
        `fivem-pack-manager://${host}/${ID}/install`,
        `fivem-pack-manager://${host}//${ID}`,
        `fivem-pack-manager://${host}/..%2F${ID}`,
        `fivem-pack-manager://${host}:8080/${ID}`,
        `fivem-pack-manager://user:pass@${host}/${ID}`,
        `fivem-pack-manager:${host}/${ID}`,
        `https://${host}/${ID}`,
        `fivem-pack-manager://${host}/${ID} --inspect`,
        `fivem-pack-manager://${host}/C:\Windows\System32\cmd.exe`
      ])
        expect(parseMarketLink(link), link).toBeNull()
    for (const link of [
      `fivem-pack-manager://author/${ID}`,
      `fivem-pack-manager://mods/${ID}`,
      `fivem-pack-manager://packs/${ID}`,
      `fivem-pack-manager://pack.mod/${ID}`,
      `fivem-pack-manager:///mod/${ID}`,
      'pas une adresse'
    ])
      expect(parseMarketLink(link), link).toBeNull()
  })
})

describe('describeLink', () => {
  it('raccourcit et garde une seule ligne', () => {
    expect(describeLink('fivem-pack-manager://pack/a\nb')).not.toContain('\n')
    expect(describeLink(`fivem-pack-manager://${'a'.repeat(500)}`).length).toBeLessThan(210)
  })
})
