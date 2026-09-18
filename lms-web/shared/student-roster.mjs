// Survey answers and attendance columns are never used for account issuance.
export function rosterRows(sheet) {
  if (!Array.isArray(sheet) || sheet.length < 2 || sheet.length > 501) throw new Error('명단 시트는 제목 행과 최대 500명의 수강생을 포함해야 합니다.');
  const headers = sheet[0].map(value => String(value ?? '').trim());
  const columns = ['학생ID', '상태', '팀', '성명'];
  for (const column of columns) if (headers.filter(h => h === column).length !== 1) throw new Error(`명단 시트의 ${column} 열을 확인하세요.`);
  const fields = { studentId: '학생ID', status: '상태', team: '팀', name: '성명', email: '이메일', phone: '연락처', school: '학교', department: '학과' };
  return sheet.slice(1).map((row, index) => ({ row: index + 2, ...Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, String(row[headers.indexOf(column)] ?? '').trim()])) }))
    .filter(row => row.studentId || row.status || row.team || row.name);
}

export function normalizeRoster(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('명단은 1~500행까지 읽을 수 있습니다.');
  const participants = [], excluded = [], failed = [], seen = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !Number.isInteger(row.row) || row.row < 2 || row.row > 501 || ['studentId','status','team','name'].some(key => typeof row[key] !== 'string' || row[key].length > 100)) throw new Error('명단 행 형식이 올바르지 않습니다.');
    const value = { row: row.row, studentId: row.studentId.trim(), username: row.studentId.trim().toLowerCase(), status: row.status.trim(), team: row.team.trim(), name: row.name.trim() };
    for (const key of ['email','phone','school','department']) value[key] = typeof row[key] === 'string' ? row[key].trim() : '';
    let error = '';
    if (!['참여','제외'].includes(value.status)) error = '상태는 참여 또는 제외로 입력하세요.';
    else if (!/^[a-z0-9][a-z0-9_.-]{3,31}$/.test(value.username)) error = '학생ID는 영문·숫자·._- 4~32자로 입력하세요.';
    else if (!value.name || value.name.length > 50) error = '성명은 1~50자로 입력하세요.';
    else if (['email','phone','school','department'].some(key => value[key].length > 100)) error = '학교·학과·연락처·이메일은 각각 100자 이내로 입력하세요.';
    else if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) error = '이메일 형식을 확인하세요.';
    else if (value.status === '참여' && (!value.team || value.team.length > 80)) error = '참여자의 팀 이름을 확인하세요.';
    if (seen.has(value.username)) {
      const previous = seen.get(value.username);
      if (!previous.error) { previous.error = '파일 안의 학생ID가 중복되었습니다.'; failed.push(previous); }
      error = '파일 안의 학생ID가 중복되었습니다.';
    }
    seen.set(value.username, value);
    if (error) { value.error = error; failed.push(value); continue; }
    if (value.status === '제외') { excluded.push(value); continue; }
    participants.push(value);
  }
  const valid = participants.filter(row => !row.error);
  if (valid.length > 100) throw new Error('한 번에 참여자 100명까지 준비할 수 있습니다. 파일을 나누어 등록하세요.');
  const teams = [...new Set(valid.map(row => row.team))];
  if (teams.length > 50) throw new Error('조는 최대 50개까지 준비할 수 있습니다.');
  return { participants: valid, excluded: excluded.filter(row => !row.error), failed, teams };
}
