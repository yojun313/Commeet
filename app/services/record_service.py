"""면담 기록 / 학생지도비 신청서.

One record per confirmed meeting. Everything personal (attendee names, the
meeting notes, the receipt and signature images) is encrypted before it
reaches MongoDB or disk - see crypto_service.

Settlements deserve a note: the 학생지도비 rules settle 컴공 students and
무은재 학부생 separately ("컴공과 학생 금액과 무은재학부생 금액을 나눠서 각각
결재"), each with its own card receipt and its own 신청서. So one meeting can
produce two forms, and a record holds a list of settlements rather than a
single amount.
"""

from datetime import UTC, datetime

from bson import ObjectId

from app.config import GUIDANCE_FEE_RATES
from app.core.ids import to_object_id
from app.db import contacts_col, events_col, meeting_records_col
from app.services import crypto_service, event_service

AFFILIATIONS = ("cse", "muunjae", "other")
AFFILIATION_LABELS = {"cse": "컴퓨터공학과", "muunjae": "무은재학부", "other": "기타"}

# 면담 내용 항목. POVIS 지도 기록이 이 네 갈래를 따로 요구합니다.
# 화면 쪽 같은 목록은 record-form.js의 NOTE_CATEGORIES입니다.
NOTE_CATEGORIES = [
    ("academic", "학업지도"),
    ("life", "생활지도"),
    ("career", "진로지도"),
    ("etc", "기타사항"),
]
NOTE_KEYS = [key for key, _ in NOTE_CATEGORIES]


def empty_notes() -> dict:
    return {key: "" for key in NOTE_KEYS}


def _as_notes(value) -> dict:
    """저장된 값을 네 갈래 형태로 맞춥니다.

    항목이 나뉘기 전에 저장된 기록은 자유 서술 **문자열 하나**입니다. 어느
    갈래였는지 알 수 없으므로 "기타사항"에 넣습니다 - 내용을 잃지 않으면서
    없는 분류를 지어내지도 않습니다. 필요하면 주최자가 옮기면 됩니다.
    """
    notes = empty_notes()
    if isinstance(value, str):
        notes["etc"] = value
    elif isinstance(value, dict):
        for key in NOTE_KEYS:
            notes[key] = str(value.get(key) or "")
    return notes


def _as_per_student(value) -> dict:
    if not isinstance(value, dict):
        return {}
    return {key: _as_notes(note) for key, note in value.items()}


class RecordsDisabled(Exception):
    """지도 면담 기능이 꺼진 일정입니다."""


class RecordNotFound(Exception):
    pass


class MeetingNotFound(Exception):
    pass


def _guess_affiliation(contact: dict | None) -> str:
    """Best-effort 소속 for the fee split, from the saved 연락처 details.

    Only a hint - the form lets the host correct it, because the amount owed
    depends on it and a wrong guess would silently mis-bill.
    """
    if not contact:
        return "cse"
    haystack = " ".join(
        str(contact.get(f) or "") for f in ("department", "gradSchool", "relation")
    )
    if "무은재" in haystack:
        return "muunjae"
    if (
        contact.get("degree") == "학사"
        and "컴퓨터" not in haystack
        and "컴공" not in haystack
    ):
        return "muunjae"
    return "cse"


async def _contacts_by_email(owner_id: ObjectId) -> dict:
    rows = await contacts_col.find({"ownerId": owner_id}).to_list(length=None)
    return {c["email"]: c for c in rows if c.get("email")}


async def _resolve_attendees(
    event: dict, owner: dict, participant_keys: list[str]
) -> list[dict]:
    """Turns stored participant keys into editable attendee rows.

    Names and emails come from the same resolver the finalize screen uses, so
    a participant reads identically in both places. The student details the
    form needs - 학번, 소속 - live only on the host's 연락처, joined by email.
    """
    from app.services.finalize_service import _load_people

    _host, people = await _load_people(event)
    by_key = {p["key"]: p for p in people}
    contacts = await _contacts_by_email(owner["_id"])

    attendees = []
    for key in participant_keys:
        person = by_key.get(key) or {"name": key, "email": ""}
        email = person.get("email") or ""
        contact = contacts.get(email) if email else None
        attendees.append(
            {
                "key": key,
                "name": (contact or {}).get("name") or person.get("name") or key,
                "email": email,
                "studentId": (contact or {}).get("studentId") or "",
                "affiliation": _guess_affiliation(contact),
                "present": True,
            }
        )
    attendees.sort(key=lambda a: a["name"])
    return attendees


def compute_settlements(attendees: list[dict]) -> list[dict]:
    """제출처(컴공/무은재)별로 신청서 하나씩 만듭니다.

    지원 규칙:
      - 컴공 학생: 컴공에서 30,000원
      - 무은재 학생: 컴공 15,000원 + 무은재 15,000원 (반반)

    그래서 무은재 학생은 **두 신청서에 모두** 올라갑니다. 예: 컴공생 1명 +
    무은재생 1명이면 컴공 제출분 상한 45,000원, 무은재 제출분 15,000원.
    """
    present = [a for a in attendees if a.get("present")]
    cse = [a for a in present if a.get("affiliation") == "cse"]
    mj = [a for a in present if a.get("affiliation") == "muunjae"]
    rate_cse = GUIDANCE_FEE_RATES.get("cse", 0)
    rate_mj = GUIDANCE_FEE_RATES.get("muunjae", 0)

    out = []

    # 컴공 제출분 - 컴공생 전액 + 무은재생 절반
    lines = []
    if cse:
        lines.append({"label": "컴퓨터공학과 학생", "unitPrice": rate_cse, "headcount": len(cse)})
    if mj:
        lines.append({"label": "무은재학부 학생", "unitPrice": rate_mj, "headcount": len(mj)})
    if lines:
        cap = sum(ln["unitPrice"] * ln["headcount"] for ln in lines)
        out.append(
            {
                "affiliation": "cse",
                "headcount": len(cse) + len(mj),
                "unitPrice": lines[0]["unitPrice"] if len(lines) == 1 else 0,
                "amount": cap,
                "capAmount": cap,
                "lines": lines,
                "receiptFile": None,
                "receiptTime": "",
            }
        )

    # 무은재 제출분 - 무은재생 절반
    if mj:
        cap = rate_mj * len(mj)
        out.append(
            {
                "affiliation": "muunjae",
                "headcount": len(mj),
                "unitPrice": rate_mj,
                "amount": cap,
                "capAmount": cap,
                "lines": [{"label": "무은재학부 학생", "unitPrice": rate_mj, "headcount": len(mj)}],
                "receiptFile": None,
                "receiptTime": "",
            }
        )
    return out


def _keep_receipts(
    existing: dict, settlements: list[dict]
) -> tuple[list[dict], list[str]]:
    """Carries stored receipt attachments over to an incoming save.

    Uploads are server-side state the form never sends back, so a save from a
    client whose copy predates the upload would otherwise drop the receipt
    from the 신청서 and leave its blob orphaned on disk.

    Returns the settlements plus the filenames of receipts whose 소속 group no
    longer exists (everyone in it was marked absent), which the caller deletes.
    """
    stored = crypto_service.decrypt_json(existing.get("enc"), {}) or {}
    by_affiliation = {
        s.get("affiliation"): s
        for s in stored.get("settlements") or []
        if s.get("receiptFile")
    }
    for settlement in settlements:
        previous = by_affiliation.pop(settlement.get("affiliation"), None)
        if previous and not settlement.get("receiptFile"):
            settlement["receiptFile"] = previous["receiptFile"]
            settlement["receiptName"] = previous.get("receiptName", "")
    return settlements, [s["receiptFile"] for s in by_affiliation.values()]


def find_meeting(event: dict, meeting_start: datetime) -> dict:
    """확정된 약속만 찾습니다.

    확정을 풀어도 배정은 남습니다 (finalize_service.cancel) - 이어서 고칠 수
    있어야 하기 때문입니다. 하지만 확정이 아닌 배정으로 새 기록을 시작하면
    안 되므로 상태를 함께 봅니다. 이미 써 둔 기록을 읽고 고치는 것은
    막지 않습니다.
    """
    finalization = event.get("finalization") or {}
    if finalization.get("status") != "confirmed":
        raise MeetingNotFound()
    for m in finalization.get("meetings") or []:
        if m["start"] == meeting_start:
            return m
    raise MeetingNotFound()


async def build_draft(event: dict, owner: dict, meeting_start: datetime) -> dict:
    """The prefilled form for a meeting that has no record yet."""
    meeting = find_meeting(event, meeting_start)
    attendees = await _resolve_attendees(
        event, owner, meeting.get("participants") or []
    )
    return {
        "eventId": str(event["_id"]),
        "eventName": event.get("name", ""),
        # Start comes from the confirmed schedule; the end is meant to be the
        # time printed on the receipt, so it starts as the scheduled end and
        # the host corrects it after paying.
        #
        # Both go out as UTC instants and the browser turns them into 일자 /
        # 시작 / 종료 in the host's own timezone - the server has no idea
        # which timezone that is, and formatting UTC here would put a 11:00
        # 면담 on the form as 02:00.
        "meetingStart": meeting["start"],
        "meetingEnd": meeting["end"],
        "date": "",
        "startTime": "",
        "endTime": "",
        "place": "",
        "professorName": owner.get("name", ""),
        "attendees": attendees,
        "notesMode": "shared",
        "sharedNotes": empty_notes(),
        "perStudentNotes": {},
        "settlements": compute_settlements(attendees),
        "status": "draft",
        "existing": False,
    }


def _public(record: dict) -> dict:
    """Decrypts a stored record back into the shape the form/API speak."""
    payload = crypto_service.decrypt_json(record.get("enc"), {}) or {}
    return {
        "_id": str(record["_id"]),
        "eventId": str(record["eventId"]),
        "eventName": record.get("eventName", ""),
        "meetingStart": record["meetingStart"],
        "date": record.get("date", ""),
        "startTime": record.get("startTime", ""),
        "endTime": record.get("endTime", ""),
        "place": payload.get("place", ""),
        "professorName": payload.get("professorName", ""),
        "attendees": payload.get("attendees", []),
        "notesMode": payload.get("notesMode", "shared"),
        # 옛 기록(자유 서술 한 칸)도 여기서 네 갈래 형태로 맞춰 내보냅니다.
        # 폼과 인쇄 화면이 형식을 두 가지 다룰 필요가 없게 하려는 것입니다.
        "sharedNotes": _as_notes(
            payload.get("sharedNotes", payload.get("sharedNote", ""))
        ),
        "perStudentNotes": _as_per_student(payload.get("perStudentNotes", {})),
        "settlements": payload.get("settlements", []),
        "hasSignature": bool(record.get("signatureFile")),
        "status": record.get("status", "draft"),
        "createdAt": record.get("createdAt"),
        "updatedAt": record.get("updatedAt"),
        "existing": True,
    }


async def get_record(owner: dict, record_id: str) -> dict:
    oid = to_object_id(record_id)
    if oid is None:
        raise RecordNotFound()
    doc = await meeting_records_col.find_one({"_id": oid, "ownerId": owner["_id"]})
    if not doc:
        raise RecordNotFound()
    return _public(doc)


async def get_by_meeting(
    owner: dict, event_id: str, meeting_start: datetime
) -> dict | None:
    oid = to_object_id(event_id)
    doc = await meeting_records_col.find_one(
        {"ownerId": owner["_id"], "eventId": oid, "meetingStart": meeting_start}
    )
    return _public(doc) if doc else None


async def save_record(owner: dict, data: dict) -> str:
    """Creates or updates the record for one meeting (upsert on the meeting)."""
    event_oid = to_object_id(data["eventId"])
    event = await events_col.find_one({"_id": event_oid})
    if not event or event.get("ownerId") != owner["_id"]:
        raise RecordNotFound()
    # 꺼 둔 일정에는 새로 쓰지 않습니다. 화면에서는 칸 자체가 안 보이지만,
    # 열어 둔 탭에서 뒤늦게 저장이 날아올 수 있습니다. 읽기는 막지 않습니다 -
    # 이미 적어 둔 기록은 계속 볼 수 있어야 합니다.
    if not event_service.records_enabled(event):
        raise RecordsDisabled()

    attendees = data.get("attendees") or []
    settlements = data.get("settlements") or compute_settlements(attendees)

    now = datetime.now(UTC)
    existing = await meeting_records_col.find_one(
        {
            "ownerId": owner["_id"],
            "eventId": event_oid,
            "meetingStart": data["meetingStart"],
        }
    )
    orphans: list[str] = []
    if existing:
        settlements, orphans = _keep_receipts(existing, settlements)

    payload = {
        "place": data.get("place", ""),
        "professorName": data.get("professorName", ""),
        "attendees": attendees,
        "notesMode": data.get("notesMode", "shared"),
        "sharedNotes": _as_notes(data.get("sharedNotes")),
        "perStudentNotes": _as_per_student(data.get("perStudentNotes", {})),
        "settlements": settlements,
    }

    doc = {
        "ownerId": owner["_id"],
        "eventId": event_oid,
        "eventName": event.get("name", ""),
        "meetingStart": data["meetingStart"],
        "date": data.get("date", ""),
        "startTime": data.get("startTime", ""),
        "endTime": data.get("endTime", ""),
        "status": data.get("status", "draft"),
        # Everything identifying goes into one encrypted blob.
        "enc": crypto_service.encrypt_json(payload),
        "updatedAt": now,
    }

    if existing:
        await meeting_records_col.update_one({"_id": existing["_id"]}, {"$set": doc})
        for name in orphans:
            crypto_service.delete_file(str(existing["_id"]), name)
        return str(existing["_id"])

    doc["createdAt"] = now
    result = await meeting_records_col.insert_one(doc)
    return str(result.inserted_id)


async def attach_file(
    owner: dict, record_id: str, kind: str, raw: bytes, filename: str
) -> None:
    """Stores an encrypted attachment.

    `kind` is the stored filename: "signature.png", or "receipt-<i>.<ext>"
    where <i> is the index of the settlement the receipt belongs to.
    """
    oid = to_object_id(record_id)
    doc = await meeting_records_col.find_one({"_id": oid, "ownerId": owner["_id"]})
    if not doc:
        raise RecordNotFound()

    stored = crypto_service.write_encrypted_file(str(oid), kind, raw)
    now = datetime.now(UTC)

    if kind.startswith("signature"):
        await meeting_records_col.update_one(
            {"_id": oid}, {"$set": {"signatureFile": stored, "updatedAt": now}}
        )
        return

    idx = int(kind.split("-", 1)[1].split(".", 1)[0])
    payload = crypto_service.decrypt_json(doc.get("enc"), {}) or {}
    settlements = payload.get("settlements") or []
    if not (0 <= idx < len(settlements)):
        return
    # Re-uploading with a different extension would otherwise leave the old
    # blob behind as an orphan.
    previous = settlements[idx].get("receiptFile")
    if previous and previous != stored:
        crypto_service.delete_file(str(oid), previous)

    settlements[idx]["receiptFile"] = stored
    settlements[idx]["receiptName"] = filename
    payload["settlements"] = settlements
    await meeting_records_col.update_one(
        {"_id": oid},
        {"$set": {"enc": crypto_service.encrypt_json(payload), "updatedAt": now}},
    )


async def clear_signature(owner: dict, record_id: str) -> None:
    oid = to_object_id(record_id)
    doc = await meeting_records_col.find_one({"_id": oid, "ownerId": owner["_id"]})
    if not doc:
        raise RecordNotFound()
    if doc.get("signatureFile"):
        crypto_service.delete_file(str(oid), doc["signatureFile"])
    await meeting_records_col.update_one(
        {"_id": oid},
        {"$unset": {"signatureFile": ""}, "$set": {"updatedAt": datetime.now(UTC)}},
    )


async def read_file(owner: dict, record_id: str, kind: str) -> bytes | None:
    oid = to_object_id(record_id)
    doc = await meeting_records_col.find_one({"_id": oid, "ownerId": owner["_id"]})
    if not doc:
        raise RecordNotFound()
    return crypto_service.read_encrypted_file(str(oid), kind)


async def delete_record(owner: dict, record_id: str) -> bool:
    oid = to_object_id(record_id)
    if oid is None:
        return False
    result = await meeting_records_col.delete_one({"_id": oid, "ownerId": owner["_id"]})
    if result.deleted_count:
        crypto_service.delete_record_files(str(oid))
    return bool(result.deleted_count)


async def list_records(owner: dict, event_id: str | None = None) -> list[dict]:
    query: dict = {"ownerId": owner["_id"]}
    if event_id:
        oid = to_object_id(event_id)
        # 잘못된 id로 전체 목록이 새어 나가지 않도록 빈 결과를 만듭니다.
        query["eventId"] = oid if oid else ObjectId()
    docs = (
        await meeting_records_col.find(query)
        .sort("meetingStart", -1)
        .to_list(length=None)
    )
    out = []
    for d in docs:
        try:
            rec = _public(d)
        except crypto_service.RecordDecryptionError:
            # One unreadable record must not take the whole list down.
            rec = {
                "_id": str(d["_id"]),
                "eventName": d.get("eventName", ""),
                "meetingStart": d.get("meetingStart"),
                "date": d.get("date", ""),
                "status": d.get("status", "draft"),
                "undecryptable": True,
                "attendees": [],
                "settlements": [],
            }
        out.append(rec)
    return out


async def count_by_event(owner: dict) -> dict[str, dict]:
    """일정별 면담 기록 수. `{eventId: {"total": n, "draft": n}}`

    목록 화면이 "이 일정에 기록이 있는지"를 표시하려고 부릅니다. 개수만
    필요하므로 **복호화하지 않고** 몽고 집계로 끝냅니다 - 기록 전체를 내려
    받아 세는 것은 느릴 뿐 아니라 필요 없는 개인정보를 옮기는 일입니다.
    """
    rows = await meeting_records_col.aggregate(
        [
            {"$match": {"ownerId": owner["_id"]}},
            {
                "$group": {
                    "_id": "$eventId",
                    "total": {"$sum": 1},
                    "draft": {"$sum": {"$cond": [{"$eq": ["$status", "draft"]}, 1, 0]}},
                }
            },
        ]
    ).to_list(length=None)
    return {
        str(r["_id"]): {"total": r["total"], "draft": r["draft"]}
        for r in rows
        if r.get("_id")
    }


async def list_open_meetings(owner: dict) -> list[dict]:
    """Confirmed meetings the host hosts, flagged with whether a record exists,
    so the UI can offer "기록 작성" for the ones still missing one."""
    events = (
        await events_col.find(
            {
                "ownerId": owner["_id"],
                "finalization.status": "confirmed",
                "isDeleted": {"$ne": True},
            }
        )
        .sort("_id", -1)
        .to_list(length=None)
    )
    existing = await meeting_records_col.find(
        {"ownerId": owner["_id"]}, {"eventId": 1, "meetingStart": 1}
    ).to_list(length=None)
    done = {(str(r["eventId"]), r["meetingStart"]) for r in existing}
    now = datetime.now(UTC)

    out = []
    for ev in events:
        for m in (ev.get("finalization") or {}).get("meetings") or []:
            # A record is written after the meeting, so upcoming ones would
            # only be noise in the "기록할 약속" list.
            if m["end"] > now:
                continue
            out.append(
                {
                    "eventId": str(ev["_id"]),
                    "eventName": ev.get("name", ""),
                    "start": m["start"],
                    "end": m["end"],
                    "headcount": len(m.get("participants") or []),
                    "hasRecord": (str(ev["_id"]), m["start"]) in done,
                }
            )
    out.sort(key=lambda m: m["start"], reverse=True)
    return out
