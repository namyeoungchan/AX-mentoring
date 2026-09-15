"""Fixed channel objects for the existing bot database (config.GUILD_ID only)."""
from dataclasses import dataclass
from types import MappingProxyType


@dataclass(frozen=True)
class PanelObject:
    channel_setting: str
    template_id: str
    channel_names: tuple[str, ...]
    refresh_seconds: int = 300


PANEL_OBJECTS = MappingProxyType({
    "dashboard": PanelObject("ASSIGNMENT_DASHBOARD_CHANNEL_ID", "assignment-dashboard", ("과제-대시보드", "과제대시보드")),
    "submit": PanelObject("ASSIGNMENT_SUBMIT_CHANNEL_ID", "assignments", ("과제제출", "과제-제출")),
    "mentoring": PanelObject("MENTORING_CHANNEL_ID", "mentoring", ("멘토링예약", "멘토링-예약")),
    "participation": PanelObject("ASSIGNMENT_DASHBOARD_CHANNEL_ID", "assignment-dashboard", ("과제-대시보드", "과제대시보드"), 3600),
    "peer_eval": PanelObject("ASSIGNMENT_DASHBOARD_CHANNEL_ID", "assignment-dashboard", ("과제-대시보드", "과제대시보드")),
})

# The onboarding cog owns the start-channel object and its persistent button.
ONBOARDING_OBJECT = MappingProxyType({"template_id": "start", "owner": "LMSOnboarding"})
