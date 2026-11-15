import os
from datetime import date, datetime, timedelta, timezone
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only'}):
    import database
    from ui import embeds
    from ui.date_select import DateSelectView
    from ui.time_select import TimeSelectView
    from ui.confirm_view import BookingConfirmView
    from ui.mentor_panel import build_panel_embed
    from ui.mentor_setup import build_setup_embed


MENTOR = {'id': 1, 'name': '멘토', 'bio': '', 'discord_id': '123456789012345678'}
NOW = '2026-11-06T17:30:00'


def interaction(values=None):
    return SimpleNamespace(
        data={'values': values or []}, user=SimpleNamespace(id=99, display_name='학생'),
        response=SimpleNamespace(defer=AsyncMock(), edit_message=AsyncMock()),
        edit_original_response=AsyncMock(), client=SimpleNamespace(fetch_user=AsyncMock()),
    )


class AvailabilityQueryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for patcher in (patch.object(database, 'DB_PATH', os.path.join(directory.name, 'bot.db')),
                        patch.object(database, '_kst_now_iso', return_value=NOW)):
            patcher.start()
            self.addCleanup(patcher.stop)
        token = database.online_mentor_ids.set(None)
        self.addCleanup(database.online_mentor_ids.reset, token)
        await database.init_db()
        self.mentor = await database.add_mentor(MENTOR['discord_id'], '멘토')

    async def slot(self, start, mentor=None):
        end = (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat()
        return await database.add_slot(mentor or self.mentor, start, end, '멘토링')

    async def test_past_and_started_slots_are_hidden_but_history_is_preserved(self):
        past = await self.slot('2026-10-10T17:00:00')
        started = await self.slot('2026-11-06T17:00:00')
        exact = await self.slot(NOW)
        future = await self.slot('2026-11-06T18:00:00')
        december = await self.slot('2026-12-31T18:00:00')
        inactive = await self.slot('2026-12-30T18:00:00')
        await database.deactivate_slot(inactive)
        booked = await self.slot('2026-11-07T18:00:00')
        self.assertTrue(await database.create_booking(booked, 'student', '학생'))
        self.assertEqual(await database.get_dates_with_available_slots(self.mentor), ['2026-11-06', '2026-12-31'])
        self.assertEqual([s['id'] for s in await database.get_slots_for_mentor_date(self.mentor, '2026-11-06')], [future])
        self.assertEqual(await database.get_slots_for_mentor_date(self.mentor, '2026-10-10'), [])
        self.assertEqual((await database.get_slots_for_mentor_date(self.mentor, '2026-11-07'))[0]['booking_status'], 'pending')
        self.assertFalse(await database.create_booking(past, 'student2', '학생2'))
        self.assertFalse(await database.create_booking(started, 'student2', '학생2'))
        self.assertFalse(await database.create_booking(exact, 'student2', '학생2'))
        self.assertTrue(await database.create_booking(december, 'student2', '학생2'))
        self.assertEqual(len(await database.get_slots_for_mentor(self.mentor, active_only=False)), 7)
        self.assertIsNotNone(await database.get_booking_for_slot(booked))

    async def test_confirmation_rejects_a_slot_that_started_after_the_menu_opened(self):
        slot_id = await self.slot('2026-11-06T18:00:00')
        self.assertEqual(await database.get_dates_with_available_slots(self.mentor), ['2026-11-06'])
        view = BookingConfirmView(await database.get_slot(slot_id), MENTOR)
        request = interaction()
        with patch.object(database, '_kst_now_iso', return_value='2026-11-06T18:00:00'):
            await view.confirm.callback(request)
        self.assertIsNone(await database.get_booking_for_slot(slot_id))
        request.client.fetch_user.assert_not_awaited()
        self.assertIsNone(request.response.edit_message.call_args.kwargs['view'])
        self.assertIn('더 이상 신청할 수 없는', request.response.edit_message.call_args.kwargs['embed'].description)

    async def test_management_and_public_counts_exclude_elapsed_slots(self):
        await self.slot('2026-10-10T17:00:00')
        await self.slot('2026-11-06T17:00:00')
        await self.slot(NOW)
        await self.slot('2026-11-06T18:00:00')
        await self.slot('2026-12-31T18:00:00')
        clock = datetime.fromisoformat(NOW).replace(tzinfo=embeds.KST)
        with patch('ui.mentor_panel.datetime') as panel_clock, patch('ui.mentor_setup.datetime') as setup_clock:
            panel_clock.now.return_value = setup_clock.now.return_value = clock
            public = await build_panel_embed([MENTOR])
            setup = await build_setup_embed(MENTOR, None)
        self.assertIn('예약 가능 **2개**', public.fields[0].value)
        stats = next(field.value for field in setup.fields if '슬롯 현황' in field.name)
        self.assertIn('신청 가능: **2개**', stats)
        self.assertIn('전체 활성: **5개**', stats)


class DateNavigationTests(unittest.IsolatedAsyncioTestCase):
    def dates(self, count=56):
        return [(date(2026, 11, 6) + timedelta(days=i)).isoformat() for i in range(count)]

    async def test_all_dates_through_december_are_reachable_with_matching_embeds(self):
        dates = self.dates()
        view = DateSelectView(MENTOR, dates)
        seen = []
        with patch.object(database, 'get_dates_with_available_slots', new=AsyncMock(return_value=dates)):
            for page in range(3):
                options = view.children[0].options
                self.assertLessEqual(len(options), 25)
                seen.extend(option.value for option in options)
                embed = embeds.date_select_embed(MENTOR, dates, view.page)
                self.assertEqual(len(embed.fields[0].value.splitlines()), len(options))
                self.assertIn(f'{page + 1}/3', embed.fields[0].name)
                for option in options:
                    self.assertIn(option.label, embed.fields[0].value)
                next_button = next(c for c in view.children if getattr(c, 'label', '') == '다음 날짜')
                self.assertEqual(next_button.disabled, page == 2)
                if page < 2:
                    request = interaction()
                    await next_button.callback(request)
                    request.response.defer.assert_awaited_once()
                    view = request.edit_original_response.call_args.kwargs['view']
            request = interaction()
            await next(c for c in view.children if getattr(c, 'label', '') == '이전 날짜').callback(request)
            self.assertEqual(request.edit_original_response.call_args.kwargs['view'].page, 1)
        self.assertEqual(seen, dates)
        self.assertEqual(seen[-1], '2026-12-31')

    async def test_empty_single_and_exact_page_boundaries(self):
        for count in (0, 1, 25, 26, 50, 51):
            view = DateSelectView(MENTOR, self.dates(count), page=99)
            self.assertEqual(view.total_pages, max(1, (count + 24) // 25))
            self.assertEqual(view.page, view.total_pages - 1)
            self.assertEqual(view.children[0].disabled, count == 0)
            self.assertLessEqual(len(view.children[0].options), 25)
            self.assertEqual(len(view.children), 3 if count > 25 else 1)

    async def test_navigation_refreshes_and_clamps_when_dates_are_no_longer_available(self):
        view = DateSelectView(MENTOR, self.dates(), page=1)
        for remaining in (self.dates(1), []):
            request = interaction()
            with patch.object(database, 'get_dates_with_available_slots', new=AsyncMock(return_value=remaining)):
                await view._on_next(request)
            new_view = request.edit_original_response.call_args.kwargs['view']
            self.assertEqual(new_view.page, 0)
            self.assertEqual(new_view.children[0].disabled, not remaining)

    async def test_december_selection_and_back_return_to_the_same_date_page(self):
        dates = self.dates()
        request = interaction(['2026-12-31'])
        with patch.object(database, 'get_slots_for_mentor_date', new=AsyncMock(return_value=[])) as lookup:
            await DateSelectView(MENTOR, dates, page=2)._on_select(request)
        lookup.assert_awaited_once_with(1, '2026-12-31')
        time_view = request.response.edit_message.call_args.kwargs['view']
        self.assertIsInstance(time_view, TimeSelectView)
        request = interaction()
        with patch.object(database, 'get_dates_with_available_slots', new=AsyncMock(return_value=dates)):
            await time_view._on_back(request)
        self.assertEqual(request.response.edit_message.call_args.kwargs['view'].page, 2)
        self.assertIn('3/3', request.response.edit_message.call_args.kwargs['embed'].fields[0].name)

    async def test_stale_time_selection_cannot_open_confirmation(self):
        request = interaction(['100'])
        with patch.object(database, 'get_slots_for_mentor_date', new=AsyncMock(return_value=[])):
            await TimeSelectView(MENTOR, '2026-11-06', [])._on_select(request)
        self.assertIsNone(request.response.edit_message.call_args.kwargs['view'])


class KoreanClockTests(unittest.TestCase):
    def test_clock_uses_korean_date_after_utc_day_boundary(self):
        utc = datetime(2026, 11, 6, 15, 1, tzinfo=timezone.utc)
        with patch.object(database, 'datetime') as clock:
            clock.now.side_effect = lambda tz: utc.astimezone(tz)
            self.assertEqual(database._kst_now_iso(), '2026-11-07T00:01:00')
