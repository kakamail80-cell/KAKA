// 라벨 OCR (tesseract.js) + 형식 필터
import { createWorker, createScheduler, PSM } from 'tesseract.js'

export const OCR_PARAMS = {
  // 원본 좌표 기준. 이보다 작으면 OCR 시도 안 함 (4K 벽 전체 거리에서 라벨 폭 ≈ 51~54px, 사람 눈으로 판독 가능)
  minLabelW: 40,
  // tesseract 신뢰도(0~100). 이 라벨에서는 맞게 읽어도 0이 자주 나와 신뢰도 대신 격자 일치(RANSAC)로 오판독을 거른다
  minConf: 0,
  cropH: 64, // OCR 입력 높이로 정규화
}

// 라벨 인쇄 형식: A-행-열, 열은 항상 두 자리(A-5-05). 멀리서는 하이픈이 점처럼 작아 OCR이 자주 빠뜨리므로
// 하이픈을 지운 뒤 "A + 숫자 3~4자리" → 끝 두 자리 = 열, 앞 = 행 으로 해석한다
// 패널 글자도 읽어서 패널별로 격자를 따로 맞춘다 (패널 경계 너머로 번호가 번지는 것 방지).
// 인식 글자는 조사 대상에 나오는 패널만 허용 (글자 후보가 많으면 0→O, 8→B 같은 오판독이 늘어남)
let panelLetters = 'ABCD'
export function parseLabel(text) {
  const t = text.replace(/[\s-]+/g, '')
  const m = /^([A-Z])(\d{1,2})(\d{2})$/.exec(t)
  if (!m || !panelLetters.includes(m[1])) return null
  const row = +m[2], col = +m[3]
  if (row < 1 || col < 1) return null
  return { panel: m[1], row, col }
}

let scheduler = null
let readyPromise = null
let workers = []

/** 조사 대상 패널 글자 설정 (예: ['A','B','H']) */
export async function setPanels(letters) {
  const next = [...new Set(letters.length ? letters : ['A', 'B', 'C', 'D'])].sort().join('')
  if (next === panelLetters) return
  panelLetters = next
  await initOcr()
  await Promise.all(workers.map((w) => w.setParameters({ tessedit_char_whitelist: panelLetters + '0123456789-' })))
}

export function initOcr(nWorkers = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1))) {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    scheduler = createScheduler()
    workers = await Promise.all(
      Array.from({ length: nWorkers }, async () => {
        const w = await createWorker('eng', 1)
        await w.setParameters({
          tessedit_char_whitelist: panelLetters + '0123456789-',
          tessedit_pageseg_mode: PSM.SINGLE_LINE,
        })
        return w
      }),
    )
    workers.forEach((w) => scheduler.addWorker(w))
    return nWorkers
  })()
  return readyPromise
}

/** 라벨 박스 → 흑백 이진화 + 여백을 준 OCR 입력 캔버스 */
function makeCrop(src, box, p) {
  // 라벨 테두리 그림자를 피하려고 안쪽으로 약간 줄여서 자른다
  const ix = box.w * 0.03, iy = box.h * 0.08
  const sx = box.x + ix, sy = box.y + iy, sw = box.w - 2 * ix, sh = box.h - 2 * iy
  const h = p.cropH
  const w = Math.round((sw / sh) * h)
  const pad = 16
  const c = document.createElement('canvas')
  c.width = w + pad * 2
  c.height = h + pad * 2
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, pad, pad, w, h)

  // 회색조 + Otsu 이진화
  const img = ctx.getImageData(pad, pad, w, h)
  const d = img.data
  const hist = new Uint32Array(256)
  const gray = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const g = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8
    gray[i] = g
    hist[g]++
  }
  const total = gray.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = 0, thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      thr = t
    }
  }
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const v = gray[i] > thr ? 255 : 0
    d[j] = d[j + 1] = d[j + 2] = v
  }
  ctx.putImageData(img, pad, pad)
  return c
}

/**
 * 폭이 충분한 라벨만 OCR. 형식·신뢰도 통과한 것만 row/col 부여
 * @returns {Promise<Array<{text:string,conf:number,row:number|null,col:number|null}|null>>}
 */
export async function readLabels(src, boxes, p = OCR_PARAMS) {
  await initOcr()
  return Promise.all(
    boxes.map(async (b) => {
      if (b.w < p.minLabelW) return null
      const crop = makeCrop(src, b, p)
      const { data } = await scheduler.addJob('recognize', crop)
      const text = (data.text || '').replace(/\s+/g, '')
      const conf = data.confidence
      const m = parseLabel(text)
      const ok = m && conf >= p.minConf
      return {
        text,
        conf,
        panel: ok ? m.panel : null,
        row: ok ? m.row : null,
        col: ok ? m.col : null,
      }
    }),
  )
}
