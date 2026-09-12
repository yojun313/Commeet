"""실제 클라이언트 IP와 "교내에서 온 요청인지" 판별.

앱은 nginx 뒤에서 돌므로 request.client.host는 항상 127.0.0.1입니다. 실제
주소는 nginx가 실어 주는 X-Forwarded-For에 있는데, 이 헤더는 **직접 접속한
상대가 로컬 프록시일 때만** 믿습니다 - 7002 포트로 직접 붙은 외부인이 헤더를
꾸며 교내인 척하는 것을 막기 위해서입니다.

nginx 쪽에는 `proxy_set_header X-Forwarded-For $remote_addr;`가 있어야
합니다. 없으면 모든 요청이 127.0.0.1(=교내 취급)로 보여 이 제한이 조용히
무력화됩니다 - 배포 문서 참고.
"""

from starlette.requests import Request

from app.config import POSTECH_IP_PREFIXES

_LOOPBACK = ("127.0.0.1", "::1")


def get_client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    if peer in _LOOPBACK:
        forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return peer


def is_internal_ip(ip: str) -> bool:
    """교내(포스텍) 주소인지. 로컬 접속(개발·프록시 미설정)도 교내로 봅니다."""
    return ip.startswith(POSTECH_IP_PREFIXES) or ip in _LOOPBACK


def is_postech_request(request: Request, user: dict | None, *, domain: str) -> bool:
    """이 요청을 포스텍 구성원의 것으로 볼 수 있는가.

    둘 중 하나면 됩니다 - 교내 IP에서 왔거나, 그 도메인 계정으로 로그인했거나.
    외부 네트워크의 구성원(집·출장)은 로그인으로, 교내의 비로그인 사용자는
    IP로 통과합니다.
    """
    email = ((user or {}).get("email") or "").lower()
    if email.endswith("@" + domain.lower()):
        return True
    return is_internal_ip(get_client_ip(request))
