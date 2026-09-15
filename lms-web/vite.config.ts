import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.PAGES_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': process.env.VITE_API_TARGET || 'http://127.0.0.1:3001' } },
})
