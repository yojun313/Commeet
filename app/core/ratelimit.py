"""아주 작은 인메모리 요청 제한기.

로그인과 인증코드 발송처럼 **반복 시도 자체가 공격**(비밀번호 무차별 대입,
남의 메일함에 코드 메일 퍼붓기)이 되는 엔드포인트에만 씁니다.

프로세스 메모리에만 남으므로 재시작하면 초기화되고 서버(도메인)마다 따로
세지만, 이 규모의 내부 도구에는 그걸로 충분합니다 - 공격자가 얻는 것은
"재시작 직후 한 묶음 더" 정도라, 공유 저장소(redis 등)를 들일 이유가
없습니다.
"""

import time
from collections import defaultdict, deque

_hits: dict[str, deque] = defaultdict(deque)

# 봇이 키(IP를 바꿔 가며)를 무한정 늘려 메모리를 채우지 못하게 하는 상한.
# 넘으면 오래 안 쓰인 키부터 버립니다 - 제한이 잠깐 느슨해질 뿐입니다.
_MAX_KEYS = 20_000


def allow(key: str, *, limit: int, per_seconds: float) -> bool:
    """이 키의 시도를 하나 더 허용할지. 허용하면 시도로 셉니다."""
    now = time.monotonic()
    q = _hits[key]
    while q and now - q[0] > per_seconds:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)

    if len(_hits) > _MAX_KEYS:
        stale = sorted(_hits, key=lambda k: _hits[k][-1] if _hits[k] else 0)
        for k in stale[: _MAX_KEYS // 10]:
            del _hits[k]
    return True


def reset(key: str) -> None:
    """테스트에서 키 하나를 깨끗이 되돌릴 때."""
    _hits.pop(key, None)
