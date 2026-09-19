"""Idempotent channel instructions; only edit this bot's marked messages."""
import json
from pathlib import Path

import discord
from ui.embeds import panel_embed

GUIDES = json.loads((Path(__file__).resolve().parents[1] / "lms-web/shared/channel-guides.json").read_text(encoding="utf-8"))


def guide_text(item):
    return item.get("guide", GUIDES.get(item["id"], f"{item['name']} 이용 안내\n이 채널의 주제에 맞는 내용을 작성하세요. 질문에는 필요한 배경과 시도한 방법을 함께 적어 주세요."))


async def ensure_guide(channel, text, view=None):
    if not text:
        return
    legacy_marker = f"learningops:guide:{channel.id}"
    marker = "AX 학습관리시스템 · 채널 이용 안내"
    def owned(message):
        return message.author.id == channel.guild.me.id and any(embed.footer.text in {marker, legacy_marker, "AX LearningOps · 채널 이용 안내"} for embed in message.embeds)
    target = None
    async for message in channel.pins(limit=100):
        if owned(message):
            target = message
            break
    if target is None:
        async for message in channel.history(limit=100):
            if owned(message):
                target = message
                break
    embed = panel_embed(title=f"{channel.name} 이용 안내", description=text, section="START HERE")
    embed.set_footer(text=marker)
    extra = {"view": view} if view is not None else {}
    if target:
        if not target.embeds or target.embeds[0].to_dict() != embed.to_dict() or view is not None:
            await target.edit(embed=embed, allowed_mentions=discord.AllowedMentions.none(), **extra)
    else:
        target = await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none(), **extra)
    if not target.pinned:
        await target.pin(reason="LMS channel instructions")
    return target
