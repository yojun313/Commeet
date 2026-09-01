"""면담 기록 / 학생지도비 신청서 데모 데이터.

Creates a host's worth of realistic, already-confirmed meetings so the record
and 신청서 flow can be exercised end to end: 컴공만, 무은재만, 두 소속이 섞여
신청서가 두 장 나오는 경우, 대규모 면담, 게스트(미가입자) 참석, 그리고 이미
작성이 끝난 기록 한 건까지.

    uv run python scripts/demo_records.py            # 생성
    uv run python scripts/demo_records.py --clean    # 데모 데이터만 삭제

Writes `finalization` straight to MongoDB instead of calling
finalize_service.confirm(), deliberately: confirm() emails every participant
and creates real Google Calendar events, which demo data has no business
doing.
"""

import argparse
import asyncio
import io
import math
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
from app.services import crypto_service, record_service
from app.services.event_service import generate_unique_short_id

# Every demo document carries this marker so --clean can find it again.
DEMO_TAG = "commeet-demo"
DEMO_DOMAIN = "demo.commeet.local"

HOST_EMAIL = "yojun313@postech.ac.kr"

# (이름, 학번, 소속키, 과정, 학과표기)
ROSTER = [
    ("김민준", "20211234", "cse", "박사", "컴퓨터공학과"),
    ("이서연", "20221045", "cse", "석사", "컴퓨터공학과"),
    ("박도윤", "20231567", "cse", "통합", "컴퓨터공학과"),
    ("최지우", "20200812", "cse", "박사", "컴퓨터공학과"),
    ("정하은", "20241123", "cse", "석사", "컴퓨터공학과"),
    ("강시우", "20219987", "cse", "통합", "컴퓨터공학과"),
    ("윤아린", "20250101", "muunjae", "학사", "무은재학부"),
    ("임건우", "20250247", "muunjae", "학사", "무은재학부"),
    ("한소율", "20240333", "muunjae", "학사", "무은재학부"),
    ("오재현", "20250412", "muunjae", "학사", "무은재학부"),
]

# 가입하지 않은 참석자. 이메일이 있으면 연락처와 이어져 학번까지 자동으로
# 채워지고, 없으면 폼에서 직접 입력해야 합니다 - 두 경우를 모두 보여줍니다.
GUESTS = [
    ("서지호", "20239001", "cse", "방문학생", "컴퓨터공학과", True),
    ("노아윤", "", "cse", "", "", False),
]


def _email(student_id: str, name: str) -> str:
    return f"{student_id or name}@{DEMO_DOMAIN}"


# ---------------------------------------------------------------- images


def _signature_png() -> bytes:
    """A handwriting-ish squiggle, transparent background."""
    from PIL import Image, ImageDraw

    w, h = 520, 200
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    points = []
    for i in range(360):
        t = i / 359
        x = 40 + t * (w - 90)
        y = (
            h / 2
            + math.sin(t * 7.5) * 38 * (1 - t * 0.45)
            - math.sin(t * 2.1) * 26
            + math.cos(t * 15) * 5
        )
        points.append((x, y))
    draw.line(points, fill=(17, 17, 17, 255), width=6, joint="curve")
    # A closing flourish, the way a signature usually trails off.
    draw.arc(
        [w - 150, h / 2 - 45, w - 40, h / 2 + 55],
        start=210,
        end=110,
        fill=(17, 17, 17, 255),
        width=6,
    )

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _receipt_png(store: str, when: str, headcount: int, unit: int, total: int) -> bytes:
    """A plausible card receipt for the 집행액."""
    from PIL import Image, ImageDraw

    w, h = 520, 760
    img = Image.new("RGB", (w, h), (252, 252, 250))
    draw = ImageDraw.Draw(img)
    ink = (28, 28, 28)
    faint = (120, 120, 120)

    def line(y, text, *, size=1, color=ink, center=False, anchor_x=40):
        # Default PIL font only; Latin/digits render fine and that is all the
        # receipt needs to be legible in the demo.
        x = (w - draw.textlength(text) * size) / 2 if center else anchor_x
        if size == 1:
            draw.text((x, y), text, fill=color)
        else:
            tmp = Image.new(
                "RGB", (int(draw.textlength(text)) + 4, 14), (252, 252, 250)
            )
            ImageDraw.Draw(tmp).text((0, 0), text, fill=color)
            tmp = tmp.resize((int(tmp.width * size), int(tmp.height * size)))
            img.paste(tmp, (int(x), int(y)))

    def rule(y, dashed=True):
        if dashed:
            for x in range(30, w - 30, 12):
                draw.line([(x, y), (x + 6, y)], fill=faint)
        else:
            draw.line([(30, y), (w - 30, y)], fill=faint)

    line(46, store.upper(), size=2.4, center=True)
    line(96, "POSTECH CAMPUS", center=True, color=faint)
    rule(130)
    line(152, f"DATE  {when}")
    line(176, "POS  #02   CASHIER  07")
    line(200, "APPROVAL  3391-8842")
    rule(230)
    line(252, "STUDENT GUIDANCE MEETING")
    line(280, f"  UNIT PRICE      {unit:>10,}")
    line(304, f"  QTY             {headcount:>10}")
    rule(336)
    line(360, f"SUBTOTAL          {total:>10,}", size=1.4)
    line(400, f"TOTAL             {total:>10,}", size=1.8)
    rule(452)
    line(474, "CARD   HANA  ****-****-****-4417")
    line(498, "TYPE   CREDIT / LUMP SUM")
    line(522, f"AMOUNT {total:,} KRW")
    rule(556)
    line(580, "THANK YOU", center=True, color=faint)
    line(604, f"* DEMO RECEIPT - {DEMO_TAG} *", center=True, color=faint)

    # Torn-paper zigzag along the bottom edge.
    for x in range(20, w - 20, 22):
        draw.polygon(
            [(x, h - 40), (x + 11, h - 22), (x + 22, h - 40), (x + 22, h), (x, h)],
            fill=(255, 255, 255),
        )

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------- cleanup


async def clean() -> int:
    """Removes only what this script created."""
    removed = 0
    demo_events = await events_col.find({"demoTag": DEMO_TAG}, {"_id": 1}).to_list(
        length=None
    )
    for ev in demo_events:
        await event_responses_col.delete_many({"eventId": ev["_id"]})
    removed += (await events_col.delete_many({"demoTag": DEMO_TAG})).deleted_count

    for rec in await meeting_records_col.find(
        {"demoTag": DEMO_TAG}, {"_id": 1}
    ).to_list(length=None):
        crypto_service.delete_record_files(str(rec["_id"]))
    removed += (
        await meeting_records_col.delete_many({"demoTag": DEMO_TAG})
    ).deleted_count
    removed += (await contacts_col.delete_many({"demoTag": DEMO_TAG})).deleted_count
    removed += (await users_col.delete_many({"demoTag": DEMO_TAG})).deleted_count
    return removed


# ---------------------------------------------------------------- build


async def build() -> None:
    host = await users_col.find_one({"email": HOST_EMAIL})
    if not host:
        raise SystemExit(f"호스트 계정을 찾을 수 없습니다: {HOST_EMAIL}")

    await clean()
    random.seed(20260825)

    # --- 학생 계정 + 연락처 ------------------------------------------------
    people: dict[str, dict] = {}
    for name, sid, aff, degree, dept in ROSTER:
        email = _email(sid, name)
        user_id = ObjectId()
        await users_col.insert_one(
            {
                "_id": user_id,
                "name": name,
                "email": email,
                "isAdmin": False,
                "demoTag": DEMO_TAG,
                "createdAt": datetime.now(UTC),
            }
        )
        await contacts_col.insert_one(
            {
                "ownerId": host["_id"],
                "name": name,
                "email": email,
                "relation": "지도학생",
                "degree": degree,
                "department": dept,
                "gradSchool": "일반대학원" if aff == "cse" else "",
                "studentId": sid,
                "status": "재학",
                "demoTag": DEMO_TAG,
                "createdAt": datetime.now(UTC),
            }
        )
        people[name] = {
            "key": str(user_id),
            "userId": user_id,
            "email": email,
            "name": name,
            "guest": False,
        }

    for name, sid, aff, degree, dept, has_contact in GUESTS:
        email = _email(sid, name) if has_contact else ""
        if has_contact:
            await contacts_col.insert_one(
                {
                    "ownerId": host["_id"],
                    "name": name,
                    "email": email,
                    "relation": "공동지도학생",
                    "degree": degree,
                    "department": dept,
                    "studentId": sid,
                    "status": "재학",
                    "demoTag": DEMO_TAG,
                    "createdAt": datetime.now(UTC),
                }
            )
        # Guests are keyed by the name they typed, not by an account id.
        people[name] = {
            "key": name,
            "userId": None,
            "email": email,
            "name": name,
            "guest": True,
        }

    # --- 확정된 일정 -------------------------------------------------------
    # Times below are the host's *local* wall clock. Building them in the
    # machine's timezone (rather than UTC) keeps 면담 at 10:00, not at 19:00
    # once the browser converts a UTC-stored 10:00 back to KST.
    local_tz = datetime.now().astimezone().tzinfo
    today = datetime.now(local_tz).replace(hour=9, minute=0, second=0, microsecond=0)

    plan = [
        (
            "학기 초 개별 면담",
            -3,
            [
                (10, 0, ["김민준", "이서연"]),
                (11, 0, ["박도윤"]),
                (14, 0, ["최지우", "정하은"]),
            ],
        ),
        (
            "무은재 신입생 학부 상담",
            -5,
            [
                (13, 0, ["윤아린", "임건우", "한소율"]),
            ],
        ),
        (
            "가을학기 진로 상담",
            -7,
            [
                (10, 30, ["김민준", "윤아린", "박도윤"]),
                (15, 0, ["오재현", "정하은"]),
            ],
        ),
        (
            "졸업예정자 종합 면담",
            -10,
            [
                (14, 0, ["김민준", "이서연", "최지우", "강시우", "한소율", "오재현"]),
            ],
        ),
        (
            "수시 상담 (외부 참석자 포함)",
            -2,
            [
                (16, 0, ["서지호", "노아윤", "이서연"]),
            ],
        ),
        # 미래 일정: "기록할 약속" 목록에 나오지 않는 것이 정상입니다.
        (
            "다음 달 정기 면담 (예정)",
            +5,
            [
                (10, 0, ["김민준", "윤아린"]),
            ],
        ),
        # 이미 작성이 끝난 기록이 붙는 일정.
        (
            "지난달 정기 면담",
            -14,
            [
                (11, 0, ["김민준", "이서연", "윤아린"]),
            ],
        ),
    ]

    created = []
    for name, day_offset, meetings in plan:
        day = today + timedelta(days=day_offset)
        everyone = sorted({n for _, _, names in meetings for n in names})
        event_id = ObjectId()

        # Availability ticks so the event/finalize pages still look coherent
        # if the host clicks through to them.
        ticks = [day + timedelta(minutes=30 * i) for i in range(16)]

        await events_col.insert_one(
            {
                "_id": event_id,
                "shortId": await generate_unique_short_id(),
                "ownerId": host["_id"],
                "name": name,
                "description": "데모 데이터입니다. 면담 기록 기능을 시험해 보세요.",
                "descriptionFormat": "text",
                "isArchived": False,
                "isDeleted": False,
                "isClosed": True,
                "duration": 8,
                "dates": [day],
                "startOnMonday": False,
                "notificationsEnabled": False,
                "blindAvailabilityEnabled": False,
                "collectEmails": True,
                "timeIncrement": 30,
                "sendEmailAfterXResponses": None,
                "type": "specific_dates",
                "remindees": [],
                "numResponses": len(everyone) + 1,
                "createdAt": day - timedelta(days=7),
                "demoTag": DEMO_TAG,
                "finalization": {
                    "status": "confirmed",
                    "capacity": max(len(names) for _, _, names in meetings),
                    "meetingMinutes": 30,
                    "meetings": [
                        {
                            "start": day.replace(hour=h, minute=m),
                            "end": day.replace(hour=h, minute=m)
                            + timedelta(minutes=30),
                            "participants": [people[n]["key"] for n in names],
                        }
                        for h, m, names in meetings
                    ],
                    "unassigned": [],
                    "confirmedAt": day - timedelta(days=2),
                    "confirmedBy": host["_id"],
                    # Empty on purpose: nothing was written to Google Calendar,
                    # so deleting a demo event must not try to remove anything.
                    "googleSyncedEvents": [],
                },
            }
        )

        await event_responses_col.insert_one(
            {
                "eventId": event_id,
                "userId": str(host["_id"]),
                "response": {
                    "userId": host["_id"],
                    "name": host.get("name", ""),
                    "email": host["email"],
                    "availability": ticks,
                    "ifNeeded": [],
                },
                "createdAt": day - timedelta(days=6),
            }
        )
        for person in (people[n] for n in everyone):
            response = {
                "name": person["name"],
                "email": person["email"],
                "availability": random.sample(ticks, k=random.randint(9, 14)),
                "ifNeeded": [],
            }
            if person["userId"]:
                response["userId"] = person["userId"]
            await event_responses_col.insert_one(
                {
                    "eventId": event_id,
                    "userId": person["key"],
                    "response": response,
                    "createdAt": day - timedelta(days=5),
                }
            )

        created.append((name, event_id, day, meetings))

    # --- 이미 작성이 끝난 기록 한 건 ---------------------------------------
    name, event_id, day, meetings = created[-1]
    event = await events_col.find_one({"_id": event_id})
    meeting_start = day.replace(hour=11, minute=0)
    draft = await record_service.build_draft(event, host, meeting_start)

    draft["place"] = "교내 카페 (무은재기념관 1층)"
    # build_draft leaves these blank on purpose - the browser normally fills
    # them in from the host's local clock, so a script has to do it too.
    local_start = meeting_start.astimezone(local_tz)
    draft["date"] = f"{local_start:%Y-%m-%d}"
    draft["startTime"] = f"{local_start:%H:%M}"
    draft["endTime"] = "12:05"
    draft["notesMode"] = "individual"
    notes = {
        "김민준": "학위논문 진행 상황 점검. 실험 결과 정리 및 3월 학회 투고 일정 확정. "
        "다음 면담까지 초안 1차 완성하기로 함.",
        "이서연": "석사 연구 주제 구체화 논의. 선행 연구 조사 범위를 좁히고 "
        "베이스라인 재현을 우선 진행하기로 함.",
        "윤아린": "전공 선택 상담. 컴퓨터공학과 진입 요건과 수강 계획을 안내하고, "
        "학부연구생 참여 방법을 설명함.",
    }
    for attendee in draft["attendees"]:
        if attendee["name"] in notes:
            draft["perStudentNotes"][attendee["key"]] = notes[attendee["name"]]
    for settlement in draft["settlements"]:
        settlement["receiptTime"] = "12:05"

    record_id = await record_service.save_record(
        host, {**draft, "meetingStart": meeting_start, "status": "saved"}
    )
    await meeting_records_col.update_one(
        {"_id": ObjectId(record_id)}, {"$set": {"demoTag": DEMO_TAG}}
    )

    await record_service.attach_file(
        host, record_id, "signature.png", _signature_png(), "signature.png"
    )
    saved = await record_service.get_record(host, record_id)
    for index, settlement in enumerate(saved["settlements"]):
        await record_service.attach_file(
            host,
            record_id,
            f"receipt-{index}.png",
            _receipt_png(
                "cafe muunjae",
                f"{day:%Y-%m-%d} 12:05",
                settlement["headcount"],
                settlement["unitPrice"],
                settlement["amount"],
            ),
            f"receipt-{index}.png",
        )

    # --- 요약 --------------------------------------------------------------
    pending = await record_service.list_open_meetings(host)
    print(f"호스트        : {host.get('name')} <{host['email']}>")
    print(f"학생 계정     : {len(ROSTER)}명 (+ 게스트 {len(GUESTS)}명)")
    print(
        f"연락처        : {await contacts_col.count_documents({'demoTag': DEMO_TAG})}건"
    )
    print(f"확정된 일정   : {len(created)}개")
    print(f"기록할 약속   : {len(pending)}건 (미래 일정 1건은 목록에서 제외됨)")
    print(f"작성 완료     : 1건  →  /records/{record_id}/print")
    print()
    for row in pending:
        mark = "작성됨" if row["hasRecord"] else "미작성"
        # Stored UTC; shown in the same local clock the browser will use.
        start = row["start"].astimezone(local_tz)
        print(
            f"  [{mark}] {start:%m/%d(%a) %H:%M}  {row['eventName']}  ({row['headcount']}명)"
        )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--clean", action="store_true", help="데모 데이터만 삭제합니다."
    )
    args = parser.parse_args()

    if args.clean:
        print(f"데모 문서 {await clean()}건을 삭제했습니다.")
        return
    await build()


if __name__ == "__main__":
    asyncio.run(main())
