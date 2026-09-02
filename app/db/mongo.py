"""The single place in the codebase that opens a MongoDB connection.

Every other module reaches MongoDB through the collection handles exported
by ``app.db`` (see ``app/db/__init__.py``), never by importing this module
directly or creating another client.

MONGO_SSH_TUNNEL=true면 MONGO_URI가 가리키는 곳에 바로 붙는 대신 SSH 터널을
먼저 연 뒤 그 로컬 포트로 붙습니다. MongoDB 포트를 바깥에 열지 않은 채로
서버 밖(개발용 맥 등)에서 실제 데이터를 보며 작업하기 위한 통로입니다.

터널을 쓰든 안 쓰든 접속 정보는 MONGO_URI 하나만 보면 되도록, 계정·authSource
같은 나머지는 그대로 두고 **호스트 부분만** 터널의 로컬 포트로 바꿔치기합니다.
그래서 MONGO_URI의 호스트는 늘 "서버에서 본 MongoDB 주소"라는 뜻을 유지합니다 -
mongodb://localhost:27017이면 서버 자신의 localhost이고, 터널은 그 주소로
서버 쪽에서 접속합니다.
"""

import warnings
from urllib.parse import parse_qsl, urlencode

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.config import (
    DB_NAME,
    MONGO_SSH_TUNNEL,
    MONGO_URI,
    SSH_HOST,
    SSH_KEY,
    SSH_KEY_PASSPHRASE,
    SSH_PASSWORD,
    SSH_PORT,
    SSH_USER,
)

# SSHTunnelForwarder 핸들. 터널을 쓰지 않으면 계속 None이고, close()에서만
# 다시 쓰입니다 - 프로세스가 사는 동안 터널도 살아 있어야 하므로.
_tunnel = None


def _split_uri(uri: str) -> tuple[str, str, str]:
    """mongodb://[user:pass@]host[:port][,host2…][/db][?opts] 를
    (호스트 앞까지, 호스트 목록, 호스트 뒤 전부) 로 자릅니다.

    비밀번호에 '@'나 ':'가 들어 있어도 되도록 authority는 마지막 '@' 기준으로
    나눕니다 - 호스트 쪽에는 '@'가 올 수 없기 때문입니다.
    """
    scheme, sep, rest = uri.partition("://")
    if not sep:
        raise ValueError(f"MONGO_URI에 스킴이 없습니다: {uri!r}")
    cut = min(
        (i for i in (rest.find("/"), rest.find("?")) if i != -1), default=len(rest)
    )
    authority, tail = rest[:cut], rest[cut:]
    userinfo, at, hosts = authority.rpartition("@")
    return f"{scheme}://{userinfo}{at}", hosts, tail


def _remote_bind(uri: str) -> tuple[str, int]:
    """터널이 서버 쪽에서 접속할 주소. MONGO_URI의 첫 호스트를 그대로 씁니다."""
    _, hosts, _ = _split_uri(uri)
    host, _, port = hosts.split(",")[0].partition(":")
    return host or "localhost", int(port or 27017)


def _with_direct_connection(uri: str) -> str:
    """터널 너머로는 directConnection=true로 붙습니다.

    이게 없으면 드라이버가 서버에게 "너희 클러스터 구성원이 누구냐"를 묻고,
    돌아온 **서버 내부 호스트명**으로 다시 접속하려다 실패합니다. 터널이
    뚫어 준 건 127.0.0.1의 포트 하나뿐이니까요.
    """
    head, sep, query = uri.partition("?")
    params = parse_qsl(query, keep_blank_values=True) if sep else []
    if any(key.lower() == "directconnection" for key, _ in params):
        return uri
    params.append(("directConnection", "true"))
    return f"{head}?{urlencode(params)}"


def _open_tunnel(uri: str) -> str:
    """SSH 터널을 열고, 그 로컬 포트를 가리키도록 고친 URI를 돌려줍니다."""
    global _tunnel

    if uri.startswith("mongodb+srv://"):
        raise RuntimeError(
            "MONGO_SSH_TUNNEL=true는 mongodb+srv:// URI를 지원하지 않습니다. "
            "SRV는 DNS로 받은 호스트 목록에 다시 접속하는데, 터널은 포트 하나만 "
            "뚫어 주기 때문입니다. mongodb:// 형식으로 적어 주세요."
        )
    missing = [
        name
        for name, value in (("SSH_HOST", SSH_HOST), ("SSH_USER", SSH_USER))
        if not value
    ]
    if missing:
        raise RuntimeError(
            f"MONGO_SSH_TUNNEL=true이면 {', '.join(missing)}가 필요합니다 (.env 확인)."
        )

    # paramiko가 오래된 알고리즘마다 DeprecationWarning을 뿜어 로그를 덮습니다.
    warnings.filterwarnings("ignore", module="paramiko")
    from sshtunnel import SSHTunnelForwarder

    _tunnel = SSHTunnelForwarder(
        (SSH_HOST, SSH_PORT),
        ssh_username=SSH_USER,
        ssh_pkey=SSH_KEY or None,
        ssh_private_key_password=SSH_KEY_PASSPHRASE or None,
        ssh_password=SSH_PASSWORD or None,
        remote_bind_address=_remote_bind(uri),
    )
    _tunnel.start()

    head, _, tail = _split_uri(uri)
    return _with_direct_connection(f"{head}127.0.0.1:{_tunnel.local_bind_port}{tail}")


_uri = _open_tunnel(MONGO_URI) if MONGO_SSH_TUNNEL else MONGO_URI

client: AsyncIOMotorClient = AsyncIOMotorClient(_uri, tz_aware=True)
db: AsyncIOMotorDatabase = client[DB_NAME]


async def ping() -> None:
    await client.admin.command("ping")


async def close() -> None:
    client.close()
    if _tunnel is not None:
        _tunnel.stop()
