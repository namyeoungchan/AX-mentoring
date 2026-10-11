// Local-only browser rehearsal. Never accepts a production origin or sends Discord DMs.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function seedReschedulingCaptures(db, mentorId, studentDiscord) {
  const fixtures = {};
  for (const [index, role] of ['group', 'student'].entries()) {
    const date = new Date(Date.now() + (7 + index * 7) * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const title = `일정 변경 실습 · ${role === 'group' ? '멘토' : '수강생'}`;
    const slotIds = [];
    for (const hour of [14, 15, 16]) {
      const row = await db.prepare('INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(?,?,?,?) RETURNING id')
        .get(mentorId, `${date}T${hour}:00:00`, `${date}T${hour}:50:00`, title);
      slotIds.push(String(row.id));
    }
    const booking = await db.prepare("INSERT INTO bookings(slot_id,user_id,user_name,status) VALUES(?,?,?,'approved') RETURNING id")
      .get(slotIds[0], studentDiscord, '최학습 · 1조');
    fixtures[role] = { id: String(booking.id), title, slotIds, date };
  }
  return fixtures;
}

export async function reschedulingCapturePlan(page, counterpart, fixture) {
  const origin = new URL(page.url()).origin;
  assert.equal(origin, 'http://127.0.0.1:3037', 'Rehearsal must use the isolated capture server');
  assert.equal(new URL(counterpart.url()).origin, origin);
  const selector = `.coordination-appointment:has-text("${fixture.title}")`;
  const card = p => p.locator(selector);
  // Navigating to the same hash does not reload the app; fetch fresh state explicitly.
  const refresh = async p => { await p.reload({ waitUntil: 'networkidle' }); await expect(card(p)).toBeVisible(); };
  const state = async p => {
    const response = await p.request.get(`${origin}/api/workspaces/default/mentoring/coordination`);
    assert.equal(response.status(), 200);
    const data = await response.json();
    return data.sessions.find(s => s.id === fixture.id);
  };
  const original = await state(page);
  assert.equal(original.status, 'confirmed');
  const initialIds = (await (await page.request.get(`${origin}/api/workspaces/default/mentoring/coordination`)).json()).sessions.map(s => s.id).sort();
  async function fillProposal(p, slotId, reason) {
    await card(p).getByRole('button', { name: '다른 시간 제안', exact: true }).click();
    await card(p).getByLabel('변경할 시간').selectOption(slotId);
    await card(p).getByLabel('기존 일정 참석 가능 여부').selectOption('yes');
    await card(p).getByLabel('사유', { exact: true }).fill(reason);
  }
  async function save(p, name) {
    const [response] = await Promise.all([
      p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/mentoring/${fixture.id}/coordination`)),
      card(p).getByRole('button', { name: `${name} 저장`, exact: true }).click(),
    ]);
    assert.equal(response.status(), 200, `${name}: ${await response.text()}`);
    await expect(card(p).locator('.coordination-form')).toHaveCount(0);
    await expect(p.locator('.mentoring-coordination [role="alert"]')).toHaveCount(0);
  }
  async function withdraw(p) {
    await card(p).getByRole('button', { name: '제안 철회', exact: true }).click();
    await card(p).getByLabel('기존 일정 참석 가능 여부').selectOption('yes');
    await card(p).getByLabel('사유', { exact: true }).fill('기존 일정에도 참석할 수 있어 변경 제안을 철회합니다.');
  }
  const plan = (target, prepare) => ({ target, prepare });
  return {
    plans: [
      plan(selector, async () => { await expect(card(page)).toContainText('예약 확정'); }),
      plan(`${selector} .coordination-form`, async () => {
        await fillProposal(page, fixture.slotIds[1], '프로젝트 검토 시간을 확보하기 위해 한 시간 뒤로 변경을 제안합니다.');
      }),
      plan(selector, async () => {
        // Each step navigates afresh, so submit the actual form again from its initial state.
        await fillProposal(page, fixture.slotIds[1], '프로젝트 검토 시간을 확보하기 위해 한 시간 뒤로 변경을 제안합니다.');
        await save(page, '다른 시간 제안');
        await expect(card(page)).toContainText('변경 응답 대기');
        await expect(card(page).getByRole('button', { name: '변경 수락', exact: true })).toHaveCount(0);
        assert.equal((await state(page)).start, original.start, 'A proposal must not change the confirmed time');
      }),
      plan(selector, async () => {
        await withdraw(page); await save(page, '제안 철회');
        assert.equal((await state(page)).status, 'confirmed');
        await refresh(counterpart);
        await fillProposal(counterpart, fixture.slotIds[2], '앞선 일정이 있어 두 시간 뒤 진행을 제안합니다.');
        await save(counterpart, '다른 시간 제안');
        await refresh(page);
        await expect(card(page)).toContainText('상대방이 보낸 제안');
        await expect(card(page).getByRole('button', { name: '변경 수락', exact: true })).toBeVisible();
      }),
      plan(selector, async () => {
        await card(page).getByRole('button', { name: '변경 수락', exact: true }).click();
        await expect(card(page).locator('.coordination-form')).toContainText(`${fixture.date} 16:00`);
        await save(page, '변경 수락');
        await refresh(counterpart);
        const mine = await state(page), theirs = await state(counterpart);
        assert.equal(mine.status, 'confirmed');
        assert.equal(mine.start, `${fixture.date}T16:00:00`);
        assert.equal(theirs.start, mine.start);
        assert.equal(mine.id, original.id, 'Reschedule keeps the same booking ID');
        const ids = (await (await page.request.get(`${origin}/api/workspaces/default/mentoring/coordination`)).json()).sessions.map(s => s.id).sort();
        assert.deepEqual(ids, initialIds, 'Reschedule neither deletes nor duplicates bookings');
        await card(page).locator('details summary').click();
        await expect(card(page)).toContainText('변경 수락');
      }),
      plan(`${selector} .coordination-form`, async () => {
        await fillProposal(page, fixture.slotIds[1], '제안 철회와 예약 취소를 구분하는 연습입니다.');
        await save(page, '다른 시간 제안');
        await withdraw(page);
      }),
    ],
    finish: async () => {
      await save(page, '제안 철회');
      assert.equal((await state(page)).status, 'confirmed');
      assert.equal((await state(page)).start, `${fixture.date}T16:00:00`);
      await card(page).getByRole('button', { name: '예약 취소', exact: true }).click();
      await expect(card(page).locator('.coordination-form')).toContainText('예약 자체를 취소');
      // Do not cancel: this rehearsal only demonstrates the distinct confirmation screen.
      await card(page).getByRole('button', { name: '입력 닫기', exact: true }).click();
      assert.equal((await state(page)).status, 'confirmed');
      return { role: original.role, bookingId: fixture.id, sameBooking: true, bothParticipantsConfirmed: true,
        proposalPreservesTime: true, ownProposalCannotBeAccepted: true, withdrawalPreservesBooking: true,
        discordDelivery: 'NOT_TESTED', environment: 'isolated-local-sqlite', productionTouched: false };
    },
  };
}
