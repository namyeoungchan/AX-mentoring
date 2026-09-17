const headers = ['courseId', 'date', 'period', 'studentId', 'name', 'team', 'status', 'reason']
const states = ['미처리', '출석', '지각', '결석', '공결']
const escape = value => {
  let text = String(value ?? '')
  if (/^'|^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}
export function exportAttendance(selection, rows) {
  return '\uFEFF' + [headers, ...rows.map(row => headers.map(key => ({ ...selection, ...row })[key]))].map(row => row.map(escape).join(',')).join('\r\n')
}
export function importAttendance(source, selection, allowedIds) {
  if (source.length > 2_000_000) throw new Error('CSV는 2MB 이하로 가져오세요.')
  const text = source.replace(/^\uFEFF/, '')
  const rows = []; let row = [], cell = '', quoted = false, ended = false
  function field() { row.push(cell.startsWith("'") ? cell.slice(1) : cell); cell = ''; ended = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') { quoted = false; ended = true }
      else cell += c
    } else if (c === ',') field()
    else if (c === '\r' || c === '\n') {
      field(); rows.push(row); row = []
      if (c === '\r' && text[i + 1] === '\n') i++
    } else if (c === '"' && !cell && !ended) quoted = true
    else {
      if (c === '"' || ended) throw new Error('CSV 따옴표 형식이 올바르지 않습니다.')
      cell += c
    }
  }
  if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.')
  if (cell || row.length || ended) { field(); rows.push(row) }
  if (JSON.stringify(rows.shift()) !== JSON.stringify(headers)) throw new Error('명단 출결 화면에서 내보낸 CSV 열을 그대로 사용하세요.')
  if (!rows.length || rows.length > 1000) throw new Error('CSV는 1~1000명의 명단을 지원합니다.')
  const seen = new Set(), allowed = new Set(allowedIds)
  return rows.map((cells, index) => {
    const [courseId, date, period, studentId, , , status, reason] = cells
    if (cells.length !== headers.length || courseId !== selection.courseId || date !== selection.date || Number(period) !== selection.period) throw new Error(`${index + 2}행: 선택한 과정·날짜·차시와 일치하지 않습니다.`)
    if (!allowed.has(studentId) || seen.has(studentId)) throw new Error(`${index + 2}행: 담당 명단에 없거나 중복된 수강생입니다.`)
    if (!states.includes(status) || reason.length > 200) throw new Error(`${index + 2}행: 출결 상태 또는 사유를 확인하세요.`)
    seen.add(studentId)
    return { studentId, status, reason }
  })
}
