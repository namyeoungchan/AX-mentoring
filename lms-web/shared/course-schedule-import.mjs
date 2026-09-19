const text = value => String(value ?? '').trim();
const header = value => text(value).replace(/\s/g, '');
export function scheduleYear(sheet, fallback) {
    const title = sheet.slice(0, 3).flat().map(text).join(' ');
    return Number(title.match(/\b(20\d{2})\b/)?.[1]) || fallback;
}
function dateValue(value, year) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 1 || value > 73050) return '';
        return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
    }
    const raw = text(value);
    const full = raw.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:T00:00:00(?:\.000)?Z)?$/);
    const short = raw.match(/^(\d{1,2})[/.-](\d{1,2})$/);
    const parts = full ? full.slice(1).map(Number) : short ? [year, ...short.slice(1).map(Number)] : [];
    if (!parts.length) return '';
    const [y, m, d] = parts, date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : '';
}
export function parseCourseSchedule(sheet, year) {
    if (!Number.isInteger(year) || year < 2000 || year > 2099) throw new Error('기준 연도는 2000~2099년으로 입력하세요.');
    if (!Array.isArray(sheet) || sheet.length > 1000) throw new Error('시간표는 1,000행 이하로 작성하세요.');
    const index = sheet.findIndex(row => ['주차', '날짜', '시간대', '세션명'].every(key => row.map(header).includes(key)));
    if (index < 0) throw new Error('‘주차별 시간표’ 시트에 주차·날짜·시간대·세션명 열이 필요합니다. 샘플 양식을 확인하세요.');
    const columns = sheet[index].map(header), entries = [], sessions = [];
    for (let i = index + 1; i < sheet.length; i++) {
        const values = sheet[i];
        if (!values.some(v => text(v))) continue;
        const get = key => values[columns.indexOf(key)];
        const weekText = text(get('주차')), title = text(get('세션명')).replace(/\s+/g, ' '), type = text(get('구분'));
        const entry = { row: i + 1, title: title || weekText, status: 'ready', message: '', session: null };
        if (weekText === '합계' || /휴강/.test(weekText + type)) {
            entries.push({ ...entry, status: 'excluded', message: weekText === '합계' ? '집계 행' : '휴강 · 수업으로 등록하지 않음' });
            continue;
        }
        const errors = [];
        const week = /^(OT|오리엔테이션)$/i.test(weekText) ? 0 : /^(\d{1,2})(?:주차|주)?$/.test(weekText) ? Number(weekText.match(/^\d+/)[0]) : -1;
        if (week < 0 || week > 52) errors.push('주차는 OT 또는 1~52주차로 입력하세요');
        const date = dateValue(get('날짜'), year);
        if (!date || !/^20\d{2}-/.test(date)) errors.push('유효한 날짜를 입력하세요');
        const times = text(get('시간대')).replace(/\s/g, '').match(/^(\d{1,2}):([0-5]\d)[~～–—-](\d{1,2}):([0-5]\d)$/);
        const startTime = times ? `${times[1].padStart(2, '0')}:${times[2]}` : '', endTime = times ? `${times[3].padStart(2, '0')}:${times[4]}` : '';
        if (!times || Number(times[1]) > 23 || Number(times[3]) > 23 || startTime >= endTime) errors.push('시간대는 09:00~12:00처럼 시작보다 종료가 늦어야 합니다');
        if (!title || title.length > 120) errors.push('세션명은 1~120자로 입력하세요');
        const weekday = text(get('요일')).replace(/요일$/, '');
        if (date && weekday && weekday !== '일월화수목금토'[new Date(`${date}T00:00:00Z`).getUTCDay()]) errors.push('날짜와 요일이 일치하지 않습니다');
        const notes = [['구분', type], ['주제', get('주제(테마)')], ['세부 내용', get('세부내용')], ['강사', get('강사(안)')], ['산출물', get('산출물')]].filter(([, value]) => text(value)).map(([label, value]) => `${label}: ${text(value)}`).join('\n');
        if (notes.length > 1000) errors.push('세부 내용·강사·산출물의 합계는 1,000자 이하여야 합니다');
        if (!errors.length && sessions.some(s => s.date === date && startTime < s.endTime && endTime > s.startTime)) errors.push('같은 날짜에 중복되거나 시간이 겹치는 수업입니다');
        if (sessions.length >= 104) errors.push('수업은 최대 104개까지 등록할 수 있습니다');
        if (errors.length) { entry.status = 'error'; entry.message = errors.join(' · '); }
        else {
            entry.session = { week, title, date, startTime, endTime, notes };
            sessions.push(entry.session);
        }
        entries.push(entry);
    }
    sessions.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    return { year, entries, sessions, startDate: sessions[0]?.date || '', endDate: sessions.at(-1)?.date || '', weeks: Math.max(1, ...sessions.map(s => s.week)) };
}
