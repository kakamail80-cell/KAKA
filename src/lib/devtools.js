// 개발 전용 시험 도구 (앱 빌드에는 포함되지 않음 — 브라우저 콘솔에서 import 해서 사용)
// 글자 인식기 학습·평가, 위치 잡기 속도 시뮬레이션, 이동 속도별 추적 시뮬레이션
import { processFrame } from './pipeline.js'
import { detectLabels } from './detect.js'
import { parseLabel, OCR_PARAMS } from './ocr.js'
import { estimateGrid } from './grid.js'
import { trackFrame, TRACK_PARAMS } from './track.js'
import * as G from './glyph.js'

const pad2 = (n) => String(n).padStart(2, '0')
const truthOf = (cell) => `${cell.panel}-${cell.row}-${pad2(cell.col)}`

// ── 영상 프레임 불러오기 ──
let vid = null
const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d', { willReadFrequently: true })
export async function frameAt(src, t) {
  if (!vid) {
    vid = document.createElement('video')
    vid.muted = true
    vid.playsInline = true
    vid.style.cssText = 'position:fixed;left:0;top:0;width:120px;opacity:0.01;pointer-events:none'
    document.body.appendChild(vid)
  }
  if (!decodeURI(vid.src).endsWith(src)) {
    vid.src = src
    await new Promise((r) => {
      vid.onloadeddata = r
      setTimeout(r, 8000)
    })
  }
  await new Promise((r) => {
    let d = false
    const f = () => !d && ((d = true), r())
    vid.addEventListener('seeked', () => setTimeout(f, 120), { once: true })
    setTimeout(f, 3000)
    vid.currentTime = t
  })
  canvas.width = vid.videoWidth
  canvas.height = vid.videoHeight
  ctx.drawImage(vid, 0, 0)
  return canvas
}

const save = (name, obj) =>
  fetch('/__save?name=' + encodeURIComponent(name), { method: 'POST', body: JSON.stringify(obj) }).then((r) => r.text())

// ── 1) 정답 수집: tesseract+격자로 번호가 확인된 라벨 (근접 구간 위주) ──
export async function collectTruth(segments, { step = 0.5, maxOcr = 30, file = 'src/lib/_glyph_truth.json', append = true, log = () => {} } = {}) {
  let data = []
  if (append) {
    try {
      data = await (await fetch('/' + file + '?' + Date.now())).json()
    } catch {}
  }
  for (const [src, t0, t1] of segments) {
    for (let t = t0; t <= t1 + 1e-6; t += step) {
      const c = await frameAt(src, +t.toFixed(2))
      const res = await Promise.race([processFrame(c, { maxOcr }), new Promise((r) => setTimeout(() => r(null), 30000))])
      if (!res) continue
      for (const l of res.labels) {
        if (!l.name || !l.cell || l.w < 45) continue
        data.push({ src, t: +t.toFixed(2), box: { x: l.x, y: l.y, w: l.w, h: l.h }, truth: truthOf(l.cell), src2: l.source })
      }
      log(`${src} ${t.toFixed(1)} → ${data.length}`)
    }
  }
  await save(file, data)
  return data.length
}

// ── 2) 글자 인식기 학습 + 평가 (프레임 단위로 반씩 학습/시험) ──
export async function trainGlyph({ K = 16, keep = 0.7, file = '/src/lib/_glyph_truth.json', saveModel = false } = {}) {
  const data = await (await fetch(file + '?' + Date.now())).json()
  const groups = {}
  for (const it of data) (groups[it.src + '|' + it.t] ??= []).push(it)
  const keys = Object.keys(groups)
  const trainK = keys.filter((_, i) => i % 2 === 0), testK = keys.filter((_, i) => i % 2 === 1)
  const byCh = {}
  let used = 0
  for (const key of trainK) {
    const [src, t] = key.split('|')
    const c = await frameAt(src, +t)
    for (const it of groups[key]) {
      const s = G.samplesFromLabel(c, it.box, it.truth)
      if (s.length) used++
      for (const q of s) (byCh[q.ch] ??= []).push(q.vec)
    }
  }
  const dot = (a, b) => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] * b[i]
    return s
  }
  const classes = {}
  for (const [k, list] of Object.entries(byCh)) {
    // 평균에서 먼 견본(잘못 잘린 것)은 버리고, 남은 것 중 서로 다른 것 K개
    const mean = new Float32Array(list[0].length)
    for (const v of list) for (let i = 0; i < v.length; i++) mean[i] += v[i]
    const kept = [...list].sort((a, b) => dot(b, mean) - dot(a, mean)).slice(0, Math.max(1, Math.ceil(list.length * keep)))
    const ch = [kept[0]]
    while (ch.length < Math.min(K, kept.length)) {
      let best = null, bd = 2
      for (const v of kept) {
        const m = Math.max(...ch.map((q) => dot(v, q)))
        if (m < bd) {
          bd = m
          best = v
        }
      }
      ch.push(best)
    }
    classes[k] = ch.map((q) => Array.from(q).map((z) => +z.toFixed(3)))
  }
  // 영상에 없는 패널 글자는 비슷한 글꼴로 그린 합성 견본
  const fonts = ['bold 40px Arial', 'bold 40px Helvetica', 'bold 40px "Malgun Gothic"', 'bold 40px sans-serif', '40px Arial']
  for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (byCh[L]?.length >= 20) continue
    for (const f of fonts) {
      const cc = document.createElement('canvas')
      cc.width = 240
      cc.height = 64
      const xx = cc.getContext('2d')
      xx.fillStyle = '#fff'
      xx.fillRect(0, 0, 240, 64)
      xx.fillStyle = '#111'
      xx.font = f
      xx.textBaseline = 'middle'
      xx.fillText(`${L}-5-05`, 14, 33)
      const s = G.samplesFromLabel(cc, { x: 0, y: 0, w: 240, h: 64 }, `${L}-5-05`)
      if (s.length) (classes[L] ??= []).push(Array.from(s[0].vec).map((z) => +z.toFixed(3)))
    }
  }
  const model = { size: [G.GW, G.GH], classes, meta: { trainFrames: trainK.length, date: new Date().toISOString().slice(0, 10) } }
  G.setGlyphModel(model)
  const ev = await evalGlyph(groups, testK)
  if (saveModel) await save('src/lib/glyphs.json', model)
  return {
    trainFrames: trainK.length, testFrames: testK.length, trainLabelsUsed: used,
    samples: Object.fromEntries(Object.entries(byCh).map(([k, l]) => [k, l.length])),
    ...ev, bytes: JSON.stringify(model).length,
  }
}

async function evalGlyph(groups, keys) {
  let n = 0, exact = 0, ms = 0
  const byW = {}, errs = []
  for (const key of keys) {
    const [src, t] = key.split('|')
    const c = await frameAt(src, +t)
    for (const it of groups[key]) {
      const t0 = performance.now()
      const r = G.recognize(c, it.box)
      ms += performance.now() - t0
      n++
      const p = r && parseLabel(r.text)
      const name = p && `${p.panel}-${p.row}-${pad2(p.col)}`
      const ok = name === it.truth
      const wb = it.box.w < 60 ? '45-59' : it.box.w < 90 ? '60-89' : it.box.w < 150 ? '90-149' : '150+'
      const b = (byW[wb] ??= { n: 0, ok: 0 })
      b.n++
      if (ok) {
        b.ok++
        exact++
      }
      if (!ok && errs.length < 14) errs.push(`${it.truth}→${r?.text}(${r?.conf})`)
    }
  }
  return { test: n, exact, pct: Math.round((exact / n) * 100), msPerLabel: +(ms / n).toFixed(2), byW, errs }
}

// ── 3) 위치 잡기(기준 잡기) 속도 시뮬레이션: 방식별 시간·성공 여부 ──
//    방식: tesseract 전체 / tesseract 14개 / 전용 인식기 전체 / 전용 인식기 14개
export async function simLocalize(frames, { log = () => {}, tess = [['tess_14', { maxOcr: 14 }]] } = {}) {
  const rows = []
  for (const [src, t] of frames) {
    const c = await frameAt(src, t)
    const row = { src: src.split('/').pop(), t }
    const t0 = performance.now()
    const boxes = detectLabels(c, c.width, c.height)
    row.detectMs = Math.round(performance.now() - t0)
    row.labels = boxes.length
    for (const [name, opts] of tess) {
      const s = performance.now()
      const r = await Promise.race([processFrame(c, opts), new Promise((res) => setTimeout(() => res(null), 20000))])
      row[name] = r
        ? { ms: Math.round(performance.now() - s), ok: !!Object.keys(r.grids).length, named: r.labels.filter((l) => l.name).length }
        : { ms: 20000, ok: false, timeout: true }
    }
    for (const [name, n] of [['glyph_all', Infinity], ['glyph_14', 14]]) {
      const s = performance.now()
      const cx = c.width / 2, cy = c.height / 2
      const sel = [...boxes]
        .filter((b) => b.w >= OCR_PARAMS.minLabelW)
        .sort((p, q) => Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy) / c.width - p.w / c.width - (Math.hypot(q.x + q.w / 2 - cx, q.y + q.h / 2 - cy) / c.width - q.w / c.width))
        .slice(0, n)
      const pts = []
      for (const b of sel) {
        const r = G.recognize(c, b)
        const p = r && parseLabel(r.text)
        if (p) pts.push({ cx: b.x + b.w / 2, cy: b.y + b.h / 2, row: p.row, col: p.col, conf: r.conf, panel: p.panel })
      }
      const byPanel = {}
      for (const q of pts) (byPanel[q.panel] ??= []).push(q)
      const g = Object.values(byPanel).map((list) => estimateGrid(list)).find(Boolean)
      row[name] = { ms: Math.round(performance.now() - s), ok: !!g, reads: pts.length }
    }
    rows.push(row)
    log(JSON.stringify(row))
  }
  return rows
}

// ── 4) 이동 속도별 추적 시뮬레이션 ──
//    step(초) = 처리 간격. 영상 속 움직임이 같을 때 step이 크면 = 기기가 느리거나 사람이 빨리 움직이는 것과 같음
export async function simTracking(src, t0, t1, steps = [0.033, 0.066, 0.1, 0.2, 0.33], { log = () => {} } = {}) {
  const out = []
  for (const step of steps) {
    // 시작 기준: t0 프레임 전체 OCR
    const c0 = await frameAt(src, t0)
    const r0 = await processFrame(c0, { maxOcr: 30 })
    let grid = Object.values(r0.grids)[0] || null
    if (grid) grid = { ...grid, medW: null }
    let ok = 0, bad = 0, lostAt = null, frames = 0
    for (let t = t0 + step; t <= t1 + 1e-6 && grid; t += step) {
      frames++
      const c = await frameAt(src, +t.toFixed(3))
      const tr = trackFrame(c, grid)
      if (!tr.grid) {
        lostAt = +t.toFixed(2)
        break
      }
      grid = tr.grid
      // 1초마다 정답(전체 OCR)과 대조
      if (Math.abs((t - t0) % 1) < step * 0.99) {
        const ref = await processFrame(c, { maxOcr: 30 })
        for (const r of ref.labels.filter((l) => l.source === 'ocr')) {
          const m = tr.labels.find((l) => l.name && Math.abs(l.cx - r.cx) < r.w * 0.3 && Math.abs(l.cy - r.cy) < r.h * 0.6)
          if (!m) continue
          if (m.name === r.name) ok++
          else bad++
        }
      }
    }
    const row = { step, fps: +(1 / step).toFixed(1), frames, ok, bad, lostAt, startOk: !!Object.keys(r0.grids).length }
    out.push(row)
    log(JSON.stringify(row))
  }
  return out
}

export { TRACK_PARAMS, G }
