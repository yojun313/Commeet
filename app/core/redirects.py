"""로그인이 필요한 페이지에서 "로그인 후 원래 보던 곳으로" 돌려보내기 위한 헬퍼.

초대 링크(/e/...)를 받은 사람이 로그인이 안 된 상태로 들어오면
로그인 화면으로 보내게 되는데, 이때 `?next=`에 원래 주소를 실어 두어야
로그인이 끝난 뒤 그 링크로 되돌아갈 수 있습니다. 서버(RedirectResponse),
템플릿(헤더의 로그인 버튼), JS(auth.js) 세 곳이 같은 규칙을 써야 하므로
규칙을 여기 한 곳에 모아 둡니다.
"""

from urllib.parse import quote

from starlette.requests import Request
from starlette.responses import RedirectResponse

SIGN_IN_PATH = "/sign-in"
SIGN_UP_PATH = "/sign-up"
DEFAULT_NEXT = "/home"

# 로그인 후 돌아갈 곳으로 의미가 없는 경로들 - 로그인 화면 자신과 랜딩 페이지.
_NOT_WORTH_RETURNING_TO = {"/", SIGN_IN_PATH, SIGN_UP_PATH}


def current_path(request: Request) -> str:
    """쿼리스트링까지 포함한 현재 경로 (호스트는 뺍니다)."""
    query = request.url.query
    return f"{request.url.path}?{query}" if query else request.url.path


def safe_next(next_url: str | None, fallback: str = DEFAULT_NEXT) -> str:
    """`?next=`로 넘어온 값 중 **이 사이트 내부 경로**만 통과시킵니다.

    `//evil.com`이나 `/\\evil.com`은 브라우저가 프로토콜 상대 URL로 읽어
    외부로 튕겨 버리므로(오픈 리다이렉트) 걸러 냅니다.
    """
    if not next_url or not next_url.startswith("/"):
        return fallback
    if next_url.startswith(("//", "/\\")):
        return fallback
    if any(c in next_url for c in "\r\n\t"):
        return fallback
    return next_url


def _auth_url(base: str, request: Request | None, next_url: str | None) -> str:
    target = (
        next_url
        if next_url is not None
        else (current_path(request) if request else None)
    )
    if not target or target.split("?")[0] in _NOT_WORTH_RETURNING_TO:
        return base
    return f"{base}?next={quote(target, safe='')}"


def sign_in_url(request: Request | None = None, next_url: str | None = None) -> str:
    """현재(또는 지정한) 경로로 돌아오는 로그인 URL."""
    return _auth_url(SIGN_IN_PATH, request, next_url)


def sign_up_url(request: Request | None = None, next_url: str | None = None) -> str:
    """현재(또는 지정한) 경로로 돌아오는 회원가입 URL."""
    return _auth_url(SIGN_UP_PATH, request, next_url)


def redirect_to_sign_in(
    request: Request, next_url: str | None = None
) -> RedirectResponse:
    """로그인 화면으로 보내되, 끝나면 여기로 돌아오게 합니다."""
    return RedirectResponse(sign_in_url(request, next_url))
