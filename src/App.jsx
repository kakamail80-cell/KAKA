import { useCallback, useEffect, useRef, useState } from 'react'
import { grabFrame, processFrame } from './lib/pipeline.js'
import { readLabels, setPanels } from './lib/ocr.js'
import { exportZip, getShot, loadSession, saveSession, saveShot } from './lib/store.js'
import { readTargets, writeStock } from './lib/excel.js'
import { buildRoute, locate } from './lib/route.js'
import { countItems, extractCell } from './lib/count.js'
import { driftFromReads, photoGridToVideo, trackFrame, TRACK_PARAMS } from './lib/track.js'

const REF_VIDEO = '/참고/재고칸_인식테스트_영상.mp4'
// 촬영 사진 크롭 범위 (격자 한 칸 간격 기준, 라벨 중심에서)
const CELL_CROP = { side: 0.6, up: 1.0, down: 0.3 }
// 가운데 고정 촬영 프레임 (화면 대비 비율). 사람이 먼저 찾은 칸을 여기에 맞춰 찍으면 그 칸을 저장
const CENTER_FRAME = { w: 0.26, cellAspect: 0.56 } // 폭 = 화면의 26%, 높이 = 폭 × 칸 세로/가로 비(실측 0.54~0.59)
const frameH = (vw, vh) => CENTER_FRAME.w * (vw / vh) * CENTER_FRAME.cellAspect
const VERIFY_MS = 600 // 추적 중 OCR로 밀림 확인 주기
const VERIFY_N = 4 // 확인할 라벨 수 (화면 중앙 가까운 순)
const PHOTO_MAX_OCR = 14 // 사진 분석 시 읽는 라벨 수 (가운데·큰 라벨 우선)
const CAPTURE_MIN_LABEL_RATIO = 0.04 // 칸 사진 저장 최소 라벨 폭 (사진 폭 대비). 4K 근접 ≈ 6%, 벽 전체 ≈ 1.4%
const RESOLUTIONS = {
  '4k': { label: '4K', w: 3840, h: 2160 },
  fhd: { label: 'FHD', w: 1920, h: 1080 },
  hd: { label: 'HD', w: 1280, h: 720 },
}
const loadRes = () => {
  try {
    const r = localStorage.getItem('resolution')
    if (RESOLUTIONS[r]) return r
  } catch {}
  return 'fhd'
}

const CELL_RE = /([A-Z])-(\d{1,2})-(\d{1,2})/g
const parseCells = (text) => [
  ...new Set([...text.toUpperCase().matchAll(CELL_RE)].map((m) => `${m[1]}-${+m[2]}-${+m[3]}`)),
]

const emptySession = () => ({ fileName: null, file: null, stops: [], results: {}, idx: 0 })

function nextPending(s, from) {
  const n = s.stops.length
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n
    if (!s.results[s.stops[i].cell]) return i
  }
  return -1
}

const PATH_AHEAD = 6 // 연결선·미리보기 박스로 보여줄 다음 대상 수

// ── 오버레이: 라벨 + 루트 연결선(화면 중앙 → 현재 대상 → 다음 대상들) + 대상 박스 ──
function drawOverlay(canvas, res, stop, loc, hit, ahead = []) {
  const { w, h } = res
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  const u = w / 640
  ctx.font = `bold ${Math.round(10 * u)}px sans-serif`
  ctx.textBaseline = 'bottom'
  // 멀리서 라벨이 많이 보일 때는 번호 글자를 생략 (안내선·대상 박스가 잘 보이도록)
  const showNames = res.labels.length <= 40
  for (const l of res.labels) {
    if (!l.name) continue
    ctx.lineWidth = 1 * u
    ctx.strokeStyle = l.source === 'ocr' ? 'rgba(143,211,255,.8)' : 'rgba(210,210,210,.6)'
    ctx.strokeRect(l.x, l.y, l.w, l.h)
    if (!showNames) continue
    ctx.fillStyle = 'rgba(0,0,0,.55)'
    const tw = ctx.measureText(l.name).width
    ctx.fillRect(l.x, l.y - 12 * u, tw + 6 * u, 12 * u)
    ctx.fillStyle = '#fff'
    ctx.fillText(l.name, l.x + 3 * u, l.y - 1 * u)
  }
  if (!stop || !loc) return

  const colorOf = (s) => (s.kind === 'locate' ? '#ffa31a' : '#22ff55')
  // 칸 박스 중심: 라벨은 칸 아래쪽에 있으므로 라벨 중심에서 위로 약간 올린 위치
  const boxOf = (x, y) => {
    const bw = loc.pitchX * 0.9, bh = loc.pitchY * 0.9
    return { x: x - bw / 2, y: y - bh * 0.75, w: bw, h: bh, cx: x, cy: y - bh * 0.25 }
  }
  const cur = boxOf(hit ? hit.cx : loc.x, hit ? hit.cy : loc.y)

  // 1) 연결선: 화면 중앙 → 현재 대상 → 다음 대상들 (화면 밖이면 선이 가장자리로 이어져 방향을 알려줌)
  const pts = [{ x: w / 2, y: h / 2 }, { x: cur.cx, y: cur.cy }]
  for (const a of ahead) pts.push({ x: a.loc.x, y: a.loc.y - a.loc.pitchY * 0.2 })
  // 모든 구간을 같은 녹색 점선으로 (어두운 테두리를 먼저 그려 밝은 배경에서도 보이게)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([16 * u, 11 * u])
  for (const [color, width] of [['rgba(0,0,0,.45)', 7], ['#22ff55', 4]]) {
    ctx.strokeStyle = color
    ctx.lineWidth = width * u
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // 2) 다음 대상 미리보기 박스 (번호)
  ctx.font = `bold ${Math.round(13 * u)}px sans-serif`
  ahead.forEach((a, k) => {
    if (!a.loc.onScreen) return
    const b = boxOf(a.loc.x, a.loc.y)
    ctx.lineWidth = 2.5 * u
    ctx.strokeStyle = colorOf(a.stop)
    ctx.globalAlpha = 0.75
    ctx.strokeRect(b.x, b.y, b.w, b.h)
    ctx.globalAlpha = 1
    const t = `${k + 2}. ${a.stop.cell}`
    ctx.fillStyle = 'rgba(0,0,0,.6)'
    ctx.fillRect(b.x, b.y - 17 * u, ctx.measureText(t).width + 8 * u, 17 * u)
    ctx.fillStyle = '#fff'
    ctx.fillText(t, b.x + 4 * u, b.y - 3 * u)
  })

  // 3) 현재 대상 박스 (굵게) — 라벨을 못 읽었어도 격자 예측 위치에 미리 표시
  if (loc.onScreen || hit) {
    ctx.lineWidth = 7 * u
    ctx.strokeStyle = colorOf(stop)
    ctx.strokeRect(cur.x, cur.y, cur.w, cur.h)
    ctx.font = `bold ${Math.round(16 * u)}px sans-serif`
    const t = stop.kind === 'locate' ? `1. ${stop.cell} 서랍 · 위치 확인` : `1. ${stop.cell}`
    const tw = ctx.measureText(t).width
    ctx.fillStyle = 'rgba(0,0,0,.75)'
    ctx.fillRect(cur.x, cur.y - 22 * u, tw + 12 * u, 22 * u)
    ctx.fillStyle = colorOf(stop)
    ctx.fillText(t, cur.x + 6 * u, cur.y - 3 * u)
  } else {
    // 화면 밖이면 선 끝(가장자리)에 방향 화살촉
    const dx = cur.cx - w / 2, dy = cur.cy - h / 2
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const tEdge = Math.min(Math.abs((w / 2 - 30 * u) / (ux || 1e-6)), Math.abs((h / 2 - 30 * u) / (uy || 1e-6)))
    const ax = w / 2 + ux * tEdge, ay = h / 2 + uy * tEdge
    const hs = 30 * u
    ctx.fillStyle = colorOf(stop)
    ctx.beginPath()
    ctx.moveTo(ax + ux * hs * 0.6, ay + uy * hs * 0.6)
    ctx.lineTo(ax - ux * hs * 0.6 - uy * hs * 0.7, ay - uy * hs * 0.6 + ux * hs * 0.7)
    ctx.lineTo(ax - ux * hs * 0.6 + uy * hs * 0.7, ay - uy * hs * 0.6 - ux * hs * 0.7)
    ctx.closePath()
    ctx.fill()
  }
}

function dirText(loc) {
  if (!loc) return ''
  const parts = []
  if (loc.dCol) parts.push(`${loc.dCol > 0 ? '→' : '←'} ${Math.abs(loc.dCol)}칸`)
  if (loc.dRow) parts.push(`${loc.dRow > 0 ? '↓' : '↑'} ${Math.abs(loc.dRow)}칸`)
  return parts.join('  ') || '여기'
}

const toBlob = (canvas, q = 0.9) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', q))

export default function App() {
  const videoRef = useRef(null)
  const overlayRef = useRef(null)
  const stageRef = useRef(null)
  const runRef = useRef({ token: 0 })
  const sessionRef = useRef(emptySession())
  const modalRef = useRef(null)
  const stepRef = useRef(0.2)
  const modeRef = useRef('idle')
  const flashRef = useRef(null)
  const guideRef = useRef(null)
  const trackRef = useRef({ grid: null, lost: 0, lastVerify: 0, verifying: false, avgBoxes: 0, blur: 0 })
  const busyRef = useRef(false)
  const autoConfirmRef = useRef(false) // 시연 녹화 시 개수 창 없이 자동 기록
  const [busy, setBusy] = useState(false)
  const [resolution, setResolution] = useState(loadRes())
  const [camRes, setCamRes] = useState('') // 카메라가 실제로 켜진 해상도 (기기가 지원 안 하면 요청보다 낮음)
  const changeResolution = (k) => {
    setResolution(k)
    try {
      localStorage.setItem('resolution', k)
    } catch {}
    if (modeRef.current === 'camera') startCamera(k)
  }

  const [session, setSessionState] = useState(emptySession())
  const [mode, setModeState] = useState('idle') // idle | file | camera
  const setMode = (m) => {
    modeRef.current = m
    setModeState(m)
  }
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState(null)
  const [msg, setMsg] = useState('OCR 엔진 준비 중…')
  const [fileTime, setFileTime] = useState({ t: 0, dur: 0 })
  const [guide, setGuide] = useState(null) // { dir, panelMsg }
  const [modal, setModal] = useState(null) // 개수 확정 창 { stop, shotId, url, auto }
  const [showList, setShowList] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manualText, setManualText] = useState('')
  const [fit, setFit] = useState({ w: 0, h: 0 })
  const [vidSize, setVidSize] = useState({ w: 16, h: 9 })

  const setSession = (s) => {
    sessionRef.current = s
    setSessionState(s)
    saveSession(s).catch(() => {})
    setPanels([...new Set(s.stops.map((x) => x.panel))])
  }
  const setModalBoth = (m) => {
    modalRef.current = m
    setModal(m)
  }

  useEffect(() => {
    setMsg('문자 인식 준비 완료 — [카메라]를 누르세요')
    loadSession().then((s) => s && setSession(s), () => {})
    window.__log = []
  }, [])

  useEffect(() => {
    const el = stageRef.current
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth, H = el.clientHeight
      const r = vidSize.w / vidSize.h
      setFit(W / H > r ? { w: H * r, h: H } : { w: W, h: W / r })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [vidSize])

  const current = () => {
    const s = sessionRef.current
    return s.stops.length && s.idx >= 0 ? s.stops[s.idx] : null
  }

  // ── 처리 결과: 안내 표시, 자동 촬영 ──
  const handleResult = useCallback(async (frame, res, extra = {}) => {
    if (import.meta.env.DEV) window.__lastRes = res
    const stop = current()
    const loc = stop ? locate(stop, res.grids, res.w, res.h) : null
    const hit = stop ? res.labels.find((l) => l.name === stop.cell) : null
    // 다음 대상들 (같은 패널 격자로 위치를 알 수 있는 것만, 미조사)
    const ahead = []
    const s = sessionRef.current
    if (stop && loc) {
      for (let k = 1; k < s.stops.length && ahead.length < PATH_AHEAD; k++) {
        const st = s.stops[(s.idx + k) % s.stops.length]
        if (st === stop || s.results[st.cell]) continue
        const l2 = locate(st, res.grids, res.w, res.h)
        if (!l2) break // 다른 패널로 넘어가면 선은 거기까지
        ahead.push({ stop: st, loc: l2 })
      }
    }
    drawOverlay(overlayRef.current, res, stop, loc, hit, ahead)
    // 방금 촬영한 칸 결과 표시 (영상 테스트)
    const fl = flashRef.current
    if (fl && extra.t != null && extra.t <= fl.until) {
      const ctx = overlayRef.current.getContext('2d')
      const u = res.w / 640
      const t = `📸 ${fl.cell}  ${fl.label === '3+' ? '3개 이상 · 확인필요' : fl.label + '개'}`
      ctx.font = `bold ${Math.round(20 * u)}px sans-serif`
      const tw = ctx.measureText(t).width
      ctx.fillStyle = 'rgba(0,120,40,.85)'
      ctx.fillRect(fl.x - tw / 2 - 10 * u, fl.y - 30 * u, tw + 20 * u, 30 * u)
      ctx.fillStyle = '#fff'
      ctx.fillText(t, fl.x - tw / 2, fl.y - 6 * u)
    }
    const tracking = !!res.grid
    setStats({ tracking, nLabels: res.labels.length, named: res.labels.filter((l) => l.name).length, ms: res.ms })

    let panelMsg = ''
    if (stop && !loc) {
      const seen = Object.keys(res.grids)
      panelMsg = seen.length ? `${stop.panel} 패널로 이동 후 사진` : '📷 사진을 찍어 위치를 잡아 주세요'
    }
    const gd = stop ? { dir: loc ? dirText(loc) : '', panelMsg, onScreen: !!(loc?.onScreen || hit) } : null
    guideRef.current = gd
    setGuide(gd)
    window.__log.push({ ...extra, tracking, ms: Math.round(res.ms), stop: stop?.cell, hit: !!hit, dir: loc && dirText(loc) })
  }, [])

  // ── 영상 1프레임: OCR 없이 추적 + 가끔 OCR로 밀림 확인 ──
  const trackStep = async (frame, extra = {}) => {
    const tr = trackRef.current
    const res = trackFrame(frame, tr.grid)
    // 느린 기기: 추적 1프레임이 평균 0.1초를 넘으면 검출 해상도를 낮춤 (960 → 720 → 560)
    tr.avgMs = tr.avgMs ? tr.avgMs * 0.8 + res.ms * 0.2 : res.ms
    if (tr.avgMs > 100 && TRACK_PARAMS.procWidth > 560) {
      TRACK_PARAMS.procWidth = TRACK_PARAMS.procWidth > 720 ? 720 : 560
      tr.avgMs = 0
    }
    // 흔들림 감지: 검출 라벨 수가 평소의 60% 밑으로 떨어진 프레임이 연속되면 번호가 밀렸을 수 있음 → 위치 잃음
    const blurry = tr.avgBoxes > 0 && res.nBoxes < tr.avgBoxes * 0.6
    tr.blur = blurry ? (tr.blur || 0) + 1 : 0
    if (!blurry) tr.avgBoxes = tr.avgBoxes ? tr.avgBoxes * 0.7 + res.nBoxes * 0.3 : res.nBoxes
    if (tr.grid && tr.blur >= 2) {
      tr.grid = null
      setMsg('화면이 흔들렸습니다 — 📷 사진을 찍어 위치를 다시 잡아 주세요')
      res.grid = null
      res.grids = {}
      res.labels = res.labels.map((l) => ({ ...l, name: undefined }))
    }
    if (tr.grid) {
      if (res.grid) {
        tr.grid = res.grid
        tr.lost = 0
      } else if (++tr.lost >= TRACK_PARAMS.lostFrames) {
        tr.grid = null
        setMsg('위치를 놓쳤습니다 — 📷 사진을 찍어 주세요')
      }
    }
    await handleResult(frame, res, extra)
    // 1.5초마다 화면 중앙 라벨 몇 개만 OCR해서 추적이 한 칸씩 밀렸는지 확인 (기다리지 않고 뒤에서)
    const now = performance.now()
    // 줌 등으로 보이는 라벨 수가 마지막 확인 때보다 1.5배 넘게 변하면 주기를 기다리지 않고 바로 확인
    const countJump = tr.verifyBoxes && (res.nBoxes > tr.verifyBoxes * 1.5 || res.nBoxes < tr.verifyBoxes / 1.5)
    if (tr.grid && !tr.verifying && (now - tr.lastVerify > VERIFY_MS || countJump)) {
      const named = res.labels
        .filter((l) => l.name && l.w >= 40)
        .sort((p, q) => Math.hypot(p.cx - res.w / 2, p.cy - res.h / 2) - Math.hypot(q.cx - res.w / 2, q.cy - res.h / 2))
        .slice(0, VERIFY_N)
      if (named.length >= 2) {
        tr.verifying = true
        tr.lastVerify = now
        tr.verifyBoxes = res.nBoxes
        readLabels(frame, named) // 크롭은 호출 즉시 만들어지므로 프레임이 바뀌어도 안전
          .then((reads) => {
            const dr = driftFromReads(named, reads)
            if (!tr.grid) return
            // 확인용 OCR이 라벨을 못 읽음(흔들림) → 연속 2번이면 번호가 밀렸는지 알 수 없으므로 위치 잃음
            tr.unreadable = dr.total < 2 ? (tr.unreadable || 0) + 1 : 0
            if (tr.unreadable >= 2) {
              tr.grid = null
              tr.unreadable = 0
              setMsg('화면이 흔들렸습니다 — 📷 사진을 찍어 위치를 다시 잡아 주세요')
              return
            }
            if (dr.votes >= 2 && (dr.dRow || dr.dCol)) {
              // 2개 이상이 같은 만큼 어긋남 → 그만큼 보정
              tr.grid = { ...tr.grid, b: tr.grid.b + dr.dCol, d: tr.grid.d + dr.dRow }
              setMsg(`위치 보정 (${dr.dRow ? `${dr.dRow}행 ` : ''}${dr.dCol ? `${dr.dCol}열` : ''})`)
            } else if (dr.total >= 2 && dr.agree === 0) {
              // 읽힌 라벨이 모두 추적 번호와 다르고 일관된 보정도 없음 → 틀린 안내 대신 위치 잃음
              tr.grid = null
              setMsg('위치가 불확실합니다 — 📷 사진을 찍어 주세요')
            }
          })
          .finally(() => (tr.verifying = false))
      }
    }
    return res
  }

  // ── 사진: 위치 잡기 + (대상 칸이 보이면) 칸 확인·저장·개수 ──
  const takePhoto = async () => {
    if (busyRef.current || modalRef.current) return
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    busyRef.current = true
    setBusy(true)
    setMsg('사진 분석 중…')
    try {
      // 1) 선명한 사진: 가능하면 카메라 최대 화질 정지 사진, 안 되면 영상 프레임
      let photo = null
      const track = v.srcObject?.getVideoTracks?.()[0]
      if (track && window.ImageCapture) {
        try {
          const blob = await new window.ImageCapture(track).takePhoto()
          const bmp = await createImageBitmap(blob)
          photo = document.createElement('canvas')
          photo.width = bmp.width
          photo.height = bmp.height
          photo.getContext('2d').drawImage(bmp, 0, 0)
        } catch {
          photo = null
        }
      }
      if (!photo) {
        const f = grabFrame(v)
        photo = document.createElement('canvas')
        photo.width = f.width
        photo.height = f.height
        photo.getContext('2d').drawImage(f, 0, 0)
      }

      // 2) 사진 전체 OCR → 격자
      // 전용 인식기(빠름): 가운데·큰 라벨 14개 → 실패하면 전부 → 그래도 실패하면 tesseract(느림) 14개
      let pres = await processFrame(photo, { maxOcr: PHOTO_MAX_OCR })
      if (!Object.keys(pres.grids).length && pres.labels.length > PHOTO_MAX_OCR) pres = await processFrame(photo)
      if (!Object.keys(pres.grids).length) {
        setMsg('정밀 인식 중… (처음 한 번은 인식 엔진을 내려받아 조금 걸립니다)')
        pres = await processFrame(photo, { maxOcr: PHOTO_MAX_OCR, engine: 'tesseract' })
      }
      const stop = current()
      const grids = Object.values(pres.grids)
      const g = (stop && pres.grids[stop.panel]) || grids.sort((p, q) => q.inliers.length - p.inliers.length)[0]
      if (!g) {
        setMsg('라벨을 읽지 못했습니다 — 라벨이 3개 이상 보이게 다시 찍어 주세요')
        return
      }

      // 3) 사진 격자 → 영상 좌표로 옮겨 추적 시작
      const guess = photoGridToVideo(g, photo.width, photo.height, v.videoWidth, v.videoHeight)
      const vres = trackFrame(grabFrame(v), guess)
      trackRef.current = { ...trackRef.current, grid: vres.grid || guess, lost: 0, blur: 0, avgBoxes: vres.nBoxes, lastVerify: performance.now(), verifyBoxes: vres.nBoxes }

      // 4) 확인·저장할 칸 고르기
      //    ① 가운데 고정 프레임 안에 든 칸 (사람이 먼저 찾아 맞춘 경우) → 조사 대상이면 순서와 무관하게 저장
      //    ② 없으면 사진에 온전히 담긴 미조사 대상 (현재 안내 대상 우선)
      const s = sessionRef.current
      const sPh = photo.width / v.videoWidth
      const oyPh = (photo.height - v.videoHeight * sPh) / 2
      const fr = {
        x0: v.videoWidth * (0.5 - CENTER_FRAME.w / 2) * sPh,
        x1: v.videoWidth * (0.5 + CENTER_FRAME.w / 2) * sPh,
        y0: v.videoHeight * (0.5 - frameH(v.videoWidth, v.videoHeight) / 2) * sPh + oyPh,
        y1: v.videoHeight * (0.5 + frameH(v.videoWidth, v.videoHeight) / 2) * sPh + oyPh,
      }
      // 칸 중심 = 라벨 중심에서 칸 높이의 1/4 위 (라벨은 칸 아래쪽)
      const inFrame = pres.labels
        .filter((l) => l.name && l.grid)
        .map((l) => ({ l, x: l.cx, y: l.cy - 0.25 / l.grid.c }))
        .filter((q) => q.x > fr.x0 && q.x < fr.x1 && q.y > fr.y0 && q.y < fr.y1)
        .sort((p, q) => Math.hypot(p.x - (fr.x0 + fr.x1) / 2, p.y - (fr.y0 + fr.y1) / 2) - Math.hypot(q.x - (fr.x0 + fr.x1) / 2, q.y - (fr.y0 + fr.y1) / 2))[0]?.l
      const pendingShoot = (name) => s.stops.find((st) => st.cell === name && st.kind === 'shoot' && !s.results[st.cell])
      // 멀리서 찍은 사진은 칸이 너무 작아 개수 확인이 안 되므로 위치 확인만 (라벨 폭이 사진 폭의 4% 이상일 때 저장)
      const bigEnough = (l) => l.w >= photo.width * CAPTURE_MIN_LABEL_RATIO
      let pick = null
      let cellImg = null
      if (inFrame) {
        const st = pendingShoot(inFrame.name)
        const e = extractCell(photo, inFrame, inFrame.grid)
        if (st && e.inside && bigEnough(inFrame)) {
          pick = { st, l: inFrame }
          cellImg = e
        }
      }
      if (!pick) {
        const cands = s.stops
          .filter((st) => st.kind === 'shoot' && !s.results[st.cell])
          .map((st) => ({ st, l: pres.labels.find((l) => l.name === st.cell) }))
          .filter((c) => c.l && bigEnough(c.l))
          .sort((p, q) => (q.st === stop) - (p.st === stop))
        pick = cands.find((c) => (cellImg = extractCell(photo, c.l, c.l.grid)).inside) || null
      }
      if (!pick) {
        const here = pres.labels.find((l) => l.name)?.name
        const done = inFrame && s.results[inFrame.name]
        const named = pres.labels.filter((l) => l.name)
        const far = named.length && !named.some(bigEnough)
        setMsg(
          far
            ? `위치 확인 ✓ (${here || g.panel + ' 패널'} 근처) — 대상 칸까지 가까이 가서 다시 찍어 주세요`
            : inFrame && !s.stops.some((st) => st.cell === inFrame.name)
            ? `${inFrame.name} 은(는) 조사 대상이 아닙니다 (위치 확인 ✓)`
            : done
              ? `${inFrame.name} 은(는) 이미 조사했습니다 (목록에서 수정 가능)`
              : stop && guideRef.current?.onScreen
                ? `${stop.cell} 칸이 사진에 온전히 안 담겼습니다 — 가운데 프레임에 맞춰 다시 찍어 주세요`
                : `위치 확인 ✓ (${here || g.panel + ' 패널'} 근처) — 안내를 따라 이동하세요`,
        )
        return
      }
      const capStop = pick.st
      const hitL = pick.l
      const px = 1 / hitL.grid.a, py = 1 / hitL.grid.c
      const x0 = Math.max(0, hitL.cx - px * CELL_CROP.side), x1 = Math.min(photo.width, hitL.cx + px * CELL_CROP.side)
      const y0 = Math.max(0, hitL.cy - py * CELL_CROP.up), y1 = Math.min(photo.height, hitL.cy + py * CELL_CROP.down)
      const crop = document.createElement('canvas')
      crop.width = Math.round(x1 - x0)
      crop.height = Math.round(y1 - y0)
      crop.getContext('2d').drawImage(photo, x0, y0, x1 - x0, y1 - y0, 0, 0, crop.width, crop.height)
      const neighbors = pres.labels
        .filter((l) => l !== hitL && l.name && l.grid)
        .map((l) => extractCell(photo, l, l.grid))
        .filter((e) => e.inside)
      const auto = countItems(cellImg, neighbors)
      const [cropBlob, fullBlob] = await Promise.all([toBlob(crop), toBlob(photo, 0.85)])
      const shotId = await saveShot({ cell: capStop.cell, time: Date.now(), crop: cropBlob, full: fullBlob })
      setMsg(`📸 ${capStop.cell} 확인·저장`)
      if (modeRef.current === 'file') {
        // 영상 테스트: 사진=영상 프레임이라 좌표가 같음 → 결과를 잠깐 표시
        flashRef.current = { cell: capStop.cell, label: auto.label, x: hitL.cx, y: hitL.cy - py * 0.3, until: v.currentTime + 1.5 }
      }
      if (modeRef.current === 'file' && autoConfirmRef.current) {
        // 시연 녹화: 창 없이 자동 인식값으로 기록
        const ns = {
          ...s,
          results: { ...s.results, [capStop.cell]: { count: auto.count, needCheck: auto.needCheck, auto: auto.count, autoOnly: true, shotId, time: Date.now() } },
        }
        ns.idx = nextPending(ns, capStop === stop ? s.idx + 1 : s.idx)
        setSession(ns)
        return { cell: capStop.cell, auto: auto.count }
      }
      setModalBoth({ stop: capStop, shotId, url: URL.createObjectURL(cropBlob), auto: auto.count })
      return { cell: capStop.cell, auto: auto.count }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // ── 개수 확정 / 이동 ──
  const confirmCount = (count) => {
    const m = modalRef.current
    if (!m || !Number.isFinite(count) || count < 0) return
    const s = sessionRef.current
    const results = {
      ...s.results,
      [m.stop.cell]: { count, needCheck: count >= 3, auto: m.auto, shotId: m.shotId, time: Date.now() },
    }
    const ns = { ...s, results }
    // 현재 대상을 찍었으면 다음으로, 지나가며 다른 대상을 찍었으면 현재 대상 유지 (수정 시에도 유지)
    const isCur = s.stops[s.idx]?.cell === m.stop.cell
    ns.idx = nextPending(ns, isCur ? s.idx + 1 : Math.max(0, s.idx))
    setSession(ns)
    URL.revokeObjectURL(m.url)
    setModalBoth(null)
  }
  const retake = () => {
    const m = modalRef.current
    if (m) URL.revokeObjectURL(m.url)
    setModalBoth(null)
  }
  const markLocated = () => {
    const s = sessionRef.current
    const stop = current()
    if (!stop) return
    const ns = { ...s, results: { ...s.results, [stop.cell]: { located: true, time: Date.now() } } }
    ns.idx = nextPending(ns, s.idx + 1)
    setSession(ns)
  }
  const go = (delta) => {
    const s = sessionRef.current
    if (!s.stops.length) return
    const n = s.stops.length
    setSession({ ...s, idx: (((s.idx < 0 ? 0 : s.idx) + delta) % n + n) % n })
  }
  const jumpTo = (i) => {
    setSession({ ...sessionRef.current, idx: i })
    setShowList(false)
  }
  const editResult = async (stop) => {
    const r = sessionRef.current.results[stop.cell]
    if (!r?.shotId) return jumpTo(sessionRef.current.stops.indexOf(stop))
    const shot = await getShot(r.shotId)
    setShowList(false)
    setModalBoth({ stop, shotId: r.shotId, url: URL.createObjectURL(shot.crop), auto: r.auto, edit: true })
  }

  // ── 엑셀 ──
  const onPickExcel = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const { items } = await readTargets(f)
      const stops = buildRoute(items)
      const old = sessionRef.current
      const keep = old.fileName === f.name && confirm('같은 파일의 이전 조사 결과를 이어서 할까요?')
      const ns = { fileName: f.name, file: f, stops, results: keep ? old.results : {}, idx: 0 }
      ns.idx = Math.max(0, nextPending(ns, 0))
      setSession(ns)
      const nLoc = stops.filter((x) => x.kind === 'locate').length
      setMsg(`${f.name}: 피어싱 ${items.length}행 → ${stops.length}칸 (서랍 위치안내 ${nLoc})`)
    } catch (err) {
      alert('엑셀을 읽을 수 없습니다: ' + err.message)
    }
  }

  // 엑셀 C열 기록 — 샘플 단계에서는 버튼을 숨겨 둠 (다음 단계에서 연결)
  // eslint-disable-next-line no-unused-vars
  const applyExcel = async () => {
    const s = sessionRef.current
    if (!s.file) return alert('엑셀로 불러온 조사만 적용할 수 있습니다')
    const values = {}
    for (const stop of s.stops) {
      const r = s.results[stop.cell]
      if (!r || r.count == null) continue
      for (const it of stop.items) if (it.row) values[it.row] = r.count
    }
    const n = Object.keys(values).length
    if (!n) return alert('기록할 개수가 없습니다')
    const pend = s.stops.filter((x) => !s.results[x.cell]).length
    if (!confirm(`${s.fileName}\n'재고입력' C열에 ${n}행을 기록합니다.${pend ? `\n(미조사 ${pend}칸은 비워 둡니다)` : ''}\n진행할까요?`)) return
    const blob = await writeStock(s.file, values)
    try {
      if (window.showSaveFilePicker) {
        const h = await window.showSaveFilePicker({ suggestedName: s.fileName })
        const wr = await h.createWritable()
        await wr.write(blob)
        await wr.close()
      } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = s.fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10000)
      }
      setMsg(`엑셀 C열 ${n}행 기록 완료`)
    } catch (err) {
      if (err.name !== 'AbortError') alert('저장 실패: ' + err.message)
    }
  }

  const applyManual = () => {
    const cells = parseCells(manualText)
    const items = cells.map((cell) => ({ row: null, code: cell, cell, sub: null, excluded: false, option: '', product: '' }))
    const ns = { fileName: null, file: null, stops: buildRoute(items), results: {}, idx: 0 }
    setSession(ns)
    setShowManual(false)
  }

  // ── 영상 소스 ──
  const stop = () => {
    runRef.current.token++
    setRunning(false)
  }
  const stopCamera = () => {
    const v = videoRef.current
    if (v?.srcObject) {
      v.srcObject.getTracks().forEach((t) => t.stop())
      v.srcObject = null
    }
  }
  const seekTo = (v, t) =>
    new Promise((resolve) => {
      if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) return resolve()
      let done = false
      const finish = () => !done && ((done = true), resolve())
      v.addEventListener(
        'seeked',
        () => {
          if (v.requestVideoFrameCallback) {
            v.requestVideoFrameCallback(finish)
            setTimeout(finish, 500)
          } else requestAnimationFrame(() => requestAnimationFrame(finish))
        },
        { once: true },
      )
      v.currentTime = t
    })
  const processAt = async (t, token) => {
    const v = videoRef.current
    await seekTo(v, t)
    if (token !== undefined && token !== runRef.current.token) return false
    const frame = grabFrame(v)
    await trackStep(frame, { t: +t.toFixed(2) })
    setFileTime({ t, dur: v.duration })
    return true
  }
  const openVideo = async (src) => {
    stop()
    stopCamera()
    const v = videoRef.current
    v.srcObject = null
    v.src = src
    v.muted = true
    await new Promise((r, j) => {
      v.onloadeddata = r
      v.onerror = () => j(new Error('영상을 열 수 없습니다'))
    })
    setVidSize({ w: v.videoWidth, h: v.videoHeight })
    setMode('file')
    trackRef.current = { grid: null, lost: 0, lastVerify: 0, verifying: false, avgBoxes: 0, blur: 0 }
    setFileTime({ t: 0, dur: v.duration })
    setMsg(`영상 ${v.videoWidth}×${v.videoHeight}, ${v.duration.toFixed(1)}초`)
    await processAt(0)
  }
  const playFile = async () => {
    const v = videoRef.current
    const token = ++runRef.current.token
    setRunning(true)
    let t = v.currentTime >= v.duration - 0.05 ? 0 : v.currentTime
    while (t <= v.duration && token === runRef.current.token) {
      while (modalRef.current && token === runRef.current.token) await new Promise((r) => setTimeout(r, 200))
      if (!(await processAt(t, token))) return
      t += stepRef.current
    }
    if (token === runRef.current.token) setRunning(false)
  }
  const startCamera = async (resKey = resolution) => {
    stop()
    stopCamera()
    const v = videoRef.current
    const R = RESOLUTIONS[resKey]
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: R.w }, height: { ideal: R.h } },
      })
      v.removeAttribute('src')
      v.srcObject = stream
      v.muted = true
      await v.play()
      setVidSize({ w: v.videoWidth, h: v.videoHeight })
      setMode('camera')
      trackRef.current = { grid: null, lost: 0, lastVerify: 0, verifying: false, avgBoxes: 0, blur: 0 }
      setMsg(`카메라 ${v.videoWidth}×${v.videoHeight} — 📷 사진을 찍어 위치를 잡아 주세요`)
      setCamRes(`${v.videoWidth}×${v.videoHeight}`)
      const token = ++runRef.current.token
      setRunning(true)
      while (token === runRef.current.token) {
        if (modalRef.current || busyRef.current) {
          await new Promise((r) => setTimeout(r, 120))
          continue
        }
        await trackStep(grabFrame(v))
        await new Promise((r) => requestAnimationFrame(r))
      }
    } catch (e) {
      setMsg('카메라를 켤 수 없습니다: ' + e.message)
      setRunning(false)
    }
  }
  // 개발 전용: 영상에 루트 안내를 입힌 시연 영상 녹화 → 작업 폴더에 저장
  const recordDemo = async ({ src, from = 0, to, step = 0.2, name = '시연_루트안내.mp4', W = 1920, H = 1080 }) => {
    await openVideo(src)
    const v = videoRef.current
    const end = Math.min(to ?? v.duration, v.duration)
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')
    const stream = c.captureStream(0)
    const track = stream.getVideoTracks()[0]
    const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 })
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const stopped = new Promise((r) => (rec.onstop = r))
    rec.start()
    rec.pause()
    const u = W / 1280
    for (let t = from; t <= end; t += step) {
      await processAt(t)
      ctx.drawImage(v, 0, 0, W, H)
      ctx.drawImage(overlayRef.current, 0, 0, W, H)
      // 하단 안내 바
      const s = sessionRef.current
      const st = s.idx >= 0 ? s.stops[s.idx] : null
      const g = guideRef.current
      ctx.fillStyle = 'rgba(0,0,0,.72)'
      ctx.fillRect(0, H - 92 * u, W, 92 * u)
      ctx.font = `bold ${Math.round(30 * u)}px sans-serif`
      ctx.fillStyle = '#22ff55'
      ctx.fillText(st ? `다음: ${st.cell}   ${g?.panelMsg || g?.dir || ''}` : '모든 대상 완료', 20 * u, H - 54 * u)
      ctx.font = `${Math.round(20 * u)}px sans-serif`
      ctx.fillStyle = '#ddd'
      const done = s.stops.map((x) => {
        const r = s.results[x.cell]
        return `${x.cell} ${!r ? '⬜' : r.count >= 3 ? '3+⚠' : r.count + '개'}`
      })
      ctx.fillText(`조사 ${s.stops.filter((x) => s.results[x.cell]).length}/${s.stops.length}  ·  ${done.join('   ')}`, 20 * u, H - 18 * u)
      ctx.textAlign = 'right'
      ctx.fillText(`${t.toFixed(1)}s`, W - 20 * u, H - 54 * u)
      ctx.textAlign = 'left'
      rec.resume()
      track.requestFrame()
      await new Promise((r) => setTimeout(r, step * 1000))
      rec.pause()
    }
    rec.stop()
    await stopped
    const blob = new Blob(chunks, { type: mime })
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm'
    const fname = name.replace(/\.\w+$/, '.' + ext)
    await fetch('/__save?name=' + encodeURIComponent(fname), { method: 'POST', body: blob })
    return { fname, size: blob.size, mime }
  }
  if (import.meta.env.DEV)
    window.__app = {
      processAt, openVideo, REF_VIDEO, confirmCount, recordDemo, takePhoto, setSession,
      session: () => sessionRef.current,
      track: () => trackRef.current,
      setAutoConfirm: (v) => (autoConfirmRef.current = v),
    }

  const onPickVideo = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) openVideo(URL.createObjectURL(f))
  }

  const cur = session.stops.length && session.idx >= 0 ? session.stops[session.idx] : null
  const doneN = session.stops.filter((x) => session.results[x.cell]).length
  const checkN = Object.values(session.results).filter((r) => r.needCheck).length

  return (
    <div className="app">
      <div className="topbar">
        <span className={'pill ' + (stats?.tracking ? 'on' : 'off')}>{stats?.tracking ? '위치 추적 중' : '위치 모름'}</span>
        <span>{stats ? `${stats.named}/${stats.nLabels}칸` : '-'}</span>
        <span>{stats ? `${stats.ms.toFixed(0)}ms` : '-'}</span>
        <select value={resolution} onChange={(e) => changeResolution(e.target.value)} title="카메라 화질">
          {Object.entries(RESOLUTIONS).map(([k, r]) => (
            <option key={k} value={k}>{r.label}</option>
          ))}
        </select>
        {mode === 'camera' && camRes && <span className="muted">{camRes}</span>}
        <span className="msg">{msg}</span>
      </div>

      <div className="stage" ref={stageRef}>
        {/* 카메라 화면 아무 데나 눌러도 사진 */}
        <div className="frame" style={{ width: fit.w, height: fit.h }} onClick={mode !== 'idle' ? takePhoto : undefined}>
          <video ref={videoRef} playsInline muted />
          <canvas ref={overlayRef} />
          {mode !== 'idle' && (
            <div
              className="center-frame"
              style={{ width: `${CENTER_FRAME.w * 100}%`, height: `${frameH(vidSize.w, vidSize.h) * 100}%` }}
            >
              <span>여기에 칸을 맞추고 촬영</span>
            </div>
          )}
        </div>
        {mode !== 'idle' && (
          <button
            className={'shutter' + (guide?.onScreen ? ' ready' : '') + (busy ? ' busy' : '')}
            onClick={(e) => {
              e.stopPropagation()
              takePhoto()
            }}
            disabled={busy}
          >
            <span className="shutter-icon">{busy ? '⏳' : '📷'}</span>
            <span className="shutter-text">{busy ? '분석 중' : stats?.tracking ? '촬영' : '위치 잡기'}</span>
          </button>
        )}
        {mode === 'idle' && (
          <div className="hint">
            {session.stops.length ? '[카메라]를 눌러 조사를 시작하세요' : '[엑셀 불러오기]로 오늘 재고 엑셀을 선택하세요'}
          </div>
        )}
      </div>

      {mode === 'file' && (
        <div className="filebar">
          <button onClick={running ? stop : playFile}>{running ? '⏸ 정지' : '▶ 처리'}</button>
          <input type="range" min={0} max={fileTime.dur || 0} step={0.1} value={fileTime.t} disabled={running}
            onChange={(e) => processAt(+e.target.value)} />
          <span className="time">{fileTime.t.toFixed(1)} / {fileTime.dur.toFixed(1)}s</span>
          <select defaultValue="0.2" onChange={(e) => (stepRef.current = +e.target.value)} title="처리 간격">
            <option value="0.1">0.1s</option>
            <option value="0.2">0.2s</option>
            <option value="0.5">0.5s</option>
          </select>
        </div>
      )}

      <div className="panel">
        {cur ? (
          <div className="card">
            <div className="card-main">
              <span className={'kind ' + cur.kind}>{cur.kind === 'locate' ? '서랍' : '촬영'}</span>
              <b className="cell">{cur.cell}</b>
              <span className="muted">{session.idx + 1}/{session.stops.length}</span>
              <span className="dir">{guide?.panelMsg || guide?.dir}</span>
            </div>
            <div className="card-sub muted">
              {cur.items.map((it) => `${it.option || ''}${it.product ? ` (${it.product})` : ''}${it.sub ? ` _${it.sub}` : ''}`).join(' · ') || ' '}
            </div>
            <div className="actions">
              <button onClick={() => go(-1)}>◀ 이전</button>
              <button onClick={() => go(1)}>건너뛰기 ▶</button>
              {cur.kind === 'locate' && <button className="primary" onClick={markLocated}>위치 확인 ✓</button>}
              <span className="muted progress">완료 {doneN}/{session.stops.length}{checkN ? ` · 확인필요 ${checkN}` : ''}</span>
            </div>
          </div>
        ) : session.stops.length ? (
          <div className="card"><b>모든 칸 조사 완료</b> <span className="muted">[엑셀에 적용]을 누르세요</span></div>
        ) : null}
        <div className="actions">
          <label className="btn">
            엑셀 불러오기
            <input type="file" accept=".xlsm,.xlsx" hidden onChange={onPickExcel} />
          </label>
          <button onClick={mode === 'camera' && running ? () => (stop(), stopCamera(), setMode('idle')) : () => startCamera()}>
            {mode === 'camera' && running ? '카메라 끄기' : '카메라'}
          </button>
          <button onClick={() => setShowList(true)} disabled={!session.stops.length}>목록</button>
          <button onClick={() => exportZip(sessionRef.current).then((n) => setMsg(n ? `사진 ${n}건 내보내기` : '저장된 사진이 없습니다'))}>내보내기</button>
          <label className="btn">
            파일 테스트
            <input type="file" accept="video/*" hidden onChange={onPickVideo} />
          </label>
          <button onClick={() => setShowManual(true)}>칸 직접 입력</button>
          {import.meta.env.DEV && <button onClick={() => openVideo(REF_VIDEO)}>참고 영상</button>}
        </div>
      </div>

      {modal && (
        <div className="modal">
          <div className="sheet count-sheet">
            <h3>{modal.stop.cell} 개수</h3>
            <div className="muted">{modal.stop.items.map((it) => it.option).filter(Boolean).join(' · ')}</div>
            <img src={modal.url} alt={modal.stop.cell} className="shot" />
            <div className="muted">자동 인식: <b>{modal.auto == null ? '?' : modal.auto >= 3 ? '3개 이상' : `${modal.auto}개`}</b> — 맞으면 같은 숫자, 틀리면 바로 고쳐 누르세요</div>
            <div className="count-btns">
              {[0, 1, 2].map((n) => (
                <button key={n} className={modal.auto === n ? 'suggest' : ''} onClick={() => confirmCount(n)}>{n}</button>
              ))}
              <button className={'many' + (modal.auto >= 3 ? ' suggest' : '')} onClick={() => confirmCount(3)}>3개 이상<br /><small>확인 필요</small></button>
            </div>
            <div className="actions">
              <button onClick={retake}>{modal.edit ? '닫기' : '다시 찍기'}</button>
            </div>
          </div>
        </div>
      )}

      {showList && (
        <div className="modal" onClick={() => setShowList(false)}>
          <div className="sheet list-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>조사 목록 <span className="muted">{session.fileName || '직접 입력'}</span></h3>
            <div className="list">
              {session.stops.map((st, i) => {
                const r = session.results[st.cell]
                return (
                  <div key={st.cell} className={'row' + (i === session.idx ? ' cur' : '')} onClick={() => (r ? editResult(st) : jumpTo(i))}>
                    <span className="cell">{st.cell}</span>
                    <span className={'kind ' + st.kind}>{st.kind === 'locate' ? '서랍' : '촬영'}</span>
                    <span className="opt muted">{st.items.map((it) => it.option).filter(Boolean).join(' · ')}</span>
                    <span className="res">
                      {!r ? '⬜' : r.located ? '📍' : r.count >= 3 ? '3+ ⚠️' : `${r.count}${r.autoOnly ? '?' : ''}`}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="actions">
              <button onClick={() => setShowList(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {showManual && (
        <div className="modal" onClick={() => setShowManual(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>칸 직접 입력</h3>
            <p className="muted">엑셀 없이 테스트할 때. 한 줄에 하나씩 A-9-12 형식</p>
            <textarea value={manualText} onChange={(e) => setManualText(e.target.value)} rows={8} />
            <div className="actions">
              <button onClick={() => setShowManual(false)}>취소</button>
              <button className="primary" onClick={applyManual}>적용 ({parseCells(manualText).length}칸)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
