"""Lossless JSON values for the existing database method interface."""
from datetime import date, datetime


def encode(value):
    if type(value) is int and abs(value) > 9007199254740991:
        return {"$lms": "int", "value": str(value)}
    if isinstance(value, (date, datetime)):
        return {"$lms": "date", "value": value.isoformat()}
    if isinstance(value, (set, tuple)):
        return {"$lms": type(value).__name__, "value": [encode(v) for v in value]}
    if isinstance(value, dict):
        return {"$lms": "dict", "value": [[encode(k), encode(v)] for k, v in value.items()]}
    if isinstance(value, list):
        return [encode(v) for v in value]
    return value


def decode(value):
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        kind, contents = value.get("$lms"), value.get("value")
        if kind == "date":
            return date.fromisoformat(contents)
        if kind == "int":
            return int(contents)
        if kind == "set":
            return set(decode(v) for v in contents)
        if kind == "tuple":
            return tuple(decode(v) for v in contents)
        if kind == "dict":
            return {decode(k): decode(v) for k, v in contents}
        return {k: decode(v) for k, v in value.items()}
    return value


def pack_runtime(kind, value):
    if kind in {'role', 'channel', 'panel', 'panel-channel'} and isinstance(value, dict):
        return {key: str(item) if key in {'id', 'messageId', 'channelId'} and type(item) is int else item for key, item in value.items()}
    return value


def unpack_runtime(kind, value):
    if kind in {'role', 'channel', 'panel', 'panel-channel'} and isinstance(value, dict):
        return {key: int(item) if key in {'id', 'messageId', 'channelId'} and isinstance(item, str) and item.isdigit() else item for key, item in value.items()}
    return value
