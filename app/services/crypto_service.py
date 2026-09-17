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
import re
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


# 첨부 파일명은 서버가 만드는 두 가지 모양뿐입니다. 저장 문서의 파일명은
# 클라이언트 저장 요청(SettlementInput.receiptFile)을 거쳐 온 값일 수 있어
# 신뢰할 수 없습니다 - "../"가 섞인 이름이 삭제/읽기 경로에 들어가면 기록
# 폴더 밖의 파일을 건드리게 되므로, 경로를 만들기 전에 반드시 거릅니다.
_SAFE_NAME_RE = re.compile(
    r"^(signature\.png|receipt-\d{1,2}\.(png|jpg|jpeg|webp|pdf))$"
)
_SAFE_RECORD_ID_RE = re.compile(r"^[0-9a-f]{24}$")


def _safe_path(record_id: str, name: str):
    """기록 폴더 안의 검증된 경로. 모양이 어긋나면 None - 호출자는 없는
    파일처럼 다룹니다 (그런 이름은 애초에 저장된 적이 없습니다)."""
    if not _SAFE_RECORD_ID_RE.match(record_id or ""):
        return None
    if not _SAFE_NAME_RE.match(name or ""):
        return None
    return storage_dir() / record_id / name


def write_encrypted_file(record_id: str, name: str, raw: bytes) -> str:
    """Stores one encrypted attachment and returns its stored filename."""
    path = _safe_path(record_id, name)
    if path is None:
        raise ValueError(f"attachment name rejected: {name!r}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encrypt_bytes(raw))
    return name


def read_encrypted_file(record_id: str, name: str) -> bytes | None:
    path = _safe_path(record_id, name)
    if path is None or not path.is_file():
        return None
    return decrypt_bytes(path.read_bytes())


def delete_file(record_id: str, name: str) -> None:
    path = _safe_path(record_id, name)
    if path is not None:
        path.unlink(missing_ok=True)


def delete_record_files(record_id: str) -> None:
    if not _SAFE_RECORD_ID_RE.match(record_id or ""):
        return
    folder = storage_dir() / record_id
    if not folder.is_dir():
        return
    for child in folder.iterdir():
        child.unlink(missing_ok=True)
    folder.rmdir()
