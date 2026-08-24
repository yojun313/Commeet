"""Turns MongoDB documents (ObjectId, tz-aware datetime) into JSON-safe values."""

from datetime import datetime

from bson import ObjectId


def jsonable(value):
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return value
