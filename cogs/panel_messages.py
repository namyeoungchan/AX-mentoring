"""Publish one owned, pinned message per channel object; recover partial writes."""
import discord


def fit_embeds(embeds, marker):
    result, size = [], 0
    for source in embeds:
        embed = discord.Embed.from_dict(source.to_dict())
        embed.set_footer(text=marker + (f" · {embed.footer.text}" if embed.footer.text and not embed.footer.text.startswith(("AX 학습관리시스템", "AX LearningOps")) else ""))
        if len(result) >= 9 or size + len(embed) > 5400:
            result.append(discord.Embed(description="표시할 내용이 많습니다. 목록 조회 버튼에서 나머지 내용을 확인하세요.").set_footer(text=marker))
            break
        result.append(embed)
        size += len(embed)
    return result


async def ensure_panel(channel, kind, embeds, view, store, legacy_message_id=None):
    key = f"{kind}:{channel.id}"
    legacy_marker = f"learningops:panel:{channel.guild.id}:{kind}"
    labels = {"attendance": "입실 · 퇴실 출석", "dashboard": "과제 운영", "submit": "과제 제출", "mentoring": "멘토링 예약", "participation": "참여도", "peer_eval": "비밀평가"}
    marker = f"AX 학습관리시스템 · {labels.get(kind, kind)} · 자동 갱신"
    previous_marker = f"AX LearningOps · {labels.get(kind, kind)} · 자동 갱신"
    record = await store.get(channel.guild.id, "panel", key)
    target = None
    for message_id in dict.fromkeys([record.get("messageId") if record else None, legacy_message_id]):
        if not message_id:
            continue
        try:
            candidate = await channel.fetch_message(int(message_id))
        except discord.NotFound:
            continue
        # A stored ID never authorizes editing somebody else's message.
        if candidate.author.id == channel.guild.me.id:
            target = candidate
            break
    if target is None:
        for source in [channel.pins(limit=100), channel.history(limit=100)]:
            async for candidate in source:
                if candidate.author.id == channel.guild.me.id and any(e.footer.text == legacy_marker or (e.footer.text or "").startswith((marker, previous_marker)) for e in candidate.embeds):
                    target = candidate
                    break
            if target:
                break
    payload = {"embeds": fit_embeds(embeds, marker), "view": view, "allowed_mentions": discord.AllowedMentions.none()}
    if target:
        await target.edit(**payload)
    else:
        target = await channel.send(**payload)
    # Save before pinning: a missing pin permission must not duplicate the message on retry.
    await store.put(channel.guild.id, "panel", key, {"messageId": target.id, "channelId": channel.id})
    if not target.pinned:
        await target.pin(reason="Automatic bot channel object")
    return target
