// 사진으로 잡은 위치를 영상에서 OCR 없이 따라가기(트래킹)
// 매 프레임 라벨 사각형만 검출 → 직전 격자로 각 라벨의 행·열을 반올림해 배정 → 그 배정으로 격자를 다시 맞춘다.
// 프레임 사이 이동이 반 칸보다 작으면 번호가 정확히 이어진다. 빠르게 움직여 놓치면 사진으로 다시 위치를 잡는다.
import { detectLabels, DETECT_PARAMS } from './detect.js'
import { PANEL_SIZE } from './grid.js'
import { cellName } from './pipeline.js'

export const TRACK_PARAMS = {
  procWidth: 960, // 추적용 검출 해상도 (속도 우선)
  fracTol: 0.3, // 칸 중심에서 이만큼(칸 단위) 이내만 배정
  minLabels: 3,
  minKeptRatio: 0.5, // 검출 라벨 중 칸 중심에 맞는 비율 하한
  maxScaleStep: 1.2, // 프레임 사이 라벨 크기 변화 허용 (±20%)
  lostFrames: 3, // 연속 이만큼 실패하면 위치 잃음
}

function fitLine(xs, vs) {
  const n = xs.length
  let sx = 0, sv = 0, sxx = 0, sxv = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sv += vs[i]; sxx += xs[i] * xs[i]; sxv += xs[i] * vs[i]
  }
  const den = n * sxx - sx * sx
  if (Math.abs(den) < 1e-9) return null
  const k = (n * sxv - sx * sv) / den
  return [k, (sv - k * sx) / n]
}

// 소수부의 원형 평균: 격자 전체가 몇 분의 1칸 밀렸는지
function circShift(vals) {
  let s = 0, c = 0
  for (const v of vals) {
    const a = 2 * Math.PI * (v - Math.round(v))
    s += Math.sin(a)
    c += Math.cos(a)
  }
  return Math.atan2(s, c) / (2 * Math.PI)
}

/**
 * 추정 격자(guess)로 라벨들에 행·열을 배정하고 격자를 다시 맞춘다
 * @returns {{grid:object, labels:Array}|null}
 */
const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y)
  return s.length ? s[s.length >> 1] : 0
}

export function refitGrid(boxes, guessIn, p = TRACK_PARAMS, center = null) {
  if (boxes.length < p.minLabels) return null
  // 확대·축소 보정: 라벨 크기는 칸 간격에 비례 → 라벨 폭 변화 비율로 칸 간격을 먼저 맞춘다 (화면 중앙 기준)
  let guess = guessIn
  const medW = median(boxes.map((b) => b.w))
  if (guessIn.medW && medW && center) {
    const k = guessIn.medW / medW
    // 한 프레임에 크기가 크게 바뀌면(빠른 줌·흔들림으로 라벨이 뭉개짐) 번호가 밀리기 쉬움 → 위치 잃음
    if (k < 1 / p.maxScaleStep || k > p.maxScaleStep) return null
    {
      const colC = guessIn.a * center.x + guessIn.b
      const rowC = guessIn.c * center.y + guessIn.d
      const a = guessIn.a * k, c = guessIn.c * k
      guess = { ...guessIn, a, c, b: colC - a * center.x, d: rowC - c * center.y }
    }
  }
  const colF = boxes.map((b) => guess.a * b.cx + guess.b)
  const rowF = boxes.map((b) => guess.c * b.cy + guess.d)
  const sc = circShift(colF), sr = circShift(rowF)
  const size = PANEL_SIZE[guess.panel]
  const kept = []
  boxes.forEach((b, i) => {
    const cf = colF[i] - sc, rf = rowF[i] - sr
    const col = Math.round(cf), row = Math.round(rf)
    if (Math.abs(cf - col) > p.fracTol || Math.abs(rf - row) > p.fracTol) return
    if (row < 1 || col < 1) return
    if (size && (row > size.rows || col > size.cols)) return
    kept.push({ b, row, col })
  })
  if (kept.length < p.minLabels) return null
  // 칸 중심에 잘 맞는 라벨이 절반도 안 되면 격자가 어긋난 것 → 틀린 안내 대신 위치 잃음 처리
  if (kept.length < boxes.length * p.minKeptRatio) return null
  // 한 행·한 열에만 몰려 있으면 기울기를 못 정하므로 이전 기울기 유지
  const distinctCols = new Set(kept.map((k) => k.col)).size
  const distinctRows = new Set(kept.map((k) => k.row)).size
  let a = guess.a, b = guess.b - sc, c = guess.c, d = guess.d - sr
  if (distinctCols >= 2) {
    const f = fitLine(kept.map((k) => k.b.cx), kept.map((k) => k.col))
    if (f && f[0] > 0 && Math.abs(f[0] / guess.a - 1) < 0.25) [a, b] = f
  }
  if (distinctRows >= 2) {
    const f = fitLine(kept.map((k) => k.b.cy), kept.map((k) => k.row))
    if (f && f[0] > 0 && Math.abs(f[0] / guess.c - 1) < 0.25) [c, d] = f
  }
  const grid = { a, b, c, d, panel: guess.panel, tracked: true, medW: median(kept.map((k) => k.b.w)) }
  const labels = kept.map(({ b: box, row, col }) => ({
    ...box,
    cell: { panel: guess.panel, row, col },
    name: cellName(guess.panel, row, col),
    source: 'track',
    grid,
  }))
  return { grid, labels }
}

/** 영상 프레임 1장: 검출 + 추적 (OCR 없음) */
export function trackFrame(frame, guess, p = TRACK_PARAMS) {
  const t0 = performance.now()
  const w = frame.width, h = frame.height
  const boxes = detectLabels(frame, w, h, { ...DETECT_PARAMS, procWidth: p.procWidth }).map((b) => ({
    ...b,
    cx: b.x + b.w / 2,
    cy: b.y + b.h / 2,
  }))
  const fit = guess ? refitGrid(boxes, guess, p, { x: w / 2, y: h / 2 }) : null
  const named = new Set(fit ? fit.labels.map((l) => l.cx + ',' + l.cy) : [])
  const labels = [...(fit ? fit.labels : []), ...boxes.filter((b) => !named.has(b.cx + ',' + b.cy))]
  return {
    w,
    h,
    labels,
    grid: fit ? fit.grid : null,
    grids: fit ? { [fit.grid.panel]: fit.grid } : {},
    nRead: 0,
    nBoxes: boxes.length,
    ms: performance.now() - t0,
  }
}

/**
 * 사진(OCR)에서 얻은 격자를 영상 좌표로 옮긴다.
 * 사진과 영상은 가로 화각이 같고 가운데 기준으로 잘린다고 가정(4:3 사진 ↔ 16:9 영상), 이후 refitGrid로 미세 보정.
 */
export function photoGridToVideo(g, pw, ph, vw, vh) {
  const s = pw / vw // 영상 1px = 사진 s px
  const ox = 0
  const oy = (ph - vh * s) / 2
  // 사진: col = a·xp + b, xp = s·xv + ox
  return { a: g.a * s, b: g.a * ox + g.b, c: g.c * s, d: g.c * oy + g.d, panel: g.panel }
}

/**
 * 가끔 OCR로 몇 개 라벨을 읽어 추적이 밀렸는지 확인. 2개 이상이 같은 만큼 어긋나면 그만큼 보정값 반환
 * @param {Array<{name:string}>} labels 추적 라벨
 * @param {Array<{panel,row,col}|null>} reads 같은 순서의 OCR 결과
 */
export function driftFromReads(labels, reads) {
  const votes = new Map()
  labels.forEach((l, i) => {
    const r = reads[i]
    if (!r || r.row == null || !l.cell || r.panel !== l.cell.panel) return
    const key = `${r.row - l.cell.row},${r.col - l.cell.col}`
    votes.set(key, (votes.get(key) || 0) + 1)
  })
  let best = null, total = 0
  for (const [k, v] of votes) {
    total += v
    if (!best || v > best.v) best = { k, v }
  }
  const agree = votes.get('0,0') || 0
  if (!best || best.v < 2) return { total, agree, dRow: 0, dCol: 0, votes: 0 }
  const [dRow, dCol] = best.k.split(',').map(Number)
  return { dRow, dCol, votes: best.v, total, agree }
}
