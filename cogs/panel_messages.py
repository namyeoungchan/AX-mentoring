"""Publish one owned, pinned message per channel object; recover partial writes."""
import discord


def fit_embeds(embeds, marker):
    result, size = [], 0
    for source in embeds:
        embed = discord.Embed.from_dict(source.to_dict())
        embed.set_footer(text=marker)
        if len(result) >= 9 or size + len(embed) > 5400:
            result.append(discord.Embed(description="표시할 내용이 많습니다. 목록 조회 버튼에서 나머지 내용을 확인하세요.").set_footer(text=marker))
            break
        result.append(embed)
        size += len(embed)
    return result


async def ensure_panel(channel, kind, embeds, view, store, legacy_message_id=None):
    key = f"{kind}:{channel.id}"
    marker = f"learningops:panel:{channel.guild.id}:{kind}"
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
                if candidate.author.id == channel.guild.me.id and any(e.footer.text == marker for e in candidate.embeds):
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
