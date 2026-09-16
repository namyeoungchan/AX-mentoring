import os
import sys
from contextvars import ContextVar
from contextlib import contextmanager
from types import SimpleNamespace
from dotenv import load_dotenv

load_dotenv()

DISCORD_TOKEN: str = os.environ["DISCORD_TOKEN"]
# Compatibility only for identifying an old, single-server local DB during import.
# Live operations use the Discord event's guild and the web workspace registry.
GUILD_ID: int = int(os.getenv("GUILD_ID", "0") or "0")
LEGACY_IMPORT_GUILD_ID: int = int(os.getenv("LEGACY_IMPORT_GUILD_ID", "0") or "0")
ADMIN_ROLE_ID: int = int(os.getenv("ADMIN_ROLE_ID", "0") or "0")
DB_PATH: str = os.getenv("DB_PATH", "data/mentoring.db")
SYNC_GLOBALLY: bool = os.getenv("SYNC_GLOBALLY", "false").lower() == "true"

# Legacy import defaults only. Live IDs come from current(), never shared constants.
TEAM_CHANNELS: dict[str, int] = {}
TEAM_MEMBERS: dict[str, str] | None = None  # Verified web roster; None means legacy mode.

# ── Q&A Forum ────────────────────────────────────────────────────────────────
QA_FORUM_CHANNEL_ID: int = int(os.getenv("QA_FORUM_CHANNEL_ID", "0") or "0")
QA_NOTIFY_ROLE_IDS: list[int] = []
QA_UNANSWERED_HOURS: int = int(os.getenv("QA_UNANSWERED_HOURS", "24"))

# ── Assignment ────────────────────────────────────────────────────────────────
ASSIGNMENT_DASHBOARD_CHANNEL_ID: int = int(os.getenv("ASSIGNMENT_DASHBOARD_CHANNEL_ID", "0") or "0")
ASSIGNMENT_SUBMIT_CHANNEL_ID: int = int(os.getenv("ASSIGNMENT_SUBMIT_CHANNEL_ID", "0") or "0")
MENTORING_CHANNEL_ID: int = int(os.getenv("MENTORING_CHANNEL_ID", "0"))

# ── Onboarding ────────────────────────────────────────────────────────────────
# Role assigned immediately on join (restricted access)
STUDENT_ROLE_ID: int = int(os.getenv("STUDENT_ROLE_ID", "0") or "0")
# Channel where the welcome+onboarding message is pinned
ONBOARDING_CHANNEL_ID: int = int(os.getenv("ONBOARDING_CHANNEL_ID", "0"))
# Channel where members post their self-introductions
INTRO_CHANNEL_ID: int = int(os.getenv("INTRO_CHANNEL_ID", "0"))
# Role granted after self-intro is submitted (unlocks full access); optional
_ONBOARDING_COMPLETE_ROLE_ID: str = os.getenv("ONBOARDING_COMPLETE_ROLE_ID", "")
ONBOARDING_COMPLETE_ROLE_ID: int | None = int(_ONBOARDING_COMPLETE_ROLE_ID) if _ONBOARDING_COMPLETE_ROLE_ID else None

workspace_guild = ContextVar('workspace_guild', default=None)
workspace_settings: dict[int, SimpleNamespace] = {}
managed_storage = False
CHANNEL_SETTINGS = ('ADMIN_ROLE_ID', 'STUDENT_ROLE_ID', 'ONBOARDING_COMPLETE_ROLE_ID',
                    'ONBOARDING_CHANNEL_ID', 'INTRO_CHANNEL_ID', 'ASSIGNMENT_DASHBOARD_CHANNEL_ID',
                    'ASSIGNMENT_SUBMIT_CHANNEL_ID', 'MENTORING_CHANNEL_ID', 'QA_FORUM_CHANNEL_ID')


@contextmanager
def guild_scope(guild_id):
    token = workspace_guild.set(int(guild_id))
    try:
        yield
    finally:
        workspace_guild.reset(token)


def install_workspace(guild_id, status):
    settings = status.get('settings') or {}
    channels = settings.get('channels') or {}
    values = {name: int(channels.get(name) or 0) for name in CHANNEL_SETTINGS}
    values.update(GUILD_ID=int(guild_id), TEAM_CHANNELS={row['name']: int(row.get('channelId') or 0) for row in settings.get('teams', [])},
                  TEAM_MEMBERS=status.get('teamMembers'), QA_NOTIFY_ROLE_IDS=[int(v) for v in settings.get('qaNotifyRoleIds', [])],
                  QA_UNANSWERED_HOURS=settings.get('qaUnansweredHours', 24))
    workspace_settings[int(guild_id)] = SimpleNamespace(**values)


def current():
    """Task-local server settings; never reuse another server's role or channel IDs."""
    if not managed_storage:
        return sys.modules[__name__]
    guild_id = workspace_guild.get()
    if guild_id not in workspace_settings:
        raise RuntimeError('워크스페이스의 서버 연결이 아직 준비되지 않았습니다.')
    return workspace_settings[guild_id]
