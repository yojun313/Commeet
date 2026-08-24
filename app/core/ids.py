"""ObjectId helpers and the short shareable event-id scheme."""

import secrets

from bson import ObjectId
from bson.errors import InvalidId

# Deliberately excludes ambiguous characters (0/O, 1/l/I).
_SHORT_ID_ALPHABET = "23456789ABCDEFabcdef"
_SHORT_ID_LENGTH = 5


def is_object_id(value: str) -> bool:
    try:
        ObjectId(value)
        return True
    except (InvalidId, TypeError):
        return False


def to_object_id(value: str) -> ObjectId | None:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def generate_short_id() -> str:
    return "".join(secrets.choice(_SHORT_ID_ALPHABET) for _ in range(_SHORT_ID_LENGTH))
