// IndexedDB 저장 (촬영 사진 + 칸번호 + 시각) 및 zip/csv 내보내기
import JSZip from 'jszip'

const DB_NAME = 'stock-check-camera'
const STORE = 'shots'
const SESSION = 'session' // 조사 진행 상태 (엑셀 원본 파일, 루트, 개수 결과) — 중간에 꺼져도 이어서
let dbp = null

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
          s.createIndex('cell', 'cell')
        }
        if (!d.objectStoreNames.contains(SESSION)) d.createObjectStore(SESSION)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbp
}

function tx(mode, fn, store = STORE) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode)
        const r = fn(t.objectStore(store))
        t.oncomplete = () => resolve(r?.result)
        t.onerror = () => reject(t.error)
      }),
  )
}

/** @param {{cell:string,time:number,crop:Blob,full:Blob}} shot */
export const saveShot = (shot) => tx('readwrite', (s) => s.add(shot))
export const allShots = () => tx('readonly', (s) => s.getAll())
export const clearShots = () => tx('readwrite', (s) => s.clear())
export const getShot = (id) => tx('readonly', (s) => s.get(id))

export const loadSession = () => tx('readonly', (s) => s.get('current'), SESSION)
export const saveSession = (v) => tx('readwrite', (s) => s.put(v, 'current'), SESSION)

const pad = (n) => String(n).padStart(2, '0')
function stamp(t) {
  const d = new Date(t)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
function isoLocal(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

/** 사진 zip + 촬영기록.csv (칸번호, 파일명, 촬영시각) + 조사결과.csv (엑셀 행별 개수) */
export async function exportZip(session) {
  const shots = await allShots()
  const zip = new JSZip()
  const rows = [['칸번호', '파일명', '전체프레임_파일명', '촬영시각']]
  const fileOf = {}
  for (const s of shots) {
    const base = `${s.cell}_${stamp(s.time)}`
    zip.file(`${base}.jpg`, s.crop)
    zip.file(`${base}_전체.jpg`, s.full)
    rows.push([s.cell, `${base}.jpg`, `${base}_전체.jpg`, isoLocal(s.time)])
    fileOf[s.id] = `${base}.jpg`
  }
  zip.file('촬영기록.csv', toCsv(rows))

  if (session?.stops?.length) {
    const res = [['엑셀행', '자사코드', '칸번호', '옵션명', '상품코드', '구분', '개수', '확인필요', '자동추정', '사진']]
    for (const st of session.stops) {
      const r = session.results[st.cell]
      for (const it of st.items) {
        res.push([
          it.row ?? '', it.code, st.cell, it.option, it.product,
          st.kind === 'locate' ? '서랍(위치안내)' : '촬영',
          r?.count ?? (r?.located ? '위치확인' : ''),
          r?.needCheck ? 'Y' : '',
          r?.auto ?? '',
          r?.shotId ? fileOf[r.shotId] ?? '' : '',
        ])
      }
    }
    zip.file('조사결과.csv', toCsv(res))
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `재고체크_${stamp(Date.now())}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  return shots.length
}
