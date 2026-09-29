// 라벨 OCR (tesseract.js) + 형식 필터
import { createWorker, createScheduler, PSM } from 'tesseract.js'

export const OCR_PARAMS = {
  minLabelW: 60, // 원본 좌표 기준. 이보다 작으면 OCR 시도 안 함
  minConf: 80, // tesseract 신뢰도(0~100). run.py의 0.8과 동일
  cropH: 64, // OCR 입력 높이로 정규화
}

const LABEL_RE = /^A-(\d{1,2})-(\d{1,2})$/

let scheduler = null
let readyPromise = null

export function initOcr(nWorkers = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1))) {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    scheduler = createScheduler()
    const workers = await Promise.all(
      Array.from({ length: nWorkers }, async () => {
        const w = await createWorker('eng', 1)
        await w.setParameters({
          tessedit_char_whitelist: 'A0123456789-',
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
      const m = LABEL_RE.exec(text)
      const ok = m && conf >= p.minConf
      return {
        text,
        conf,
        row: ok ? +m[1] : null,
        col: ok ? +m[2] : null,
      }
    }),
  )
}
