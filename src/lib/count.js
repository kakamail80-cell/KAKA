// 칸 안 물건 개수 추정 (AI 없이 영상 처리)
// 같은 화면의 이웃 칸들을 같은 크기로 잘라 픽셀별 중앙값 = "빈 서랍" 기준 영상으로 삼고,
// 대상 칸에서 기준과 다른 부분(물건)을 덩어리로 묶어 센다. 0·1·2까지 목표, 3 이상은 "3+"로 확인 필요.

export const COUNT_PARAMS = {
  W: 120, // 정규화 크기
  H: 72,
  // 라벨 중심 기준 서랍 바닥 영역 (격자 한 칸 간격 단위)
  side: 0.4, // 좌우 (서랍 옆벽 제외)
  up: 0.62, // 라벨 위쪽 끝 (서랍 뒤쪽 벽 제외, 바닥 위주)
  down: 0.02, // 라벨 윗부분까지 (라벨 자체는 제외)
  diffThr: 45, // 기준과의 색 차이 (0~441)
  shiftR: 3, // 칸 사이 위치 어긋남 허용(px)
  minBlobArea: 40, // 정규화 영상 기준 최소 덩어리 면적(px)
  mergeR: 6, // 같은 물건의 조각(볼·바)을 합치는 거리(px)
  edgeW: 14, // 좌우 가장자리에 붙은 폭 이하 덩어리는 서랍 옆벽으로 보고 제외
  minNeighbors: 5,
}

/** 칸 내부 영역을 정규화 크기로 잘라 픽셀 배열 반환 */
export function extractCell(frame, l, g, p = COUNT_PARAMS) {
  const px = 1 / g.a, py = 1 / g.c
  const sx = l.cx - px * p.side
  const sw = px * p.side * 2
  const sy = l.cy - py * p.up
  const sh = py * (p.up - p.down) - l.h / 2
  const c = document.createElement('canvas')
  c.width = p.W
  c.height = p.H
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, p.W, p.H)
  const fw = frame.videoWidth || frame.width, fh = frame.videoHeight || frame.height
  const inside = sx >= 0 && sy >= 0 && sx + sw <= fw && sy + sh <= fh
  return { canvas: c, data: ctx.getImageData(0, 0, p.W, p.H).data, rect: { x: sx, y: sy, w: sw, h: sh }, inside }
}

function medianTemplate(cells, n) {
  const k = cells.length
  const out = new Uint8ClampedArray(n * 4)
  const buf = new Uint8Array(k)
  for (let i = 0; i < n * 4; i++) {
    if ((i & 3) === 3) { out[i] = 255; continue }
    for (let j = 0; j < k; j++) buf[j] = cells[j].data[i]
    buf.sort()
    out[i] = buf[k >> 1]
  }
  return out
}

/**
 * @param {{data:Uint8ClampedArray}} target
 * @param {{data:Uint8ClampedArray}[]} neighbors 같은 화면의 다른 칸들
 * @returns {{count:number|null, label:string, needCheck:boolean, mask:Uint8Array, blobs:Array, fg:number}}
 */
export function countItems(target, neighbors, p = COUNT_PARAMS) {
  const W = p.W, H = p.H, n = W * H
  if (neighbors.length < p.minNeighbors) return { count: null, label: '?', needCheck: true, reason: '이웃 칸 부족' }
  const tpl = medianTemplate(neighbors, n)
  const d = target.data

  // 밝기 차이는 조명 차이를 줄이려고 칸 평균 밝기를 맞춘 뒤 비교
  let mt = 0, mb = 0
  for (let i = 0; i < n * 4; i += 4) {
    mt += d[i] + d[i + 1] + d[i + 2]
    mb += tpl[i] + tpl[i + 1] + tpl[i + 2]
  }
  const gain = mb / Math.max(1, mt)

  // 칸마다 서랍 구조가 몇 px씩 어긋나므로, 기준 영상의 주변 ±shiftR px 중 가장 비슷한 값과 비교
  const mask = new Uint8Array(n)
  const R = p.shiftR
  const thr2 = p.diffThr * p.diffThr
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const j = (y * W + x) * 4
      const r = d[j] * gain, g = d[j + 1] * gain, b = d[j + 2] * gain
      let best = Infinity
      for (let dy = -R; dy <= R && best > thr2; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const k = (yy * W + xx) * 4
          const dr = r - tpl[k], dg = g - tpl[k + 1], db = b - tpl[k + 2]
          const e = dr * dr + dg * dg + db * db
          if (e < best) best = e
        }
      }
      if (best > thr2) mask[y * W + x] = 1
    }
  }
  // 잡티 제거(열림) 후 조각 합치기(팽창)
  morph(mask, W, H, 1, false)
  morph(mask, W, H, 1, true)
  const grown = mask.slice()
  morph(grown, W, H, p.mergeR, true)

  // 합쳐진 덩어리 단위로 원래 마스크 면적 집계
  const lab = new Int32Array(n)
  const blobs = []
  const stack = []
  for (let s = 0; s < n; s++) {
    if (!grown[s] || lab[s]) continue
    const id = blobs.length + 1
    let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0
    lab[s] = id
    stack.push(s)
    while (stack.length) {
      const q = stack.pop()
      const x = q % W, y = (q / W) | 0
      if (mask[q]) {
        area++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      if (x > 0 && grown[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack.push(q - 1) }
      if (x < W - 1 && grown[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack.push(q + 1) }
      if (y > 0 && grown[q - W] && !lab[q - W]) { lab[q - W] = id; stack.push(q - W) }
      if (y < H - 1 && grown[q + W] && !lab[q + W]) { lab[q + W] = id; stack.push(q + W) }
    }
    blobs.push({ area, x0, y0, x1, y1 })
  }
  const items = blobs.filter((b) => {
    if (b.area < p.minBlobArea) return false
    const touchesSide = b.x0 <= 1 || b.x1 >= W - 2
    return !(touchesSide && b.x1 - b.x0 + 1 <= p.edgeW)
  })
  const fg = items.reduce((s, b) => s + b.area, 0) / n
  // 0·1·2까지만 판정, 3 이상은 "확인 필요"
  const count = Math.min(items.length, 3)
  return {
    count,
    label: count >= 3 ? '3+' : String(count),
    needCheck: count >= 3,
    mask,
    blobs: items,
    fg,
  }
}

function morph(mask, W, H, r, isDilate) {
  const tmp = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = isDilate ? 0 : 1
      for (let k = -r; k <= r; k++) {
        const xx = x + k
        if (xx < 0 || xx >= W) continue
        const m = mask[y * W + xx]
        if (isDilate ? m : !m) { v = isDilate ? 1 : 0; break }
      }
      tmp[y * W + x] = v
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = isDilate ? 0 : 1
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy < 0 || yy >= H) continue
        const m = tmp[yy * W + x]
        if (isDilate ? m : !m) { v = isDilate ? 1 : 0; break }
      }
      mask[y * W + x] = v
    }
  }
}
