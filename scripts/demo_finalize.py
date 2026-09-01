"""일정 확정(finalize) 데모 데이터.

확정 화면을 제대로 시험하려면 최적화가 실제로 고민할 거리가 있어야 합니다.
그래서 이 스크립트는 단순히 사람을 많이 넣는 대신, 배정을 어렵게 만드는
상황을 일부러 섞어 둡니다:

  * 응답자가 많고 (등록 사용자 + 게스트), 후보 시간대와 날짜 범위가 넓음
  * 사람마다 생활 패턴이 달라 가능 시간이 연속 블록으로 몰려 있음
  * 좁은 시간대에 여러 명이 몰려 경합이 생김
  * 호스트가 못 오는 시간대가 있어 후보 블록이 걸러짐
  * 호스트가 불가능한 시간에만 응답한 사람이 있어 "미배정"이 반드시 생김
  * "가능(선택)"으로만 커버되는 사람이 있어 allowIfNeeded 토글이 결과를 바꿈

    uv run python scripts/demo_finalize.py             # 생성 (미확정 - 확정 흐름 시험용)
    uv run python scripts/demo_finalize.py --no-email  # 이메일 없는 변형을 별도 일정으로 생성
    uv run python scripts/demo_finalize.py --past      # 과거 날짜 + 확정 완료 + 면담 기록까지
    uv run python scripts/demo_finalize.py --clean     # 위 전부 삭제

--past는 면담 기록(학생지도비 신청서) 시험용입니다. 기록은 끝난 면담에만
쓸 수 있어(record_service.list_open_meetings) 기본 변형처럼 날짜가 미래면
"기록할 약속" 목록에 아예 뜨지 않습니다. 그래서 이 변형은 날짜를 과거로 두고
확정까지 끝낸 뒤, 일부 면담에는 기록을 미리 써 둡니다.

확정은 finalize_service.confirm()이 아니라 finalization 문서를 직접 쓰는
방식이라 이 변형도 메일이 나가지 않고 구글 캘린더도 건드리지 않습니다.

--no-email은 응답자를 전원 게스트(계정·이메일 없음)로 만듭니다. 확정 시
메일은 이메일이 있는 참가자에게만 나가므로(finalize_service._notify), 이
변형은 확정 버튼을 눌러도 메일이 한 통도 발송되지 않습니다. 두 일정은 서로
다른 demoTag를 달고 나란히 존재합니다.

finalize_service.confirm()을 호출하지 않고 응답만 심어 둡니다. 확정 자체가
시험 대상이기 때문에 일정은 미확정 상태로 남습니다.
"""

import argparse
import asyncio
import random
from datetime import UTC, datetime, timedelta

from bson import ObjectId

from app.db import (
    contacts_col,
    event_responses_col,
    events_col,
    meeting_records_col,
    users_col,
)
from app.services import crypto_service, finalize_service, record_service
from app.services.event_service import generate_unique_short_id

DEMO_TAG = "commeet-demo-finalize"
# 이메일 없는 변형. 태그를 나눠 두 일정이 나란히 존재할 수 있고, --clean은
# 접두사로 둘 다 지웁니다.
DEMO_TAG_NOEMAIL = "commeet-demo-finalize-noemail"
DEMO_TAG_PAST = "commeet-demo-finalize-past"
DEMO_TAG_PREFIX = "commeet-demo-finalize"
DEMO_DOMAIN = "demo-finalize.commeet.local"
HOST_EMAIL = "yojun313@postech.ac.kr"

EVENT_NAME = "2학기 정기 면담 (확정 테스트)"
EVENT_NAME_NOEMAIL = "2학기 정기 면담 (확정 테스트 · 메일 없음)"
EVENT_NAME_PAST = "1학기 마무리 면담 (기록 테스트)"

# --past에서 곧바로 확정할 때 쓰는 설정. 한 면담에 여러 명이 들어가야
# 학생지도비가 소속별로 갈리고 "개별 입력" 모드도 의미가 생깁니다.
PAST_CAPACITY = 3
PAST_MEETING_MINUTES = 30
# 이 개수만큼은 기록을 미리 작성해 둡니다 (나머지는 "기록 필요"로 남습니다).
PAST_RECORDS_WRITTEN = 4

# 후보 시간대: 매일 09:00~19:00, 30분 단위 -> 하루 20틱
DAY_START_HOUR = 9
WINDOW_HOURS = 10
INCREMENT_MIN = 30
TICKS_PER_DAY = WINDOW_HOURS * 60 // INCREMENT_MIN

# 날짜 범위: 오늘 이후 평일 12일 (약 2주 반)
NUM_WEEKDAYS = 12
DAYS_FROM_NOW = 3

# (이름, 학번, 소속, 과정, 패턴)
#
# 패턴은 (시작시각, 끝시각) 구간들의 목록입니다. 사람은 흩어진 칸이 아니라
# 연속한 구간을 칠하므로, 실제 응답과 같은 모양이 되도록 구간 단위로 만듭니다.
ROSTER = [
    # 오전형 - 오전에 몰려 경합을 만듭니다
    ("강민서", "20211101", "cse", "박사", "morning"),
    ("김도현", "20211102", "cse", "박사", "morning"),
    ("나윤서", "20221103", "cse", "석사", "morning"),
    ("문지후", "20221104", "cse", "석사", "morning"),
    ("박서준", "20231105", "cse", "통합", "morning"),
    # 오후형
    ("배하준", "20231106", "cse", "통합", "afternoon"),
    ("서지안", "20241107", "cse", "석사", "afternoon"),
    ("송예은", "20241108", "cse", "석사", "afternoon"),
    ("신우진", "20201109", "cse", "박사", "afternoon"),
    # 저녁형
    ("안소민", "20251110", "muunjae", "학사", "evening"),
    ("오채원", "20251111", "muunjae", "학사", "evening"),
    ("유하람", "20241112", "muunjae", "학사", "evening"),
    # 어디든 가능 - 최적화가 빈 자리를 메우는 데 씁니다
    ("윤태오", "20221113", "cse", "통합", "flexible"),
    ("이가온", "20231114", "cse", "석사", "flexible"),
    ("임서윤", "20251115", "muunjae", "학사", "flexible"),
    # 매우 바쁨 - 가능 시간이 아주 좁아 우선 배정되어야 합니다
    ("장민혁", "20201116", "cse", "박사", "scarce"),
    ("전유나", "20211117", "cse", "박사", "scarce"),
    # 특정 요일만 - 요일 단위로 몰림
    ("정하늘", "20231118", "cse", "통합", "mon_wed"),
    ("조은결", "20241119", "cse", "석사", "tue_thu"),
    ("차예린", "20251120", "muunjae", "학사", "friday"),
    # "가능"만으로는 배정 불가, "가능(선택)"을 켜야 자리가 생기는 사람.
    # 확정 화면의 '가능(선택)도 포함' 토글이 결과를 바꾸는지 보여줍니다.
    ("최나영", "20221121", "cse", "석사", "soft_only"),
    ("추민준", "20241122", "cse", "석사", "soft_only"),
    ("탁서현", "20251123", "muunjae", "학사", "soft_only"),
    # 추가 인원 - 화면이 실제로 붐비도록
    ("표지훈", "20211124", "cse", "박사", "morning"),
    ("하윤재", "20221125", "cse", "통합", "afternoon"),
    ("홍서아", "20231126", "cse", "석사", "afternoon"),
    ("고은우", "20241127", "cse", "석사", "evening"),
    ("구다인", "20251128", "muunjae", "학사", "evening"),
    ("권시윤", "20221129", "cse", "통합", "mon_wed"),
    ("남주호", "20231130", "cse", "석사", "tue_thu"),
    ("도예찬", "20201131", "cse", "박사", "scarce"),
]

# 미가입 참석자. 키가 ObjectId가 아니라 입력한 이름 그 자체가 되므로,
# 확정 화면이 다형적 키를 제대로 다루는지 함께 확인할 수 있습니다.
GUESTS = [
    ("한지우(외부)", "flexible"),
    ("허도윤(외부)", "afternoon"),
    ("황시원(외부)", "morning"),
    # 호스트가 못 오는 시간에만 가능 -> 반드시 미배정으로 남습니다
    ("남기훈(외부)", "host_blocked"),
]

# 호스트가 비우는 시간 (요일, 시작시각, 끝시각). 이 구간은 후보 블록에서
# 통째로 빠지므로, 확정 화면의 슬롯 수가 전체보다 적게 나옵니다.
HOST_BLOCKED = [
    (2, 13, 19),  # 수요일 오후: 교수회의
    (4, 15, 19),  # 금요일 늦은 오후
]
# 호스트는 매일 점심시간에도 자리를 비웁니다.
HOST_LUNCH = (12, 13)


def _email(student_id: str, tag: str) -> str:
    """변형마다 도메인을 나눕니다 - users.email이 유니크라 같은 주소를 쓰면
    두 변형이 동시에 존재할 수 없습니다."""
    suffix = tag[len(DEMO_TAG_PREFIX) :].lstrip("-")
    domain = (
        f"{DEMO_DOMAIN.split('.', 1)[0]}{'-' + suffix if suffix else ''}.commeet.local"
    )
    return f"{student_id}@{domain}"


def _ticks(day: datetime, ranges: list[tuple[float, float]]) -> list[datetime]:
    """(시작시각, 끝시각) 구간들을 그리드 틱 목록으로 바꿉니다.

    covers_slot()은 블록 안의 모든 틱이 칠해져 있어야 참석 가능으로 보므로,
    구간은 반드시 틱 경계에 맞아야 합니다.
    """
    out = []
    for start_h, end_h in ranges:
        cursor = day.replace(hour=DAY_START_HOUR, minute=0) + timedelta(
            minutes=(start_h - DAY_START_HOUR) * 60
        )
        end = day.replace(hour=DAY_START_HOUR, minute=0) + timedelta(
            minutes=(end_h - DAY_START_HOUR) * 60
        )
        while cursor < end:
            out.append(cursor)
            cursor += timedelta(minutes=INCREMENT_MIN)
    return out


def _pattern_ranges(pattern: str, weekday: int, rng: random.Random):
    """하루치 (가능 구간, 가능-선택 구간)을 만듭니다.

    사람마다 매일 똑같이 답하지는 않으므로 날짜마다 조금씩 흔듭니다.
    """
    jitter = rng.choice([-1, 0, 0, 1])

    if pattern == "morning":
        avail = [(9, 12 + jitter * 0.5)]
        soft = [(13, 15)]
    elif pattern == "afternoon":
        avail = [(13 + jitter * 0.5, 17)]
        soft = [(17, 19)]
    elif pattern == "evening":
        avail = [(16, 19)]
        soft = [(14, 16)]
    elif pattern == "flexible":
        avail = [(9, 13), (14, 19)]
        soft = []
    elif pattern == "scarce":
        # 주 2회, 두 시간짜리 창만 열립니다.
        if weekday not in (1, 3):
            return [], []
        avail = [(10, 12)]
        soft = [(16, 17)]
    elif pattern == "mon_wed":
        if weekday not in (0, 2):
            return [], []
        avail = [(9, 13), (14, 18)]
        soft = []
    elif pattern == "tue_thu":
        if weekday not in (1, 3):
            return [], []
        avail = [(10, 14), (15, 19)]
        soft = []
    elif pattern == "friday":
        if weekday != 4:
            return [], []
        avail = [(9, 19)]
        soft = []
    elif pattern == "soft_only":
        # "가능"은 전부 호스트가 비우는 시간(수요일 오후)에만 있고,
        # 호스트와 겹치는 시간은 "가능(선택)"으로만 표시했습니다. 따라서
        # allowIfNeeded를 꺼면 배정이 불가능하고, 켜야 자리가 생깁니다.
        if weekday == 2:
            return [(13, 19)], []
        return [], [(9, 11)]
    elif pattern == "host_blocked":
        # 호스트가 비우는 수요일 오후에만 가능 -> 어떤 설정으로도 배정 불가
        if weekday != 2:
            return [], []
        avail = [(13, 19)]
        soft = []
    else:
        avail, soft = [(9, 19)], []

    return avail, soft


def _host_ranges(weekday: int) -> list[tuple[float, float]]:
    """호스트가 참석 가능한 구간. 점심시간과 고정 일정을 제외합니다."""
    blocked = [(s, e) for wd, s, e in HOST_BLOCKED if wd == weekday]
    blocked.append(HOST_LUNCH)
    blocked.sort()

    ranges = []
    cursor = float(DAY_START_HOUR)
    for start, end in blocked:
        if start > cursor:
            ranges.append((cursor, float(start)))
        cursor = max(cursor, float(end))
    if cursor < DAY_START_HOUR + WINDOW_HOURS:
        ranges.append((cursor, float(DAY_START_HOUR + WINDOW_HOURS)))
    return ranges


# ---------------------------------------------------------------- --past

NOTE_TEMPLATES = [
    (
        "연구 진행 상황 점검. 실험 결과를 정리하고 다음 학회 투고 일정을 확정함. "
        "다음 면담까지 초안 1차를 완성하기로 함."
    ),
    (
        "학위 논문 주제 구체화 논의. 선행 연구 조사 범위를 좁히고 베이스라인 "
        "재현을 우선 진행하기로 함."
    ),
    (
        "수강 계획 및 진로 상담. 전공 선택 요건을 안내하고 학부연구생 참여 "
        "방법을 설명함."
    ),
    (
        "인턴십 지원 준비 상황 점검. 이력서와 포트폴리오를 함께 검토하고 "
        "추천서 일정을 조율함."
    ),
    "연구실 적응 상황 확인. 주간 미팅 참여와 논문 세미나 발표 순서를 정함.",
]
PLACES = [
    "교내 카페 (무은재기념관 1층)",
    "공학동 세미나실 3층",
    "교수 연구실",
    "학생회관 카페테리아",
]


async def _confirm_directly(
    event: dict, host: dict, capacity: int, minutes: int
) -> dict:
    """최적 배정을 계산해 finalization을 직접 씁니다.

    finalize_service.confirm()을 쓰지 않는 이유는 그쪽이 참석자 전원에게
    메일을 보내고 구글 캘린더에 이벤트를 만들기 때문입니다. 데모가 할 일이
    아니므로 결과 문서만 같은 모양으로 저장합니다.
    """
    proposal = await finalize_service.build_proposal(event, capacity, minutes, True)
    finalization = {
        "status": "confirmed",
        "capacity": capacity,
        "meetingMinutes": minutes,
        "meetings": [
            {
                "start": m["start"],
                "end": m["end"],
                "participants": [p["key"] for p in m["participants"]],
            }
            for m in proposal["meetings"]
        ],
        "unassigned": [u["key"] for u in proposal["unassigned"]],
        "confirmedAt": datetime.now(UTC),
        "confirmedBy": host["_id"],
        "googleSyncedEvents": [],
    }
    await events_col.update_one(
        {"_id": event["_id"]},
        {"$set": {"finalization": finalization, "isClosed": True}},
    )
    return finalization


def _demo_images():
    """서명/영수증 이미지 생성기. Pillow가 없으면 (None, None)."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from demo_records import _receipt_png, _signature_png

        _signature_png()  # Pillow가 실제로 있는지 여기서 확인
    except Exception:
        return None, None
    return _signature_png, _receipt_png


async def _write_records(
    event_id, host: dict, tag: str, local_tz, how_many: int
) -> list[dict]:
    """앞쪽 몇 건의 면담에 기록을 미리 작성해 둡니다.

    나머지는 "기록 필요"로 남겨, 조회와 작성 흐름을 둘 다 시험할 수 있게 합니다.
    """
    signature_png, receipt_png = _demo_images()
    event = await events_col.find_one({"_id": event_id})
    meetings = (event.get("finalization") or {}).get("meetings") or []
    written = []

    for index, meeting in enumerate(meetings[:how_many]):
        draft = await record_service.build_draft(event, host, meeting["start"])

        # build_draft는 일자/시각을 비워 둡니다 - 서버는 호스트의 시간대를
        # 알 수 없어 브라우저가 채우는 값이기 때문입니다. 스크립트에서는
        # 직접 로컬 시각으로 넣어 줍니다.
        local_start = meeting["start"].astimezone(local_tz)
        local_end = meeting["end"].astimezone(local_tz)
        receipt_time = (local_end + timedelta(minutes=35)).strftime("%H:%M")
        draft["date"] = f"{local_start:%Y-%m-%d}"
        draft["startTime"] = f"{local_start:%H:%M}"
        draft["endTime"] = receipt_time
        draft["place"] = PLACES[index % len(PLACES)]

        # 절반은 "동일 내용", 절반은 "개별 입력"으로 두 모드를 모두 보여줍니다.
        if index % 2 == 0:
            draft["notesMode"] = "shared"
            draft["sharedNote"] = NOTE_TEMPLATES[index % len(NOTE_TEMPLATES)]
        else:
            draft["notesMode"] = "individual"
            for i, attendee in enumerate(draft["attendees"]):
                draft["perStudentNotes"][attendee["key"]] = NOTE_TEMPLATES[
                    (index + i) % len(NOTE_TEMPLATES)
                ]

        for settlement in draft["settlements"]:
            settlement["receiptTime"] = receipt_time

        record_id = await record_service.save_record(
            host, {**draft, "meetingStart": meeting["start"], "status": "saved"}
        )
        await meeting_records_col.update_one(
            {"_id": ObjectId(record_id)}, {"$set": {"demoTag": tag}}
        )

        # 마지막 한 건은 서명/영수증 없이 남겨 "첨부 전" 상태도 보여줍니다.
        attached = False
        if signature_png and index < how_many - 1:
            await record_service.attach_file(
                host, record_id, "signature.png", signature_png(), "signature.png"
            )
            saved = await record_service.get_record(host, record_id)
            for i, settlement in enumerate(saved["settlements"]):
                await record_service.attach_file(
                    host,
                    record_id,
                    f"receipt-{i}.png",
                    receipt_png(
                        "cafe commeet",
                        f"{local_start:%Y-%m-%d} {receipt_time}",
                        settlement["headcount"],
                        settlement["unitPrice"],
                        settlement["amount"],
                    ),
                    f"receipt-{i}.png",
                )
            attached = True

        saved = await record_service.get_record(host, record_id)
        written.append(
            {
                "id": record_id,
                "start": local_start,
                "names": [a["name"] for a in saved["attendees"]],
                "mode": draft["notesMode"],
                "settlements": saved["settlements"],
                "attached": attached,
            }
        )
    return written


async def clean(tag: str | None = None) -> int:
    """`tag`가 없으면 이 스크립트가 만든 두 변형을 모두 지웁니다."""
    match = {"demoTag": tag} if tag else {"demoTag": {"$regex": f"^{DEMO_TAG_PREFIX}"}}
    removed = 0
    for ev in await events_col.find(match, {"_id": 1}).to_list(length=None):
        await event_responses_col.delete_many({"eventId": ev["_id"]})
    removed += (await events_col.delete_many(match)).deleted_count
    # 기록은 디스크에 암호화된 첨부(서명/영수증)를 함께 남기므로 파일부터 지웁니다.
    for rec in await meeting_records_col.find(match, {"_id": 1}).to_list(length=None):
        crypto_service.delete_record_files(str(rec["_id"]))
    removed += (await meeting_records_col.delete_many(match)).deleted_count
    removed += (await contacts_col.delete_many(match)).deleted_count
    removed += (await users_col.delete_many(match)).deleted_count
    return removed


async def build(no_email: bool = False, past: bool = False) -> None:
    """`no_email`이면 응답자를 전원 게스트(계정·이메일 없음)로 만듭니다.

    확정 시 메일 발송 대상은 `person["email"]`이 있는 사람뿐이므로
    (finalize_service._notify), 이메일을 비우면 확정을 눌러도 메일이 한 통도
    나가지 않습니다. 계정을 만들지 않는 이유는 users 컬렉션의 email 유니크
    인덱스 때문이기도 합니다 - 이메일 없는 사용자는 하나만 존재할 수 있습니다.
    """
    if past:
        tag, event_name = DEMO_TAG_PAST, EVENT_NAME_PAST
    elif no_email:
        tag, event_name = DEMO_TAG_NOEMAIL, EVENT_NAME_NOEMAIL
    else:
        tag, event_name = DEMO_TAG, EVENT_NAME

    host = await users_col.find_one({"email": HOST_EMAIL})
    if not host:
        raise SystemExit(f"호스트 계정을 찾을 수 없습니다: {HOST_EMAIL}")

    await clean(tag)
    rng = random.Random(20260829)

    # 시각은 호스트의 로컬 벽시계 기준으로 만듭니다. UTC로 만들면 브라우저가
    # 로컬로 되돌릴 때 09:00 면담이 18:00으로 밀립니다.
    local_tz = datetime.now().astimezone().tzinfo
    today = datetime.now(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)

    # 평일만 모읍니다. --past는 과거로 거슬러 올라가며 모읍니다 - 기록은
    # 이미 끝난 면담에만 쓸 수 있기 때문입니다.
    days: list[datetime] = []
    if past:
        cursor = today - timedelta(days=1)
        while len(days) < NUM_WEEKDAYS:
            if cursor.weekday() < 5:
                days.append(cursor.replace(hour=DAY_START_HOUR, minute=0))
            cursor -= timedelta(days=1)
        days.reverse()
    else:
        cursor = today + timedelta(days=DAYS_FROM_NOW)
        while len(days) < NUM_WEEKDAYS:
            if cursor.weekday() < 5:
                days.append(cursor.replace(hour=DAY_START_HOUR, minute=0))
            cursor += timedelta(days=1)

    # --- 참가자 -------------------------------------------------------------
    people: list[dict] = []
    for name, sid, aff, degree, pattern in ROSTER:
        if no_email:
            # 계정도 연락처도 만들지 않습니다. 응답 키는 이름 그 자체가 되고,
            # 이메일이 비어 있어 확정해도 메일이 나가지 않습니다.
            people.append(
                {
                    "key": name,
                    "userId": None,
                    "name": name,
                    "email": "",
                    "pattern": pattern,
                }
            )
            continue
        user_id = ObjectId()
        email = _email(sid, tag)
        await users_col.insert_one(
            {
                "_id": user_id,
                "name": name,
                "email": email,
                "isAdmin": False,
                "demoTag": tag,
                "createdAt": datetime.now(local_tz),
            }
        )
        await contacts_col.insert_one(
            {
                "ownerId": host["_id"],
                "name": name,
                "email": email,
                "relation": "지도학생",
                "degree": degree,
                "department": "컴퓨터공학과" if aff == "cse" else "무은재학부",
                "gradSchool": "일반대학원" if aff == "cse" else "",
                "studentId": sid,
                "status": "재학",
                "demoTag": tag,
                "createdAt": datetime.now(local_tz),
            }
        )
        people.append(
            {
                "key": str(user_id),
                "userId": user_id,
                "name": name,
                "email": email,
                "pattern": pattern,
            }
        )

    for name, pattern in GUESTS:
        # 게스트는 계정이 없고, 응답 키가 곧 입력한 이름입니다.
        people.append(
            {"key": name, "userId": None, "name": name, "email": "", "pattern": pattern}
        )

    # --- 일정 ---------------------------------------------------------------
    event_id = ObjectId()
    await events_col.insert_one(
        {
            "_id": event_id,
            "shortId": await generate_unique_short_id(),
            "ownerId": host["_id"],
            "name": event_name,
            "description": (
                "확정(finalize) 기능 시험용 데모입니다.\n"
                f"응답자 {len(people)}명 · 후보 {len(days)}일 · "
                f"매일 {DAY_START_HOUR:02d}:00~{DAY_START_HOUR + WINDOW_HOURS:02d}:00 "
                f"({INCREMENT_MIN}분 단위)"
            ),
            "descriptionFormat": "text",
            "isArchived": False,
            "isDeleted": False,
            "isClosed": False,  # 확정 전 상태 - 이게 시험 대상입니다
            "duration": float(WINDOW_HOURS),
            "dates": days,
            "startOnMonday": False,
            "notificationsEnabled": False,
            "blindAvailabilityEnabled": False,
            # 이메일을 아예 받지 않는 변형에서는 수집 옵션도 꺼 둡니다.
            "collectEmails": not no_email,
            "timeIncrement": INCREMENT_MIN,
            "sendEmailAfterXResponses": None,
            "type": "specific_dates",
            "remindees": [],
            "numResponses": len(people) + 1,
            "createdAt": datetime.now(local_tz),
            "demoTag": tag,
        }
    )

    # --- 호스트 응답 ---------------------------------------------------------
    host_ticks: list[datetime] = []
    for day in days:
        host_ticks.extend(_ticks(day, _host_ranges(day.weekday())))
    await event_responses_col.insert_one(
        {
            "eventId": event_id,
            "userId": str(host["_id"]),
            "response": {
                "userId": host["_id"],
                "name": host.get("name", ""),
                "email": host["email"],
                "availability": host_ticks,
                "ifNeeded": [],
            },
        }
    )

    # --- 참가자 응답 ---------------------------------------------------------
    stats = []
    for person in people:
        avail_ticks: list[datetime] = []
        soft_ticks: list[datetime] = []
        for day in days:
            avail_ranges, soft_ranges = _pattern_ranges(
                person["pattern"], day.weekday(), rng
            )
            avail_ticks.extend(_ticks(day, avail_ranges))
            soft_ticks.extend(_ticks(day, soft_ranges))

        # 가능으로 이미 칠한 칸은 가능(선택)에서 제외합니다.
        firm = set(avail_ticks)
        soft_ticks = [t for t in soft_ticks if t not in firm]

        response = {
            "name": person["name"],
            "email": person["email"],
            "availability": avail_ticks,
            "ifNeeded": soft_ticks,
        }
        if person["userId"]:
            response["userId"] = person["userId"]

        await event_responses_col.insert_one(
            {"eventId": event_id, "userId": person["key"], "response": response}
        )
        stats.append(
            (person["name"], person["pattern"], len(avail_ticks), len(soft_ticks))
        )

    # --- --past: 확정 + 기록 작성 -------------------------------------------
    finalization = None
    records = []
    if past:
        event_doc = await events_col.find_one({"_id": event_id})
        finalization = await _confirm_directly(
            event_doc, host, PAST_CAPACITY, PAST_MEETING_MINUTES
        )
        records = await _write_records(
            event_id, host, tag, local_tz, PAST_RECORDS_WRITTEN
        )

    # --- 요약 ---------------------------------------------------------------
    event = await events_col.find_one({"_id": event_id})
    total_ticks = len(days) * TICKS_PER_DAY

    print(f"일정        : {event_name}")
    print(f"URL         : /e/{event['shortId']}")
    print(f"확정 화면    : /e/{event['shortId']}/finalize")
    print()
    print(
        f"날짜        : {days[0]:%m/%d(%a)} ~ {days[-1]:%m/%d(%a)}  (평일 {len(days)}일)"
    )
    print(
        f"시간대      : 매일 {DAY_START_HOUR:02d}:00~{DAY_START_HOUR + WINDOW_HOURS:02d}:00, "
        f"{INCREMENT_MIN}분 단위 ({TICKS_PER_DAY}칸/일, 총 {total_ticks}칸)"
    )
    if no_email:
        print(
            f"응답자      : {len(people)}명 (전원 게스트 · 계정/이메일 없음) + 호스트"
        )
        with_email = sum(1 for p in people if p["email"])
        print(f"메일 발송    : 확정해도 0통 (이메일 있는 참가자 {with_email}명)")
    else:
        print(
            f"응답자      : {len(people)}명 (등록 {len(ROSTER)} + 게스트 {len(GUESTS)}) + 호스트"
        )
    print(
        f"호스트 가능  : {len(host_ticks)}/{total_ticks}칸 "
        f"(점심시간·수요일 오후·금요일 늦은 오후 제외)"
    )
    if past:
        print()
        print(
            f"확정        : 정원 {PAST_CAPACITY}명 · {PAST_MEETING_MINUTES}분 "
            f"→ 면담 {len(finalization['meetings'])}건, 미배정 {len(finalization['unassigned'])}명"
        )
        print("              (confirm() 미호출 - 메일 0통, 구글 캘린더 0건)")
        print(
            f"기록 작성    : {len(records)}건 완료 / "
            f"{len(finalization['meetings']) - len(records)}건 미작성"
        )
        print()
        for r in records:
            total = sum(x["amount"] for x in r["settlements"])
            split = " + ".join(
                f"{record_service.AFFILIATION_LABELS.get(x['affiliation'], x['affiliation'])} "
                f"{x['headcount']}명 {x['amount']:,}원"
                for x in r["settlements"]
            )
            mode = "개별 입력" if r["mode"] == "individual" else "동일 내용"
            att = "서명·영수증 첨부" if r["attached"] else "첨부 없음"
            print(f"   {r['start']:%m/%d(%a) %H:%M}  {', '.join(r['names'])}")
            print(
                f"      {mode} · {att} · 신청서 {len(r['settlements'])}장 "
                f"· 합계 {total:,}원  ({split})"
            )
        print()
        print(f"   기록은 일정 페이지 캘린더 아래에서: /e/{event['shortId']}")
    print()
    print("응답자별 가능 칸 수:")
    for name, pattern, n_avail, n_soft in stats:
        note = ""
        if pattern == "scarce":
            note = "  ← 가능 시간이 매우 좁음"
        elif pattern == "soft_only":
            note = "  ← '가능(선택) 포함'을 켜야만 배정됨"
        elif pattern == "host_blocked":
            note = "  ← 호스트가 못 오는 시간에만 가능 (항상 미배정)"
        print(
            f"  {name:<12} {pattern:<12} 가능 {n_avail:>3}칸 / 선택 {n_soft:>3}칸{note}"
        )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--clean", action="store_true", help="이 스크립트가 만든 두 일정을 모두 삭제"
    )
    parser.add_argument(
        "--no-email",
        action="store_true",
        help="응답자를 전원 게스트(계정·이메일 없음)로 만듭니다. "
        "확정해도 메일이 나가지 않습니다.",
    )
    parser.add_argument(
        "--past",
        action="store_true",
        help="날짜를 과거로 두고 확정까지 끝낸 뒤 면담 기록을 "
        "일부 작성해 둡니다 (면담 기록 시험용).",
    )
    args = parser.parse_args()

    if args.clean:
        print(f"데모 문서 {await clean()}건을 삭제했습니다.")
        return
    await build(no_email=args.no_email, past=args.past)


if __name__ == "__main__":
    asyncio.run(main())
