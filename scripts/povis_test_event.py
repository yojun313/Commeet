"""POVIS 자동입력 확장 테스트용 일정 하나.

지도학생 두 명(POVIS 지도면담입력 목록에 실제로 있는 학번)이 참석한 확정 일정과,
네 갈래 내용이 채워진 작성 완료 기록을 만듭니다. 확장의 "일괄 입력"이 이 기록을
읽어 POVIS에 넣는 흐름을 끝까지 시험하기 위한 것입니다.

    uv run python scripts/povis_test_event.py                       # 생성 (호스트: yojun313)
    uv run python scripts/povis_test_event.py --host g.kim@postech.ac.kr
    uv run python scripts/povis_test_event.py --clean               # 이 스크립트가 만든 것만 삭제

demo_records.py와 같은 이유로 finalization을 MongoDB에 직접 씁니다 -
finalize_service.confirm()은 참석자 전원에게 메일을 보냅니다.
"""

import argparse
import asyncio
from datetime import UTC, datetime, timedelta

from bson import ObjectId

from app.db import event_responses_col, events_col, meeting_records_col, users_col
from app.services import record_service
from app.services.event_service import generate_unique_short_id

TAG = "povis-test"
DEFAULT_HOST = "yojun313@postech.ac.kr"
EVENT_NAME = "[테스트] POVIS 자동입력 확인 면담"

# (이름, 학번, 과정) - POVIS 지도면담입력 목록의 표기 그대로. 이름의 띄어쓰기는
# POVIS 쪽 표기("배 준형")이고, Commeet에는 붙여 씁니다. 매칭은 학번으로만 합니다.
STUDENTS = [
    ("배준형", "20252323", "석사"),
    ("문요준", "20230024", "학사"),
]

# POVIS에 실제로 저장되는 내용입니다. 나중에 지도면담입력 → 변경에서 찾아
# 지우기 쉽도록 앞에 표시를 달아 둡니다.
NOTES = {
    "20252323": {
        "academic": "[Commeet 테스트] 석사 1학기 수강 과목 진행 상황 점검. 알고리즘 과목 과제 부담이 크나 잘 따라가고 있음.",
        "life": "[Commeet 테스트] 기숙사 생활 적응 양호. 연구실 동료들과의 관계 원만.",
        "career": "[Commeet 테스트] 박사 진학 여부는 2학기 연구 결과를 보고 결정하기로 함.",
        "etc": "[Commeet 테스트] 다음 면담은 중간고사 이후로 예정.",
    },
    "20230024": {
        "academic": "[Commeet 테스트] 졸업 요건 확인. 전공 필수 1과목 미이수 - 이번 학기 수강 중.",
        "life": "[Commeet 테스트] 특이사항 없음.",
        "career": "[Commeet 테스트] 대학원 진학과 취업 사이에서 고민 중. 연구실 인턴 경험을 권함.",
        "etc": "",
    },
}


async def clean() -> int:
    removed = 0
    for ev in await events_col.find({"demoTag": TAG}, {"_id": 1}).to_list(length=None):
        await event_responses_col.delete_many({"eventId": ev["_id"]})
    removed += (await events_col.delete_many({"demoTag": TAG})).deleted_count
    removed += (await meeting_records_col.delete_many({"demoTag": TAG})).deleted_count
    return removed


async def build(host_email: str) -> None:
    host = await users_col.find_one({"email": host_email})
    if not host:
        raise SystemExit(f"호스트 계정을 찾을 수 없습니다: {host_email}")
    await clean()

    # 가입한 학생은 계정 id로, 아니면 이름으로 참석자를 식별합니다 - 폼이
    # perStudentNotes를 `key || name`으로 찾기 때문에 둘 다 동작합니다.
    attendees = []
    for name, student_id, _degree in STUDENTS:
        user = await users_col.find_one({"name": name})
        attendees.append(
            {
                "key": str(user["_id"]) if user else name,
                "name": name,
                "email": user["email"] if user else "",
                "studentId": student_id,
                "affiliation": "cse",
                "present": True,
            }
        )

    local_tz = datetime.now().astimezone().tzinfo
    day = datetime.now(local_tz).replace(hour=9, minute=0, second=0, microsecond=0)
    start = day.replace(hour=14, minute=0)
    end = start + timedelta(minutes=30)
    event_id = ObjectId()

    await events_col.insert_one(
        {
            "_id": event_id,
            "shortId": await generate_unique_short_id(),
            "ownerId": host["_id"],
            "name": EVENT_NAME,
            "description": "POVIS 자동입력 확장 테스트용 일정입니다. scripts/povis_test_event.py --clean 으로 지웁니다.",
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
            "numResponses": len(attendees) + 1,
            "createdAt": day - timedelta(days=3),
            "demoTag": TAG,
            "finalization": {
                "status": "confirmed",
                "capacity": len(attendees),
                "meetingMinutes": 30,
                "meetings": [
                    {"start": start, "end": end, "participants": [a["key"] for a in attendees]}
                ],
                "unassigned": [],
                "confirmedAt": day - timedelta(days=1),
                "confirmedBy": host["_id"],
                "googleSyncedEvents": [],
            },
        }
    )

    ticks = [day + timedelta(minutes=30 * i) for i in range(16)]
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
            "createdAt": day - timedelta(days=2),
        }
    )
    for a in attendees:
        # 호스트 본인이 참석자이기도 하면(문요준) 응답은 위에서 이미 넣었습니다 -
        # (eventId, userId)가 유일 인덱스라 한 번 더 넣으면 실패합니다.
        if a["key"] == str(host["_id"]):
            continue
        response = {"name": a["name"], "email": a["email"], "availability": ticks[8:12], "ifNeeded": []}
        if ObjectId.is_valid(a["key"]):
            response["userId"] = ObjectId(a["key"])
        await event_responses_col.insert_one(
            {"eventId": event_id, "userId": a["key"], "response": response, "createdAt": day - timedelta(days=2)}
        )

    record_id = await record_service.save_record(
        host,
        {
            "eventId": str(event_id),
            "meetingStart": start,
            "date": f"{start:%Y-%m-%d}",
            "startTime": f"{start:%H:%M}",
            "endTime": f"{end:%H:%M}",
            "place": "연구실",
            "professorName": host.get("name", ""),
            "attendees": attendees,
            "notesMode": "individual",
            "sharedNotes": record_service.empty_notes(),
            "perStudentNotes": {a["key"]: NOTES[a["studentId"]] for a in attendees},
            "settlements": record_service.compute_settlements(attendees),
            "status": "saved",
        },
    )
    await meeting_records_col.update_one({"_id": ObjectId(record_id)}, {"$set": {"demoTag": TAG}})

    print(f"호스트   : {host.get('name')} <{host['email']}>")
    print(f"일정     : {EVENT_NAME}  (id {event_id})")
    print(f"면담     : {start:%Y-%m-%d %H:%M}~{end:%H:%M}  → POVIS 면담일 {start:%Y%m%d}")
    print(f"기록     : {record_id}  (학생별 노트, 작성 완료)")
    for a in attendees:
        print(f"  - {a['name']} ({a['studentId']})  key={a['key']}")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST, help="일정 소유자(교수) 계정 이메일")
    parser.add_argument("--clean", action="store_true", help="이 스크립트가 만든 것만 삭제")
    args = parser.parse_args()
    if args.clean:
        print(f"{await clean()}건 삭제했습니다.")
        return
    await build(args.host)


if __name__ == "__main__":
    asyncio.run(main())
