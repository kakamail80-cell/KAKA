// 격자 모델 추정 (run.py 로직 이식)
// 열 = a·x + b, 행 = c·y + d. 두 점 조합 RANSAC, 일치 3개 이상일 때만 격자 ON

export const GRID_PARAMS = {
  tol: 0.35, // 행/열 단위 허용 오차 (인라이어 판정)
  assignTol: 0.3, // 못 읽은 라벨에 번호를 붙일 때 허용 오차
  minInliers: 3,
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

  // 인라이어로 최소제곱 재추정
  const ip = best.inliers.map((k) => pts[k])
  const fx = fitLine(ip.map((q) => q.cx), ip.map((q) => q.col))
  const fy = fitLine(ip.map((q) => q.cy), ip.map((q) => q.row))
  if (fx && fy && fx[0] > 0 && fy[0] > 0) {
    const ok = ip.every(
      (q) => Math.abs(fx[0] * q.cx + fx[1] - q.col) < p.tol && Math.abs(fy[0] * q.cy + fy[1] - q.row) < p.tol,
    )
    if (ok) return { a: fx[0], b: fx[1], c: fy[0], d: fy[1], inliers: best.inliers }
  }
  return best
}

/** 격자로 위치 → 칸번호 추정. 오차가 크면 null */
export function predictCell(g, cx, cy, p = GRID_PARAMS) {
  const colF = g.a * cx + g.b
  const rowF = g.c * cy + g.d
  const col = Math.round(colF), row = Math.round(rowF)
  if (Math.abs(colF - col) > p.assignTol || Math.abs(rowF - row) > p.assignTol) return null
  if (row < 1 || col < 1) return null
  return { row, col }
}
