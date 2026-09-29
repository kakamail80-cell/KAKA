import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'node:fs'
import path from 'node:path'

// 개발 전용: 브라우저에서 만든 시연 영상을 작업 폴더에 저장 (POST /__save?name=파일명)
const devSave = () => ({
  name: 'dev-save',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      if (req.method !== 'POST') return (res.statusCode = 405), res.end()
      const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') || 'output.bin')
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        fs.writeFileSync(path.join(server.config.root, name), Buffer.concat(chunks))
        res.end(name)
      })
    })
  },
})

// `npm run dev`       → http://localhost:5173 (PC 파일 테스트용)
// `npm run dev:phone` → https://<PC IP>:5173 (같은 와이파이의 폰에서 카메라 사용)
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    devSave(),
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
  server: {
    host: mode === 'phone',
    // 구글 드라이브 폴더는 파일 변경 알림이 누락되는 경우가 있어 주기적으로 확인
    watch: { usePolling: true, interval: 500 },
  },
}))
