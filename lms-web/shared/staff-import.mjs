export const staffRoles = {
  PM: { role: 'instructor', mentorType: 'main', label: '메인 강사' },
  강의: { role: 'instructor', mentorType: 'main', label: '메인 강사' },
  기술멘토: { role: 'instructor', mentorType: 'group', label: '조 담당 멘토' },
  '자문/운영': { role: 'admin', mentorType: 'main', label: '워크스페이스 관리자' },
}
export function staffCsv(text) {
  if (text.length > 2_000_000) throw new Error('2MB 이하의 파일을 선택하세요.')
  text = text.replace(/^\uFEFF/, '')
  const rows = []; let row = [], cell = '', quoted = false, ended = false
  const field = () => { row.push(cell); cell = ''; ended = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') { quoted = false; ended = true }
      else cell += c
    } else if (c === ',') field()
    else if (c === '\r' || c === '\n') { field(); rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++ }
    else if (c === '"' && !cell && !ended) quoted = true
    else { if (ended || c === '"') throw new Error('CSV 따옴표 형식을 확인하세요.'); cell += c }
  }
  if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.')
  if (row.length || cell || ended) { field(); rows.push(row) }
  return rows
}
export function staffRows(sheet) {
  if (!Array.isArray(sheet) || sheet.length < 2 || sheet.length > 501) throw new Error('제목 행과 구성원 명단이 있는 파일을 선택하세요. 한 번에 최대 50명을 발급합니다.')
  const aliases = { 구분: 'category', 이름: 'name', 성명: 'name', 연락처: 'phone', 전화번호: 'phone', 이메일: 'email', 아이디: 'username', ID: 'username', 계정: 'username', 담당조: 'teams' }
  const headers = sheet[0].map(v => aliases[String(v ?? '').trim().replace(/\s/g, '')])
  for (const required of ['category', 'name', 'username']) if (headers.filter(h => h === required).length !== 1) throw new Error('첫 행에 구분·이름·아이디 열이 각각 하나씩 있어야 합니다.')
  for (const optional of ['phone', 'email', 'teams']) if (headers.filter(h => h === optional).length > 1) throw new Error('같은 종류의 열을 중복해서 넣지 마세요.')
  let category = ''
  const rows = []
  for (const [index, cells] of sheet.slice(1).entries()) {
    const get = key => String(cells[headers.indexOf(key)] ?? '').trim()
    if (!cells.some(v => String(v ?? '').trim())) continue
    const supplied = get('category').replace(/\s/g, '')
    if (supplied) category = supplied.toUpperCase() === 'PM' ? 'PM' : supplied
    // Merged category cells are returned as blanks by spreadsheet readers.
    if (!get('name') && !get('username') && supplied) continue
    rows.push({ row: index + 2, category, name: get('name'), username: get('username').toLowerCase(), phone: get('phone'), email: get('email'), teamNames: get('teams').split(/[;,/\n]/).map(s => s.trim()).filter(Boolean) })
  }
  if (!rows.length || rows.length > 50) throw new Error('한 번에 1~50명의 명단을 등록하세요.')
  return rows
}
export function staffExport(rows) {
  const escape = value => {
    let text = String(value ?? '')
    if (/^'|^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text
    return '"' + text.replaceAll('"', '""') + '"'
  }
  return '\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')
}
