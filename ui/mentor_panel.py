from workspace_context import WorkspaceView
"""
Persistent mentor panel — lives in a channel, survives bot restarts.
Each button opens an ephemeral slot-select flow for that mentor.
"""

from datetime import datetime

import discord
import database
from ui import embeds
from ui.date_select import DateSelectView


def _chunk(lst: list, size: int) -> list[list]:
    return [lst[i : i + size] for i in range(0, len(lst), size)]


class MentorPanelView(WorkspaceView):
    """
    Persistent view — timeout=None so it works after bot restarts.
    Buttons are rebuilt from the live mentors list each time the panel is refreshed.
    """

    def __init__(self, mentors: list[dict]) -> None:
        super().__init__(timeout=None)
        for mentor in mentors[:25]:  # Discord limit: 25 components
            btn = discord.ui.Button(
                label=mentor["name"][:80],
                emoji="💬",
                style=discord.ButtonStyle.secondary,
                custom_id=f"mentor_book:{mentor['id']}",
            )
            btn.callback = self._make_callback(mentor)
            self.add_item(btn)

    def _make_callback(self, mentor: dict):
        async def callback(interaction: discord.Interaction) -> None:
            try:
                # Re-fetch mentor in case data changed after bot restart
                fresh_mentor = await database.get_mentor_by_id(mentor["id"])
                if not fresh_mentor:
                    await interaction.response.send_message(
                        embed=embeds.error_embed("멘토 정보를 찾을 수 없습니다. 관리자에게 문의하세요."),
                        ephemeral=True,
                    )
                    return

                dates = await database.get_dates_with_available_slots(fresh_mentor["id"])
                await interaction.response.send_message(
                    embed=embeds.date_select_embed(fresh_mentor, dates),
                    view=DateSelectView(fresh_mentor, dates),
                    ephemeral=True,
                )
            except Exception as e:
                msg = f"오류가 발생했습니다: {e}"
                if interaction.response.is_done():
                    await interaction.followup.send(embed=embeds.error_embed(msg), ephemeral=True)
                else:
                    await interaction.response.send_message(embed=embeds.error_embed(msg), ephemeral=True)

        return callback


async def build_panel_embed(mentors: list[dict]) -> discord.Embed:
    embed = embeds.panel_embed(
        "멘토와 함께, 다음 단계로",
        "막힌 부분을 정리하고, 함께 해결할 시간을 만나보세요.\n"
        "**멘토 선택 → 날짜 · 시간 선택 → 승인 후 확정**",
        section="MENTORING",
    )
    if not mentors:
        embeds.panel_field(embed, "예약 준비 중", "멘토가 등록되면 이곳에서 예약할 수 있습니다.\n운영자에게 멘토 초대 상태를 확인해 주세요.")
        return embed
    for mentor in mentors[:25]:
        slots = await database.get_slots_for_mentor(mentor["id"], active_only=True)
        bookings = await database.get_bookings_by_slot_ids([slot["id"] for slot in slots])
        today = datetime.now(embeds.KST).date().isoformat()
        available = sum(1 for slot in slots if slot["id"] not in bookings and slot["start_time"][:10] >= today)
        status = f"예약 가능 **{available}개**" if available else "새 일정 준비 중"
        expertise = (mentor.get("bio") or "").split("\n", 1)[0][:100]
        embeds.panel_field(embed, mentor["name"], f"{expertise}\n{status}".strip(), inline=True)
    embeds.panel_field(embed, "예약 안내", "아래에서 멘토를 선택하세요. 신청 결과는 본인에게만 표시됩니다.\n멘토의 승인은 개인 메시지로 안내하며, `/mybooking`으로 예약을 확인할 수 있습니다.")
    if len(mentors) > 25:
        embed.set_footer(text="AX 학습관리시스템 · 첫 25명 표시 · /book에서 전체 멘토 검색")
    return embed
