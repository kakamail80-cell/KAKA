// 프레임 1장 처리: 라벨 검출 → OCR → 격자 → 칸번호 부여
import { detectLabels } from './detect.js'
import { readLabels } from './ocr.js'
import { estimateGrid, predictCell } from './grid.js'

export const cellName = (row, col) => `A-${row}-${col}`

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
  const pts = accepted.map((l) => ({ cx: l.cx, cy: l.cy, row: l.ocr.row, col: l.ocr.col }))
  const grid = estimateGrid(pts)

  if (grid) {
    const inl = new Set(grid.inliers.map((k) => accepted[k]))
    for (const l of labels) {
      if (inl.has(l)) {
        l.cell = { row: l.ocr.row, col: l.ocr.col }
        l.source = 'ocr'
      } else {
        // OCR 결과가 격자와 어긋나면(오인식 의심) 버리고 위치로 추정한다
        const c = predictCell(grid, l.cx, l.cy)
        if (c) {
          l.cell = c
          l.source = 'grid'
        }
      }
    }
  }
  for (const l of labels) if (l.cell) l.name = cellName(l.cell.row, l.cell.col)

  return {
    w,
    h,
    labels,
    grid,
    nRead: accepted.length,
    ms: performance.now() - t0,
    tDetect: t1 - t0,
    tOcr: t2 - t1,
  }
}
