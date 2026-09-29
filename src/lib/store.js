// IndexedDB 저장 (촬영 사진 + 칸번호 + 시각) 및 zip/csv 내보내기
import JSZip from 'jszip'

const DB_NAME = 'stock-check-camera'
const STORE = 'shots'
let dbp = null

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
        s.createIndex('cell', 'cell')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbp
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode)
        const r = fn(t.objectStore(STORE))
        t.oncomplete = () => resolve(r?.result)
        t.onerror = () => reject(t.error)
      }),
  )
}

/** @param {{cell:string,time:number,crop:Blob,full:Blob}} shot */
export const saveShot = (shot) => tx('readwrite', (s) => s.add(shot))
export const allShots = () => tx('readonly', (s) => s.getAll())
export const clearShots = () => tx('readwrite', (s) => s.clear())

const pad = (n) => String(n).padStart(2, '0')
function stamp(t) {
  const d = new Date(t)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
function isoLocal(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 사진 zip + 촬영기록.csv (칸번호, 파일명, 촬영시각) */
export async function exportZip() {
  const shots = await allShots()
  const zip = new JSZip()
  const rows = [['칸번호', '파일명', '전체프레임_파일명', '촬영시각']]
  for (const s of shots) {
    const base = `${s.cell}_${stamp(s.time)}`
    zip.file(`${base}.jpg`, s.crop)
    zip.file(`${base}_전체.jpg`, s.full)
    rows.push([s.cell, `${base}.jpg`, `${base}_전체.jpg`, isoLocal(s.time)])
  }
  const csv = '﻿' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n'
  zip.file('촬영기록.csv', csv)
  const blob = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `재고체크_${stamp(Date.now())}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  return shots.length
}
