// 프레임 1장 처리: 라벨 검출 → OCR → 격자 → 칸번호 부여
import { detectLabels } from './detect.js'
import { readLabels } from './ocr.js'
import { estimateGrid, predictCell } from './grid.js'

export const cellName = (panel, row, col) => `${panel}-${row}-${col}`

let frameCanvas = null

/** video 현재 프레임을 캔버스로 고정 (처리 중 영상이 넘어가도 좌표가 어긋나지 않게) */
export function grabFrame(video) {
  const w = video.videoWidth, h = video.videoHeight
  if (!frameCanvas) frameCanvas = document.createElement('canvas')
  if (frameCanvas.width !== w || frameCanvas.height !== h) {
    frameCanvas.width = w
    frameCanvas.height = h
  }
  frameCanvas.getContext('2d').drawImage(video, 0, 0, w, h)
  return frameCanvas
}

/**
 * @returns {Promise<{w:number,h:number,labels:Array,grid:object|null,nRead:number,ms:number,tDetect:number,tOcr:number}>}
 */
export async function processFrame(frame) {
  const t0 = performance.now()
  const w = frame.width, h = frame.height
  const boxes = detectLabels(frame, w, h)
  const t1 = performance.now()
  const reads = await readLabels(frame, boxes)
  const t2 = performance.now()

  const labels = boxes.map((b, i) => ({
    ...b,
    cx: b.x + b.w / 2,
    cy: b.y + b.h / 2,
    ocr: reads[i],
    cell: null,
    source: null,
  }))
  const accepted = labels.filter((l) => l.ocr && l.ocr.row != null)

  // 패널(A~D)별로 격자 추정
  const grids = {}
  for (const panel of new Set(accepted.map((l) => l.ocr.panel))) {
    const mine = accepted.filter((l) => l.ocr.panel === panel)
    const g = estimateGrid(mine.map((l) => ({ cx: l.cx, cy: l.cy, row: l.ocr.row, col: l.ocr.col, conf: l.ocr.conf })))
    if (!g) continue
    g.panel = panel
    grids[panel] = g
    for (const k of g.inliers) {
      const l = mine[k]
      l.cell = { panel, row: l.ocr.row, col: l.ocr.col }
      l.source = 'ocr'
      l.grid = g
    }
  }

  // 못 읽었거나 격자와 어긋난(오인식 의심) 라벨은 위치로 추정. 여러 패널이 겹치면 오차가 작은 쪽
  const gridList = Object.values(grids)
  for (const l of labels) {
    if (l.cell) continue
    const readPanel = /^[A-D]/.exec(l.ocr?.text || '')?.[0]
    let best = null
    for (const g of gridList) {
      if (readPanel && readPanel !== g.panel) continue
      const c = predictCell(g, l.cx, l.cy)
      if (c && (!best || c.err < best.c.err)) best = { g, c }
    }
    if (best) {
      l.cell = { panel: best.g.panel, row: best.c.row, col: best.c.col }
      l.source = 'grid'
      l.grid = best.g
    }
  }
  for (const l of labels) if (l.cell) l.name = cellName(l.cell.panel, l.cell.row, l.cell.col)

  return {
    w,
    h,
    labels,
    grid: gridList.length ? gridList[0] : null,
    grids,
    nRead: accepted.length,
    ms: performance.now() - t0,
    tDetect: t1 - t0,
    tOcr: t2 - t1,
  }
}
