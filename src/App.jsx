import { useCallback, useEffect, useRef, useState } from 'react'
import { grabFrame, processFrame } from './lib/pipeline.js'
import { initOcr } from './lib/ocr.js'
import { allShots, exportZip, saveShot } from './lib/store.js'

const DEFAULT_TARGETS = ['A-9-12', 'A-18-17', 'A-24-15']
const REF_VIDEO = '/참고/재고칸_인식테스트_영상.mp4'
const STREAK_NEEDED = 5 // 연속 5프레임
const MIN_W_RATIO = 0.08 // 라벨 폭 ≥ 화면 폭 8%
// 칸 크롭 범위 (격자 한 칸 간격 기준, 라벨 중심에서)
const CELL_CROP = { left: 0.55, right: 0.55, up: 0.9, down: 0.25 }

// A-5-05 / A-5-5 모두 A-5-5 로 통일 (라벨 인쇄는 열이 두 자리)
const LABEL_RE = /([A-D])-(\d{1,2})-(\d{1,2})/g
const parseTargets = (text) => [
  ...new Set([...text.toUpperCase().matchAll(LABEL_RE)].map((m) => `${m[1]}-${+m[2]}-${+m[3]}`)),
]

function loadTargets() {
  try {
    const t = JSON.parse(localStorage.getItem('targets'))
    if (Array.isArray(t) && t.length) return t
  } catch {}
  return DEFAULT_TARGETS
}

function drawOverlay(canvas, res, targets) {
  if (canvas.width !== res.w || canvas.height !== res.h) {
    canvas.width = res.w
    canvas.height = res.h
  }
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, res.w, res.h)
  const u = res.w / 640 // 선 두께·글자 크기 단위
  ctx.font = `bold ${Math.round(11 * u)}px sans-serif`
  ctx.textBaseline = 'bottom'
  for (const l of res.labels) {
    const isTarget = l.name && targets.includes(l.name)
    if (isTarget) {
      const m = l.h * 0.6
      ctx.lineWidth = 4 * u
      ctx.strokeStyle = '#22ff55'
      ctx.strokeRect(l.x - m, l.y - m, l.w + 2 * m, l.h + 2 * m)
    } else {
      ctx.lineWidth = 1.2 * u
      ctx.strokeStyle = l.source === 'ocr' ? '#8fd3ff' : 'rgba(200,200,200,0.85)'
      ctx.strokeRect(l.x, l.y, l.w, l.h)
    }
    if (l.name) {
      const label = l.name + (l.source === 'grid' ? '*' : '')
      const tw = ctx.measureText(label).width
      const ty = l.y - (isTarget ? l.h * 0.6 + 2 * u : 2 * u)
      ctx.fillStyle = isTarget ? 'rgba(0,90,20,0.85)' : 'rgba(0,0,0,0.6)'
      ctx.fillRect(l.x, ty - 13 * u, tw + 6 * u, 13 * u)
      ctx.fillStyle = isTarget ? '#aaffbb' : '#fff'
      ctx.fillText(label, l.x + 3 * u, ty)
    }
  }
}

function toBlob(canvas, q = 0.9) {
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', q))
}

async function captureShot(frame, res, label) {
  const g = label.grid
  const px = 1 / g.a, py = 1 / g.c // 한 칸 간격(px)
  const x0 = Math.max(0, label.cx - px * CELL_CROP.left)
  const x1 = Math.min(frame.width, label.cx + px * CELL_CROP.right)
  const y0 = Math.max(0, label.cy - py * CELL_CROP.up)
  const y1 = Math.min(frame.height, label.cy + py * CELL_CROP.down)
  const crop = document.createElement('canvas')
  crop.width = Math.round(x1 - x0)
  crop.height = Math.round(y1 - y0)
  crop.getContext('2d').drawImage(frame, x0, y0, x1 - x0, y1 - y0, 0, 0, crop.width, crop.height)
  const [cropBlob, fullBlob] = await Promise.all([toBlob(crop), toBlob(frame, 0.85)])
  await saveShot({ cell: label.name, time: Date.now(), crop: cropBlob, full: fullBlob })
}

export default function App() {
  const videoRef = useRef(null)
  const overlayRef = useRef(null)
  const stageRef = useRef(null)
  const runRef = useRef({ token: 0 })
  const streakRef = useRef({})
  const shotRef = useRef(new Set())
  const targetsRef = useRef(loadTargets())
  const stepRef = useRef(0.2)

  const [mode, setMode] = useState('idle') // idle | file | camera
  const [running, setRunning] = useState(false)
  const [targets, setTargets] = useState(targetsRef.current)
  const [shot, setShot] = useState(new Set())
  const [stats, setStats] = useState(null)
  const [msg, setMsg] = useState('OCR 엔진 준비 중…')
  const [fileTime, setFileTime] = useState({ t: 0, dur: 0 })
  const [showList, setShowList] = useState(false)
  const [listText, setListText] = useState(targets.join('\n'))
  const [fit, setFit] = useState({ w: 0, h: 0 })
  const [vidSize, setVidSize] = useState({ w: 16, h: 9 })

  useEffect(() => {
    initOcr().then((n) => setMsg(`OCR 준비 완료 (작업자 ${n}개)`), (e) => setMsg('OCR 로드 실패: ' + e.message))
    allShots().then((s) => {
      const set = new Set(s.map((x) => x.cell))
      shotRef.current = set
      setShot(new Set(set))
    })
    window.__log = []
  }, [])

  // 화면에 맞게 영상 영역 크기 계산 (오버레이와 영상 좌표 일치)
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

  const updateTargets = (list) => {
    targetsRef.current = list
    setTargets(list)
    try {
      localStorage.setItem('targets', JSON.stringify(list))
    } catch {}
  }

  // 처리 결과 반영: 오버레이, 통계, 자동 촬영
  const handleResult = useCallback(async (frame, res, extra = {}) => {
    const tg = targetsRef.current
    if (import.meta.env.DEV) window.__lastRes = res
    drawOverlay(overlayRef.current, res, tg)
    setStats({ grid: !!res.grid, nRead: res.nRead, nLabels: res.labels.length, ms: res.ms, tDetect: res.tDetect, tOcr: res.tOcr })
    const seen = res.grid ? res.labels.filter((l) => l.name && tg.includes(l.name)) : []
    window.__log.push({
      ...extra,
      nLabels: res.labels.length,
      nRead: res.nRead,
      grid: !!res.grid,
      ms: Math.round(res.ms),
      targets: seen.map((l) => ({ name: l.name, src: l.source, wRatio: +(l.w / res.w).toFixed(3) })),
      reads: res.labels.filter((l) => l.ocr).map((l) => `${l.ocr.text}(${Math.round(l.ocr.conf)})${l.ocr.row != null ? '' : 'x'}${l.name ? '→' + l.name + (l.source === 'grid' ? '*' : '') : ''}`),
    })
    const seenNames = new Set(seen.map((l) => l.name))
    for (const name of tg) {
      streakRef.current[name] = seenNames.has(name) ? (streakRef.current[name] || 0) + 1 : 0
    }
    for (const l of seen) {
      if (shotRef.current.has(l.name)) continue
      if (streakRef.current[l.name] >= STREAK_NEEDED && l.w >= res.w * MIN_W_RATIO) {
        shotRef.current.add(l.name)
        setShot(new Set(shotRef.current))
        await captureShot(frame, res, l)
        setMsg(`📸 ${l.name} 촬영·저장`)
      }
    }
  }, [])

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

  // ── 파일 테스트 모드 ──
  // seeked 뒤에도 이전 프레임이 남아 있을 수 있어, 새 프레임이 실제로 그려질 때까지 기다린다
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
          } else {
            requestAnimationFrame(() => requestAnimationFrame(finish))
          }
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
    const res = await processFrame(frame)
    if (token !== undefined && token !== runRef.current.token) return false
    await handleResult(frame, res, { t: +t.toFixed(2) })
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
    streakRef.current = {}
    window.__log = []
    setFileTime({ t: 0, dur: v.duration })
    setMsg(`영상 ${v.videoWidth}×${v.videoHeight}, ${v.duration.toFixed(1)}초`)
    await processAt(0)
  }

  const playFile = async () => {
    const v = videoRef.current
    const token = ++runRef.current.token
    setRunning(true)
    let t = v.currentTime >= v.duration - 0.05 ? 0 : v.currentTime
    if (t === 0) streakRef.current = {}
    while (t <= v.duration && token === runRef.current.token) {
      if (!(await processAt(t, token))) return
      t += stepRef.current
    }
    if (token === runRef.current.token) {
      setRunning(false)
      setMsg('영상 처리 끝')
    }
  }

  // ── 카메라 모드 ──
  const startCamera = async () => {
    stop()
    const v = videoRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // 기본 화질 4K (지원 안 되는 폰은 가능한 최대 화질로 내려감)
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      })
      v.removeAttribute('src')
      v.srcObject = stream
      v.muted = true
      await v.play()
      setVidSize({ w: v.videoWidth, h: v.videoHeight })
      setMode('camera')
      streakRef.current = {}
      setMsg(`카메라 ${v.videoWidth}×${v.videoHeight}`)
      const token = ++runRef.current.token
      setRunning(true)
      while (token === runRef.current.token) {
        const frame = grabFrame(v)
        const res = await processFrame(frame)
        if (token !== runRef.current.token) break
        await handleResult(frame, res)
        await new Promise((r) => requestAnimationFrame(r))
      }
    } catch (e) {
      setMsg('카메라를 켤 수 없습니다: ' + e.message)
      setRunning(false)
    }
  }

  // 개발용: 검증 스크립트에서 특정 시각 처리
  if (import.meta.env.DEV) window.__app = { processAt, openVideo, REF_VIDEO }

  const onPickFile = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) openVideo(URL.createObjectURL(f))
  }

  const onPickCsv = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) setListText(parseTargets(await f.text()).join('\n'))
  }

  const applyList = () => {
    const list = parseTargets(listText)
    updateTargets(list)
    setListText(list.join('\n'))
    streakRef.current = {}
    setShowList(false)
  }

  const reshoot = (name) => {
    if (!shotRef.current.has(name)) return
    if (!confirm(`${name} 을(를) 다시 촬영할까요? (이전 사진은 남아 있습니다)`)) return
    shotRef.current.delete(name)
    streakRef.current[name] = 0
    setShot(new Set(shotRef.current))
  }

  const onExport = async () => {
    const n = await exportZip()
    setMsg(n ? `사진 ${n}건 내보내기` : '저장된 사진이 없습니다')
  }

  return (
    <div className="app">
      <div className="topbar">
        <span className={'pill ' + (stats?.grid ? 'on' : 'off')}>격자 {stats?.grid ? 'ON' : 'OFF'}</span>
        <span>판독 {stats ? `${stats.nRead}/${stats.nLabels}` : '-'}</span>
        <span title={stats ? `검출 ${stats.tDetect.toFixed(0)}ms · OCR ${stats.tOcr.toFixed(0)}ms` : ''}>
          {stats ? `${stats.ms.toFixed(0)}ms` : '-'}
        </span>
        <span className="msg">{msg}</span>
      </div>

      <div className="stage" ref={stageRef}>
        <div className="frame" style={{ width: fit.w, height: fit.h }}>
          <video ref={videoRef} playsInline muted />
          <canvas ref={overlayRef} />
        </div>
        {mode === 'idle' && <div className="hint">[파일 테스트] 또는 [카메라]를 눌러 시작하세요</div>}
      </div>

      {mode === 'file' && (
        <div className="filebar">
          <button onClick={running ? stop : playFile}>{running ? '⏸ 정지' : '▶ 처리'}</button>
          <input
            type="range"
            min={0}
            max={fileTime.dur || 0}
            step={0.1}
            value={fileTime.t}
            disabled={running}
            onChange={(e) => processAt(+e.target.value)}
          />
          <span className="time">
            {fileTime.t.toFixed(1)} / {fileTime.dur.toFixed(1)}s
          </span>
          <select defaultValue="0.2" onChange={(e) => (stepRef.current = +e.target.value)} title="처리 간격">
            <option value="0.1">0.1s</option>
            <option value="0.2">0.2s</option>
            <option value="0.5">0.5s</option>
          </select>
        </div>
      )}

      <div className="panel">
        <div className="targets">
          {targets.map((t) => (
            <button key={t} className={'target ' + (shot.has(t) ? 'done' : '')} onClick={() => reshoot(t)}>
              {t} {shot.has(t) ? '✅' : '⬜'}
            </button>
          ))}
          {!targets.length && <span className="muted">대상 목록이 비어 있습니다</span>}
        </div>
        <div className="actions">
          <button onClick={() => setShowList(true)}>목록 입력</button>
          <label className="btn">
            파일 테스트
            <input type="file" accept="video/*" hidden onChange={onPickFile} />
          </label>
          {import.meta.env.DEV && <button onClick={() => openVideo(REF_VIDEO)}>참고 영상</button>}
          <button onClick={mode === 'camera' && running ? () => (stop(), stopCamera(), setMode('idle')) : startCamera}>
            {mode === 'camera' && running ? '카메라 끄기' : '카메라'}
          </button>
          <button onClick={onExport}>내보내기</button>
        </div>
      </div>

      {showList && (
        <div className="modal" onClick={() => setShowList(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>대상 목록</h3>
            <p className="muted">한 줄에 하나씩 A-9-12 형식으로 붙여넣기 (CSV도 가능)</p>
            <textarea value={listText} onChange={(e) => setListText(e.target.value)} rows={10} />
            <div className="actions">
              <label className="btn">
                CSV 불러오기
                <input type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={onPickCsv} />
              </label>
              <button onClick={() => setShowList(false)}>취소</button>
              <button className="primary" onClick={applyList}>
                적용 ({parseTargets(listText).length}건)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
