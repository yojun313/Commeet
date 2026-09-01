"""Encryption at rest for meeting records.

Meeting notes, attendee names and receipt/signature images are personal data
about students, so nothing sensitive is written to MongoDB or to disk in the
clear. Everything goes through Fernet (AES-128-CBC + HMAC-SHA256, with the
timestamp and authentication the recipe provides), so a stolen database dump
or a copied storage folder is unreadable without the key.

The key comes from RECORD_ENCRYPTION_KEY. When that is unset it is derived
from SESSION_SECRET instead, so the feature works with no extra setup - the
trade-off being that rotating SESSION_SECRET would then also orphan existing
records. `key_is_derived()` lets the UI point that out.
"""

import base64
import json
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from app.config import (
    RECORD_ENCRYPTION_KEY,
    RECORD_STORAGE_DIR,
    SESSION_SECRET,
)
from app.core.paths import BASE_DIR


class RecordDecryptionError(Exception):
    """The stored data could not be decrypted with the current key."""


def _derive_key(secret: str) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"commeet-meeting-records-v1",
        iterations=200_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(secret.encode("utf-8")))


def key_is_derived() -> bool:
    return not RECORD_ENCRYPTION_KEY


_fernet = Fernet(
    RECORD_ENCRYPTION_KEY.encode("utf-8")
    if RECORD_ENCRYPTION_KEY
    else _derive_key(SESSION_SECRET)
)


def storage_dir() -> Path:
    """Where encrypted blobs live. Created on demand; gitignored by default."""
    path = (
        Path(RECORD_STORAGE_DIR)
        if RECORD_STORAGE_DIR
        else BASE_DIR / "instance" / "records"
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def encrypt_bytes(raw: bytes) -> bytes:
    return _fernet.encrypt(raw)


def decrypt_bytes(token: bytes) -> bytes:
    try:
        return _fernet.decrypt(token)
    except InvalidToken as exc:
        raise RecordDecryptionError(
            "저장된 데이터를 복호화하지 못했습니다. RECORD_ENCRYPTION_KEY가 "
            "기록을 저장할 때와 다른 값일 수 있습니다."
        ) from exc


def encrypt_json(value) -> bytes:
    """Any JSON-serialisable value -> one opaque blob for a Mongo field."""
    return encrypt_bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def decrypt_json(token: bytes | None, default=None):
    if not token:
        return default
    return json.loads(decrypt_bytes(token).decode("utf-8"))


def write_encrypted_file(record_id: str, name: str, raw: bytes) -> str:
    """Stores one encrypted attachment and returns its stored filename."""
    folder = storage_dir() / record_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(encrypt_bytes(raw))
    return name


def read_encrypted_file(record_id: str, name: str) -> bytes | None:
    path = storage_dir() / record_id / name
    if not path.is_file():
        return None
    return decrypt_bytes(path.read_bytes())


def delete_file(record_id: str, name: str) -> None:
    (storage_dir() / record_id / name).unlink(missing_ok=True)


def delete_record_files(record_id: str) -> None:
    folder = storage_dir() / record_id
    if not folder.is_dir():
        return
    for child in folder.iterdir():
        child.unlink(missing_ok=True)
    folder.rmdir()
