"""POVIS 자동입력 크롬 확장: 소개·설치 안내 페이지와 설치 파일 다운로드.

확장 소스는 이 저장소의 `extension/` 폴더 그대로입니다. 별도 빌드 산출물을
관리하지 않고 요청이 오면 그 폴더를 zip으로 묶어 내려줍니다 - 배포 서버에
코드를 올리면 그 순간의 확장이 곧 배포본이라, "zip을 다시 만드는 걸 잊는"
종류의 사고가 없습니다. 파일이 몇 개 안 되어 묶는 비용은 무시할 만하지만,
같은 내용을 매번 다시 압축하지는 않도록 파일 변경 시각으로 캐시합니다.
"""

import io
import json
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from app.core.paths import BASE_DIR
from app.core.templates import templates
from app.services.auth_service import get_optional_user

router = APIRouter(tags=["extension"])

EXTENSION_DIR = BASE_DIR / "extension"
# README는 개발자용이고, 숨김 파일(.DS_Store 등)은 스토어·크롬이 싫어합니다.
EXCLUDED_NAMES = {"README.md"}

_cache: dict[str, object] = {"key": None, "zip": b"", "version": ""}


def _extension_files() -> list[Path]:
    return sorted(
        p
        for p in EXTENSION_DIR.rglob("*")
        if p.is_file()
        and p.name not in EXCLUDED_NAMES
        and not any(part.startswith(".") for part in p.relative_to(EXTENSION_DIR).parts)
    )


def extension_version() -> str:
    try:
        return json.loads((EXTENSION_DIR / "manifest.json").read_text("utf-8")).get(
            "version", ""
        )
    except (OSError, ValueError):
        return ""


def build_zip() -> tuple[bytes, str]:
    """(zip 바이트, 버전). 폴더가 바뀌지 않았으면 지난번 것을 돌려줍니다."""
    files = _extension_files()
    if not files:
        raise FileNotFoundError(EXTENSION_DIR)
    key = tuple(
        (p.relative_to(EXTENSION_DIR).as_posix(), p.stat().st_mtime_ns) for p in files
    )
    if _cache["key"] == key:
        return _cache["zip"], _cache["version"]  # type: ignore[return-value]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            # manifest.json이 zip 최상위에 오도록 폴더 이름 없이 상대 경로만 씁니다.
            z.write(p, p.relative_to(EXTENSION_DIR).as_posix())
    version = extension_version()
    _cache.update({"key": key, "zip": buf.getvalue(), "version": version})
    return _cache["zip"], version  # type: ignore[return-value]


@router.get("/povis-extension")
async def povis_extension_page(request: Request):
    user = await get_optional_user(request)
    return templates.TemplateResponse(
        request=request,
        name="povis_extension.html",
        context={"user": user, "version": extension_version()},
    )


@router.get("/povis-extension/download")
async def povis_extension_download():
    try:
        data, version = build_zip()
    except FileNotFoundError:
        raise HTTPException(
            status_code=404, detail="확장 프로그램 파일이 서버에 없습니다."
        )
    filename = f"commeet-povis-{version or 'latest'}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-cache",
        },
    )
