// 흰색 라벨 사각형 검출 (det.py 로직 이식)
// HSV 흰색 마스크 → 연결 성분(컨투어 대용) → 가로세로비 2~6.5, 채움비 0.6 이상

export const DETECT_PARAMS = {
  // 검출은 축소 영상에서 수행 (속도). 4K 기준 1/3 축소 → 멀리 있는 작은 라벨도 검출
  procWidth: 1280,
  maxSat: 60, // OpenCV 기준 S(0~255) 이하
  // V(0~255) 기준: 화면 상위 1% 밝기 - valMargin (라벨 종이 ≈ 225~230, 투명 서랍 앞면 ≈ 170)
  valMargin: 40,
  minValFloor: 150,
  minValCeil: 210,
  closeR: 2, // 닫힘 연산 반경 (축소 영상 px)
  minAspect: 2,
  maxAspect: 6.5,
  minFill: 0.6,
  minW: 10, // 축소 영상 기준 최소 폭(px)
  minH: 4,
}

let procCanvas = null
export let lastMinVal = 0

// 정사각형 커널 팽창/침식 (가로·세로 분리, 누적합 사용)
function morph(mask, W, H, r, isDilate) {
  const tmp = new Uint8Array(W * H)
  const need = isDilate ? 1 : 2 * r + 1
  for (let y = 0; y < H; y++) {
    const row = y * W
    let s = 0
    for (let x = -r; x < W + r; x++) {
      const add = x + r, sub = x - r - 1
      if (add < W && add >= 0) s += mask[row + add]
      if (sub >= 0 && sub < W) s -= mask[row + sub]
      if (x >= 0 && x < W) {
        const cnt = Math.min(W - 1, x + r) - Math.max(0, x - r) + 1
        tmp[row + x] = isDilate ? (s >= need ? 1 : 0) : s >= Math.min(need, cnt) ? 1 : 0
      }
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0
    for (let y = -r; y < H + r; y++) {
      const add = y + r, sub = y - r - 1
      if (add < H && add >= 0) s += tmp[add * W + x]
      if (sub >= 0 && sub < H) s -= tmp[sub * W + x]
      if (y >= 0 && y < H) {
        const cnt = Math.min(H - 1, y + r) - Math.max(0, y - r) + 1
        mask[y * W + x] = isDilate ? (s >= need ? 1 : 0) : s >= Math.min(need, cnt) ? 1 : 0
      }
    }
  }
}
const dilate = (m, W, H, r) => morph(m, W, H, r, true)
const erode = (m, W, H, r) => morph(m, W, H, r, false)

/**
 * @param {CanvasImageSource} src 영상 프레임 (video 또는 canvas)
 * @param {number} srcW 원본 폭
 * @param {number} srcH 원본 높이
 * @returns {{x:number,y:number,w:number,h:number,fill:number}[]} 원본 좌표계 박스
 */
export function detectLabels(src, srcW, srcH, p = DETECT_PARAMS) {
  const scale = Math.min(1, p.procWidth / srcW)
  const W = Math.round(srcW * scale)
  const H = Math.round(srcH * scale)
  if (!procCanvas) procCanvas = document.createElement('canvas')
  procCanvas.width = W
  procCanvas.height = H
  const ctx = procCanvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(src, 0, 0, W, H)
  const px = ctx.getImageData(0, 0, W, H).data

  // 1) 흰색 마스크 (밝기 기준은 프레임마다 자동)
  const n = W * H
  const vmax = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2]
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b
    vmax[i] = mx
    hist[mx]++
  }
  let acc = 0, p99 = 255
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc >= n * 0.01) { p99 = v; break }
  }
  const minVal = Math.min(p.minValCeil, Math.max(p.minValFloor, p99 - p.valMargin))
  const mask = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const mx = vmax[i]
    if (mx < minVal) continue
    const r = px[j], g = px[j + 1], b = px[j + 2]
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b
    if (((mx - mn) * 255) / mx <= p.maxSat) mask[i] = 1
  }
  // 글자 획이 흰 영역을 쪼개지 않도록 닫힘 연산(팽창→침식)
  if (p.closeR > 0) {
    dilate(mask, W, H, p.closeR)
    erode(mask, W, H, p.closeR)
  }
  lastMinVal = minVal

  // 2) 연결 성분 (2-pass, union-find, 4-연결)
  const lab = new Int32Array(n)
  const parent = [0]
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  let next = 1
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!mask[i]) continue
      const l = x > 0 ? lab[i - 1] : 0
      const u = y > 0 ? lab[i - W] : 0
      if (!l && !u) {
        parent.push(next)
        lab[i] = next++
      } else if (l && u) {
        const rl = find(l), ru = find(u)
        lab[i] = rl < ru ? rl : ru
        if (rl !== ru) parent[rl > ru ? rl : ru] = rl < ru ? rl : ru
      } else {
        lab[i] = l || u
      }
    }
  }

  const minX = new Int32Array(next).fill(W)
  const minY = new Int32Array(next).fill(H)
  const maxX = new Int32Array(next).fill(-1)
  const maxY = new Int32Array(next).fill(-1)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!lab[i]) continue
      const r = find(lab[i])
      lab[i] = r
      if (x < minX[r]) minX[r] = x
      if (x > maxX[r]) maxX[r] = x
      if (y < minY[r]) minY[r] = y
      if (y > maxY[r]) maxY[r] = y
    }
  }

  // 3) 형태 필터
  const out = []
  for (let r = 1; r < next; r++) {
    if (maxX[r] < 0 || parent[r] !== r) continue
    const w = maxX[r] - minX[r] + 1
    const h = maxY[r] - minY[r] + 1
    if (w < p.minW || h < p.minH) continue
    const ar = w / h
    if (ar < p.minAspect || ar > p.maxAspect) continue
    // 채움비: 행마다 좌우 끝 사이를 채운 면적(= 외곽 컨투어 면적 근사, 글자 구멍 포함) / 박스 면적
    let filled = 0
    for (let y = minY[r]; y <= maxY[r]; y++) {
      const row = y * W
      let a = -1, b = -1
      for (let x = minX[r]; x <= maxX[r]; x++) {
        if (lab[row + x] === r) {
          if (a < 0) a = x
          b = x
        }
      }
      if (a >= 0) filled += b - a + 1
    }
    const fill = filled / (w * h)
    if (fill < p.minFill) continue
    out.push({
      x: minX[r] / scale,
      y: minY[r] / scale,
      w: w / scale,
      h: h / scale,
      fill,
    })
  }
  return out
}
