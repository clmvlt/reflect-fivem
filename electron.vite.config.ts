import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
    // Serveur de dev (npm run dev et devprod) sur 5180 : le 5173 est celui du site (Vite), lancé en même temps.
    // strictPort : erreur plutôt qu'un autre port pris au hasard.
    server: { port: 5180, strictPort: true },
    // Code de l'interface réduit : moins de JavaScript à lire au démarrage.
    build: { minify: true }
  }
})
