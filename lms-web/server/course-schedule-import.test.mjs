import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSheet } from 'read-excel-file/node';
import { parseCourseSchedule, scheduleYear } from '../shared/course-schedule-import.mjs';
import { courseSchedule, validCourseSchedule } from './course-schedule.mjs';

const headers = ['주차','날짜','시간대','세션명','요일','세부 내용'];
test('downloadable timetable sample imports OT and multiple sessions per week without holiday or totals', async () => {
    const sheet = await readSheet(new URL('../public/templates/course-schedule-template.xlsx', import.meta.url), '주차별 시간표');
    const plan = parseCourseSchedule(sheet, scheduleYear(sheet, 2030));
    assert.equal(plan.year, 2026);
    assert.equal(plan.sessions.length, 5);
    assert.equal(plan.entries.filter(e => e.status === 'excluded').length, 2);
    assert.equal(plan.entries.filter(e => e.status === 'error').length, 0);
    assert.equal(plan.sessions[0].week, 0);
    assert.equal(plan.sessions[1].startTime, '19:00');
    assert.match(plan.sessions[1].notes, /강사: 담당 강사/);
    const schedule = courseSchedule.parse(plan.sessions.map((s, i) => ({ ...s, id: String(i) })));
    assert.equal(validCourseSchedule({ ...plan, weeks: '2주 과정', schedule }), true);
});
test('dates, weekday, time ranges, unknown weeks, notes and overlaps produce row errors', () => {
    const plan = parseCourseSchedule([headers,
        ['1주차','9/15','9:00~12:00','수업','화','내용'],
        ['1주차','9/15','11:00~13:00','겹친 수업','화'],
        ['2주차','2/30','19:00~22:00','틀린 날짜'],
        ['2주차','9/17','22:00~19:00','역전 시간'],
        ['미정','9/17','19:00~22:00','미정 주차'],
        ['2주차','9/17','19:00~22:00','요일 오류','월'],
        ['2주차','9/17','19:00~22:00','긴 내용','목','가'.repeat(1001)],
    ],2026);
    assert.equal(plan.sessions.length, 1);
    assert.equal(plan.entries.filter(e => e.status === 'error').length, 6);
    assert.equal(plan.entries[1].row, 3);
    assert.equal(plan.sessions[0].notes, '세부 내용: 내용');
});
test('Excel dates and explicit next-year dates preserve actual dates and empty or incorrect sheets fail safely', () => {
    const plan = parseCourseSchedule([headers,
        ['1', new Date('2026-12-31T00:00:00Z'), '10:00~12:00', '연말'],
        ['2', '2027-01-02', '10:00~12:00', '새해'],
    ],2026);
    assert.equal(plan.startDate, '2026-12-31'); assert.equal(plan.endDate, '2027-01-02');
    assert.throws(() => parseCourseSchedule([['잘못된 양식']],2026));
    assert.equal(parseCourseSchedule([headers],2026).sessions.length,0);
    assert.throws(() => parseCourseSchedule([headers],0));
});
