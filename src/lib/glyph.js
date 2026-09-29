// 이 라벨 전용 글자 인식기 (tesseract 대체)
// 라벨은 글꼴이 하나로 고정되고 글자가 [A-Z] 패널 1자 + 숫자 + 하이픈뿐이라,
// 글자를 한 자씩 떼어내 학습한 글자 모양(견본)과 가장 닮은 것을 고르는 방식으로 충분하다.
// 견본은 4K 샘플 영상에서 격자로 번호가 확인된 라벨들로 자동 수집 (학습: window.__glyphTrain, 개발 모드)

export const GW = 12, GH = 20 // 글자 정규화 크기
const CROP_H = 48 // 라벨 정규화 높이

let work = null
function canvas2d(w, h) {
  if (!work) work = document.createElement('canvas')
  work.width = w
  work.height = h
  return work.getContext('2d', { willReadFrequently: true })
}

/** 라벨 → 회색조 배열 + Otsu 이진화(글자=1) */
function labelImage(src, box) {
  const ix = box.w * 0.03, iy = box.h * 0.08
  const sx = box.x + ix, sy = box.y + iy, sw = box.w - 2 * ix, sh = box.h - 2 * iy
  const H = CROP_H
  const W = Math.max(8, Math.round((sw / sh) * H))
  const ctx = canvas2d(W, H)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H)
  const d = ctx.getImageData(0, 0, W, H).data
  const n = W * H
  const gray = new Float32Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8
    gray[i] = g
    hist[g]++
  }
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = 0, thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const bt = wB * wF * (mB - mF) * (mB - mF)
    if (bt > best) {
      best = bt
      thr = t
    }
  }
  const ink = new Uint8Array(n)
  for (let i = 0; i < n; i++) ink[i] = gray[i] < thr ? 1 : 0
  return { W, H, gray, ink, thr }
}

/** 글자 덩어리 분리: 연결 성분 → 테두리에 닿은 것 제거 → 글자/하이픈 분류 */
export function segment(src, box) {
  const img = labelImage(src, box)
  const { W, H, ink } = img
  const lab = new Int32Array(W * H)
  const comps = []
  const stack = []
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || lab[s]) continue
    const id = comps.length + 1
    let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0
    lab[s] = id
    stack.push(s)
    while (stack.length) {
      const q = stack.pop()
      const x = q % W, y = (q / W) | 0
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const r = yy * W + xx
          if (ink[r] && !lab[r]) {
            lab[r] = id
            stack.push(r)
          }
        }
      }
    }
    comps.push({ id, x0, y0, x1, y1, area, w: x1 - x0 + 1, h: y1 - y0 + 1 })
  }
  // 검출 박스가 실제 라벨보다 넓어 옆 서랍 내용물(검은 덩어리)이 섞이므로,
  // "높이가 비슷하고 한 줄로 나란한 덩어리 무리"만 글자로 인정한다 (가장자리에 닿은 글자도 허용)
  const inner = comps.filter((c) => c.area >= 6 && c.h < H * 0.95 && c.w < W * 0.5)
  const cands = inner.filter((c) => c.h >= H * 0.25 && c.w <= c.h * 1.6)
  let bestRun = []
  for (const seed of cands) {
    const yc = (seed.y0 + seed.y1) / 2
    const grp = cands
      .filter((c) => Math.abs((c.y0 + c.y1) / 2 - yc) < seed.h * 0.25 && c.h > seed.h * 0.75 && c.h < seed.h * 1.33)
      .sort((a, b) => a.x0 - b.x0)
    // x 간격이 글자 높이의 1.8배를 넘으면 다른 무리로 끊는다
    let run = []
    for (const c of grp) {
      if (run.length && c.x0 - run[run.length - 1].x1 > seed.h * 1.8) {
        if (run.length > bestRun.length) bestRun = run
        run = []
      }
      run.push(c)
    }
    if (run.length > bestRun.length) bestRun = run
  }
  const parts = bestRun.map((c) => ({ ...c, kind: 'char' }))
  if (parts.length) {
    const charH = parts.map((c) => c.h).sort((a, b) => a - b)[parts.length >> 1]
    const yc = parts.reduce((s, c) => s + (c.y0 + c.y1) / 2, 0) / parts.length
    const xa = parts[0].x0, xb = parts[parts.length - 1].x1
    for (const c of inner) {
      const cy = (c.y0 + c.y1) / 2
      if (c.x0 > xa && c.x1 < xb && c.h <= charH * 0.45 && c.w >= c.h * 1.1 && Math.abs(cy - yc) < charH * 0.3)
        parts.push({ ...c, kind: 'hyphen' })
    }
  }
  parts.sort((a, b) => a.x0 - b.x0)
  // 붙어 버린 두 글자(가로로 너무 넓은 덩어리)는 반으로 나눈다
  const cw = parts.filter((p) => p.kind === 'char').map((p) => p.w).sort((a, b) => a - b)
  const medW = cw.length ? cw[cw.length >> 1] : H * 0.3
  const out = []
  for (const p of parts) {
    // 숫자 폭은 높이의 약 0.7배 → 높이보다 넓고 보통 글자보다 1.3배 넓으면 두 글자가 붙은 것
    if (p.kind === 'char' && p.w > medW * 1.3 && p.w > p.h * 1.05) {
      const half = Math.round(p.w / 2)
      out.push({ ...p, x1: p.x0 + half - 1, w: half, split: true })
      out.push({ ...p, x0: p.x0 + half, w: p.w - half, split: true })
    } else out.push(p)
  }
  return { img, parts: out, lab }
}

/** 글자 1개 → GW×GH 특징 벡터 (가로세로 비율 유지·가운데 정렬, 평균 0·길이 1로 정규화)
 *  비율을 유지해야 '1'처럼 가는 글자가 늘어나 다른 숫자와 헷갈리지 않는다 */
export function featurize(img, p) {
  const { W, H, gray, thr } = img
  const v = new Float32Array(GW * GH)
  const bw = p.x1 - p.x0 + 1, bh = p.y1 - p.y0 + 1
  let sf = GH / bh // 높이를 칸에 맞춤
  if (bw * sf > GW) sf = GW / bw // 너무 넓으면 폭에 맞춤
  const gw = bw * sf, gh = bh * sf
  const ox = (GW - gw) / 2, oy = (GH - gh) / 2
  const inkAt = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0
    const g = gray[y * W + x]
    return g < thr ? 1 : Math.max(0, 1 - (g - thr) / 60)
  }
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      // 격자 칸 → 원본 좌표 영역 평균
      const xa = p.x0 + (gx - ox) / sf, xb = p.x0 + (gx + 1 - ox) / sf
      const ya = p.y0 + (gy - oy) / sf, yb = p.y0 + (gy + 1 - oy) / sf
      if (xb <= p.x0 || xa >= p.x1 + 1 || yb <= p.y0 || ya >= p.y1 + 1) continue
      let s = 0, n = 0
      for (let y = Math.floor(Math.max(ya, p.y0)); y < Math.max(Math.floor(Math.max(ya, p.y0)) + 1, Math.ceil(Math.min(yb, p.y1 + 1))); y++) {
        for (let x = Math.floor(Math.max(xa, p.x0)); x < Math.max(Math.floor(Math.max(xa, p.x0)) + 1, Math.ceil(Math.min(xb, p.x1 + 1))); x++) {
          s += inkAt(x, y)
          n++
        }
      }
      v[gy * GW + gx] = n ? s / n : 0
    }
  }
  let m = 0
  for (const x of v) m += x
  m /= v.length
  let norm = 0
  for (let i = 0; i < v.length; i++) {
    v[i] -= m
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

let model = null // { classes: { '0': [vec, ...], 'A': [...] } }
export function setGlyphModel(m) {
  model = m && {
    classes: Object.fromEntries(Object.entries(m.classes).map(([k, vs]) => [k, vs.map((x) => Float32Array.from(x))])),
  }
}
export const hasGlyphModel = () => !!model

function classify(vec, allowed) {
  let best = null, second = -1
  for (const [k, list] of Object.entries(model.classes)) {
    if (!allowed(k)) continue
    let s = -1
    for (const t of list) {
      let dot = 0
      for (let i = 0; i < vec.length; i++) dot += vec[i] * t[i]
      if (dot > s) s = dot
    }
    if (!best || s > best.s) {
      if (best) second = Math.max(second, best.s)
      best = { k, s }
    } else if (s > second) second = s
  }
  return best ? { ch: best.k, sim: best.s, margin: best.s - second } : null
}

const isDigit = (k) => k >= '0' && k <= '9'
const isLetter = (k) => k >= 'A' && k <= 'Z'

/**
 * 라벨 1개 인식 → { text, conf(0~100) }
 * 첫 글자는 패널 글자(A~Z), 나머지는 숫자로 제한. 하이픈은 모양으로 판별
 */
export function recognize(src, box) {
  if (!model) return null
  const { img, parts } = segment(src, box)
  const chars = parts.filter((p) => p.kind === 'char')
  if (chars.length < 3 || chars.length > 6) return { text: '', conf: 0 }
  let text = ''
  let minSim = 1, minMargin = 1
  let ci = 0
  for (const p of parts) {
    if (p.kind === 'hyphen') {
      text += '-'
      continue
    }
    const r = classify(featurize(img, p), ci === 0 ? isLetter : isDigit)
    ci++
    if (!r) return { text: '', conf: 0 }
    text += r.ch
    minSim = Math.min(minSim, r.sim)
    minMargin = Math.min(minMargin, r.margin)
  }
  // 신뢰도: 가장 애매한 글자 기준 (닮은 정도 + 2등과의 차이)
  const conf = Math.round(Math.max(0, Math.min(1, (minSim - 0.5) * 1.2 + minMargin * 2)) * 100)
  return { text, conf }
}

/** 학습용: 라벨과 정답 문자열(A-5-05)로 글자 견본 수집. 글자 수가 맞을 때만 */
export function samplesFromLabel(src, box, truth) {
  const { img, parts } = segment(src, box)
  const chars = parts.filter((p) => p.kind === 'char' && !p.split)
  const want = truth.replace(/-/g, '')
  if (chars.length !== want.length) return []
  return chars.map((p, i) => ({ ch: want[i], vec: featurize(img, p) }))
}
