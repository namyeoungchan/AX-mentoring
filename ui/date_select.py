from workspace_context import WorkspaceView
"""Step 1: User selects a date from available dates."""
from datetime import date as date_cls

import discord
import database
from ui import embeds

WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]


def _date_label(ds: str) -> str:
    d = date_cls.fromisoformat(ds)
    return f"{d.month}/{d.day} ({WEEKDAYS[d.weekday()]})"


class DateSelectView(WorkspaceView):
    def __init__(self, mentor: dict, dates: list[str], page: int = 0) -> None:
        super().__init__(timeout=120)
        self.mentor = mentor
        self.dates = dates
        self.total_pages = max(1, (len(dates) + embeds.DATE_PAGE_SIZE - 1) // embeds.DATE_PAGE_SIZE)
        self.page = max(0, min(page, self.total_pages - 1))

        if not dates:
            sel = discord.ui.Select(
                placeholder="예약 가능한 날짜가 없습니다",
                options=[discord.SelectOption(label="없음", value="none")],
                disabled=True,
            )
            sel.callback = self._noop
            self.add_item(sel)
            return

        sel = discord.ui.Select(
            placeholder="날짜를 선택하세요",
            min_values=1,
            max_values=1,
            options=[
                discord.SelectOption(label=_date_label(ds), value=ds)
                for ds in dates[self.page * embeds.DATE_PAGE_SIZE:(self.page + 1) * embeds.DATE_PAGE_SIZE]
            ],
        )
        sel.callback = self._on_select
        self.add_item(sel)

        if self.total_pages > 1:
            previous = discord.ui.Button(label="이전 날짜", style=discord.ButtonStyle.secondary,
                                         disabled=self.page == 0, row=1)
            previous.callback = self._on_previous
            self.add_item(previous)
            following = discord.ui.Button(label="다음 날짜", style=discord.ButtonStyle.secondary,
                                          disabled=self.page == self.total_pages - 1, row=1)
            following.callback = self._on_next
            self.add_item(following)

    async def _change_page(self, interaction: discord.Interaction, page: int) -> None:
        await interaction.response.defer()
        dates = await database.get_dates_with_available_slots(self.mentor["id"])
        view = DateSelectView(self.mentor, dates, page)
        await interaction.edit_original_response(
            embed=embeds.date_select_embed(self.mentor, dates, view.page), view=view,
        )

    async def _on_previous(self, interaction: discord.Interaction) -> None:
        await self._change_page(interaction, self.page - 1)

    async def _on_next(self, interaction: discord.Interaction) -> None:
        await self._change_page(interaction, self.page + 1)

    async def _noop(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()

    async def _on_select(self, interaction: discord.Interaction) -> None:
        from ui.time_select import TimeSelectView

        selected_date = interaction.data["values"][0]  # type: ignore[index]
        slots = await database.get_slots_for_mentor_date(self.mentor["id"], selected_date)

        await interaction.response.edit_message(
            embed=embeds.time_slot_embed(self.mentor, selected_date, slots),
            view=TimeSelectView(self.mentor, selected_date, slots),
        )
