// 격자 모델 추정 (run.py 로직 이식)
// 열 = a·x + b, 행 = c·y + d. 두 점 조합 RANSAC, 일치 3개 이상일 때만 격자 ON

export const GRID_PARAMS = {
  tol: 0.35, // 행/열 단위 허용 오차 (인라이어 판정)
  assignTol: 0.3, // 못 읽은 라벨에 번호를 붙일 때 허용 오차
  minInliers: 3,
  // 격자 인정 조건: 신뢰도 높은 판독이 minInliers개 이상 일치하거나,
  // 판독 minWeakInliers개 이상 & 전체 판독의 minInlierRatio 이상이 일치 (신뢰도 0 오판독끼리 우연히 맞는 가짜 격자 방지)
  strongConf: 80,
  minWeakInliers: 8,
  minInlierRatio: 0.4,
  // 패널 크기를 모를 때: 판독된 행·열 범위 밖으로 몇 칸까지 추정할지. 0 = 범위 안만 (옆 패널로 번지는 것 방지)
  extrapolate: 0,
}

// 패널 크기(행·열 수). 알면 판독 범위와 무관하게 패널 안이면 추정한다.
// A는 4K 샘플에서 관찰한 값(행 1~25, 열 1~21. 21열은 인쇄 라벨 없이 손글씨) — 확인 필요
export const PANEL_SIZE = {
  A: { rows: 25, cols: 21 },
}

function withRange(g, pts) {
  const ip = g.inliers.map((k) => pts[k])
  g.rowMin = Math.min(...ip.map((q) => q.row))
  g.rowMax = Math.max(...ip.map((q) => q.row))
  g.colMin = Math.min(...ip.map((q) => q.col))
  g.colMax = Math.max(...ip.map((q) => q.col))
  return g
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

/**
 * @param {{cx:number,cy:number,row:number,col:number}[]} pts OCR 채택된 라벨 중심
 * @returns {{a:number,b:number,c:number,d:number,inliers:number[]}|null}
 */
export function estimateGrid(pts, p = GRID_PARAMS) {
  if (pts.length < p.minInliers) return null
  let best = null
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const P = pts[i], Q = pts[j]
      if (P.col === Q.col || P.row === Q.row) continue
      if (P.cx === Q.cx || P.cy === Q.cy) continue
      const a = (P.col - Q.col) / (P.cx - Q.cx)
      const b = P.col - a * P.cx
      const c = (P.row - Q.row) / (P.cy - Q.cy)
      const d = P.row - c * P.cy
      // 열은 오른쪽으로, 행은 아래로 증가해야 한다
      if (a <= 0 || c <= 0) continue
      const inl = []
      for (let k = 0; k < pts.length; k++) {
        const R = pts[k]
        if (Math.abs(a * R.cx + b - R.col) < p.tol && Math.abs(c * R.cy + d - R.row) < p.tol) inl.push(k)
      }
      if (!best || inl.length > best.inliers.length) best = { a, b, c, d, inliers: inl }
    }
  }
  if (!best || best.inliers.length < p.minInliers) return null
  const strong = best.inliers.filter((k) => (pts[k].conf ?? 100) >= p.strongConf).length
  const weakOk = best.inliers.length >= p.minWeakInliers && best.inliers.length >= pts.length * p.minInlierRatio
  if (strong < p.minInliers && !weakOk) return null

  // 인라이어로 최소제곱 재추정
  const ip = best.inliers.map((k) => pts[k])
  const fx = fitLine(ip.map((q) => q.cx), ip.map((q) => q.col))
  const fy = fitLine(ip.map((q) => q.cy), ip.map((q) => q.row))
  if (fx && fy && fx[0] > 0 && fy[0] > 0) {
    const ok = ip.every(
      (q) => Math.abs(fx[0] * q.cx + fx[1] - q.col) < p.tol && Math.abs(fy[0] * q.cy + fy[1] - q.row) < p.tol,
    )
    if (ok) return withRange({ a: fx[0], b: fx[1], c: fy[0], d: fy[1], inliers: best.inliers }, pts)
  }
  return withRange(best, pts)
}

/** 격자로 위치 → 칸번호 추정. 오차가 크거나 판독 범위 밖이면 null */
export function predictCell(g, cx, cy, p = GRID_PARAMS) {
  const colF = g.a * cx + g.b
  const rowF = g.c * cy + g.d
  const col = Math.round(colF), row = Math.round(rowF)
  const err = Math.max(Math.abs(colF - col), Math.abs(rowF - row))
  if (err > p.assignTol) return null
  if (row < 1 || col < 1) return null
  const size = PANEL_SIZE[g.panel]
  if (size && (row > size.rows || col > size.cols)) return null
  // 판독된 행·열 폭보다 멀리는 추정하지 않는다 (좁은 구간에서 잰 간격을 멀리 연장하면 한 칸씩 밀림).
  // 패널 크기를 알면 판독 폭만큼, 모르면 extrapolate 칸만큼 (옆 패널로 번지는 것 방지)
  const mr = size ? g.rowMax - g.rowMin : p.extrapolate
  const mc = size ? g.colMax - g.colMin : p.extrapolate
  if (row < g.rowMin - mr || row > g.rowMax + mr || col < g.colMin - mc || col > g.colMax + mc) return null
  return { row, col, err }
}
