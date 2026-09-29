import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// `npm run dev`       → http://localhost:5173 (PC 파일 테스트용)
// `npm run dev:phone` → https://<PC IP>:5173 (같은 와이파이의 폰에서 카메라 사용)
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode === 'phone' && basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '재고 체크 카메라',
        short_name: '재고체크',
        lang: 'ko',
        display: 'standalone',
        background_color: '#111111',
        theme_color: '#111111',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,wasm,gz}'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
      },
    }),
  ].filter(Boolean),
  server: { host: mode === 'phone' },
}))
