from workspace_context import WorkspaceView, WorkspaceModal, each_workspace
"""
과제 시스템 v2
- 관리자: 과제 대시보드 채널에 패널 게시 → [➕ 팀 과제 생성] / [➕ 개인 과제 생성] 버튼으로 생성
          제출 항목(필드)을 자유롭게 지정 가능 (최대 4개)
- 수강생: 과제제출 채널의 버튼 → 팀 선택(팀 과제) → 커스텀 필드 Modal
- 대시보드: 과제 생성·제출 시 자동 갱신 (주차별 팀 제출 현황)
"""
import datetime
import io
import json
import logging

import discord
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from discord import app_commands
from discord.ext import commands, tasks

import config
import database
from ui.embeds import fmt_kst, KST, panel_embed, panel_field, progress_bar, BRAND_COLOR

log = logging.getLogger("asanAX.assignment")

def teams():
    return list(config.current().TEAM_CHANNELS)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_admin(interaction: discord.Interaction) -> bool:
    member = interaction.user
    if not isinstance(member, discord.Member):
        return False
    return member.guild_permissions.administrator or any(r.id == config.current().ADMIN_ROLE_ID for r in member.roles)


def _parse_fields(raw: str | None) -> list[str]:
    if not raw:
        return ["제출 내용"]
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list) and parsed:
            return [str(f) for f in parsed[:4]]
    except (json.JSONDecodeError, TypeError):
        pass
    return ["제출 내용"]


# ── Dashboard builder ─────────────────────────────────────────────────────────

async def build_dashboard_embeds() -> list[discord.Embed]:
    assignments = await database.get_assignments(active_only=True)
    now_str = datetime.datetime.now(KST).strftime("%m.%d %H:%M KST")
    summary = panel_embed(
        "과제 운영 현황",
        "제출 흐름을 한눈에 확인하고, 필요한 피드백을 이어가세요.",
        section="STAFF DESK",
    )
    panel_field(summary, "진행 중인 과제", f"**{len(assignments)}개**", inline=True)
    panel_field(summary, "운영 중인 조", f"**{len(teams())}개 조**", inline=True)
    panel_field(summary, "최근 갱신", now_str, inline=True)
    panel_field(summary, "빠른 실행", "**과제 만들기** → 제출 내역 확인 → 피드백\n아래 버튼에서 팀·개인 과제를 만들고 제출 내역을 확인하세요.")
    if not assignments:
        panel_field(summary, "첫 과제를 기다리고 있어요", "팀 과제 또는 개인 과제를 만들면 이곳에 제출 현황이 표시됩니다.")
        return [summary]

    cards = [summary]
    for assignment in assignments:
        subs = await database.get_submissions(assignment["id"])
        by_team = {}
        for submission in subs:
            by_team.setdefault(submission["team"], []).append(submission)
        is_team = assignment["type"] == "team"
        card = panel_embed(
            f"{assignment['week']:02d}주차  ·  {assignment['title']}",
            (assignment["description"] or "제출 항목을 확인하고 마감일까지 제출해 주세요.")[:500],
            section="ASSIGNMENTS",
        )
        panel_field(card, "마감", assignment["due_date"], inline=True)
        panel_field(card, "제출 방식", "팀 과제" if is_team else "개인 과제", inline=True)
        panel_field(card, "접수 완료", f"**{len(subs)}건**", inline=True)
        if is_team and teams():
            done = sum(bool(by_team.get(team)) for team in teams())
            panel_field(card, "제출 진행률", f"{progress_bar(done, len(teams()))}  **{done} / {len(teams())}조**")
            lines = [f"{'✓' if by_team.get(team) else '○'}  **{team}**  ·  {'제출 완료' if by_team.get(team) else '제출 대기'}" for team in teams()]
            panel_field(card, "조별 현황", "\n".join(lines))
        panel_field(card, "제출 항목", " · ".join(_parse_fields(assignment.get("fields"))))
        cards.append(card)
    return cards


async def refresh_dashboard(bot: commands.Bot) -> None:
    manager = bot.get_cog('AutoPanels')
    if manager:
        await manager.publish('dashboard')
        return
    panel = await database.get_assignment_panel("dashboard")
    if not panel:
        return
    guild = bot.get_guild(config.current().GUILD_ID)
    if not guild:
        return
    ch = guild.get_channel(int(panel["channel_id"]))
    if not ch or not isinstance(ch, discord.TextChannel):
        return
    try:
        msg = await ch.fetch_message(int(panel["message_id"]))
        new_embeds = await build_dashboard_embeds()
        # Pass view so buttons are preserved after edit
        await msg.edit(embeds=new_embeds, view=AdminDashboardView(bot))
    except (discord.NotFound, discord.HTTPException) as e:
        log.warning("Dashboard refresh failed: %s", e)


# ── Admin: Assignment creation modal ──────────────────────────────────────────

class CreateAssignmentModal(WorkspaceModal):
    week_input = discord.ui.TextInput(
        label="주차",
        placeholder="1",
        max_length=3,
    )
    title_input = discord.ui.TextInput(
        label="과제 제목",
        placeholder="아이디어 기획서 제출",
        max_length=100,
    )
    description_input = discord.ui.TextInput(
        label="과제 설명",
        placeholder="이번 주차 과제에 대한 안내를 입력하세요.",
        style=discord.TextStyle.paragraph,
        required=False,
        max_length=500,
    )
    due_date_input = discord.ui.TextInput(
        label="마감일 (YYYY-MM-DD)",
        placeholder="2026-05-30",
        max_length=10,
    )
    fields_input = discord.ui.TextInput(
        label="제출 항목 (쉼표로 구분, 최대 4개)",
        placeholder="제출 링크, 핵심 인사이트, 팀 역할 분담",
        default="제출 내용",
        required=False,
        max_length=200,
    )

    def __init__(self, bot: commands.Bot, assignment_type: str) -> None:
        type_label = "팀" if assignment_type == "team" else "개인"
        super().__init__(title=f"{type_label} 과제 생성")
        self.bot = bot
        self.assignment_type = assignment_type

    async def on_submit(self, interaction: discord.Interaction) -> None:
        try:
            week = int(self.week_input.value.strip())
        except ValueError:
            await interaction.response.send_message(
                "주차는 숫자로 입력해주세요. (예: `1`)", ephemeral=True
            )
            return

        try:
            datetime.date.fromisoformat(self.due_date_input.value.strip())
        except ValueError:
            await interaction.response.send_message(
                "날짜 형식이 올바르지 않습니다. 예: `2026-05-30`", ephemeral=True
            )
            return

        raw = self.fields_input.value.strip()
        field_names = (
            [f.strip() for f in raw.split(",") if f.strip()][:4]
            if raw else ["제출 내용"]
        )
        fields_json = json.dumps(field_names, ensure_ascii=False)

        assignment_id = await database.create_assignment(
            week=week,
            title=self.title_input.value.strip(),
            description=self.description_input.value.strip(),
            due_date=self.due_date_input.value.strip(),
            type_=self.assignment_type,
            fields=fields_json,
        )

        type_label = "팀별" if self.assignment_type == "team" else "개인별"
        await interaction.response.send_message(
            embed=discord.Embed(
                title="✅ 과제 생성 완료",
                description=(
                    f"**{week}주차 — {self.title_input.value.strip()}**\n"
                    f"마감일: {self.due_date_input.value.strip()} | {type_label}\n"
                    f"제출 항목: {', '.join(field_names)}\n"
                    f"ID: `{assignment_id}`"
                ),
                color=discord.Color.green(),
            ),
            ephemeral=True,
        )
        await refresh_dashboard(self.bot)


# ── Excel export ─────────────────────────────────────────────────────────────

async def build_excel(assignment_id: int | None = None) -> tuple[io.BytesIO, str]:
    """
    Build an Excel workbook for one assignment (or all active ones).
    Returns (BytesIO, filename).
    """
    if assignment_id is not None:
        assignments = [a for a in await database.get_assignments(active_only=False) if a["id"] == assignment_id]
    else:
        assignments = await database.get_assignments(active_only=False)

    wb = openpyxl.Workbook()
    wb.remove(wb.active)  # remove default sheet

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(fill_type="solid", fgColor="2B5CE6")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for a in assignments:
        subs = await database.get_submissions(a["id"])
        field_names = _parse_fields(a.get("fields"))

        sheet_name = f"{a['week']}주차_{a['title']}"[:31]  # Excel sheet name max 31 chars
        ws = wb.create_sheet(title=sheet_name)

        # ── Header row ────────────────────────────────────────────────────────
        headers = ["팀", "이름", *field_names, "링크", "제출 시각(KST)"]
        for col, h in enumerate(headers, start=1):
            cell = ws.cell(row=1, column=col, value=h)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = center

        # ── Meta row (assignment info) ─────────────────────────────────────────
        ws.insert_rows(1)
        meta = ws.cell(row=1, column=1, value=f"{a['week']}주차 — {a['title']}  |  마감: {a['due_date']}  |  총 {len(subs)}건")
        meta.font = Font(bold=True, size=12)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))

        # ── Data rows ─────────────────────────────────────────────────────────
        for row_idx, sub in enumerate(subs, start=3):
            try:
                fv: dict = json.loads(sub["content"])
            except (json.JSONDecodeError, TypeError):
                fv = {field_names[0]: sub["content"]} if field_names else {}

            ws.cell(row=row_idx, column=1, value=sub["team"])
            ws.cell(row=row_idx, column=2, value=sub["user_name"])
            for col_offset, fname in enumerate(field_names):
                ws.cell(row=row_idx, column=3 + col_offset, value=fv.get(fname, ""))
            ws.cell(row=row_idx, column=3 + len(field_names), value=sub["link"] or "")
            ws.cell(row=row_idx, column=4 + len(field_names), value=fmt_kst(sub["submitted_at"], suffix=False))

        # ── Column widths ──────────────────────────────────────────────────────
        ws.column_dimensions["A"].width = 8   # 팀
        ws.column_dimensions["B"].width = 14  # 이름
        col_letters = [openpyxl.utils.get_column_letter(i) for i in range(3, 3 + len(field_names))]
        for letter in col_letters:
            ws.column_dimensions[letter].width = 40
        link_col = openpyxl.utils.get_column_letter(3 + len(field_names))
        time_col = openpyxl.utils.get_column_letter(4 + len(field_names))
        ws.column_dimensions[link_col].width = 50
        ws.column_dimensions[time_col].width = 20

        ws.freeze_panes = "A3"  # freeze meta + header

    if not wb.sheetnames:
        ws = wb.create_sheet("과제 없음")
        ws.cell(row=1, column=1, value="내보낼 과제 데이터가 없습니다.")

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    today = datetime.datetime.now(KST).date().isoformat()
    if assignment_id is not None and assignments:
        fname = f"과제_{assignments[0]['week']}주차_{today}.xlsx"
    else:
        fname = f"과제_전체_{today}.xlsx"

    return buf, fname


# ── Admin: Edit assignment modal ──────────────────────────────────────────────

class EditAssignmentModal(WorkspaceModal):
    def __init__(self, bot: commands.Bot, assignment: dict) -> None:
        super().__init__(title="과제 수정")
        self.bot = bot
        self.assignment = assignment

        field_names = _parse_fields(assignment.get("fields"))

        self.week_input = discord.ui.TextInput(
            label="주차", default=str(assignment["week"]), max_length=3
        )
        self.title_input = discord.ui.TextInput(
            label="과제 제목", default=assignment["title"], max_length=100
        )
        self.description_input = discord.ui.TextInput(
            label="과제 설명",
            default=assignment["description"] or "",
            style=discord.TextStyle.paragraph,
            required=False,
            max_length=500,
        )
        self.due_date_input = discord.ui.TextInput(
            label="마감일 (YYYY-MM-DD)", default=assignment["due_date"], max_length=10
        )
        self.fields_input = discord.ui.TextInput(
            label="제출 항목 (쉼표로 구분, 최대 4개)",
            default=", ".join(field_names),
            required=False,
            max_length=200,
        )

        for item in (
            self.week_input, self.title_input, self.description_input,
            self.due_date_input, self.fields_input,
        ):
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        try:
            week = int(self.week_input.value.strip())
        except ValueError:
            await interaction.response.send_message("주차는 숫자로 입력해주세요.", ephemeral=True)
            return

        try:
            datetime.date.fromisoformat(self.due_date_input.value.strip())
        except ValueError:
            await interaction.response.send_message(
                "날짜 형식이 올바르지 않습니다. 예: `2026-05-30`", ephemeral=True
            )
            return

        raw = self.fields_input.value.strip()
        field_names = (
            [f.strip() for f in raw.split(",") if f.strip()][:4] if raw else ["제출 내용"]
        )
        fields_json = json.dumps(field_names, ensure_ascii=False)

        await database.update_assignment(
            assignment_id=self.assignment["id"],
            week=week,
            title=self.title_input.value.strip(),
            description=self.description_input.value.strip(),
            due_date=self.due_date_input.value.strip(),
            type_=self.assignment["type"],
            fields=fields_json,
        )

        await interaction.response.send_message(
            embed=discord.Embed(
                title="✅ 과제 수정 완료",
                description=(
                    f"**{week}주차 — {self.title_input.value.strip()}**\n"
                    f"마감일: {self.due_date_input.value.strip()} | "
                    f"제출 항목: {', '.join(field_names)}"
                ),
                color=discord.Color.green(),
            ),
            ephemeral=True,
        )
        await refresh_dashboard(self.bot)


# ── Admin: Delete confirmation ────────────────────────────────────────────────

class DeleteConfirmView(WorkspaceView):
    def __init__(self, bot: commands.Bot, assignment: dict) -> None:
        super().__init__(timeout=60)
        self.bot = bot
        self.assignment = assignment

    @discord.ui.button(label="🗑️ 삭제 확인", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        sub_count = len(await database.get_submissions(self.assignment["id"]))
        await database.delete_assignment(self.assignment["id"])
        await interaction.response.edit_message(
            embed=discord.Embed(
                title="🗑️ 삭제 완료",
                description=(
                    f"**{self.assignment['week']}주차 — {self.assignment['title']}** 과제가 삭제되었습니다.\n"
                    f"제출 내역 **{sub_count}건**도 함께 삭제되었습니다."
                ),
                color=discord.Color.red(),
            ),
            view=None,
        )
        await refresh_dashboard(self.bot)

    @discord.ui.button(label="취소", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await interaction.response.edit_message(
            embed=discord.Embed(description="삭제가 취소되었습니다.", color=discord.Color.blurple()),
            view=None,
        )


# ── Admin: Generic assignment action select ───────────────────────────────────

class AssignmentActionSelectView(WorkspaceView):
    """Reused for both edit and delete flows."""

    def __init__(self, bot: commands.Bot, assignments: list[dict], action: str) -> None:
        super().__init__(timeout=60)
        self.bot = bot
        self.action = action  # "edit" | "delete"

        options = [
            discord.SelectOption(
                label=f"{a['week']}주차 — {a['title'][:45]}",
                value=str(a["id"]),
                description=f"마감: {a['due_date']} | {'활성' if a['is_active'] else '비활성'}",
            )
            for a in assignments[:25]
        ]
        placeholder = "수정할 과제를 선택하세요" if action == "edit" else "삭제할 과제를 선택하세요"
        select = discord.ui.Select(placeholder=placeholder, min_values=1, max_values=1, options=options)
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction) -> None:
        assignment_id = int(interaction.data["values"][0])  # type: ignore[index]
        assignment = await database.get_assignment(assignment_id)
        if not assignment:
            await interaction.response.send_message("과제를 찾을 수 없습니다.", ephemeral=True)
            return

        if self.action == "edit":
            await interaction.response.send_modal(EditAssignmentModal(self.bot, assignment))
        else:
            sub_count = len(await database.get_submissions(assignment_id))
            await interaction.response.edit_message(
                embed=discord.Embed(
                    title="⚠️ 과제 삭제 확인",
                    description=(
                        f"**{assignment['week']}주차 — {assignment['title']}** 과제를 삭제합니다.\n\n"
                        f"제출 내역 **{sub_count}건**도 함께 영구 삭제됩니다.\n"
                        "계속하시겠습니까?"
                    ),
                    color=discord.Color.red(),
                ),
                view=DeleteConfirmView(self.bot, assignment),
            )


# ── Admin: Submission detail view (ephemeral, paginated) ─────────────────────

def _build_submission_page(assignment: dict, subs: list[dict], page: int, per_page: int) -> list[discord.Embed]:
    total = len(subs)
    total_pages = max(1, (total + per_page - 1) // per_page)
    start = page * per_page
    page_subs = subs[start : start + per_page]

    header = discord.Embed(
        title=f"📋 {assignment['week']}주차 — {assignment['title']} 제출 내역",
        description=f"총 **{total}건** | {page + 1}/{total_pages} 페이지",
        color=BRAND_COLOR,
    )
    embeds = [header]

    for sub in page_subs:
        try:
            field_values: dict = json.loads(sub["content"])
        except (json.JSONDecodeError, TypeError):
            field_values = {"내용": sub["content"]}

        sub_embed = discord.Embed(
            title=f"👤 {sub['user_name']} ({sub['team']})",
            color=discord.Color.green(),
        )
        for label, value in field_values.items():
            sub_embed.add_field(name=label, value=value[:512] or "—", inline=False)
        if sub["link"]:
            sub_embed.add_field(name="링크", value=sub["link"], inline=False)
        sub_embed.set_footer(text=f"제출 시각: {fmt_kst(sub['submitted_at'])}")
        embeds.append(sub_embed)

    return embeds


class SubmissionDetailView(WorkspaceView):
    PER_PAGE = 4  # header + 4 submissions = 5 embeds (Discord max 10)

    def __init__(self, assignment: dict, subs: list[dict], page: int = 0) -> None:
        super().__init__(timeout=120)
        self.assignment = assignment
        self.subs = subs
        self.page = page
        self.total_pages = max(1, (len(subs) + self.PER_PAGE - 1) // self.PER_PAGE)
        self._sync_buttons()

    def _sync_buttons(self) -> None:
        self.prev_btn.disabled = self.page == 0
        self.next_btn.disabled = self.page >= self.total_pages - 1

    def build_embeds(self) -> list[discord.Embed]:
        return _build_submission_page(self.assignment, self.subs, self.page, self.PER_PAGE)

    @discord.ui.button(label="◀ 이전", style=discord.ButtonStyle.secondary)
    async def prev_btn(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.page -= 1
        self._sync_buttons()
        await interaction.response.edit_message(embeds=self.build_embeds(), view=self)

    @discord.ui.button(label="다음 ▶", style=discord.ButtonStyle.secondary)
    async def next_btn(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.page += 1
        self._sync_buttons()
        await interaction.response.edit_message(embeds=self.build_embeds(), view=self)


class SubmissionAssignmentSelectView(WorkspaceView):
    def __init__(self, bot: commands.Bot, assignments: list[dict]) -> None:
        super().__init__(timeout=60)
        self.bot = bot
        options = [
            discord.SelectOption(
                label=f"{a['week']}주차 — {a['title'][:45]}",
                value=str(a["id"]),
                description=f"마감: {a['due_date']}",
            )
            for a in assignments[:25]
        ]
        select = discord.ui.Select(
            placeholder="제출 내역을 볼 과제를 선택하세요",
            min_values=1,
            max_values=1,
            options=options or [discord.SelectOption(label="등록된 과제가 없습니다", value="unconfigured")],
            disabled=not options,
        )
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction) -> None:
        assignment_id = int(interaction.data["values"][0])  # type: ignore[index]
        assignment = await database.get_assignment(assignment_id)
        if not assignment:
            await interaction.response.edit_message(content="과제를 찾을 수 없습니다.", embeds=[], view=None)
            return

        subs = await database.get_submissions(assignment_id)
        if not subs:
            await interaction.response.edit_message(
                embeds=[discord.Embed(
                    title=f"📋 {assignment['week']}주차 — {assignment['title']} 제출 내역",
                    description="아직 제출한 인원이 없습니다.",
                    color=discord.Color.orange(),
                )],
                view=None,
            )
            return

        view = SubmissionDetailView(assignment, subs)
        await interaction.response.edit_message(embeds=view.build_embeds(), view=view)


# ── Admin: Dashboard panel view (persistent) ──────────────────────────────────

class AdminDashboardView(WorkspaceView):
    """Survives bot restarts via custom_id."""

    def __init__(self, bot: commands.Bot) -> None:
        super().__init__(timeout=None)
        self.bot = bot

    @discord.ui.button(
        label="팀 과제 만들기",
        emoji="➕",
        style=discord.ButtonStyle.success,
        custom_id="assignment:create:team",
        row=0,
    )
    async def create_team(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return
        await interaction.response.send_modal(CreateAssignmentModal(self.bot, "team"))

    @discord.ui.button(
        label="개인 과제 만들기",
        emoji="➕",
        style=discord.ButtonStyle.primary,
        custom_id="assignment:create:individual",
        row=0,
    )
    async def create_individual(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return
        await interaction.response.send_modal(CreateAssignmentModal(self.bot, "individual"))

    @discord.ui.button(
        label="📋 제출 내역 보기",
        style=discord.ButtonStyle.secondary,
        custom_id="assignment:view_submissions",
        row=0,
    )
    async def view_submissions(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        assignments = await database.get_assignments(active_only=False)
        if not assignments:
            await interaction.response.send_message(
                embed=discord.Embed(description="등록된 과제가 없습니다.", color=discord.Color.orange()),
                ephemeral=True,
            )
            return

        if len(assignments) == 1:
            assignment = assignments[0]
            subs = await database.get_submissions(assignment["id"])
            if not subs:
                await interaction.response.send_message(
                    embeds=[discord.Embed(
                        title=f"📋 {assignment['week']}주차 — {assignment['title']} 제출 내역",
                        description="아직 제출한 인원이 없습니다.",
                        color=discord.Color.orange(),
                    )],
                    ephemeral=True,
                )
                return
            view = SubmissionDetailView(assignment, subs)
            await interaction.response.send_message(
                embeds=view.build_embeds(), view=view, ephemeral=True
            )
        else:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="📋 제출 내역 조회",
                    description="내역을 볼 과제를 선택하세요.",
                    color=BRAND_COLOR,
                ),
                view=SubmissionAssignmentSelectView(self.bot, assignments),
                ephemeral=True,
            )

    @discord.ui.button(
        label="✏️ 과제 수정",
        style=discord.ButtonStyle.secondary,
        custom_id="assignment:edit",
        row=1,
    )
    async def edit_assignment(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        assignments = await database.get_assignments(active_only=False)
        if not assignments:
            await interaction.response.send_message(
                embed=discord.Embed(description="등록된 과제가 없습니다.", color=discord.Color.orange()),
                ephemeral=True,
            )
            return

        if len(assignments) == 1:
            await interaction.response.send_modal(
                EditAssignmentModal(self.bot, assignments[0])
            )
        else:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="✏️ 과제 수정",
                    description="수정할 과제를 선택하세요.",
                    color=BRAND_COLOR,
                ),
                view=AssignmentActionSelectView(self.bot, assignments, "edit"),
                ephemeral=True,
            )

    @discord.ui.button(
        label="🗑️ 과제 삭제",
        style=discord.ButtonStyle.danger,
        custom_id="assignment:delete",
        row=1,
    )
    async def delete_assignment(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        assignments = await database.get_assignments(active_only=False)
        if not assignments:
            await interaction.response.send_message(
                embed=discord.Embed(description="등록된 과제가 없습니다.", color=discord.Color.orange()),
                ephemeral=True,
            )
            return

        if len(assignments) == 1:
            assignment = assignments[0]
            sub_count = len(await database.get_submissions(assignment["id"]))
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="⚠️ 과제 삭제 확인",
                    description=(
                        f"**{assignment['week']}주차 — {assignment['title']}** 과제를 삭제합니다.\n\n"
                        f"제출 내역 **{sub_count}건**도 함께 영구 삭제됩니다.\n"
                        "계속하시겠습니까?"
                    ),
                    color=discord.Color.red(),
                ),
                view=DeleteConfirmView(self.bot, assignment),
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="🗑️ 과제 삭제",
                    description="삭제할 과제를 선택하세요.",
                    color=discord.Color.red(),
                ),
                view=AssignmentActionSelectView(self.bot, assignments, "delete"),
                ephemeral=True,
            )

    @discord.ui.button(
        label="📥 엑셀 내보내기",
        style=discord.ButtonStyle.secondary,
        custom_id="assignment:export_excel",
        row=1,
    )
    async def export_excel(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        buf, fname = await build_excel()
        await interaction.followup.send(
            content="📊 전체 과제 제출 현황 엑셀 파일입니다.",
            file=discord.File(buf, filename=fname),
            ephemeral=True,
        )

    @discord.ui.button(
        label="🔄 새로고침",
        style=discord.ButtonStyle.secondary,
        custom_id="assignment:dashboard:refresh",
        row=1,
    )
    async def refresh_btn(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        await interaction.response.defer(ephemeral=True)
        await refresh_dashboard(self.bot)
        await interaction.followup.send("✅ 대시보드가 새로고침되었습니다.", ephemeral=True)

    @discord.ui.button(
        label="🔒 비밀평가 게시",
        style=discord.ButtonStyle.secondary,
        custom_id="assignment:peer_eval",
        row=2,
    )
    async def peer_eval(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return
        from cogs.peer_eval import open_admin_panel  # 지연 임포트로 순환 참조 방지
        await open_admin_panel(interaction, self.bot)


# ── Student: Dynamic submit modal ─────────────────────────────────────────────

class DynamicSubmitModal(WorkspaceModal):
    """Fields are built dynamically from assignment's fields config."""

    def __init__(self, bot: commands.Bot, assignment: dict, team: str) -> None:
        super().__init__(title="과제 제출")
        self.bot = bot
        self.assignment = assignment
        self.team = team

        field_names = _parse_fields(assignment.get("fields"))
        self._field_inputs: list[discord.ui.TextInput] = []

        for name in field_names:
            inp = discord.ui.TextInput(
                label=name[:45],
                style=discord.TextStyle.paragraph,  # 모든 내용 필드 여러 줄 입력 (Enter = 줄바꿈)
                required=True,
                max_length=500,
            )
            self.add_item(inp)
            self._field_inputs.append(inp)

        self._link_input = discord.ui.TextInput(
            label="링크 (선택 — GitHub, Notion, Drive 등)",
            placeholder="https://...",
            required=False,
            max_length=500,
        )
        self.add_item(self._link_input)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)

        from storage_client import client, StorageUnavailable
        if client:
            try:
                await client.refresh_settings(config.current().GUILD_ID)
            except StorageUnavailable:
                await interaction.followup.send('과제 제출을 시작하지 못했습니다. 웹 연결이 복구된 뒤 다시 제출해 주세요.', ephemeral=True)
                return
        if config.current().TEAM_MEMBERS is not None:
            user_id = str(interaction.user.id)
            team = config.current().TEAM_MEMBERS.get(user_id)
            if user_id not in config.current().TEAM_MEMBERS or (self.assignment['type'] == 'team' and not team):
                await interaction.followup.send('웹의 승인·과정 등록·팀 배정을 확인하세요.', ephemeral=True)
                return
            self.team = team if self.assignment['type'] == 'team' else '개인'

        field_values = {inp.label: inp.value.strip() for inp in self._field_inputs}
        link = self._link_input.value.strip()
        content_json = json.dumps(field_values, ensure_ascii=False)

        try:
            ok = await database.create_submission(
                assignment_id=self.assignment["id"],
                user_id=str(interaction.user.id),
                user_name=interaction.user.display_name,
                team=self.team,
                content=content_json,
                link=link,
            )
        except StorageUnavailable:
            await interaction.followup.send('제출 결과를 확인하지 못했습니다. 잠시 후 다시 제출해 주세요. 이미 저장된 경우에는 중복 제출 안내가 표시됩니다.', ephemeral=True)
            return

        if not ok:
            await interaction.followup.send(
                embed=discord.Embed(
                    title="이미 제출하셨습니다",
                    description=(
                        f"**{self.assignment['title']}** 과제는 이미 제출하셨습니다.\n"
                        "중복 제출은 허용되지 않습니다."
                    ),
                    color=discord.Color.orange(),
                ),
                ephemeral=True,
            )
            return

        await interaction.followup.send(
            embed=discord.Embed(
                title="✅ 제출 완료!",
                description=(
                    f"**{self.assignment['week']}주차 — {self.assignment['title']}** "
                    "과제가 제출되었습니다."
                ),
                color=discord.Color.green(),
            ),
            ephemeral=True,
        )
        await refresh_dashboard(self.bot)


# ── Student: Team select ──────────────────────────────────────────────────────

class TeamSelectView(WorkspaceView):
    def __init__(self, bot: commands.Bot, assignment: dict) -> None:
        super().__init__(timeout=120)
        self.bot = bot
        self.assignment = assignment

        options = [discord.SelectOption(label=t, value=t, emoji="👥") for t in teams()[:25]]
        select = discord.ui.Select(
            placeholder="소속 팀을 선택하세요",
            min_values=1,
            max_values=1,
            options=options or [discord.SelectOption(label="웹에서 팀을 먼저 설정하세요", value="unconfigured")],
            disabled=not options,
        )
        select.callback = self._on_team_select
        self.add_item(select)

    async def _on_team_select(self, interaction: discord.Interaction) -> None:
        if await start_web_submission(self.bot, interaction, self.assignment):
            return
        team = interaction.data["values"][0]  # type: ignore[index]
        await interaction.response.send_modal(
            DynamicSubmitModal(self.bot, self.assignment, team)
        )


# ── Student: Assignment select (multiple active) ──────────────────────────────

class AssignmentSelectView(WorkspaceView):
    def __init__(self, bot: commands.Bot, assignments: list[dict]) -> None:
        super().__init__(timeout=120)
        self.bot = bot

        options = [
            discord.SelectOption(
                label=f"{a['week']}주차 — {a['title'][:45]}",
                value=str(a["id"]),
                description=f"마감: {a['due_date']}",
            )
            for a in assignments[:25]
        ]
        select = discord.ui.Select(
            placeholder="제출할 과제를 선택하세요",
            min_values=1,
            max_values=1,
            options=options or [discord.SelectOption(label="등록된 과제가 없습니다", value="unconfigured")],
            disabled=not options,
        )
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction) -> None:
        assignment_id = int(interaction.data["values"][0])  # type: ignore[index]
        assignment = await database.get_assignment(assignment_id)
        if not assignment:
            await interaction.response.send_message("과제를 찾을 수 없습니다.", ephemeral=True)
            return

        existing = await database.get_submission(assignment_id, str(interaction.user.id))
        if existing:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="이미 제출하셨습니다",
                    description=f"**{assignment['title']}** 과제는 이미 제출하셨습니다.",
                    color=discord.Color.orange(),
                ),
                ephemeral=True,
            )
            return

        if await start_web_submission(self.bot, interaction, assignment):
            return
        if assignment["type"] == "team":
            await interaction.response.send_message(
                embed=discord.Embed(
                    title=f"📌 {assignment['week']}주차 — {assignment['title']}",
                    description="소속 팀을 선택해주세요.",
                    color=BRAND_COLOR,
                ),
                view=TeamSelectView(self.bot, assignment),
                ephemeral=True,
            )
        else:
            await interaction.response.send_modal(
                DynamicSubmitModal(self.bot, assignment, "개인")
            )


# ── Student: Submit panel (persistent) ───────────────────────────────────────

def build_submit_embed():
    embed = panel_embed("배운 것을, 결과물로", "오늘의 배움을 기록하고 피드백을 받아보세요.", section="ASSIGNMENTS")
    panel_field(embed, "01  과제 선택", "아래 **과제 제출하기** 버튼에서 진행 중인 과제를 선택하세요.")
    panel_field(embed, "02  내용 작성", "과제의 제출 항목을 채우고, 필요한 링크를 함께 남겨 주세요.")
    panel_field(embed, "03  제출 확인", "제출 완료 안내를 확인하세요. 결과는 LMS 제출 내역에도 반영됩니다.")
    embed.set_footer(text="AX LearningOps · 팀 과제는 LMS에 배정된 소속 조로 제출됩니다")
    return embed


async def start_web_submission(bot, interaction, assignment):
    if config.current().TEAM_MEMBERS is None:
        return False
    user_id = str(interaction.user.id)
    team = config.current().TEAM_MEMBERS.get(user_id)
    if user_id not in config.current().TEAM_MEMBERS or (assignment['type'] == 'team' and not team):
        await interaction.response.send_message('웹의 가입 승인·과정 등록·팀 배정을 확인하세요.', ephemeral=True)
    else:
        await interaction.response.send_modal(DynamicSubmitModal(bot, assignment, team if assignment['type'] == 'team' else '개인'))
    return True


class SubmitPanelView(WorkspaceView):
    """Survives bot restarts via custom_id."""

    def __init__(self, bot: commands.Bot) -> None:
        super().__init__(timeout=None)
        self.bot = bot

    @discord.ui.button(
        label="과제 제출하기",
        emoji="📝",
        style=discord.ButtonStyle.primary,
        custom_id="assignment:submit",
    )
    async def submit(
        self, interaction: discord.Interaction, button: discord.ui.Button
    ) -> None:
        assignments = await database.get_assignments(active_only=True)

        if not assignments:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="진행 중인 과제 없음",
                    description="현재 제출 가능한 과제가 없습니다.",
                    color=discord.Color.orange(),
                ),
                ephemeral=True,
            )
            return

        if len(assignments) == 1:
            assignment = assignments[0]
            existing = await database.get_submission(assignment["id"], str(interaction.user.id))
            if existing:
                await interaction.response.send_message(
                    embed=discord.Embed(
                        title="이미 제출하셨습니다",
                        description=f"**{assignment['title']}** 과제는 이미 제출하셨습니다.",
                        color=discord.Color.orange(),
                    ),
                    ephemeral=True,
                )
                return

            if await start_web_submission(self.bot, interaction, assignment):
                return
            if assignment["type"] == "team":
                await interaction.response.send_message(
                    embed=discord.Embed(
                        title=f"📌 {assignment['week']}주차 — {assignment['title']}",
                        description=f"마감일: **{assignment['due_date']}**\n\n소속 팀을 선택해주세요.",
                        color=BRAND_COLOR,
                    ),
                    view=TeamSelectView(self.bot, assignment),
                    ephemeral=True,
                )
            else:
                await interaction.response.send_modal(
                    DynamicSubmitModal(self.bot, assignment, "개인")
                )
        else:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="📋 과제 선택",
                    description="제출할 과제를 선택하세요.",
                    color=BRAND_COLOR,
                ),
                view=AssignmentSelectView(self.bot, assignments),
                ephemeral=True,
            )


# ── Cog ───────────────────────────────────────────────────────────────────────

class Assignment(commands.Cog):
    group = app_commands.Group(name="과제", description="과제 관리")

    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    async def cog_load(self) -> None:
        self.bot.add_view(SubmitPanelView(self.bot))
        self.bot.add_view(AdminDashboardView(self.bot))
        self.deadline_reminder.start()

    async def cog_unload(self) -> None:
        self.deadline_reminder.cancel()

    # ── Deadline reminder loop ─────────────────────────────────────────────────
    # Runs daily at 09:00 KST (00:00 UTC)

    @tasks.loop(time=datetime.time(hour=0, minute=0, tzinfo=datetime.timezone.utc))
    @each_workspace
    async def deadline_reminder(self) -> None:
        if config.managed_storage:
            return  # The web outbox owns durable team and individual D-1 notifications.
        # Tomorrow in KST = today UTC+9 + 1 day
        tomorrow_kst = (
            datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
            + datetime.timedelta(days=1)
        ).date()
        due_str = tomorrow_kst.isoformat()

        assignments = await database.get_team_assignments_due_on(due_str)
        if not assignments:
            return

        guild = self.bot.get_guild(config.current().GUILD_ID)
        if not guild:
            return

        for assignment in assignments:
            subs = await database.get_submissions(assignment["id"])
            submitted_teams = {s["team"] for s in subs}

            for team, channel_id in config.current().TEAM_CHANNELS.items():
                if team in submitted_teams:
                    continue  # already submitted
                if await database.is_assignment_reminder_sent(assignment["id"], team):
                    continue  # already reminded

                ch = guild.get_channel(channel_id)
                if not ch or not isinstance(ch, discord.TextChannel):
                    continue

                embed = discord.Embed(
                    title="⏰ 과제 마감 D-1 알림",
                    description=(
                        f"**{assignment['week']}주차 — {assignment['title']}** 과제 마감이 "
                        f"**내일({due_str})** 입니다.\n\n"
                        "아직 제출하지 않으셨습니다. 마감 전에 과제를 제출해주세요! 🙏"
                    ),
                    color=discord.Color.orange(),
                )
                embed.set_footer(text="AX LearningOps · 과제 마감 알림")

                try:
                    await ch.send(embed=embed)
                    await database.mark_assignment_reminder_sent(assignment["id"], team)
                    log.info("Deadline reminder sent to %s for assignment %d", team, assignment["id"])
                except discord.Forbidden:
                    log.warning("Cannot send reminder to channel %d (%s)", channel_id, team)

    @deadline_reminder.before_loop
    async def before_deadline_reminder(self) -> None:
        await self.bot.wait_until_ready()

    # ── /과제 패널 ─────────────────────────────────────────────────────────────

    @group.command(name="패널", description="과제제출 채널에 제출 패널을 게시합니다 (관리자 전용)")
    async def post_panel(self, interaction: discord.Interaction) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        manager = self.bot.get_cog('AutoPanels')
        if manager:
            message = await manager.publish('submit')
            await interaction.followup.send('제출 패널을 갱신하고 고정했습니다.' if message else '웹의 제출 채널 설정을 확인하세요.', ephemeral=True)
            return
        ch = interaction.guild.get_channel(config.current().ASSIGNMENT_SUBMIT_CHANNEL_ID)  # type: ignore[union-attr]
        if not ch or not isinstance(ch, discord.TextChannel):
            await interaction.followup.send("과제제출 채널을 찾을 수 없습니다.", ephemeral=True)
            return

        embed = build_submit_embed()

        msg = await ch.send(embed=embed, view=SubmitPanelView(self.bot))
        await database.save_assignment_panel("submit", str(ch.id), str(msg.id))

        await interaction.followup.send(
            embed=discord.Embed(
                title="✅ 제출 패널 게시 완료",
                description=f"{ch.mention} 채널에 게시되었습니다.",
                color=discord.Color.green(),
            ),
            ephemeral=True,
        )

    # ── /과제 대시보드 ──────────────────────────────────────────────────────────

    @group.command(name="대시보드", description="과제 대시보드 패널을 게시합니다 (관리자 전용)")
    async def post_dashboard(self, interaction: discord.Interaction) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        manager = self.bot.get_cog('AutoPanels')
        if manager:
            message = await manager.publish('dashboard')
            await interaction.followup.send('과제 대시보드를 갱신하고 고정했습니다.' if message else '웹의 대시보드 채널 설정을 확인하세요.', ephemeral=True)
            return
        ch = interaction.guild.get_channel(config.current().ASSIGNMENT_DASHBOARD_CHANNEL_ID)  # type: ignore[union-attr]
        if not ch or not isinstance(ch, discord.TextChannel):
            await interaction.followup.send("과제 대시보드 채널을 찾을 수 없습니다.", ephemeral=True)
            return

        new_embeds = await build_dashboard_embeds()
        msg = await ch.send(embeds=new_embeds, view=AdminDashboardView(self.bot))
        await database.save_assignment_panel("dashboard", str(ch.id), str(msg.id))

        await interaction.followup.send(
            embed=discord.Embed(
                title="✅ 대시보드 게시 완료",
                description=f"{ch.mention} 채널에 게시되었습니다.",
                color=discord.Color.green(),
            ),
            ephemeral=True,
        )

    # ── /과제 목록 ─────────────────────────────────────────────────────────────

    @group.command(name="목록", description="과제 목록을 확인합니다")
    async def list_assignments(self, interaction: discord.Interaction) -> None:
        assignments = await database.get_assignments(active_only=False)

        if not assignments:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title="과제 없음",
                    description="등록된 과제가 없습니다.",
                    color=discord.Color.orange(),
                ),
                ephemeral=True,
            )
            return

        embed = discord.Embed(title="📋 과제 목록", color=BRAND_COLOR)
        for a in assignments[:10]:
            status = "✅ 활성" if a["is_active"] else "🚫 비활성"
            type_label = "팀별" if a["type"] == "team" else "개인별"
            embed.add_field(
                name=f"{a['week']}주차 — {a['title']}",
                value=f"ID: `{a['id']}` | 마감: {a['due_date']} | {type_label} | {status}",
                inline=False,
            )

        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ── /과제 비활성화 ─────────────────────────────────────────────────────────

    @group.command(name="비활성화", description="과제를 비활성화합니다 (관리자 전용)")
    @app_commands.describe(assignment_id="비활성화할 과제 ID (/과제 목록에서 확인)")
    async def deactivate(
        self, interaction: discord.Interaction, assignment_id: int
    ) -> None:
        if not _is_admin(interaction):
            await interaction.response.send_message("관리자만 사용할 수 있습니다.", ephemeral=True)
            return

        ok = await database.deactivate_assignment(assignment_id)
        if not ok:
            await interaction.response.send_message(
                "해당 ID의 과제를 찾을 수 없습니다.", ephemeral=True
            )
            return

        await interaction.response.send_message(
            embed=discord.Embed(
                title="✅ 비활성화 완료",
                description=f"과제 ID `{assignment_id}`이(가) 비활성화되었습니다.",
                color=discord.Color.green(),
            ),
            ephemeral=True,
        )
        await refresh_dashboard(self.bot)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Assignment(bot))
