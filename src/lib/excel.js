// 재고 엑셀(.xlsm/.xlsx) 읽기·쓰기 — 태블릿 안에서 처리
// 쓰기는 '재고입력' 시트의 C열 셀 값만 바꾸고 나머지(매크로·서식·다른 시트)는 원본 그대로 둔다.
import JSZip from 'jszip'

export const SHEET_NAME = '재고입력'
const COL_CODE = 'B' // 자사코드
const COL_STOCK = 'C' // 재고 (조사 결과를 쓰는 열)
const COL_OPTION = 'D' // 옵션명
const COL_PRODUCT = 'E' // 상품코드

// "[P] A-11-14 ]", "[P] T-26-10_2 ]##", "###[P] B-06-07 ]"
const P_RE = /\[P\]\s*([A-Z])-(\d{1,2})-(\d{1,2})(?:_(\d+))?\s*\]/

const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml')

async function locateSheet(zip) {
  const wb = parseXml(await zip.file('xl/workbook.xml').async('string'))
  const sheet = [...wb.getElementsByTagName('sheet')].find((s) => s.getAttribute('name') === SHEET_NAME)
  if (!sheet) throw new Error(`'${SHEET_NAME}' 시트가 없습니다`)
  const rid = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
  const rels = parseXml(await zip.file('xl/_rels/workbook.xml.rels').async('string'))
  const rel = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid)
  const target = rel.getAttribute('Target').replace(/^\/?(xl\/)?/, '')
  return 'xl/' + target
}

async function sharedStrings(zip) {
  const f = zip.file('xl/sharedStrings.xml')
  if (!f) return []
  const doc = parseXml(await f.async('string'))
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''),
  )
}

function cellText(c, sst) {
  if (!c) return ''
  const t = c.getAttribute('t')
  if (t === 'inlineStr') return [...c.getElementsByTagName('t')].map((x) => x.textContent).join('')
  const v = c.getElementsByTagName('v')[0]?.textContent ?? ''
  return t === 's' ? sst[+v] ?? '' : v
}

/**
 * 엑셀에서 [P] 피어싱 대상 목록 읽기
 * @returns {Promise<{fileName:string, items:Array<{row:number, code:string, cell:string, sub:number|null, excluded:boolean, option:string, product:string, stock:string}>}>}
 */
export async function readTargets(file) {
  const zip = await JSZip.loadAsync(file)
  const path = await locateSheet(zip)
  const sst = await sharedStrings(zip)
  const doc = parseXml(await zip.file(path).async('string'))
  const items = []
  for (const row of doc.getElementsByTagName('row')) {
    const r = +row.getAttribute('r')
    const cells = {}
    for (const c of row.getElementsByTagName('c')) cells[c.getAttribute('r').replace(/\d+/, '')] = c
    const code = cellText(cells[COL_CODE], sst)
    const m = P_RE.exec(code)
    if (!m) continue
    items.push({
      row: r,
      code: code.trim(),
      cell: `${m[1]}-${+m[2]}-${+m[3]}`,
      sub: m[4] ? +m[4] : null,
      excluded: code.trimStart().startsWith('#'),
      option: cellText(cells[COL_OPTION], sst),
      product: cellText(cells[COL_PRODUCT], sst),
      stock: cellText(cells[COL_STOCK], sst),
    })
  }
  return { fileName: file.name, items }
}

/**
 * C열에 개수 기록. values: { [엑셀 행번호]: 숫자 }
 * @returns {Promise<Blob>} 수정된 엑셀 (같은 형식)
 */
export async function writeStock(file, values) {
  const zip = await JSZip.loadAsync(file)
  const path = await locateSheet(zip)
  let xml = await zip.file(path).async('string')

  for (const [rowStr, val] of Object.entries(values)) {
    const row = +rowStr
    const ref = `${COL_STOCK}${row}`
    const v = `<v>${Number(val)}</v>`
    // 1) 기존 C셀 교체 (빈 셀 <c .../> 또는 값 있는 셀 <c ...>...</c>). 서식(s) 유지, 형식(t)·수식은 제거
    const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(/>|>[\\s\\S]*?</c>)`)
    const m = cellRe.exec(xml)
    if (m) {
      const attrs = m[1].replace(/\s+t="[^"]*"/, '')
      xml = xml.slice(0, m.index) + `<c r="${ref}"${attrs}>${v}</c>` + xml.slice(m.index + m[0].length)
      continue
    }
    // 2) C셀이 없으면 같은 행의 B셀 뒤(없으면 행 시작)에 삽입
    const rowRe = new RegExp(`<row r="${row}"[^>]*>`)
    const rm = rowRe.exec(xml)
    if (!rm) throw new Error(`${row}행을 찾을 수 없습니다`)
    const rowEnd = xml.indexOf('</row>', rm.index)
    const rowXml = xml.slice(rm.index, rowEnd)
    const bRe = new RegExp(`<c r="${COL_CODE}${row}"[^>]*?(/>|>[\\s\\S]*?</c>)`)
    const bm = bRe.exec(rowXml)
    const at = bm ? rm.index + bm.index + bm[0].length : rm.index + rm[0].length
    xml = xml.slice(0, at) + `<c r="${ref}">${v}</c>` + xml.slice(at)
  }
  zip.file(path, xml, { createFolders: false })

  // 수식이 C열을 참조할 수 있으므로 열 때 전체 재계산
  let wb = await zip.file('xl/workbook.xml').async('string')
  if (/<calcPr\b/.test(wb)) {
    if (!/fullCalcOnLoad=/.test(wb)) wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"')
  } else {
    wb = wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>')
  }
  zip.file('xl/workbook.xml', wb, { createFolders: false })

  const isMacro = /\.xlsm$/i.test(file.name)
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    mimeType: isMacro
      ? 'application/vnd.ms-excel.sheet.macroEnabled.12'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
