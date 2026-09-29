// 조사 루트: 엑셀 대상 행 → 칸 단위로 묶고, 확대 상태로 벽을 따라 이동하기 좋은 순서로 정렬
// 패널 알파벳 순 → 행 오름차순 → 행마다 열 방향을 번갈아(지그재그) 이동 거리 최소화

export function parseCell(name) {
  const m = /^([A-Z])-(\d{1,2})-(\d{1,2})$/.exec(name)
  return m ? { panel: m[1], row: +m[2], col: +m[3] } : null
}

/**
 * @param {Array<{row:number, code:string, cell:string, sub:number|null, excluded:boolean, option:string, product:string}>} items 엑셀 행
 * @returns {Array<{cell:string, panel:string, row:number, col:number, kind:'shoot'|'locate', items:Array}>}
 */
export function buildRoute(items) {
  const byCell = new Map()
  for (const it of items) {
    if (it.excluded) continue
    if (!byCell.has(it.cell)) byCell.set(it.cell, [])
    byCell.get(it.cell).push(it)
  }
  const stops = [...byCell.entries()].map(([cell, its]) => ({
    cell,
    ...parseCell(cell),
    // _번호가 붙은 상품은 서랍식 보관이라 촬영 없이 위치만 안내
    kind: its.some((i) => i.sub != null) ? 'locate' : 'shoot',
    items: its,
  }))
  stops.sort((p, q) => {
    if (p.panel !== q.panel) return p.panel < q.panel ? -1 : 1
    if (p.row !== q.row) return p.row - q.row
    // 같은 패널 안에서 행 순번이 홀수/짝수에 따라 열 방향 반대
    return p.row % 2 ? p.col - q.col : q.col - p.col
  })
  return stops
}

/**
 * 현재 격자 기준 목표 칸의 화면 위치와 칸 단위 거리
 * @returns {{onScreen:boolean, x:number, y:number, dCol:number, dRow:number}|null} 같은 패널 격자가 없으면 null
 */
export function locate(stop, grids, w, h) {
  const g = grids[stop.panel]
  if (!g) return null
  const x = (stop.col - g.b) / g.a
  const y = (stop.row - g.d) / g.c
  const cCol = g.a * (w / 2) + g.b
  const cRow = g.c * (h / 2) + g.d
  // 칸이 화면에 조금이라도 걸치면 박스를 미리 표시 (라벨 중심이 화면 밖 반 칸까지)
  const mx = 0.5 / g.a, my = 0.5 / g.c
  return {
    x,
    y,
    dCol: Math.round(stop.col - cCol),
    dRow: Math.round(stop.row - cRow),
    onScreen: x > -mx && x < w + mx && y > -my && y < h + my,
    pitchX: 1 / g.a,
    pitchY: 1 / g.c,
  }
}
