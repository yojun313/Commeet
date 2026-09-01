# Commeet 구현 문서

이 문서는 Commeet의 **모든 기능이 어떤 파일의 어떤 코드로 동작하는지**를 정리한 개발자용 레퍼런스입니다.
사용법 요약은 [README.md](README.md)에 있고, 이 문서는 그 아래 계층 — 실제 구현, 데이터 구조, 설계 판단의 이유 — 를 다룹니다.

---

## 목차

1. [기술 스택과 전체 구조](#1-기술-스택과-전체-구조)
2. [기반 계층 (core / db / main)](#2-기반-계층-core--db--main)
3. [인증과 계정](#3-인증과-계정)
4. [일정(Event) 생성·수정·삭제](#4-일정event-생성수정삭제)
5. [가용시간 응답과 히트맵 그리드](#5-가용시간-응답과-히트맵-그리드)
6. [그룹(Group) 일정](#6-그룹group-일정)
7. [비공개 응답 (blind availability)](#7-비공개-응답-blind-availability)
8. [일정 확정과 최적 배정 알고리즘](#8-일정-확정과-최적-배정-알고리즘)
9. [Google Calendar 연동](#9-google-calendar-연동)
10. [전체 캘린더 페이지](#10-전체-캘린더-페이지)
11. [대시보드와 폴더](#11-대시보드와-폴더)
12. [연락처](#12-연락처)
13. [카드 정렬과 드래그 재배치](#13-카드-정렬과-드래그-재배치)
14. [마크다운 렌더러](#14-마크다운-렌더러)
15. [관리자 대시보드](#15-관리자-대시보드)
16. [면담 기록과 학생지도비 신청서](#16-면담-기록과-학생지도비-신청서)
17. [이메일 발송](#17-이메일-발송)
18. [프런트엔드 공통 인프라](#18-프런트엔드-공통-인프라)
19. [CSS 디자인 시스템과 레이아웃 규칙](#19-css-디자인-시스템과-레이아웃-규칙)
20. [데이터 모델 (MongoDB 컬렉션)](#20-데이터-모델-mongodb-컬렉션)
21. [API 레퍼런스](#21-api-레퍼런스)
22. [운영: 환경변수·스크립트·인덱스](#22-운영-환경변수스크립트인덱스)

---

## 1. 기술 스택과 전체 구조

### 스택

| 계층 | 선택 | 비고 |
|---|---|---|
| 웹 프레임워크 | FastAPI | 전부 `async` |
| DB | MongoDB + Motor | `AsyncIOMotorClient(MONGO_URI, tz_aware=True)` |
| 템플릿 | Jinja2 | SSR 껍데기 + 클라이언트 fetch |
| 프런트엔드 | **바닐라 JS** | 빌드 단계 없음, 번들러 없음, 프레임워크 없음 |
| 패키지 관리 | `uv` | `pyproject.toml` |
| 인증 | itsdangerous 서명 쿠키 + bcrypt | 서버 세션 저장소 없음 |
| 암호화 | `cryptography` (Fernet) | 면담 기록 전용 |

의존성은 13개뿐입니다 (`pyproject.toml`). PDF 라이브러리도, 차트 라이브러리도, 마크다운 라이브러리도 없습니다 — 각각 인쇄용 HTML, 직접 만든 SVG, 직접 만든 렌더러로 대체했습니다. 그 이유는 해당 섹션에서 설명합니다.

### 디렉터리

```
app/
  main.py              앱 조립: 라우터/미들웨어/예외 핸들러 등록
  config.py            환경변수 → 상수 (import 시점에 1회)
  core/
    paths.py           BASE_DIR / APP_DIR / TEMPLATES_DIR / STATIC_DIR
    templates.py       Jinja 환경 + 전역변수 + asset() 캐시버스터
    security.py        bcrypt, 세션 서명, OTP 해시
    ids.py             ObjectId 헬퍼 + short-id 생성
    serialize.py       jsonable(): ObjectId/datetime → JSON 안전 값
  db/
    mongo.py           MongoDB 연결을 여는 유일한 곳
    __init__.py        컬렉션 핸들 레지스트리 + create_indexes()
  schemas/             Pydantic 요청 모델 8개 (auth, event, finalize, folder, user, contact, admin, record)
  services/            비즈니스 로직 13개 모듈
  routes/              FastAPI 라우터 10개 (JSON API + 페이지)
  templates/           Jinja2 템플릿
  static/css/style.css 4,300줄 단일 스타일시트
  static/js/           15개 스크립트, 모듈 시스템 없이 <script> 순서로 로드
scripts/
  bootstrap_admin.py   최초 관리자 지정 CLI
  demo_records.py      면담 기록 데모 데이터 생성/삭제
```

### 요청 수명주기

```
브라우저
  → CORSMiddleware
  → access_log_middleware        (app/main.py) — 정적 파일 제외, 백그라운드로 1행 기록
  → 라우터 매칭
      /api/**   → JSON 라우터 → service → app.db 컬렉션 핸들 → MongoDB
      그 외      → page_routes → Jinja 템플릿 (껍데기만) 
  → 예외 핸들러 (422 / 404 / 500)
```

**페이지는 대체로 껍데기만 렌더링합니다.** `page_routes.py`는 HTML과 `window.*_CONFIG` JSON 한 덩어리를 내려주고, 실제 데이터는 JS가 `/api/...`로 다시 가져옵니다.

각 페이지의 전역 config 변수:

| 페이지 | 전역 변수 | 내용 |
|---|---|---|
| `/e/{id}`, `/g/{id}` | `window.COMMEET_EVENT_CONFIG` | `eventId`, `isGroup`, `currentUser`, `currentUserEmail`, `googleCalendarEnabled` |
| `/e/{id}/finalize` | `window.COMMEET_FINALIZE` | + `timeIncrement`, `durationHours`, **`finalization` 전체** |
| `/calendar` | `window.COMMEET_CALENDAR` | `userId` |
| `/e/{id}`, `/g/{id}` | `window.RECORDS_CONFIG` | `feeRates`, `professorName` (면담 기록 폼용) |

예외가 둘 있습니다:

- **`/e/{id}/finalize`** — 확정 데이터(`finalization`)를 config에 직접 실어 보냅니다. 확정 화면은 열자마자 기존 배정을 복원해야 하기 때문입니다(§8.6).
- **`/records/{id}/print`** — 신청서 전체를 서버에서 렌더링합니다. 인쇄는 fetch 깜빡임 없이 완성된 페이지여야 하므로 유일하게 완전 SSR입니다.

---

## 2. 기반 계층 (core / db / main)

### 2.1 `app/config.py`

`load_dotenv()` 후 모듈 최상위에서 상수를 만듭니다. **import 시점에 1회 평가**되므로 `.env`를 바꾸면 서버 재시작이 필요합니다.

파생 플래그 두 개가 앱 전체의 기능 토글 역할을 합니다:

```python
# 명시적 스위치 AND 자격증명 존재
GOOGLE_CALENDAR_ENABLED = _bool("GOOGLE_CALENDAR_ENABLED", "true") and bool(
    GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
)

if MAIL_BACKEND == "postech":
    MAIL_SENDER = MAIL_SENDER or "commeet@postech.ac.kr"
    MAIL_ENABLED = True  # 릴레이가 IP로 인증하므로 자격증명 불필요
else:
    MAIL_ENABLED = bool(MAIL_SENDER and MAIL_PASSWORD)
```

미설정이 곧 "그 기능 없이 동작"을 의미합니다. Google 자격증명이 없으면 연동 버튼이 사라지고, 메일이 없으면 인증 코드가 콘솔에 찍힙니다. 어느 쪽도 앱을 죽이지 않습니다.

### 2.2 `app/core/templates.py` — `asset()`

```python
def asset(path: str) -> str:
    version = int((STATIC_DIR / path.lstrip("/")).stat().st_mtime)
    return f"/static/{path.lstrip('/')}?v={version}"
```

`StaticFiles`는 `Cache-Control` 헤더를 보내지 않습니다. 그러면 브라우저가 휴리스틱 캐싱을 하면서 재검증조차 건너뛰기 때문에, CSS/JS를 고쳐도 하드 리프레시 전까지 반영되지 않습니다. mtime을 쿼리로 붙여 URL 자체를 바꾸는 것으로 해결합니다.

Jinja 전역변수: `APP_NAME`, `APP_FULL_NAME`, `GOOGLE_CALENDAR_ENABLED`, `ALLOWED_EMAIL_DOMAIN`, `RESTRICT_SIGNUP_DOMAIN`, `SUPPORT_EMAIL`, `PROFESSOR_EMAIL`, `asset`.

### 2.3 `app/core/security.py`

- **비밀번호**: `bcrypt.hashpw` / `checkpw`. `checkpw`는 잘못된 해시 형식에 `ValueError`를 던지므로 감싸서 `False` 반환.
- **세션**: `URLSafeTimedSerializer(SESSION_SECRET, salt="commeet-session")`. 쿠키가 곧 진실의 원천이고 **서버 측 세션 저장소가 없습니다.** 즉 `SESSION_SECRET`을 바꾸면 전원 로그아웃됩니다.
- **OTP**: 코드는 절대 평문 저장하지 않고 `sha256(f"{email}|{code}|{SESSION_SECRET}")`만 저장. 검증은 `secrets.compare_digest`로 타이밍 세이프.

### 2.4 `app/core/ids.py`

```python
_SHORT_ID_ALPHABET = "23456789ABCDEFabcdef"  # 0/O, 1/l/I 제외
_SHORT_ID_LENGTH = 5
```

혼동되는 글자를 뺀 5글자 공유용 ID. `event_service.generate_unique_short_id()`가 충돌 시 재시도합니다.

`get_event_by_either_id()`는 **길이로 분기**합니다:

```python
if len(event_id) <= 10:
    return await get_event_by_short_id(event_id)  # 5글자 short id
return await get_event_by_id(event_id)  # 24자리 ObjectId hex
```

덕분에 `/e/aB3f9`와 `/e/6a8d...`가 같은 라우트로 동작합니다.

### 2.5 `app/core/serialize.py`

```python
def jsonable(value):   # dict/list 재귀
    ObjectId  → str
    datetime  → isoformat().replace("+00:00", "Z")
```

**모든 API 응답은 이 함수를 거칩니다.** 여기서 나오는 `...Z` 형식과 JS의 `toISOString()`이 만드는 `...000Z` 형식이 다르다는 점이 프런트에서 몇 번 문제를 일으켰고, 그래서 타임스탬프 비교는 항상 epoch ms로 합니다 (§5.2, §8.4).

### 2.6 `app/db/`

`mongo.py`가 **연결을 여는 유일한 곳**이고, `__init__.py`가 컬렉션 핸들을 한 번씩만 선언합니다. 다른 모듈은 `from app.db import events_col` 식으로만 접근합니다 — 두 번째 클라이언트를 만드는 코드는 없습니다.

`create_indexes()`는 앱 시작 시(`@app.on_event("startup")`) 실행되며 인덱스를 선언적으로 보장합니다. TTL 인덱스 두 개가 자동 정리를 담당합니다:

```python
await pending_signups_col.create_index(
    "expiresAt", expireAfterSeconds=0
)  # 만료된 가입 대기
await access_logs_col.create_index(
    "ts", expireAfterSeconds=60 * 24 * 3600
)  # 60일 지난 접속 로그
```

### 2.7 `app/main.py`

**접속 로그 미들웨어**:

```python
@app.middleware("http")
async def access_log_middleware(request, call_next):
    if not access_log_service.should_log(path):  # /static/ 제외
        return await call_next(request)
    start = time.monotonic()
    response = await call_next(request)
    ...
    asyncio.create_task(access_log_service.record_request(...))  # 응답을 막지 않음
    return response
```

`asyncio.create_task`로 던져두므로 로그 기록이 응답 지연에 포함되지 않습니다. 사용자 식별은 `read_session_token()`으로 쿠키만 검증 — DB 조회 없이 ID만 꺼냅니다.

**예외 핸들러**:
- `RequestValidationError` → 422, 단 `error.pop("input")`으로 **입력값을 응답에서 제거** (비밀번호가 검증 에러에 실려 나가는 것 방지).
- 404/500 → `/api`로 시작하면 JSON, 아니면 에러 페이지 템플릿.

라우터 등록 순서: page, auth, event, finalize, folder, user, user_public, calendar, contact, **record**, admin.

---

## 3. 인증과 계정

**파일**: `app/services/auth_service.py`, `app/routes/auth_routes.py`, `app/schemas/auth.py`, `app/static/js/auth.js`, `app/templates/auth/sign_in.html`

### 3.1 2단계 가입

원본 timeful.app의 Google OAuth 대신 이메일+비밀번호를 쓰고, 메일 인증을 붙였습니다.

**1단계 — `POST /api/auth/signup/send-code`** → `start_signup()`

```python
if not is_allowed_email(email):  raise EmailDomainNotAllowed()
if await get_user_by_email(email): raise EmailAlreadyRegistered()

code = generate_otp_code()                    # 6자리
await pending_signups_col.update_one({"email": email}, {"$set": {
    "email", "name",
    "passwordHash": hash_password(password),  # 이 시점에 이미 해싱
    "codeHash": hash_otp_code(email, code),   # 코드 평문은 저장 안 함
    "expiresAt": now + 10분,
    "tries": 0,
}}, upsert=True)
return code                                   # 라우터가 메일로 보냄
```

**계정은 아직 만들어지지 않습니다.** `pending_signups` 컬렉션에만 있고, TTL 인덱스가 만료된 문서를 알아서 지웁니다.

**2단계 — `POST /api/auth/signup/verify`** → `verify_signup()`

```python
pending = await pending_signups_col.find_one({"email": email, "expiresAt": {"$gt": now}})
if not pending:                       raise VerificationExpired()
if pending["tries"] >= 5:  삭제 후    raise VerificationTooManyAttempts()
if not verify_otp_code(...):  tries += 1;  raise VerificationCodeInvalid()
# 통과 → pending 삭제 → users_col.insert_one(...)
```

시도 횟수 초과 시 pending 문서를 **삭제**합니다 — 코드를 새로 요청해야만 재시도할 수 있게 만드는 것이 무차별 대입 방어입니다.

`RESTRICT_SIGNUP_DOMAIN=false`로 두면 `is_allowed_email()`이 항상 통과하고 도메인 제한 없이 가입 가능합니다. **메일 인증은 어느 쪽이든 항상 적용됩니다.**

### 3.2 세션

```python
def set_session_cookie(response, user_id):
    response.set_cookie(
        SESSION_COOKIE_NAME,
        create_session_token(str(user_id)),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
    )
```

`httponly` — JS에서 읽을 수 없음. `samesite="lax"` — Google OAuth 콜백 리다이렉트가 쿠키를 유지할 수 있는 최소 수준.

의존성 3종:
- `get_optional_user()` — 없으면 `None` (공개 페이지)
- `require_user()` — 없으면 401
- `require_admin()` — `isAdmin` 아니면 403

### 3.3 프로필과 계정 삭제

`GET /api/user/profile` (`user_routes.py`)은 `calendarAccounts`를 내보낼 때 **`oauth` 키를 제거**하고 대신 계산 필드 하나를 붙입니다:

```python
"hasWriteScope": "calendar.events" in ((account.get("oauth") or {}).get("scope") or "")
```

토큰은 절대 클라이언트로 나가지 않지만, "이 계정은 쓰기 권한이 있는가"는 UI가 알아야 하기 때문입니다 (재연결 안내 표시용).

계정 삭제(`DELETE /api/user`)는 확인용으로 **이메일을 다시 입력**받아 일치할 때만 진행합니다.

---

## 4. 일정(Event) 생성·수정·삭제

**파일**: `app/services/event_service.py`, `app/routes/event_routes.py`, `app/schemas/event.py`, `app/static/js/new-event.js`, `app/templates/partials/new_event_dialog.html`

### 4.1 세 가지 이벤트 타입

`EventType` enum (`schemas/event.py`):

| 값 | 의미 | `dates` 필드의 뜻 |
|---|---|---|
| `specific_dates` | 특정 날짜 투표 | 실제 달력 날짜 |
| `dow` | 요일 반복 | **기준 주(reference week)** 날짜 |
| `group` | 초대 전용 반복 주간 | **기준 주** 날짜 |

### 4.2 기준 주(reference week) 트릭

요일 기반 일정을 저장할 때 서버가 "요일"이라는 개념을 전혀 몰라도 되게 만든 장치입니다.

`new-event.js`:

```js
const REF_SUNDAY = new Date(2024, 0, 7);   // 실제로 일요일

// 요일 N → REF_SUNDAY + N일
for (const idx of state.selectedDow) {
  const ref = new Date(REF_SUNDAY);
  ref.setDate(ref.getDate() + idx);
  dates.push(combine(ref, startVal).toISOString());
}
```

서버는 그냥 날짜 목록으로 저장합니다. 표시할 때 `event-grid.js`가 다시 실제 주로 투영합니다:

```js
function projectToWeek(refDate, weekOffset) {
  const sunday = thisWeekSunday(weekOffset);
  const result = new Date(sunday);
  result.setDate(result.getDate() + dayDiffFromRefSunday(refDate));  // 요일 오프셋만 보존
  result.setHours(refDate.getHours(), refDate.getMinutes(), 0, 0);
  return result;
}
```

> ⚠️ `REF_SUNDAY` 상수는 `new-event.js`와 `event-grid.js` **양쪽에 각각 선언**되어 있습니다. 한쪽만 바꾸면 기존 요일 일정이 전부 어긋납니다. 두 파일 모두 주석으로 표시해 두었습니다.

### 4.3 생성

`create_event()`는 문서를 넣고 `shortId`를 부여한 뒤 타입에 따라 갈립니다:

- **group**: `attendees_col`에 초대 명단을 `upsert` (소유자 포함) + 각자에게 초대 메일
- **그 외**: `remindees` 배열을 이벤트 문서에 저장 + 초대 메일

`$setOnInsert: {"declined": False}`를 쓰는 이유는 이미 거절한 사람을 재초대해도 거절 상태가 되살아나지 않게 하기 위해서입니다.

### 4.4 수정

`update_event()`에서 group 타입은 명단 diff를 계산합니다:

```python
added = new_emails - existing_emails
removed = existing_emails - new_emails

for email in removed:
    attendees_col.delete_one(...)
    # 가입자였다면 그 사람의 응답도 지우고 numResponses를 감소
```

소유자 이메일은 항상 `new_emails`에 강제로 넣어 스스로를 그룹에서 제외하는 사고를 막습니다.

### 4.5 삭제 — 소프트/하드 두 갈래

```python
async def delete_event(event, requester):
    responses = await get_event_responses(event["_id"])
    has_other_responses = any(r["userId"] != str(requester["_id"]) for r in responses)
    synced = (event.get("finalization") or {}).get("googleSyncedEvents")

    if has_other_responses:
        # 남의 데이터가 섞여 있음 → 숨기기만
        update = {"isDeleted": True}
        if synced is not None:
            update["finalization.googleSyncedEvents"] = (
                calendar_service.clear_synced_events_detached(synced, only_future=True)
            )
        await events_col.update_one({"_id": ...}, {"$set": update})
    else:
        calendar_service.clear_synced_events_detached(synced, only_future=True)
        await events_col.delete_one(...)
        await event_responses_col.delete_many({"eventId": ...})
        await attendees_col.delete_many({"eventId": ...})
        await folder_events_col.delete_many({"eventId": ...})
```

**두 가지가 중요합니다:**

1. **소프트 삭제 분기도 Google 정리를 합니다.** 예전에는 이 분기가 정리를 건너뛰어서, 남이 응답한 방을 지우면 구글 캘린더에 일정이 그대로 남았습니다.
2. **`only_future=True`** — 이미 지난 면담은 실제 히스토리이므로 캘린더에서 지우지 않고, 앞으로 열릴 약속만 제거합니다. §9.5 참조.

조회 함수(`get_event_by_id` 등)는 전부 `{"isDeleted": {"$ne": True}}`를 걸고 있어 소프트 삭제된 방은 보이지 않습니다.

### 4.5b 휴지통 (`/trash`)

> ⚠️ `isDeleted`와 `isArchived`는 **완전히 다른 플래그**입니다. 삭제는 `isDeleted`를 세우고, 대시보드의 "보관됨" 폴더는 `isArchived`를 봅니다. 한동안 삭제 확인창이 "안전하게 보관 처리됩니다"라고 안내했지만 그 일정은 **어디에서도 볼 수 없었습니다** — 모든 조회가 `isDeleted`를 거르기 때문입니다.

그래서 소프트 삭제된 내 일정을 보는 전용 페이지를 뒀습니다.

| | |
|---|---|
| `GET /api/user/deleted-events` | 내 휴지통 목록 (응답 수·면담 기록 수 포함) |
| `POST /api/events/{id}/restore` | `isDeleted: False`로 되돌리기 |
| `DELETE /api/events/{id}/purge` | **완전 삭제** |

`purge_event()`가 지우는 것: 일정 문서, `event_responses`, `attendees`, `folder_events`, `meeting_records`와 **그 암호화 첨부 파일**.

```python
# 문서를 지우기 전에 파일부터 - 순서가 반대면 파일 경로를 알 방법이 없어져
# 고아 파일이 남습니다.
for record in records:
    crypto_service.delete_record_files(str(record["_id"]))
```

구글 캘린더는 건드리지 않습니다. `delete_event()`가 이미 앞으로의 약속만 지웠고(§9.5), 지난 약속은 실제로 있었던 일이라 남겨 두는 편이 맞습니다.

접근 경로는 `_deleted_owned_event()`가 `ownerId` + `isDeleted: True`로 함께 조회해, 남의 휴지통이나 살아 있는 일정에는 손댈 수 없습니다.

### 4.5c "취소" vs "삭제", 그리고 참가자에게 알리기

**참가자 입장에서 일정이 사라지면 아무 안내도 없었습니다.** 링크는 그냥 404였고 메일도 나가지 않아, 확정된 면담을 기다리던 사람은 링크가 죽은 것만 봤습니다. 두 가지를 붙였습니다.

**1) 링크를 누르면 이유를 알려 줍니다.** `get_removed_event()`가 `isDeleted: True` 문서까지 찾아 `errors/removed_event.html`을 **410 Gone**으로 렌더합니다(존재한 적 없는 id는 그대로 404). 이름과 주최자만 쓰고 응답 내용은 노출하지 않습니다.

**2) 취소 안내 메일.** `delete_event(..., notify=True)`가 `send_many_detached()`로 보냅니다. 대상은 응답자 전원 + (그룹이면) 초대만 받고 아직 응답하지 않은 사람이며, **주최자 본인은 뺍니다**. 삭제 다이얼로그의 체크박스로 끌 수 있습니다(시험용 일정 등). 휴지통에서 되돌릴 때는 `restore_event(..., notify=True)`로 "다시 열렸습니다" 정정 안내를 보낼 수 있습니다.

**"취소"와 "삭제"는 다른 말입니다.**

```python
def is_past_event(event) -> bool:
    # dow / group은 dates가 기준 주라 지난 일정 개념이 없습니다 (§4.2)
    if event["type"] in (DOW, GROUP): return False
    return max(dates) + duration < now

def removal_word(event) -> str:
    return "삭제" if is_past_event(event) else "취소"
```

지난 일정을 두고 "취소되었습니다"라고 하면 오지 않아도 될 사람이 놀라고, 앞으로의 일정을 "삭제"라고 하면 약속이 없어졌다는 사실이 전달되지 않습니다. 이 단어가 **버튼·다이얼로그·메일 제목과 본문·휴지통 배지·안내 페이지**에 일관되게 쓰입니다. 클라이언트에도 같은 규칙의 `isPastEvent()`가 있어 서버와 표현이 어긋나지 않습니다.

### 4.6 복제

```python
new_event = {
    k: v
    for k, v in event.items()
    if k not in {"_id", "shortId", "numResponses", "remindees", "createdAt"}
}
```

블랙리스트 방식이라 **`finalization`도 함께 복사됩니다.** 확정된 일정을 복제하면 확정 상태까지 딸려온다는 뜻입니다. (`copyAvailability`가 켜져 있으면 응답까지 복사.)

---

## 5. 가용시간 응답과 히트맵 그리드

**파일**: `app/static/js/event-grid.js` (1,247줄 — 앱에서 가장 큰 파일), `app/templates/partials/event_page_body.html`, `app/static/css/style.css` §Event page

`/e/{id}`(일반)와 `/g/{id}`(그룹)가 같은 스크립트를 씁니다. 차이는 `window.COMMEET_EVENT_CONFIG.isGroup` 플래그 하나입니다.

### 5.1 상태 객체 `ST`

전역 상태를 객체 하나에 모읍니다:

```js
const ST = {
  event, dayColumns, slotCount, startHour,
  responsesFull,        // userKey -> {availability:[iso], ifNeeded:[iso], user}
  responseSets,         // userKey -> {available: Set<slotKey>, ifNeeded: Set<slotKey>}
  weekOffset, editing, editTool, ownMarks,
  cellGrid,             // [row][col] -> DOM element (사각형 드래그용)
  dragging, dragValue, dragAnchor, dragBase,
  selectedRespondents, showBestTimes, hideIfNeeded,
  viewerKey, guestName, isOwner,
};
```

### 5.2 슬롯 키 — epoch ms

```js
/* 절대로 타임스탬프를 문자열로 비교하지 말 것: 서버는 "...T09:00:00Z"를,
   JS toISOString()은 "...T09:00:00.000Z"를 만든다. 양쪽이 동의하는 표현은 epoch ms뿐. */
function slotKey(value) { return String(new Date(value).getTime()); }
```

이 규칙이 그리드 전체의 기반입니다. 응답을 불러오면 즉시 `Set`으로 인덱싱합니다:

```js
ST.responseSets[key] = {
  available: new Set((resp.availability || []).map(slotKey)),
  ifNeeded:  new Set((resp.ifNeeded || []).map(slotKey)),
};
```

셀마다 전체 타임스탬프 배열을 선형 스캔하는 대신 `Set.has()` 한 번으로 끝내기 위함입니다.

### 5.3 히트맵 렌더링 — `renderGridCells()`

셀 색상은 **네 가지 모드** 중 하나로 결정됩니다 (우선순위 순):

1. **편집 중** — 내 마크(`ownMarks`)만 표시
2. **응답자 선택 중** — 선택된 사람들의 합집합만 표시
3. **최적 시간만 보기** — 최대 인원 셀만 진한 원색, 나머지는 `.dim`
4. **기본 히트맵**:

```js
const totalRespondents = Math.max(1, Object.keys(ST.responsesFull).length);
if (available > 0) {
  const opacity = 0.18 + 0.82 * (available / totalRespondents);
  cell.style.background = `rgba(200, 1, 80, ${opacity.toFixed(2)})`;   // 크림슨
} else if (ifNeeded > 0) {
  const opacity = 0.25 + 0.6 * (ifNeeded / totalRespondents);
  cell.style.background = `rgba(245, 195, 68, ${opacity.toFixed(2)})`; // 노랑
}
```

`countsForCell()`에서 `else if`를 쓰는 게 핵심입니다 — 한 사람이 "가능"이면 그 사람의 "가능(선택)"은 세지 않습니다.

**"가능" vs "가능(선택)"**: 전자는 확실히 참석 가능, 후자는 필요하면 맞출 수 있음. 최적 시간 계산과 "최적 시간만 보기"에는 **"가능"만** 집계됩니다. 이 구분은 확정 알고리즘의 비용 함수(§8.2)로 그대로 이어집니다.

### 5.4 드래그 페인팅 — 사각형 선택

Pointer Events 기반이라 마우스와 터치가 같은 코드로 동작합니다.

```js
grid.addEventListener("pointerdown", (e) => {
  // 이미 현재 도구로 칠해진 셀에서 시작하면 → 지우기 모드
  ST.dragValue = ST.ownMarks[cell.dataset.slot] === ST.editTool ? null : ST.editTool;
  ST.dragAnchor = {row, col};
  ST.dragBase = { ...ST.ownMarks };   // 드래그 시작 시점 스냅샷
  grid.setPointerCapture(e.pointerId);
});
```

`pointermove`에서 **셀별 `pointerover`를 쓰지 않는 이유**:

```js
// 셀마다 pointerover를 기다리면 브라우저의 포인터 샘플링 속도만큼만 발생해서,
// 빠르게 드래그하면 중간 타일을 건너뛴다.
const target = document.elementFromPoint(e.clientX, e.clientY);
const cell = target?.closest(".grid-cell");
```

`paintDragRect()`는 매번 **스냅샷(`dragBase`)에서 다시 계산**합니다:

```js
ST.ownMarks = { ...ST.dragBase };
for (let r = rowStart; r <= rowEnd; r++)
  for (let c = colStart; c <= colEnd; c++)
    if (ST.dragValue) ST.ownMarks[slot] = ST.dragValue;
    else delete ST.ownMarks[slot];
```

누적 방식이 아니라 재계산이라, 사각형을 다시 줄이면 벗어난 셀이 제대로 해제됩니다.

### 5.5 세로 크기 모델 — 시간당 60px

timeful.app의 모델을 그대로 채택했습니다.

```js
const HOUR_HEIGHT = 60;          // 데스크톱: 1시간 = 60px
const HOUR_HEIGHT_MOBILE = 44;   // 모바일은 더 촘촘하게
const MOBILE_GRID_BREAKPOINT = 768;

function syncCalendarHeight() {
  const increment = ST.event.timeIncrement || 15;
  const hourH = window.innerWidth <= MOBILE_GRID_BREAKPOINT ? HOUR_HEIGHT_MOBILE : HOUR_HEIGHT;
  grid.style.setProperty("--grid-row-h", `${(hourH * increment) / 60}px`);
  scroll.style.maxHeight = "";   // 페이지에서는 절대 높이를 제한하지 않음
}
```

즉 **행 높이 = 시간 증분**입니다. 15분 행은 15px, 60분 행은 60px. 예전의 "행마다 무조건 16px" 방식은 15분 단위 8시간 일정이 30분 단위 같은 일정보다 두 배 길어지는 문제가 있었습니다.

캘린더가 페이지의 주인공이므로 **내부 스크롤을 만들지 않고** 페이지 자체가 길어집니다. 대신 응답자 사이드바가 캘린더 높이를 따라가고(`syncRespondentListHeight`), 명단이 넘치면 사이드바만 내부 스크롤합니다.

> 측정 대상은 `.grid-scroll`이지 그것을 감싸는 래퍼가 아닙니다. 래퍼는 flex로 늘어나 있어서 측정하면 순환 참조가 됩니다.

### 5.6 게스트 응답

로그인 없이도 응답할 수 있습니다. 게스트의 **`userId` 키는 그가 입력한 이름 문자열 그 자체**입니다:

```python
if payload.guest:
    user_key = payload.name
    response = {"name": ..., "email": ..., "userId": None, "availability": ..., "ifNeeded": ...}
else:
    user_key = str(requester["_id"])
    response = {"userId": requester["_id"], ...}
```

이 **다형적 키**(24자리 hex 또는 임의 이름 문자열)가 앱 전체에 퍼져 있습니다 — 확정 배정(§8), 캘린더 참여자 이름 해석(§10), 면담 기록 참석자(§16) 모두 이 키를 다뤄야 합니다.

브라우저는 게스트 이름을 `localStorage[`pcts_guest_name_${eventId}`]`에 저장해 재방문 시 자기 응답을 인식합니다.

`guest_name_exists()`는 새 게스트 이름이 **기존 사용자의 ObjectId처럼 보이는 경우도** 거부합니다 — 그렇지 않으면 남의 응답을 덮어쓸 수 있습니다.

### 5.7 개인정보 처리 — `_decorate_response()`

응답을 클라이언트로 내보내기 전 반드시 이 함수를 거칩니다:

```python
show_emails = is_owner and bool(event.get("collectEmails"))
```

- 이메일은 **소유자에게만**, 그것도 `collectEmails`가 켜진 경우에만 노출 (그룹은 예외적으로 유지)
- `resp.pop("userId")` — 내부 ObjectId는 항상 제거
- 계정이 삭제된 응답은 `None`을 반환해 목록에서 빠짐
- `include_availability=False`이면 시간표 자체를 빼고 명단만 (`GET /api/events/{id}`가 이 모드; 실제 시간표는 시간 범위를 지정해 별도 호출)

### 5.8 "자세히 보기" 모달 — DOM 재부모화

큰 화면에서 그리드를 보려고 열 때, 그리드를 **복제하지 않고 실제 DOM 노드를 옮깁니다**:

```js
function openGridDetail() {
  gridDetailOriginalParent = layout.parentElement;
  gridDetailOriginalNextSibling = layout.nextElementSibling;
  modalBody.appendChild(layout);          // 같은 노드를 모달 안으로 이동
}
function restoreGridFromDetailView() {
  gridDetailOriginalParent.insertBefore(layout, gridDetailOriginalNextSibling);
}
```

복제하면 이벤트 핸들러와 편집 중 상태가 전부 끊깁니다. 이동하면 같은 라이브 DOM이므로 상태가 그대로 유지됩니다.

**모달 가림 버그 처리**: 초대 다이얼로그와 상세 모달은 같은 스택 레벨의 전체화면 백드롭이라, 상세 모달 위에서 초대창을 열면 상세가 백드롭 뒤로 묻힙니다. 그래서 초대창을 열 때 상세를 **닫지 않고 감추고**(재부모화된 그리드는 그 안에 그대로 둔 채) 플래그를 남깁니다:

```js
gridDetail.classList.remove("open");
gridDetail.dataset.pendingRestore = "1";
// 초대창이 어떤 경로로 닫히든 복원
if (!inviteDialogEl.classList.contains("open") && gridDetailDialog.dataset.pendingRestore) { ... }
```

### 5.9 확정 후 잠금

일정이 확정되면 `isClosed: true`가 되고 응답이 얼어붙습니다. 서버는 `upsert_response`/`delete_response`에서 `EventClosed`(409)를 던지고, 클라이언트는 왕복을 줄이려 버튼도 함께 숨깁니다 (`updateRespondBtnVisibility`).

---

## 6. 그룹(Group) 일정

그룹은 세 가지가 다릅니다.

**1) 접근 제어** — `event_routes._check_group_access()`:

```python
if event["type"] != "group":
    return  # 일반 이벤트는 링크만 있으면 누구나
if not viewer:
    raise HTTPException(401)
if event.get("ownerId") == viewer["_id"]:
    return
attendees = await get_attendees(event["_id"])
if any(a["email"] == viewer["email"] for a in attendees):
    return
raise HTTPException(403)
```

일반 이벤트는 링크 공유 방식이지만 그룹은 **초대 명단 기반**입니다. 그래서 `POST /api/events/{id}/invite`가 그룹일 때는 메일 발송과 함께 `add_attendee()`로 접근 권한도 부여합니다.

**2) 주 단위 페이징** — 기준 주에 저장되므로 `changeWeek(delta)`로 `ST.weekOffset`을 바꿔 앞뒤 주를 볼 수 있습니다. 응답은 `manualAvailability`(날짜별 개별 지정)로 특정 주만 다르게 저장할 수 있고, 이 필드는 **머지 방식**으로 갱신됩니다:

```python
manual = dict((existing or {}).get("response", {}).get("manualAvailability") or {})
if payload.manualAvailability:
    manual.update(payload.manualAvailability)
```

**3) 캘린더 오버레이** — `GET /api/events/{id}/calendar-availabilities`가 그룹 멤버들의 구글 캘린더 바쁜 시간을 겹쳐 보여줍니다. 남의 일정 제목은 반드시 가려집니다:

```python
if user_key != str(viewer["_id"]):
    calendar_event = {**calendar_event, "summary": "BUSY"}
```

---

## 7. 비공개 응답 (blind availability)

이벤트 옵션 `blindAvailabilityEnabled`. 켜면 **소유자만 전체를 보고, 나머지는 자기 응답만** 봅니다.

`event_service.apply_blind_filter()`:

```python
if not event.get("blindAvailabilityEnabled") or is_owner:
    return responses_map  # 그대로
if viewer:
    key = str(viewer["_id"])
    return {key: responses_map[key]} if key in responses_map else {}
if guest_name and guest_name in responses_map:
    return {guest_name: responses_map[guest_name]}
return {}
```

추가로 `GET /api/events/{id}`가 소유자가 아닐 때 응답 수까지 감춥니다:

```python
if event.get("blindAvailabilityEnabled") and not is_owner:
    result["numResponses"] = None
    result["remindees"] = None
```

그리고 비공개 모드에서는 **로그인한 사람이 게스트로 대리 응답하는 것**을 막습니다 (`BlindAvailabilityViolation`) — 아니면 남의 이름으로 응답을 만들어 다른 사람의 답을 엿볼 수 있기 때문입니다. 소유자는 예외입니다.

---

## 8. 일정 확정과 최적 배정 알고리즘

**파일**: `app/services/scheduling.py` (알고리즘), `app/services/finalize_service.py` (오케스트레이션), `app/routes/finalize_routes.py`, `app/static/js/finalize.js`, `app/templates/event/finalize.html`

이 앱에서 알고리즘적으로 가장 무거운 부분입니다.

### 8.1 문제 정의

호스트는 **모든 면담에 참석**합니다. 따라서 두 면담이 겹치면 안 됩니다. 그래서 각 날짜를 면담 길이만큼의 **연속된 블록**으로 자릅니다 — 이러면 어떤 블록 조합을 골라도 호스트 기준으로 충돌이 없습니다.

```python
def build_slots(day_starts, window_hours, meeting_minutes):
    for day_start in sorted(day_starts):
        window_end = day_start + timedelta(hours=window_hours)
        cursor = day_start
        while cursor + length <= window_end:
            slots.append((cursor, cursor + length))
            cursor += length
```

그 다음 "응답자를 블록에 배정"하는 문제는 **차수 제한 이분 매칭(b-matching)** 과 정확히 같아지고, 이를 **최소비용 최대유량(min-cost max-flow)** 으로 최적해를 구합니다.

- **최대 유량** → 배정 가능한 인원을 최대화
- **최소 비용** → 그 중에서도 "가능"을 "가능(선택)"보다 선호하고, 이른 블록을 선호

### 8.2 비용 설계

```python
COST_AVAILABLE = 0
COST_IF_NEEDED = 1_000_000
COST_SLOT_TIEBREAK = 1
```

간선 비용은 `cost + j * COST_SLOT_TIEBREAK` (j = 슬롯 인덱스). 타이브레이크가 1인 이유가 중요합니다: **모든 슬롯의 타이브레이크를 다 합쳐도 "가능(선택)" 한 번의 비용을 넘을 수 없어야** 합니다. 그래야 "이른 시간 선호"가 "가능 우선"을 절대 뒤집지 않습니다.

### 8.3 유량 네트워크

```
source → (용량 1, 비용 0)         → 각 참가자        # 한 사람은 최대 한 블록
참가자 → (용량 1, 비용=위 공식)    → 참석 가능한 블록  # 불가능한 블록은 간선 자체가 없음
블록   → (용량 capacity, 비용 0)  → sink            # 블록당 정원
```

구현은 `_MinCostMaxFlow` — **Johnson 포텐셜을 쓴 연속 최단경로법**(Dijkstra + 포텐셜). 음수 비용 간선(역방향)이 생겨도 Dijkstra를 쓸 수 있게 해줍니다. 복잡도는 O(F·E log V), F = 응답자 수. 수십 명 / 수백 블록 수준에서는 밀리초 단위입니다.

결과 읽기가 미묘합니다:

```python
# 단위 용량 간선의 잔여 용량이 0 = 유량이 흐름
if flow.graph[participant_node(i)][edge_index][1] == 0:
    meetings.setdefault(j, []).append(key)
```

남은 용량으로 역추론하지 않고 간선 위치를 미리 기억(`choice_edges`)해 두었다가 직접 읽습니다.

### 8.4 제안 생성 — `build_proposal()`

```python
# 호스트가 못 오는 블록은 아예 후보에서 제외
if host_response:
    host_ticks = set(host_response["availability"])
    if allow_if_needed:
        host_ticks |= set(host_response["ifNeeded"])
    usable = [s for s in all_slots if covers_slot(host_ticks, s[0], s[1], increment)]

# 각 참가자가 각 블록을 커버하는지 판정
for index, (start, end) in enumerate(usable):
    if covers_slot(p["availability"], start, end, increment):
        firm.add(index)
    elif allow_if_needed and covers_slot(p["availability"] | p["ifNeeded"], ...):
        soft.add(index)
```

`covers_slot()`은 블록 안의 **모든 그리드 틱**이 칠해져 있어야 True입니다 — 30분 블록에 15분만 칠했으면 참석 불가로 봅니다.

응답은 `slots[].eligible`(각 블록에 올 수 있는 사람 키 목록)까지 함께 내려줍니다. 프런트가 드래그 유효성을 서버 왕복 없이 판정하기 위해서입니다.

### 8.5 프런트엔드 — 드래그로 손보기

`finalize.js`는 배정을 `choice = {참가자키: 슬롯시작ISO | null}` 하나로 표현합니다. 드롭 종류가 세 가지입니다 (`dropTargetAt`):

- **미배정 트레이** → `choice[key] = null`
- **빈 셀** → `slot.eligible.includes(key)`일 때만 이동
- **다른 사람의 칩** → `resolveChipSwap()`

```js
const iCanTakeTheirs  = theirSlotObj && theirSlotObj.eligible.includes(draggedKey);
const theyCanTakeMine = !mySlotObj || mySlotObj.eligible.includes(otherKey);
return { ok: Boolean(iCanTakeTheirs && theyCanTakeMine), ... };
```

즉 **양쪽 모두 상대 시간에 참석 가능해야** 교환이 성립합니다. 단, 드래그한 사람이 트레이에서 왔다면(`mySlotObj === null`) 넘겨받기(take-over)가 되어 상대가 미배정으로 밀려납니다.

트레이가 칩보다 우선하는 것도 의도된 규칙입니다 — 미배정 카드 위에 떨어뜨려도 "교환"이 아니라 "미배정"입니다.

### 8.6 확정된 배정 복원

이미 확정된 일정을 다시 열면, 새로 최적화하지 않고 저장된 배정을 복원해야 합니다. 여기서 §2.5의 ISO 형식 차이 문제가 다시 등장합니다:

```js
// 페이지 로드 시 받은 payload와 방금 API가 준 응답의 ISO 표기가 미묘하게 달라도
// 호스트의 확정 배정이 조용히 사라지지 않도록, epoch로 다시 키를 맞춘다.
const slotByTime = new Map(proposal.slots.map((s) => [timeKey(s.start), s.start]));
stored.forEach((m) => {
  const canonicalStart = slotByTime.get(timeKey(m.start));
  (m.participants || []).forEach((key) => { choice[key] = canonicalStart || null; });
});
```

### 8.7 확정 — `confirm()`

검증 순서:

1. 면담 길이가 그리드 증분의 배수인지
2. 한 면담 인원이 정원 이하인지
3. 응답자 목록에 없는 사람이 섞이지 않았는지
4. **한 사람이 두 번 배정되지 않았는지**
5. 정렬 후 `pairwise`로 **면담 시간 겹침 검사** (호스트가 동시에 두 곳에 있을 수 없음)

저장되는 `finalization` 서브도큐먼트:

```python
{
    "status": "confirmed",
    "capacity": int,
    "meetingMinutes": int,
    "meetings": [
        {"start": dt, "end": dt, "participants": [key, ...]}
    ],  # 호스트는 미포함
    "unassigned": [key, ...],
    "confirmedAt": dt,
    "confirmedBy": ObjectId,
    "googleSyncedEvents": [...],  # §9.4
}
```

> **주의**: `meetings[]`의 각 항목에는 **고유 id가 없습니다.** 그리고 `confirm()`은 서브도큐먼트 전체를 통째로 교체합니다. 그래서 면담 기록(§16)은 `(eventId, meetingStart)`를 키로 삼습니다 — 시작 시각이 유일하게 안정적인 손잡이입니다.

### 8.8 재확정 — 바뀐 사람에게만 알리기

한 명의 시간을 옮겼는데 전원에게 "일정이 변경되었습니다"가 가면, 받는 사람은 자기 일정이 바뀐 줄 알고 다시 확인해야 합니다. 그래서 재확정 시에는 **이전 확정본과 비교해 실제로 달라진 사람에게만** 보냅니다.

비교 기준은 `_booking_by_key()`가 만드는 참가자별 `(시작시각, 같은 약속의 다른 사람들)` 튜플입니다.

```python
if previous is not None and before.get(key) == after.get(key):
    continue  # 이 사람 예약은 그대로 - 보내지 않음
```

**같이 오는 사람까지 비교에 넣은 이유**: 시간이 그대로여도 1:1이던 약속에 다른 사람이 들어오면 그 사람에게도 달라진 약속입니다. 알리지 않으면 예상과 다른 자리에 앉게 됩니다. 대신 정원이 2명 이상인 일정에서는 한 명을 옮겨도 그가 떠난 약속과 합류한 약속의 동석자들이 함께 대상이 됩니다(1:1 면담에서는 동석자가 없어 "옮긴 사람만"과 같습니다).

메일 종류도 상태에 맞춰 갈립니다 — 원래 배정이 있던 사람에게만 "변경" 안내가 가고, 새로 들어온 사람은 첫 확정 안내를 받습니다. 계속 미배정인 사람에게는 다시 보내지 않습니다.

**화면에도 같은 규칙으로 표시합니다.** 확정 화면 상단의 "확정 이후 바뀐 배정" 패널(`renderChangeSummary`)이 이름·변경 종류(시간 변경 / 배정 해제 / 새로 배정 / 함께하는 사람 변경)·이전→이후 시각을 보여 주고, 확정 확인창에도 대상 이름을 나열합니다. 클라이언트의 `bookingByKey()`는 서버 `_booking_by_key()`와 같은 규칙이라 **화면에 표시된 사람과 실제 수신자가 일치합니다.**

---

## 9. Google Calendar 연동

**파일**: `app/services/calendar_service.py` (700줄), `app/routes/calendar_routes.py`

전부 **선택 기능**입니다. `GOOGLE_CALENDAR_ENABLED`가 꺼져 있으면 읽기는 빈 결과를, 쓰기는 `None`을 반환하고 앱은 정상 동작합니다.

### 9.0 전체 끄기

`.env`의 `GOOGLE_CALENDAR_ENABLED=false`(또는 자격증명 미설정)면 **기능이 멈추는 데서 그치지 않고 관련 UI가 화면에서 사라집니다.** 쓰지 않는 기능의 버튼과 안내가 남아 있으면 그것도 설명해야 할 대상이 되기 때문입니다.

| 위치 | 꺼졌을 때 |
|---|---|
| `/calendar` | "Google Calendar 설정" 버튼과 모달 전체 제거 |
| `/settings` | "캘린더 연동" 섹션 제거 |
| `/e/{id}` | "캘린더로 자동 채우기" 버튼 숨김 (`ST.googleCalendarEnabled`) |
| 랜딩 · 개인정보처리방침 | Google Calendar 언급 문단 제거 |
| 관리자 사용자 상세 | "Google Calendar" 행 제거 |

**UI에서 감추는 것만으로는 부족합니다.** 주소를 직접 치거나 예전 링크로 들어올 수 있으므로 `calendar_routes._require_enabled()`가 관련 엔드포인트를 전부 **501**로 막습니다 (`connect`, `callback`, 계정 해제/토글, `/api/user/calendars`). `/api/user/profile`도 `calendarAccounts`를 빈 객체로 내보냅니다 — 저장된 계정 정보 자체는 지우지 않아 다시 켜면 그대로 돌아옵니다.

### 9.1 OAuth 흐름

```
GET /calendar/google/connect
  → state = secrets.token_urlsafe(24)  (CSRF 방어)
  → 쿠키 google_oauth_state 저장 (10분, httponly)
  → Google 동의 화면으로 리다이렉트

GET /calendar/google/callback
  → state != 쿠키   → 실패 리다이렉트
  → code → 토큰 교환 → connect_account()
```

스코프 3종과 각각의 이유:

| 스코프 | 용도 |
|---|---|
| `calendar.readonly` | 가용시간 그리드용 바쁜 시간 읽기 |
| `calendar.events` | 확정된 면담을 이벤트로 쓰기 |
| `calendar.calendars` | 전용 "Commeet" 캘린더 생성 |

> 리프레시 토큰은 **처음 동의한 범위 이상을 절대 부여하지 않습니다.** 스코프를 추가한 뒤에는 기존 사용자가 재연결해야 합니다. 그래서 `/api/user/profile`이 `hasWriteScope`를 계산해 내려줍니다 (§3.3).

### 9.2 Mongo 점(dot) 경로 오염 — 두 번 겪은 함정

`user.calendarAccounts`는 이메일을 키로 쓰는 딕셔너리입니다. 그런데 이 키가 `$set` **연산자 키**에 들어갑니다:

```python
await users_col.update_one({"_id": ...}, {"$set": {f"calendarAccounts.{key}": account}})
```

Mongo는 연산자 키를 **항상 점 경로로 파싱**합니다. 이메일에는 점이 반드시 들어가므로(`gmail.com`), 그대로 쓰면 문서가 의도치 않게 여러 단계로 쪼개집니다.

```python
def account_key(email, calendar_type="google"):
    safe_email = email.strip().lower().replace(".", "．")  # 전각 점(U+FF0E)
    return f"{safe_email}_{calendar_type}"
```

**같은 함정이 하위 캘린더에서 또 발생합니다.** 구글 캘린더 ID도 점을 포함합니다(`...@group.calendar.google.com`). 여기는 키를 치환할 수 없으므로 **읽기-수정-쓰기**로 우회합니다:

```python
async def toggle_sub_calendar(user, email, sub_calendar_id, enabled):
    fresh = await users_col.find_one({"_id": ...}, {f"calendarAccounts.{key}": 1})
    account = ...
    account["subCalendars"][sub_calendar_id]["enabled"] = (
        enabled  # 값 안쪽의 평범한 dict 키
    )
    await users_col.update_one(
        {"_id": ...}, {"$set": {f"calendarAccounts.{key}": account}}
    )
```

### 9.3 토큰 갱신

```python
async def _ensure_fresh_account(user, account_key_str, account):
    if expire_at and expire_at > now + timedelta(seconds=30):  # 30초 여유
        return account
    tokens = await refresh_access_token(refresh_token)
    ...
    await users_col.update_one(..., {"$set": {f"calendarAccounts.{key}.oauth": oauth}})
```

갱신 실패 시 예외를 던지지 않고 **원래 계정 객체를 그대로 반환**합니다 — 호출자가 토큰 없음으로 판단해 조용히 건너뛰게 하기 위함입니다.

### 9.4 읽기: 어떤 캘린더를 "바쁜 시간" 후보로 볼 것인가

```python
def _is_real_busy_time_calendar(item):
    if item.get("accessRole") not in ("owner", "writer"):
        return False  # 공휴일 등 구독 캘린더 제외
    if item["id"].startswith("family"):
        return False  # 구글 가족 캘린더 제외
    return item.get("summary") != COMMEET_CALENDAR_SUMMARY  # 자기 자신 제외
```

마지막 조건이 없으면 Commeet이 쓴 일정을 다시 바쁜 시간으로 읽어들이는 되먹임 고리가 생깁니다.

`get_calendar_events()`는 "바쁨" 판정도 합니다:

```python
free = item.get("transparency") == "transparent"  # 명시적 "한가함"
if not free:
    for attendee in item.get("attendees", []):
        if attendee.get("self") and attendee.get("responseStatus") not in (
            "accepted",
            None,
        ):
            free = True  # 내가 수락하지 않은 초대는 바쁜 시간이 아님
```

활성화된 하위 캘린더가 하나도 없으면 계정의 기본 캘린더(= 이메일 주소가 곧 캘린더 ID)로 폴백합니다. 이때 `key`를 역파싱하지 않고 **`fresh["email"]` 필드를 읽습니다** — `account_key()`가 점을 전각으로 바꿔놨기 때문에 키는 유효한 캘린더 ID가 아닙니다.

### 9.5 쓰기: 전용 캘린더 + 삭제 정책

확정된 면담을 사용자의 **기본 캘린더에 섞지 않고** `Commeet`이라는 전용 보조 캘린더를 만들어 거기에만 씁니다 (`create_commeet_calendar`). 구글은 새로 만든 캘린더를 소유자의 캘린더 목록에 자동 추가하므로 별도 `calendarList.insert`가 필요 없습니다.

연결 해제 시에는 캘린더 **전체를 삭제**합니다 — 캘린더를 지우면 안의 이벤트도 함께 사라지므로 이벤트를 하나씩 지울 필요가 없고, 남겨두면 Commeet에서 더 이상 관리할 수 없는 고아 캘린더가 됩니다.

**삭제 정책 — `partition_synced_events()`**:

```python
def partition_synced_events(records, *, only_future=False):
    for rec in records or []:
        start = rec.get("start")
        if only_future and (not isinstance(start, datetime) or start <= now):
            kept.append(rec)  # 이미 지난 면담 = 실제 히스토리, 건드리지 않음
        else:
            to_remove.append(rec)
```

- 방 삭제 → `only_future=True` (지난 면담은 캘린더에 남김)
- 재확정 / 확정 취소 → 전체 삭제 (스케줄 자체가 무효)
- `start`가 없는 오래된 레코드는 보수적으로 **보존**

### 9.6 비동기 삭제와 순차 처리

삭제 버튼을 눌렀을 때 구글 API 왕복 수십 번을 기다리게 하지 않습니다:

```python
def clear_synced_events_detached(records, *, only_future=False):
    to_remove, kept = partition_synced_events(records, only_future=only_future)
    if to_remove:
        _spawn_background(_delete_synced_records(to_remove))
    return kept  # 즉시 반환 (순수 분할 연산)
```

측정 결과 블로킹 방식 대비 **2ms**로 끝납니다.

**`_delete_synced_records()`는 의도적으로 순차 실행**합니다:

```python
# 수십 개를 동시에 던지면 구글 레이트 리미터가 일부를 조용히 떨군다.
# 요청과 분리되어 실행되므로 아무도 기다리지 않는다. 재시도 1회로 일시적 실패를 흡수.
try:
    await delete_calendar_event(token, calendar_id, event_id)
except httpx.HTTPError:
    await asyncio.sleep(1)
    await delete_calendar_event(token, calendar_id, event_id)  # 실패하면 warning 로그
```

동시 실행 시절에는 20개 중 5개가 조용히 남았습니다.

**백그라운드 태스크 강한 참조 유지**:

```python
_background_tasks: set[asyncio.Task] = set()


def _spawn_background(coro):
    task = asyncio.create_task(runner())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
```

asyncio는 실행 중인 태스크를 약한 참조로만 잡으므로, 이렇게 하지 않으면 작업 도중 GC될 수 있습니다.

### 9.7 계정 매칭

```python
def _match_account(user, calendar_id):
    for key, account in (user.get("calendarAccounts") or {}).items():
        if calendar_id in (account.get("email"), account.get("pctsCalendarId")):
            return key, account
```

**이메일 또는 전용 캘린더 ID 둘 다** 매칭해야 합니다. 전용 캘린더로 옮긴 뒤 이메일만 비교하던 시절에는 삭제가 조용히 아무것도 못 찾았습니다.

> 필드명이 `pctsCalendarId`인 것은 서비스 이름을 PCTS → Commeet으로 바꾸기 전의 잔재입니다. 마이그레이션을 피하려고 그대로 뒀습니다.

---

## 10. 전체 캘린더 페이지

**파일**: `app/static/js/calendar-page.js` (608줄), `app/templates/calendar.html`, CSS의 `cal-page-*` 프리픽스

`/calendar`는 사용자가 관여하는 **모든** 일정을 한 화면에 모읍니다. `GET /api/user/events`가 데이터를 줍니다.

### 10.1 참여자 이름 해석 — `_attach_participant_names()`

`meetings[].participants`에는 원시 키만 있습니다. 캘린더는 사람 이름을 앞세워야 하므로, `user_service.py`가 **한 번의 배치 쿼리**로 해석합니다:

```python
_OBJECT_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")
# 모든 이벤트를 훑어 ObjectId처럼 생긴 키만 모음
ids = {key for ... if _OBJECT_ID_RE.match(key)}
docs = await users_col.find({"_id": {"$in": [...]}}, {"name": 1, "email": 1})
meeting["participantNames"] = [name_by_id.get(key, key) for key in participants]
```

해석되지 않는 키(게스트 이름)는 **그대로 이름으로 사용**됩니다 — 게스트 키가 곧 그가 입력한 이름이므로 자연스럽게 맞아떨어집니다.

### 10.2 배치(placement) 생성

```js
if (event.isClosed && fin?.meetings) {
  fin.meetings.forEach((meeting) => {
    const mine = isOwner || meeting.participants.some(p => String(p) === CURRENT_USER_ID);
    if (!mine) return;                      // 내가 안 낀 면담은 표시 안 함
    add(dateKey(start), { kind: "confirmed", start, end, participantNames });
  });
  return;
}
// dow/group 폴은 기준 주에 저장되므로 확정 전에는 표시할 실제 날짜가 없음
if (event.type === "dow" || event.type === "group") return;
// 나머지는 미확정 후보 날짜
(event.dates || []).forEach(...)  // kind: "tentative"
```

### 10.3 주/일 뷰 겹침 배치 — 스윕라인 열 패킹

```js
function layoutTimedBlocks(placements) {
  blocks.forEach((b) => {
    active = active.filter((a) => a.p.end > b.p.start);   // 끝난 것 제거
    if (active.length === 0) flushCluster();              // 클러스터 경계
    const usedCols = new Set(active.map((a) => a.col));
    let col = 0; while (usedCols.has(col)) col++;         // 빈 열 찾기
    b.col = col; active.push(b); cluster.push(b);
  });
  flushCluster();   // 클러스터 내 모든 블록에 동일한 colCount 부여
}
```

겹치는 면담이 쌓이지 않고 나란히 놓입니다. `colCount`를 클러스터 단위로 통일해야 같은 시간대 블록들의 너비가 맞습니다.

### 10.4 월 뷰 높이 고정 — 두 번 만에 고친 버그

달을 넘길 때마다 주 수(4~6)가 달라져 페이지 길이가 출렁였습니다.

**첫 시도(실패)**: 42칸(6주)까지 패딩 `<div>`를 채움 → 여전히 출렁임.
**실제 원인**: 패딩 `<div>`에 높이가 없어서, **전부 패딩으로 채워진 행이 0px로 붕괴**했습니다.
**해결**:

```css
.month-cell-empty { aspect-ratio: 1; }
```

헤드리스 크롬으로 14개월을 확인해 전부 정확히 633.6px로 동일함을 검증했습니다. 같은 패턴이 `new-event.js`의 날짜 선택 달력에도 적용되어 있습니다(방 생성 다이얼로그 크기 고정).

### 10.5 Google 설정 모달

구글 캘린더 설정은 원래 설정 페이지에 있었으나 **캘린더 페이지의 모달**로 옮겼습니다. 권한 표도 모달 안에 들어 있습니다. `loadGoogleAccounts()` / `googleAccountRow()` 참조.

---

## 11. 대시보드와 폴더

**파일**: `app/static/js/dashboard.js`, `app/services/folder_service.py`, `app/routes/folder_routes.py`, `app/templates/home.html`

### 11.1 대시보드에 뜨는 일정의 정의

`user_service.get_dashboard_events()` — 세 집합의 합집합:

```python
responded_event_ids = {응답을 남긴 이벤트}
attendee_event_ids  = {그룹 초대를 받았고 거절하지 않은 이벤트}
owned_event_ids     = {내가 만든 이벤트}
all_ids = responded | attendee | owned
```

각 이벤트에 `hasResponded`, **`isOwner`** 플래그를 붙이고 `_attach_participant_names()`를 적용합니다. 남의 일정에는 `ownerName`(만든 사람)도 한 번의 배치 조회로 채웁니다.

### 11.1b 내가 만든 일정 vs 참여 중인 일정

대시보드는 두 종류를 나눠 보여 줍니다.

| | 내가 만든 일정 | 참여 중인 일정 |
|---|---|---|
| 폴더 · 보관 | O | X (폴더는 내 일정을 정리하는 도구) |
| 순서 드래그 | O | X |
| 수정 · 복제 · 보관 · 삭제 | O | **X** |
| 표시 | 생성일 | "○○○님의 일정" + 응답 여부 |

**서버가 이미 소유자만 허용하므로**, 버튼을 두면 눌러 봐야 403만 돌아옵니다. 그래서 UI에서 아예 없앴습니다.

> 복제(`POST /{id}/duplicate`)만은 원래 소유자 검사가 **없었습니다**. 위 규칙에 맞춰 추가했고, 소유자 없는(게스트가 만든) 일정은 링크를 가진 누구나 다룰 수 있으므로 예외로 뒀습니다.

`folderEventList()`는 `ownedEvents()`만 대상으로 계산합니다 — 그렇지 않으면 남의 일정이 "폴더 없음"에 섞입니다. 참여 섹션 블록은 `notDroppable`이라 폴더 드롭을 받지 않고, `noHeader`라 섹션 제목과 같은 말을 두 번 하지 않습니다.

### 11.2 폴더 모델

폴더는 **조인 컬렉션**(`folder_events`)으로 구현되어 이벤트 문서를 건드리지 않습니다.

```python
async def set_event_folder(event_id, user_id, folder_id):
    await folder_events_col.delete_many({"eventId": event_id, "userId": user_id})
    if folder_id is not None:
        await folder_events_col.insert_one({...})
```

한 이벤트는 한 폴더에만 속합니다 (delete-then-insert).

가상 폴더 두 개가 UI에만 존재합니다:
- `__none__` — 어떤 폴더에도 속하지 않은 것
- `__archived__` — `isArchived: true`인 것 (드롭 대상 아님)

> ⚠️ `delete_folder()`는 **폴더 안의 이벤트들도 `isDeleted: true`로 만듭니다.** 폴더 삭제 = 안의 일정도 삭제입니다.

### 11.3 드래그: 재배치와 폴더 이동을 하나의 제스처로

```js
startReorderDrag(e, {
  onMove: (x, y) => { /* 다른 폴더 위면 하이라이트 */ },
  onDrop: async (x, y, reordered) => {
    if (target && target !== originFolder) {
      await api.post(`/api/user/events/${event._id}/set-folder`, { folderId });
      return;                    // 폴더 이동
    }
    if (reordered) persistManualOrder();    // 자기 폴더 안이면 순서 저장
  },
});
```

같은 드래그가 놓는 위치에 따라 두 가지 의미를 갖습니다. 원래 폴더 위에서는 하이라이트하지 않습니다 — 일어나지 않을 이동을 암시하지 않기 위해서입니다.

---

## 12. 연락처

**파일**: `app/services/contact_service.py`, `app/routes/contact_routes.py`, `app/static/js/contacts.js`, `app/static/js/contact-filters.js`, `app/templates/contacts.html`

### 12.1 모델

연락처는 **단방향**입니다 — 친구 요청/수락이 없습니다. 아직 가입하지 않은 사람도 등록할 수 있어야 하기 때문입니다.

**이메일이 곧 신원**입니다: `(ownerId, email)` 유니크 인덱스. 가입자와 일치하면 `userId` 링크를 걸어 프로필 이름이 최신으로 유지됩니다.

로스터 상세 필드 10개 (`_DETAIL_FIELDS`), 전부 선택:

```
relation(구분) degree(과정) gradSchool(대학원) department(학과)
year(학년) semester(학기) studentId(학번) status(학적상태) phone memo
```

> 가입과 달리 연락처는 도메인 제한이 없습니다 — 외부 인사를 이벤트에 초대하려면 필요하기 때문입니다. Pydantic `EmailStr`만 검증합니다.

### 12.2 세 가지 쓰기 함수의 의미 차이

이 구분이 중요합니다:

| 함수 | 의미 | 빈 값 처리 |
|---|---|---|
| `add_contact()` | 신규 추가 | 빈 필드는 아예 저장 안 함 |
| `upsert_contact()` | 로스터 붙여넣기용 | 빈 값은 **기존 값 유지** |
| `update_contact()` | 편집 폼 저장 | 빈 값은 **`$unset`으로 삭제** |

`upsert_contact()`가 빈 값을 무시하는 이유:

> 붙여넣은 로스터 행에는 memo가 절대 없습니다. 그래서 같은 로스터를 다시 붙여넣어도 손으로 적어둔 메모가 지워지지 않습니다.

반대로 `update_contact()`는 "지금 폼에 보이는 것을 그대로 저장"이므로 비운 필드는 실제로 지워야 합니다.

### 12.3 대량 붙여넣기 파서

`contact-filters.js`의 `parseBulkContacts()`. POVIS 로스터 내보내기의 11개 컬럼 순서를 그대로 지원합니다:

```js
const BULK_CONTACT_COLUMNS = ["relation","degree","gradSchool","department",
  "year","semester","studentId","name","status","email","phone"];
```

컬럼 수가 부족하면 **휴리스틱 폴백**으로 넘어갑니다:

```js
const email = cells.find(c => EMAIL_RE.test(c)) || "";
const phone = cells.find(c => PHONE_RE.test(c)) || "";
const name  = cells.find(c => c && c !== email && c !== phone) || "";
```

즉 `이름<TAB>이메일` 두 칸짜리도 됩니다.

**이름 정규화 — 고쳐야 했던 버그**:

```js
function normalizeContactName(name) {
  // "성, 이름" 형태만 공백을 없앤다 ("최, 윤호" → "최윤호").
  // "John Doe" 같은 평범한 공백 이름은 공백을 잃으면 안 되므로 쉼표가 있을 때만 동작.
  if (trimmed.includes(",")) return trimmed.replace(/,/g, " ").replace(/\s+/g, "");
  return trimmed;
}
```

처음에는 무조건 공백을 제거해서 "John Doe"가 "JohnDoe"가 됐습니다.

프런트는 `POST /api/contacts?overwrite=true`로 한 건씩 보내고 `{created: bool}`을 세어 "N명 추가 · M명 갱신"을 표시합니다.

### 12.4 필터 — 세 화면 공유

`setupContactFilterBar(root, contacts, onChange)`가 과정/학적상태 체크박스 바를 만들고 **술어 함수를 반환**합니다. 세 화면이 이걸 그대로 씁니다:

1. 연락처 페이지
2. 새 일정 다이얼로그의 연락처 선택기
3. 초대 다이얼로그

선택은 `localStorage["pcts_contact_filters"]`에 저장되어 세 화면이 같은 설정을 공유합니다.

로스터 상세가 있는 연락처가 하나도 없으면 바 자체를 숨기고 항상 참인 술어를 반환합니다.

```js
function contactMatchesFilters(c, selectedDegrees, selectedStatuses) {
  if (c.degree && !selectedDegrees.has(c.degree)) return false;
  if (c.status && !selectedStatuses.has(c.status)) return false;
  return true;
}
```

**필드가 없는 연락처는 절대 걸러지지 않습니다** — 필터는 해당 필드를 실제로 가진 연락처만 좁힙니다.

초대 다이얼로그에서 필터를 바꿔도 이미 체크한 사람이 풀리지 않도록 체크 상태를 보존합니다 (`previouslyChecked`).

### 12.5 다중 선택 — 윈도우 탐색기 방식

**파일**: `app/static/js/contacts.js` (`applySelectionClick`), `app/templates/contacts.html`

선택 상태는 `selectedContacts: Set<contactId>` 하나, 범위 선택의 기준점은 `selectionAnchorId` 하나로 관리합니다. 체크박스의 `checked`는 **결과를 그린 것일 뿐 상태가 아닙니다** — 클릭을 받으면 `preventDefault()`로 브라우저 기본 토글을 막고, Set을 고친 뒤 목록을 다시 그립니다. `change` 이벤트를 쓰지 않는 이유는 거기에 `shiftKey`/`ctrlKey`가 실려 오지 않아 범위 선택을 알 수 없기 때문입니다.

| 누른 곳 | 그냥 | Ctrl(⌘) | Shift | Ctrl+Shift |
|---|---|---|---|---|
| 체크박스 | 하나 켜고 끄기 | 하나 켜고 끄기 | 기준점~여기 (기존 선택 대체) | 기준점~여기를 기존 선택에 **추가** |
| 카드 본문 | **이것만** 선택 | 하나 켜고 끄기 | 기준점~여기 (기존 선택 대체) | 추가 |

체크박스만 예외적으로 "그냥 클릭 = 토글"입니다. 체크박스를 하나 켰다고 앞서 켠 것들이 사라지면 아무도 예상하지 못하기 때문입니다. 카드 본문은 탐색기와 같은 배타 선택입니다.

기준점은 **마지막으로 직접 누른 항목**이며, Ctrl로 해제한 항목도 기준점이 됩니다 (탐색기와 동일). 범위 선택 자체는 기준점을 옮기지 않아 같은 자리에서 범위를 늘렸다 줄였다 할 수 있습니다.

범위는 `visibleContacts()`가 돌려주는 **화면에 보이는 순서** 기준입니다. 정렬을 바꾸거나 필터를 걸면 범위의 의미도 그 화면을 따라갑니다. 필터로 가려진 연락처는 `renderContactList()`에서 선택에서 빠지고 (§12.4의 "보이지 않는 사람을 지우지 않는다"는 규칙), 기준점도 안 보이면 버립니다.

잔손질 세 가지:

- 선택이 바뀌면 목록 전체를 다시 그리므로 눌렀던 체크박스가 새 요소로 교체됩니다. `rerenderKeepingFocus()`가 같은 자리에 포커스를 되돌려 놓아 스페이스바 연타가 끊기지 않습니다.
- `#contacts-list .contact-row { user-select: none }` — Shift+클릭이 글자를 함께 끌어 선택하는 것을 막습니다. 다만 이메일은 복사할 일이 많아 `user-select: text`로 되돌려 두고, 대신 Shift+클릭 시 `getSelection().removeAllRanges()`로 정리합니다.
- 카드 클릭 핸들러는 `e.target.closest("button, a, input, label, .contact-grip")`이면 그냥 빠집니다 — "자세히"·"수정"·"삭제"와 드래그 손잡이가 선택으로 새지 않게 합니다.

`.contact-row`는 위쪽 "가입자 검색" 결과에도 쓰이므로 선택 관련 CSS는 전부 `#contacts-list` 아래로 한정했습니다.

사용법 안내(`#contact-select-hint`)는 `navigator.userAgent`로 맥이면 `⌘`, 아니면 `Ctrl`로 씁니다. 900px 아래에서는 숨깁니다 — 터치 화면에는 수식 키가 없고, 없어도 체크박스 하나씩 누르는 동작은 그대로 됩니다.

---

## 13. 카드 정렬과 드래그 재배치

**파일**: `app/static/js/card-sort.js` (171줄) — 대시보드와 연락처가 공유

### 13.1 저장 규약

```
localStorage["<key>_sort"]   현재 정렬 옵션, 또는 "manual"
localStorage["<key>_order"]  손으로 배치한 id 순서 (manual일 때만 의미 있음)
```

키는 `pcts_dashboard`, `pcts_contacts`.

**규칙: 정렬 옵션은 항상 수동 배치를 이깁니다. 단, 카드를 드래그하면 목록이 "manual"로 전환되어 배치가 유지됩니다.**

```js
function persistManualOrder() {
  sortMode = "manual";
  manualOrder = [...document.querySelectorAll(".folder-body .event-card")].map(el => el.dataset.eventId);
  saveSortState(SORT_STORAGE_KEY, sortMode, manualOrder);
}
```

`"사용자 정렬"`은 셀렉트의 선택지로 제공되지 않고, 현재 값일 때만 옵션으로 추가됩니다 — 드래그하기 전에는 존재하지 않는 상태이기 때문입니다.

새로 생긴 항목 처리:

```js
// 저장된 순서에 없는 id는 rank -1 → 맨 앞으로.
// 새로 만든 일정이 목록 맨 아래 숨어버리지 않게 하기 위함.
const ra = rank.has(getId(a)) ? rank.get(getId(a)) : -1;
```

### 13.2 삽입 위치 판정

그리드와 단일 컬럼은 히트 테스트가 달라야 합니다. 컬럼 수를 실제 배치에서 추론합니다:

```js
const lefts = new Set(els.map(el => Math.round(el.getBoundingClientRect().left)));
const singleColumn = lefts.size <= 1;

if (singleColumn) {
  if (y < r.top + r.height / 2) return el;          // 세로 중앙 기준
} else {
  if (y < r.top) return el;                         // 윗 행이면 그 앞
  if (y <= r.bottom && x < r.left + r.width / 2) return el;   // 같은 행이면 좌우 중앙 기준
}
```

### 13.3 드래그 메커니즘

Pointer Events 기반 (`startReorderDrag`). 이 앱에서 같은 패턴이 네 곳에 쓰입니다: 가용시간 페인팅, 확정 화면 칩 교환, 폴더 이동, 카드 재배치.

드래그 중에는 실제 DOM을 옮겨 즉각 반영하고, `onDrop`에서 `movedWithin` 플래그로 저장 여부를 결정합니다. 컨테이너 밖으로 나가면 재배치를 멈춰 호출자의 드롭 처리(폴더 이동)에 양보합니다.

---

## 14. 마크다운 렌더러

**파일**: `app/static/js/markdown.js` (179줄)

### 왜 직접 만들었는가

일정 설명은 **호스트가 쓰고 링크를 가진 모두가 읽습니다.** 범용 마크다운 라이브러리는 기본적으로 인라인 HTML을 허용하므로 XSS 통로가 됩니다.

### 핵심 설계: 이스케이프 우선

```js
function mdEscape(text) {
  return String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                     .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
```

**먼저 전부 이스케이프한 뒤, 화이트리스트에 있는 구성요소만 태그로 되돌립니다.** 따라서 `<script>`, 이벤트 핸들러 속성, `javascript:` URL은 구조적으로 불가능합니다.

URL 화이트리스트:

```js
function mdSafeUrl(url) {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null;
}
```

`javascript:`, `data:`, `vbscript:`, 프로토콜 상대 경로는 전부 링크가 아니라 평문으로 렌더링됩니다.

### 인라인 코드 보호

```js
const codes = [];
out = out.replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return ` CODE${codes.length-1} `; });
// ... 나머지 인라인 규칙 적용 ...
return out.replace(/ CODE(\d+) /g, (_, i) => `<code>${mdEscape(codes[Number(i)])}</code>`);
```

코드 스팬 내용이 볼드/링크 규칙에 오염되지 않도록 플레이스홀더로 빼뒀다가 마지막에 복원합니다.

### 지원 문법

제목, 볼드, 이탤릭, 취소선, 인라인 코드, 펜스 코드블록, 링크(명시적/자동), 순서/비순서 목록, 인용, 수평선, 문단.

블록 파서는 라인 단위 상태 머신(`listType`, `inCode`, `paragraph`, `quote`)으로 `closeList()`/`closeParagraph()`/`closeQuote()`를 적절히 호출합니다.

### 진입점

```js
function renderDescription(src, format) {
  if (!src?.trim()) return "";
  return format === "markdown" ? renderMarkdown(src) : renderPlainText(src);
}
```

`renderPlainText()`도 이스케이프를 거치며 줄바꿈만 `<br />`로 보존합니다.

> ⚠️ **이름 충돌 주의**: `event-grid.js`에서 이 함수를 감싸는 지역 함수는 `renderEventDescription`이라는 **다른 이름**을 씁니다. 같은 이름으로 선언하면 호이스팅된 지역 선언이 전역을 가려 무한 재귀가 됩니다. 실제로 한 번 발생한 버그이고 양쪽 파일에 주석으로 남겼습니다.

CSS: 전역 리셋에 `ul { list-style: none }`이 있어서 `.md-body`에서 목록 불릿을 다시 켜줘야 합니다.

---

## 15. 관리자 대시보드

**파일**: `app/services/access_log_service.py`, `app/services/admin_service.py`, `app/routes/admin_routes.py`, `app/static/js/admin.js`, `app/templates/admin.html`, `scripts/bootstrap_admin.py`

`/admin`은 관리자가 아니면 **404**를 반환합니다 (403이 아니라) — 존재 자체를 노출하지 않습니다. 프로필 드롭다운에도 관리자에게만 링크가 보입니다.

### 15.1 접속 로그

**의도적으로 가볍게** 설계했습니다: 요청당 1행, 바디/헤더 미수집.

```python
{"ts", "method", "path", "statusCode", "durationMs", "userId", "ip", "userAgent"[:200]}
```

`/static/` 프리픽스는 제외 — 그렇지 않으면 에셋 요청이 로그 볼륨을 몇 배로 압도합니다. TTL 인덱스가 60일 지난 문서를 자동 삭제하므로 무한정 자라지 않습니다.

### 15.2 통계 집계

```python
daily = await access_logs_col.aggregate(
    [
        {"$match": {"ts": {"$gte": since}}},
        {
            "$group": {
                "_id": {
                    "$dateToString": {
                        "format": "%Y-%m-%d",
                        "date": "$ts",
                        "timezone": "UTC",
                    }
                },
                "requests": {"$sum": 1},
                "users": {"$addToSet": "$userId"},
            }
        },
        {"$sort": {"_id": 1}},
    ]
)
```

`$addToSet`으로 일별 순 사용자를 세고, 파이썬에서 `None`을 걸러 로그인 사용자만 셉니다. 상위 경로 10개는 별도 `$group` + `$sort` + `$limit`.

`days` 파라미터는 `min(max(days, 1), 90)`으로 클램프됩니다.

### 15.3 차트 — 의존성 없이 SVG 직접 생성

`admin.js`의 `renderTrafficChart()`가 `document.createElementNS`로 SVG를 만듭니다.

```js
const width = 900, height = 200;
const padding = {top:10, right:10, bottom:24, left:36};
const maxVal = Math.max(1, ...daily.map(d => d.requests));
const barWidth = chartW / daily.length;
svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
svg.setAttribute("preserveAspectRatio", "none");
```

`viewBox` + `preserveAspectRatio="none"`으로 반응형이 되고, 각 막대에 `<title>`을 넣어 네이티브 툴팁을 얻습니다. x축 라벨은 `labelStride`로 솎아 겹침을 방지합니다.

차트 라이브러리를 넣지 않은 이유는 막대 그래프 하나 때문에 수백 KB를 들이지 않기 위해서입니다.

### 15.4 마지막 관리자 보호

```python
if not is_admin:
    if target.get("isAdmin"):
        if await users_col.count_documents({"isAdmin": True}) <= 1:
            raise LastAdminError()
```

관리자를 관리하는 대시보드가 스스로를 잠가버리는 것을 막습니다.

### 15.5 최초 관리자 부트스트랩

앱 안에는 최초 관리자를 만드는 경로가 없습니다 (한 명 있으면 그가 다른 사람을 승격 가능). CLI로 처리합니다:

```bash
uv run python scripts/bootstrap_admin.py someone@postech.ac.kr
```

### 15.6 메일 테스트

`POST /api/admin/test-mail`. 예외를 **일부러 넓게 잡아** 그대로 돌려줍니다:

```python
except Exception as exc:
    raise HTTPException(status_code=502, detail=f"발송 실패: {type(exc).__name__}: {exc}")
```

smtplib/DNS/TLS가 던진 실제 메시지가 관리자에게 필요한 정보이기 때문입니다.

---

## 16. 면담 기록과 학생지도비 신청서

**파일**: `app/services/crypto_service.py`, `app/services/record_service.py`, `app/routes/record_routes.py`, `app/schemas/record.py`, `app/static/js/record-form.js`, `app/templates/partials/record_form_dialog.html`, `app/templates/record_print.html`, `scripts/demo_records.py`

면담 후 내용을 기록하고 영수증을 붙여 **POVIS 입력 텍스트 + 학생지도비 정산 요청 양식**까지 만드는 기능입니다.

### 16.0 진입점

기록은 **일정 페이지(`/e/{id}`, `/g/{id}`)의 캘린더 아래** "면담 기록 · 학생지도비" 섹션 한 곳에서 관리합니다. 확정된 시간대 하나가 한 줄이고, 그 줄에서 폼을 엽니다.

> 별도의 `/records` 목록 페이지가 있었으나 제거했습니다 (일정 맥락 안에서 관리하는 편이 낫다는 판단). **인쇄 라우트 `/records/{id}/print`는 남아 있습니다** — "신청서" 버튼이 쓰는 별도 경로입니다.
>
> 함께 사라진 것: 여러 일정을 가로지르는 기록 조회·검색, 그리고 "끝났는데 아직 안 쓴 면담" 할 일 목록(`record_service.list_open_meetings`). 서비스 함수 자체는 `scripts/demo_records.py`가 요약 출력에 쓰고 있어 남아 있지만, 앱에서 호출하는 곳은 없습니다.

폼 마크업은 `partials/record_form_dialog.html`, 동작은 `record-form.js`의 `RecordDialog` 모듈입니다 — `new-event.js`/`NewEventDialog`와 같은 패턴이라 다른 화면에서도 그대로 띄울 수 있습니다. `event-grid.js`가 시간대별 행을 그리고 `RecordDialog.open(eventId, meetingStart, onSaved)`로 폼을 엽니다. `onSaved` 콜백으로 저장/삭제 후 배지와 요약을 갱신합니다.

이벤트 페이지의 기록 섹션(`#ev-records-card`)은 **저장된 `finalization.meetings`** 를 기준으로 그립니다. 확정 화면에서 드래그 중인 배정은 아직 저장 전 초안이라, 그걸 기준으로 삼으면 존재하지 않는 면담에 기록이 붙을 수 있습니다. 두 조건을 모두 만족할 때만 나타납니다:

```js
if (!ST.isOwner || !confirmedMeetings().length) { card.style.display = "none"; return; }
```

호스트가 아니면 기록 API를 **호출조차 하지 않습니다**. 마크업은 `#event-body-root` 바깥에 두어 `renderSkeleton()`이 그리드를 다시 그려도 지워지지 않습니다.

참가자 이름은 `ST.event.responses`에서 가져옵니다 (`participantDisplayName`) — 게스트 키는 이름 그 자체라 그대로 쓰면 맞고, 등록 사용자의 키는 ObjectId 문자열이라 반드시 해석해야 합니다.

> ⚠️ **`const`는 `window`의 속성이 아닙니다.** `record-form.js`는 `const RecordDialog = (() => {...})()`로 선언되는데, 최상위 `const`/`let`은 `var`/함수 선언과 달리 `window`에 붙지 않습니다. `if (window.RecordDialog)` 가드는 **항상 거짓**이라 `init()`이 통째로 건너뛰어지고, 저장 버튼에 리스너가 안 붙어 클릭해도 아무 일도 일어나지 않습니다. `typeof RecordDialog !== "undefined"`로 확인해야 합니다 — 실제로 겪은 버그입니다.

모듈 시스템이 없어 전역 이름이 곧 네임스페이스이므로, `esc`/`el` 같은 공용 유틸은 `RecordDialog` **안에** 가둬 두었습니다. 전역으로 내보내면 같은 이름을 쓰는 `event-grid.js`/`finalize.js`와 충돌합니다.

**확정/취소 버튼**은 페이지가 길어 아래쪽에 두면 배정을 훑고 다시 스크롤해 내려가야 했으므로 헤더로 올렸습니다(`#fin-top-actions`). 다만 배정을 계산하기 전에는 확정할 것이 없으므로 `setResultVisible()`이 `#fin-result`와 함께 켜고 끕니다.

> ⚠️ **짧은 공유 id 주의**: 이벤트 페이지의 `CFG.eventId`는 `shortId`(예: `6eBBf`)입니다. `record_service`는 ObjectId를 기대하므로 라우트(`list_records`, `get_draft`)에서 `_owned_event()`로 해석해 **실제 ObjectId로 바꿔서** 넘깁니다. 짧은 id를 그대로 넘기면 저장된 기록을 못 찾고 빈 초안이 뜹니다 — 확정 화면을 붙이면서 실제로 겪은 버그입니다.

### 16.1 저장 위치와 암호화

면담 내용, 참석자 이름, 영수증/서명 이미지는 학생에 대한 개인정보이므로 **MongoDB와 디스크 어디에도 평문으로 쓰지 않습니다.**

```python
def _derive_key(secret: str) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"commeet-meeting-records-v1",
        iterations=200_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(secret.encode("utf-8")))


_fernet = Fernet(
    RECORD_ENCRYPTION_KEY.encode()
    if RECORD_ENCRYPTION_KEY
    else _derive_key(SESSION_SECRET)
)
```

Fernet = AES-128-CBC + HMAC-SHA256 + 타임스탬프. 인증 암호화이므로 변조도 탐지됩니다.

`RECORD_ENCRYPTION_KEY`가 없으면 `SESSION_SECRET`에서 파생 — 추가 설정 없이 동작하지만, **그 경우 `SESSION_SECRET`을 교체하면 기존 기록을 읽을 수 없게 됩니다.** `key_is_derived()`가 UI에 이 사실을 알릴 수 있게 해줍니다.

저장 경로:

```python
def storage_dir() -> Path:
    path = (
        Path(RECORD_STORAGE_DIR)
        if RECORD_STORAGE_DIR
        else BASE_DIR / "instance" / "records"
    )
    path.mkdir(parents=True, exist_ok=True)
    return path
```

`.env`에 지정하면 거기에, 없으면 프로젝트 루트의 `instance/`(`.gitignore`에 추가됨)에 저장됩니다.

Mongo 문서에서 민감 필드는 **`enc` 하나의 불투명 블롭**으로 뭉쳐집니다:

```python
"enc": crypto_service.encrypt_json({
    "place", "professorName", "attendees", "notesMode",
    "sharedNote", "perStudentNotes", "settlements",
})
```

비민감 필드(`eventName`, `meetingStart`, `date`, `startTime`, `endTime`, `status`)는 평문으로 두어 목록/정렬/인덱싱이 가능하게 합니다.

첨부파일은 파일 단위로 암호화되어 `<storage>/<recordId>/signature.png`, `receipt-<i>.<ext>`로 저장되고, `/static`으로는 절대 노출되지 않습니다. 다운로드는 메모리에서 복호화해 스트리밍합니다:

```python
return Response(content=raw, media_type=media, headers={"Cache-Control": "no-store"})
```

### 16.2 레코드 식별 키

```python
await meeting_records_col.create_index(
    [("ownerId", 1), ("eventId", 1), ("meetingStart", 1)], unique=True
)
```

§8.7에서 설명한 대로 `meetings[]`에는 id가 없고 `confirm()`이 서브도큐먼트를 통째로 교체하므로, **면담 시작 시각이 유일하게 안정적인 손잡이**입니다.

### 16.3 초안 생성 — `build_draft()`

참석자는 확정된 배정에서 가져오되, **이름·이메일 해석은 확정 화면과 같은 함수를 재사용**합니다:

```python
from app.services.finalize_service import _load_people

_host, people = await _load_people(event)
by_key = {p["key"]: p for p in people}
```

두 화면에서 같은 사람이 다르게 보이지 않게 하기 위함입니다.

학번·소속은 **호스트의 연락처에 이메일로 조인**해서 채웁니다:

```python
def _guess_affiliation(contact):
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
```

**추측일 뿐이며 폼에서 수정 가능합니다** — 금액이 여기에 달려 있어서 조용히 잘못 청구되면 안 되기 때문입니다.

### 16.4 정산 분리 — 소속별 개별 결재

학생지도비 규정상 컴공 학생과 무은재 학부생은 **각각 따로 결재**하며, 영수증도 따로, 신청서도 따로입니다. 그래서 레코드는 금액 하나가 아니라 **정산 목록**을 가집니다:

```python
def compute_settlements(attendees):
    for aff in ("cse", "muunjae"):
        people = [a for a in attendees if a["present"] and a["affiliation"] == aff]
        if not people: continue
        rate = GUIDANCE_FEE_RATES.get(aff, 0)     # 기본 30,000 / 15,000원
        out.append({"affiliation", "headcount", "unitPrice",
                    "amount": rate * len(people), "receiptFile": None, "receiptTime": ""})
```

한 면담이 최대 두 장의 신청서를 만듭니다.

### 16.5 시간대 처리 — 실제로 있었던 버그

처음에는 `build_draft()`가 서버에서 시각 문자열을 만들었습니다:

```python
"startTime": meeting["start"].strftime("%H:%M")   # ← 버그
```

`meeting["start"]`는 tz-aware **UTC**입니다. 11:00 KST 면담이 폼에 **02:00**으로 채워졌습니다. 서버는 호스트의 시간대를 알 방법이 없습니다.

**수정**: 서버는 UTC 시점만 보내고 브라우저가 로컬 시각으로 변환합니다 (앱의 다른 시간 표시와 동일한 방식).

```python
"meetingStart": meeting["start"],
"meetingEnd": meeting["end"],
"date": "", "startTime": "", "endTime": "",   # 클라이언트가 채움
```

```js
function localParts(iso) {
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,
           time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
// 초안은 로컬 시각으로 채우고, 저장된 기록은 확정된 문자열을 그대로 유지
date: data.date || startedAt.date,
startTime: data.startTime || startedAt.time,
```

> 스크립트에서 `build_draft()`를 직접 호출하는 경우(`scripts/demo_records.py`)에는 브라우저가 없으므로 직접 채워야 합니다.

### 16.6 첨부파일은 서버 소유 상태 — 두 번째 버그

폼을 다시 저장하면 첨부한 영수증이 사라졌습니다. 클라이언트가 보내는 `settlements`에는 `receiptFile: null`이 들어 있었기 때문입니다(업로드 이전에 받은 오래된 사본).

**첨부는 서버가 소유하는 상태이고, 폼이 되돌려 보내지 않습니다.** 그래서 서버에서 병합합니다:

```python
def _keep_receipts(existing, settlements) -> tuple[list[dict], list[str]]:
    by_affiliation = {
        s["affiliation"]: s for s in stored["settlements"] if s.get("receiptFile")
    }
    for settlement in settlements:
        previous = by_affiliation.pop(settlement.get("affiliation"), None)
        if previous and not settlement.get("receiptFile"):
            settlement["receiptFile"] = previous["receiptFile"]
            settlement["receiptName"] = previous.get("receiptName", "")
    return settlements, [s["receiptFile"] for s in by_affiliation.values()]  # 고아 파일
```

`pop`으로 소비하고 남은 것 = 정산 그룹이 사라진 영수증 = **고아 파일**이므로 호출자가 디스크에서 지웁니다.

### 16.7 서명 캔버스 — 세 번째 버그

Pointer Events로 캔버스에 직접 그립니다. 세 가지 문제를 고쳤습니다.

**(a) 그리는 중 리사이즈로 획이 지워짐.** `canvas.width = w`는 백킹 스토어를 리셋하며 내용을 지웁니다. `pointerdown`에서 리사이즈하던 것을 제거하고 `ResizeObserver`로 옮겼습니다:

```js
canvas.addEventListener("pointerdown", (e) => {
  // 여기서 리사이즈하지 않는다: 리사이즈는 백킹 스토어를 리셋해 패드를 지운다.
  if (!signature.ctx) resizeSignatureCanvas();
  ...
});
new ResizeObserver(() => { if (!signature.drawing) resizeSignatureCanvas(true); }).observe(canvas);
```

`preserve=true`이면 `toDataURL()`로 스냅샷을 뜬 뒤 복원합니다.

**(b) 저장된 서명이 다시 열 때 안 보임.** 열 때 호출되는 `clearSignature()`가 "사용자가 지웠다"(`signatureDirty`)로 표시해서, 뒤늦게 도착한 이미지 로드가 스스로 차단됐습니다. **초기화와 사용자 삭제를 분리**했습니다:

```js
function resetSignaturePad() { /* 픽셀만 지움, dirty 표시 안 함 */ }
function clearSignature() {   /* 지우기 버튼: reset + dirty 표시 */
  resetSignaturePad();
  state.signatureDirty = state.hasSignature || state.signatureDirty;
}
```

**(c) 늦게 도착한 이미지가 새 획을 덮어씀.** 비동기 로드 완료 시점에 조건을 확인합니다:

```js
if (state.recordId !== forRecord || state.signatureDirty || !signature.ctx) return;
```

지우기를 저장할 때는 빈 이미지를 올리지 않고 `dataUrl: ""`를 보내 서버가 파일을 삭제하게 합니다 (`clear_signature()`).

### 16.8 업로드 검증

```python
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp", "application/pdf"}
```

파일명은 서버가 **직접 만듭니다** (`receipt-{index}.{ext}`) — 사용자 입력 파일명을 경로에 쓰지 않습니다. 다운로드 시에도 방어합니다:

```python
if "/" in kind or "\\" in kind or ".." in kind:
    raise HTTPException(status_code=400, detail="잘못된 요청입니다.")
```

모든 조회/수정은 `{"_id": oid, "ownerId": owner["_id"]}`로 소유권을 함께 검사합니다.

### 16.9 목록: 끝난 면담만

```python
# 기록은 면담 후에 쓰는 것이므로 아직 안 끝난 약속은 목록에서 노이즈일 뿐이다.
if m["end"] > now:
    continue
```

`tz_aware=True` 덕분에 `datetime.now(UTC)`와 직접 비교할 수 있습니다.

### 16.10 복호화 실패에 대한 내성

```python
try:
    rec = _public(d)
except crypto_service.RecordDecryptionError:
    # 하나가 안 읽힌다고 목록 전체가 죽으면 안 된다.
    rec = {..., "undecryptable": True, "attendees": [], "settlements": []}
```

키가 바뀐 기록이 하나 있어도 나머지는 정상적으로 보입니다.

### 16.11 출력: 인쇄용 HTML

PDF 라이브러리를 넣지 않고 **인쇄 최적화 HTML**을 서버 렌더링합니다 (`record_print.html`). 정산 하나당 한 장:

```css
.sheet + .sheet { page-break-before: always; }
@media print {
  .print-bar { display: none; }
  .sheet { border: none; margin: 0 auto; padding: 0; max-width: none; }
}
```

이 페이지는 앱 테마 토큰을 일부러 무시하고 흑백으로 고정합니다 — 양식은 종이에 검은 잉크로 나가야 하기 때문입니다.

개별 입력 모드일 때 각 장은 **그 소속 참석자의 내용만** 보여줍니다:

```jinja
{% for a in form.attendees %}[{{ a.name }}]
{{ record.perStudentNotes.get(a.key, "") }}
{% endfor %}
```

`POVIS 입력용 복사` 버튼은 `povisText()`가 만든 평문을 클립보드에 넣습니다. Clipboard API는 보안 컨텍스트가 필요하므로 `document.execCommand("copy")` 폴백이 있습니다.

### 16.12 데모 스크립트

```bash
uv run python scripts/demo_records.py            # 생성
uv run python scripts/demo_records.py --clean    # 삭제
```

**`finalize_service.confirm()`을 호출하지 않고 `finalization`을 DB에 직접 씁니다** — `confirm()`은 참석자 전원에게 실제 메일을 보내고 구글 캘린더 이벤트를 만들기 때문입니다. 데모 데이터가 할 일이 아닙니다.

모든 문서에 `demoTag: "commeet-demo"`를 달아 `--clean`이 자신이 만든 것만 지웁니다.

---

## 17. 이메일 발송

**파일**: `app/services/email_service.py` (307줄)

### 17.1 두 가지 백엔드

```python
def _smtp_target():
    if MAIL_BACKEND == "postech":
        return POSTECH_SMTP_HOST, POSTECH_SMTP_PORT  # :25
    return "smtp.gmail.com", 587
```

- **gmail** — 앱 비밀번호로 로그인. 어디서든 동작.
- **postech** — `smtp.postech.ac.kr:25` **무인증 릴레이**. 자격증명이 필요 없지만 POSTECH 메일 관리자에게 등록된 IP에서만 동작합니다(등록 IP: `141.223.145.21`). 다른 곳에서는 `421 4.3.2 Service not available`이 돌아옵니다.

설정되지 않은 경우 **콘솔 로그로 대체**되어 로컬 개발이 메일을 특수 처리할 필요가 없습니다. 특히 인증 코드는 경고 레벨로 찍혀 메일 없이도 가입 흐름 테스트가 가능합니다.

### 17.2 여러 명에게 보내기 — `send_many()`

메일 발송에서 시간을 잡아먹는 것은 본문 전송이 아니라 **접속 + STARTTLS + 로그인**입니다. 통마다 연결을 새로 열고 한 통씩 순차로 보내면, 34명짜리 일정 확정은 그 과정을 34번 반복합니다.

```python
async def send_many(mails: Sequence[Mail]) -> None:
    workers = min(MAIL_MAX_CONNECTIONS, len(pending))
    # 라운드로빈으로 나눠 각 연결이 비슷한 양을 맡게 합니다.
    batches = [pending[i::workers] for i in range(workers)]
    results = await asyncio.gather(
        *(asyncio.to_thread(_deliver_batch, batch) for batch in batches),
        return_exceptions=True,
    )
```

두 가지를 동시에 줄입니다.

| | 이전 | 지금 |
|---|---|---|
| 접속·로그인 횟수 | 통 수만큼 (N) | 연결 수만큼 (기본 4) |
| 대기 | 순차 | 동시 |

`_deliver_batch()`는 한 연결(`_smtp_session`)로 자기 몫을 이어서 보냅니다. 실패 처리가 두 단계입니다:

- **수신자 한 명의 문제**(`SMTPRecipientsRefused` 등) → 기록만 남기고 **다음 사람 계속**. 주소 하나가 틀렸다고 나머지 30명이 못 받으면 안 됩니다.
- **연결이 끊김** → 남은 메일만 새 연결로 **한 번 더** 시도.

동시 연결 수를 `MAIL_MAX_CONNECTIONS`(기본 4)로 제한하는 이유는 §9.6의 구글 캘린더 대량 삭제와 같습니다 — 수십 개를 한꺼번에 열면 서버가 조용히 거절하거나 스팸으로 판단합니다.

### 받을 수 없는 주소 거르기

없는 도메인에 계속 시도하면 로그가 지저분해질 뿐 아니라 **발신 평판도 깎입니다.** 두 단계로 거릅니다.

**1) 예약 도메인 — DNS 없이 즉시 차단.** RFC 2606/6761/6762가 예약한 `.test` `.example` `.invalid` `.localhost` `.local`과 `example.com/net/org`은 실제로 배달될 수 없습니다. `MAIL_VERIFY_DOMAIN`과 무관하게 항상 차단합니다.

> `.local`은 DNS로 물어보면 **NXDOMAIN이 아니라 `NoNameservers`** 가 돌아옵니다(mDNS용이라 리졸버에 권한이 없음). 아래 fail-open 규칙 때문에 "일시적 장애"로 오해돼 계속 발송되므로, 이름만 보고 먼저 끊어야 합니다.

**2) DNS 조회 — MX(없으면 A/AAAA).** `dnspython`으로 확인합니다(이미 `pymongo`·`email-validator`가 끌어오는 의존성).

```python
except dns.resolver.NXDOMAIN:     ok = False   # 도메인 자체가 없음
except dns.resolver.NoAnswer:     ...          # MX 없으면 A 확인 (RFC 5321)
except dns.exception.DNSException: ok = True   # 확신할 수 없으면 보냄
```

**판단이 서지 않으면 보냅니다(fail-open).** DNS 타임아웃으로 진짜 메일이 조용히 사라지는 쪽이, 없는 주소에 한 번 더 시도하는 것보다 훨씬 나쁩니다.

결과는 도메인 단위로 10분 캐시합니다 — 같은 학교 메일 34명에게 보낼 때 DNS를 34번 물어볼 이유가 없습니다. 조회는 블로킹이라 `asyncio.to_thread`로 돌립니다.

**빌더/발송 분리**: 여러 명에게 가는 5종(초대 2종, 확정/미배정/취소)은 `build_*_mail()`이 `Mail`만 만들고, 호출부가 목록으로 모아 `send_many()`에 한 번 넘깁니다. 한 명뿐인 곳은 `send_*_email()` 편의 함수를 그대로 씁니다.

```python
# finalize_service._notify() - 34명이면 34통을 한 번에
mails = [email_service.build_meeting_confirmed_mail(...) for ...]
mails += [email_service.build_meeting_unassigned_mail(...) for ...]
await email_service.send_many(mails)
```

`smtplib`는 동기 블로킹이므로 워커 스레드(`asyncio.to_thread`)로 보냅니다. **발송 실패는 로그로만 남깁니다** — 확정이나 초대 같은 본래 작업이 메일 때문에 실패하면 안 됩니다.

### 사람을 기다리게 하지 않기 — `send_many_detached()`

메일 발송은 **아무리 최적화해도 초 단위**입니다. Gmail SMTP를 실측하면:

| 구간 | 실측 |
|---|---|
| 접속 + STARTTLS + 로그인 | **1.0 ~ 1.5 초** (연결 하나당) |
| 명령 왕복 1회 | 약 140 ms |
| 한 통 (`MAIL FROM`·`RCPT TO`·`DATA`·본문·`.`) | 왕복 4회 안팎 ≈ 0.5 초 |
| DNS 도메인 확인 | 최초 40 ms, 이후 캐시 히트 0 ms |

연결을 4개까지 나눠 써도 20명을 초대하면 `1.5 + 0.5×5 ≈ 4초`입니다. 이걸 요청 안에서 기다리면 **"만들기" 버튼을 누른 뒤 4초 동안 화면이 멈춰 있습니다.**

그래서 사람이 기다리는 경로는 전부 `send_many_detached()`로 넘깁니다. `asyncio.create_task`로 띄우고 **넘긴 통수만 즉시 반환**합니다(§9.6의 캘린더 동기화와 같은 이유 — DB가 이미 진실이고 메일은 안내일 뿐).

| 경로 | 함수 |
|---|---|
| 일정/그룹 생성 시 초대 | `event_service.create_event()` |
| 수정하며 새로 추가된 사람 초대 | `event_service.update_event()` |
| 초대 보내기 다이얼로그 (최대 20명) | `POST /api/events/{id}/invite` |
| 확정 / 미배정 / 확정 취소 | `finalize_service._notify()` |
| 일정 취소·되돌리기 안내 | `event_service.delete_event()` / `restore_event()` |

통수는 응답에 `invitesQueued`(생성·수정) / `sent`(초대 다이얼로그)로 실어 보냅니다. **저장하지 않는 응답 전용 필드**입니다 — `confirm()`의 `notifiedCount`와 같은 방식.

측정: 한 통에 2초 걸리는 가짜 SMTP를 물려도 `POST /api/events`는 초대 0명·1명·8명·20명 모두 **8ms 안팎**으로 응답하고, 메일은 그 뒤에 20통 전부 나갔습니다.

**화면 안내**: 생성 직후에는 곧바로 새 일정 페이지로 이동해 버려서, 만들기 창에서 스낵바를 띄워도 같이 사라집니다. `ui.js`의 `queueSnackbar()`가 `sessionStorage`에 맡겨 두고 다음 페이지의 `flushQueuedSnackbar()`가 대신 띄웁니다 (한 번 띄우면 지웁니다).

> 문구는 "보냈습니다"가 아니라 **"N명에게 초대 메일을 보내는 중입니다. 이 페이지를 나가도 전송됩니다."** 입니다 — 응답 시점에 아직 안 나갔으므로 완료형으로 쓰면 거짓말입니다.

### 17.3 발신자 표시

```python
def _host_sender_name(owner):
    return f"{_owner_name(owner)} ({APP_NAME})"  # "홍길동 (Commeet)"
```

초대는 호스트가 보내는 것이므로 받는 사람 메일함에 계정 주소 대신 호스트 이름이 뜨도록 `formataddr`로 표시 이름을 붙입니다. `MAIL_REPLY_TO`가 있으면 회신 주소를 따로 지정합니다.

### 17.4 시간 표기

```python
MEETING_TZ = ZoneInfo("Asia/Seoul")  # 이 서비스 사용자는 전부 한국


def _format_meeting_time(start, end=None):
    local_start = start.astimezone(MEETING_TZ)
    weekday = "월화수목금토일"[local_start.weekday()]
    ...
```

### 17.5 메일 종류

| 함수 | 트리거 |
|---|---|
| `send_verification_code_email` | 가입 1단계 |
| `send_event_invite_email` / `send_group_invite_email` | 생성·수정 시 초대, 초대 보내기 |
| `send_someone_responded_email` | 새 응답 (알림 켜짐 또는 그룹) |
| `send_threshold_reached_email` | N명 응답 도달 |
| `send_meeting_confirmed_email` | 일정 확정 |
| `send_meeting_unassigned_email` | 배정 실패자 |
| `send_meeting_cancelled_email` | 확정 취소 |
| `send_test_email` | 관리자 테스트 |

임계값 알림은 **1회만** 발송됩니다 — 발송 후 `sendEmailAfterXResponses`를 `-1`로 덮어씁니다.

`SendInvitePayload`는 `max_length=20`으로 제한되어 대량 발송기로 악용되는 것을 막고, 초대 발송 권한은 **소유자에게만** 있습니다 (소유자 없는 게스트 생성 이벤트는 누구나 수정할 수 있지만 메일은 보낼 수 없음 — 오픈 릴레이 방지).

---

## 18. 프런트엔드 공통 인프라

### 18.1 모듈 시스템 없음

번들러도 `import`도 없습니다. `base.html`이 `api.js` → `ui.js` 순으로 로드하고, 페이지별 스크립트가 `{% block extra_scripts %}`로 뒤에 붙습니다. **함수는 전부 전역**입니다.

이 때문에 §14의 이름 충돌 문제가 생길 수 있습니다.

### 18.1.1 화면이 낡은 채로 남지 않게

**증상**: 일정을 만들고 뒤로 가면 대시보드에 **방금 만든 일정이 없었습니다.** 새로고침해야 나타났습니다.

원인은 두 가지가 겹칠 수 있습니다.

**1) 브라우저 HTTP 캐시.** API 응답에 `Cache-Control`이 없으면 크롬은 자체 기준(heuristic freshness)으로 GET 응답을 재사용합니다. 실제로 뒤로 갈 때 `/api/user/events` 요청은 **나갔고 200도 받았는데 본문이 생성 전 목록**이었습니다 — 캐시에서 나온 것입니다. `app/main.py`의 `no_store_api_middleware`가 `/api/`로 시작하는 응답에 `Cache-Control: no-store`를 붙여 막습니다. 정적 파일은 그대로 둡니다 (캐시되는 편이 맞고 파일명에 해시가 붙습니다).

**2) bfcache.** 브라우저가 페이지를 통째로 얼려 뒀다 되살리면 스크립트가 **다시 실행되지 않아** 요청조차 나가지 않습니다. `ui.js`의 `onPageRestore(fn)`에 등록해 두면 `pageshow`의 `persisted`가 참일 때 다시 불러옵니다.

```js
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;          // 평범한 첫 로드는 각 페이지가 알아서 불러옴
  pageRestoreHandlers.forEach((fn) => { try { fn(); } catch (err) {} });
});
```

| 화면 | 복원 시 다시 부르는 것 |
|---|---|
| `/home` | `loadDashboard()` |
| `/contacts` | `loadContacts()` |
| `/trash` | `load()` |
| `/calendar` | `load()` |
| `/e/{id}` · `/g/{id}` | `refreshAll()` (확정 화면에 갔다 오면 배정이 바뀌어 있을 수 있음) |

> 두 가지를 다 막아야 합니다. no-store만 있으면 bfcache 복원 시 요청 자체가 안 나가고, `pageshow`만 있으면 그 요청이 다시 캐시를 맞습니다.

### 18.2 `api.js`

```js
const api = {
  get: (url) => apiRequest("GET", url),
  post: (url, body) => apiRequest("POST", url, body ?? {}),
  put:, patch:, del:
};
```

`apiRequest()`는 항상 `credentials: "same-origin"`으로 세션 쿠키를 실어 보내고, 실패 시 서버의 `detail`을 메시지로 하는 `Error`에 `status`와 `data`를 붙여 던집니다. 그래서 호출부에서 `err.status === 401` 같은 분기가 가능합니다(§5.1의 `init()`).

**파일 업로드만 예외**로 `api`를 쓰지 않고 `fetch`를 직접 씁니다 — `FormData`는 `Content-Type`을 브라우저가 경계 문자열과 함께 설정해야 하는데 `apiRequest`는 JSON으로 고정하기 때문입니다.

### 18.3 `ui.js`

- `showSnackbar(message, type)` — 3.2초 후 자동 제거
- `openDialog(id)` / `closeDialog(id)` — `.open` 클래스 토글
- 전역 클릭 위임: 백드롭 클릭과 `[data-dialog-close]`로 닫기
- 사용자 메뉴 드롭다운, 로그아웃

### 18.4 테마 (다크 모드)

`base.html`의 **`<head>` 안, 스타일시트 링크보다 먼저** 실행되는 인라인 스크립트가 처리합니다:

```js
var stored = localStorage.getItem("pcts_theme");
var theme = stored === "light" || stored === "dark" ? stored
          : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.setAttribute("data-theme", theme);
```

`ui.js`에서 하면 `</body>` 직전에 로드되므로 잘못된 팔레트가 한 번 번쩍입니다. 사용자의 명시적 선택이 항상 우선하고, 없으면 OS 설정을 따릅니다. JS가 꺼져 있어도 CSS의 `prefers-color-scheme` 미디어 쿼리가 자체적으로 동작합니다.

### 18.5 localStorage 키 목록

| 키 | 용도 |
|---|---|
| `pcts_theme` | 테마 선택 |
| `pcts_guest_name_<eventId>` | 이벤트별 게스트 이름 |
| `pcts_dashboard_view` / `pcts_dashboard_sort` / `pcts_dashboard_order` | 대시보드 뷰·정렬 |
| `pcts_contacts_view` / `pcts_contacts_sort` / `pcts_contacts_order` | 연락처 뷰·정렬 |
| `pcts_contact_filters` | 과정/학적상태 필터 (3개 화면 공유) |

> 전부 `pcts_` 프리픽스입니다 — 이름 변경 전의 잔재이며, 바꾸면 기존 사용자의 설정이 초기화되므로 유지했습니다.

---

## 19. CSS 디자인 시스템과 레이아웃 규칙

**파일**: `app/static/css/style.css` (4,317줄, 단일 파일)

### 19.1 토큰

```css
--color-primary: #c80150;      /* POSTECH 크림슨 - 배경/버튼 역할 */
--color-accent:  #c80150;      /* 크림슨 - 텍스트/아이콘/링크 역할 */
--color-navy:    #34495e;      /* 슬레이트 네이비 - 보조 버튼, 선택 상태 */
--color-heading: #34495e;
--color-accent-yellow: #f5c344;  /* "가능(선택)" */
```

`--color-primary`와 `--color-accent`가 라이트 모드에서 같은 값인데도 분리된 이유:

> 단색 버튼 배경으로 잘 읽히는 색이 어두운 페이지의 텍스트로도 잘 읽히는 경우는 드뭅니다(대비 요구가 반대). 다크 모드에서 각각 독립적으로 재조정됩니다.

크림슨을 남발하지 않기 위해 **UI 크롬과 선택 상태는 네이비**가 담당합니다.

POSTECH 푸터는 두 테마에서 **동일하게 어둡습니다** — 공식 마크를 담고 있기 때문입니다.

다크 모드는 WCAG 2.1 AA 대비를 확인하며 토큰을 재정의합니다.

### 19.2 그리드 사이징 변수

```css
--grid-label-w: 64px;   /* 시간 라벨 열 */
--grid-col-min: 64px;   /* 날짜 열 최소 너비 */
--grid-head-h:  56px;
--grid-row-h:   16px;   /* JS가 런타임에 덮어씀 (§5.5) */
```

`buildGridDom()`이 인라인 픽셀 대신 `var(...)`를 쓰는 이유는 미디어 쿼리가 작은 화면에서 이 값을 줄일 수 있게 하기 위해서입니다.

### 19.3 겪은 CSS 함정들

이 프로젝트에서 실제로 발생해 고친 문제들입니다. 새 UI를 만들 때 같은 함정을 피하려면 참고하세요.

**(a) 특이도 함정 — element+class가 class 하나를 이깁니다.**

```css
select.input   { width: 100%; }        /* (0,1,1) */
.list-sort-select { width: auto; }     /* (0,1,0) — 짐 */
```

정렬 셀렉트가 행 전체로 늘어나 뷰 토글을 다음 줄로 밀어냈습니다. 해결:

```css
select.list-sort-select { width: auto; ... }
```

**같은 함정이 두 번 발생했습니다.** 면담 기록의 텍스트 영역도 `textarea.input { min-height: 72px }`에 져서 `textarea.rec-textarea`로 써야 했습니다.

**(b) `min-width: auto` — 그리드/플렉스 아이템의 기본값입니다.**

긴 nowrap 텍스트가 셀을 늘려 레이아웃을 깨뜨립니다. 해결: `min-width: 0` + 고정 `height` + `overflow: hidden`.

**(c) 패딩 셀에는 `aspect-ratio`가 필요합니다.** §10.4 참조.

**(d) 이미지 왜곡 — `flex-shrink: 0`.** 로고가 좁은 화면에서 너비만 압축되고 높이는 고정되어 찌그러졌습니다.

**(e) 카드 액션 정렬 — `margin-top: auto`.** 내용 길이가 다른 카드들의 버튼 줄을 아래로 맞춥니다.

**(f) 전역 리셋 되돌리기.** `ul { list-style: none }` 때문에 `.md-body`에서 불릿을 다시 켜야 했습니다.

### 19.4 "글자 길이로 레이아웃이 변하지 않는다" 규칙

이 앱의 UI 규칙 중 가장 자주 적용된 것입니다. 텍스트가 바뀔 때 주변 요소가 움직이면 안 됩니다.

**고정 폭 중앙 정렬 라벨**:

```css
#finalize-link-label {
  display: inline-block;
  min-width: 122px;      /* 두 라벨 중 넓은 쪽을 예약 */
  text-align: center;
}
```

같은 처리가 `#cal-label`, `#week-label`, `#admin-logs-page-label`에도 적용되어 있습니다. 화살표 버튼이 픽셀 단위로 동일한 위치에 머무는 것을 헤드리스 크롬으로 검증했습니다(8개 상태에서 868.8px 동일).

**고정 크기 모달**:

```css
/* 일부러 max-height가 아니라 height - 내용이 짧든 길든 항상 이 크기 */
.dialog.dialog-xl {
  width: 92vw; max-width: 1300px;
  height: 85vh; max-height: 85vh;
  display: flex; flex-direction: column; overflow: hidden;
}
```

내부 본문이 `flex: 1; min-height: 0; overflow-y: auto`로 스크롤합니다. 참석자를 추가하거나 노트 모드를 바꿔도 모달 크기가 변하지 않습니다.

**한 줄 말줄임**: 사용자 입력 텍스트가 들어가는 제목은 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.

**숫자 정렬**: 금액에 `font-variant-numeric: tabular-nums`를 적용해 자릿수가 바뀌어도 흔들리지 않게 합니다.

### 19.5 "세로로만 길어지지 않는다" 규칙

목록은 너비가 허락하는 만큼 열을 늘립니다:

```css
#contacts-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
.rec-list      { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
```

사이드바 + 메인의 2단 구성:

```css
.contacts-layout { grid-template-columns: 330px minmax(0, 1fr); }
.rec-layout      { grid-template-columns: 340px minmax(0, 1fr); }
```

`minmax(0, 1fr)`이 (b)의 `min-width: auto` 문제를 예방합니다.

### 19.6 반응형 브레이크포인트

`1100px` `1024px` `900px` `768px` `760px` `700px` `560px` `420px`

모바일에서 그리드는 컬럼 영역(`grid-template-areas`)으로 재배치되어 좁은 폭에서 컨트롤이 몇 글자 너비로 찌그러지지 않게 합니다.

터치 드래그에는 `touch-action: none`이 필수입니다 — 없으면 서명하려는 드래그가 페이지 스크롤이 됩니다.

`@media (prefers-reduced-motion: reduce)`로 애니메이션을 끕니다.

---

## 20. 데이터 모델 (MongoDB 컬렉션)

### `users`

```js
{
  _id, email(unique), passwordHash, name, picture,
  isAdmin: bool,
  numEventsCreated: int,
  createdAt,
  calendarOptions: { bufferTime: {enabled, time}, workingHours: {enabled, startTime, endTime} },
  calendarAccounts: {
    "user＠gmail．com_google": {          // 점이 전각으로 치환된 키 (§9.2)
      calendarType: "google", email, picture, enabled,
      subCalendars: { "<calendarId>": {name, enabled} },
      pctsCalendarId: "<전용 Commeet 캘린더 id>",
      oauth: { accessToken, accessTokenExpireDate, refreshToken, scope }
    }
  }
}
```

### `events`

```js
{
  _id, shortId(unique, sparse), ownerId(null 가능 - 게스트 생성),
  name, description, descriptionFormat: "text"|"markdown",
  type: "specific_dates"|"dow"|"group",
  dates: [datetime],        // dow/group은 기준 주
  duration: float(시간),
  timeIncrement: int(분),
  startOnMonday, notificationsEnabled, blindAvailabilityEnabled, collectEmails,
  sendEmailAfterXResponses: int|null|-1,
  remindees: [{email, responded}],
  numResponses: int,
  isArchived, isDeleted, isClosed,
  createdAt,
  finalization: {
    status: "confirmed", capacity, meetingMinutes,
    meetings: [{start, end, participants: [key]}],   // id 없음, 호스트 미포함
    unassigned: [key],
    confirmedAt, confirmedBy,
    googleSyncedEvents: [{userId, accountKey, calendarId, googleEventId, start, end}]
  }
}
```

### `event_responses` — `(eventId, userId)` unique

```js
{
  eventId, userId: "<ObjectId hex>" | "<게스트 이름>",   // 다형적 키
  response: {
    userId: ObjectId|null, name, email,
    availability: [datetime], ifNeeded: [datetime],
    useCalendarAvailability, enabledCalendars,
    manualAvailability: { "<ISO 날짜>": [datetime] }     // 그룹 전용
  }
}
```

### 그 외

| 컬렉션 | 스키마 | 인덱스 |
|---|---|---|
| `attendees` | `{eventId, email, declined}` | `(eventId, email)` unique |
| `folders` | `{userId, name, color, isDeleted}` | `userId` |
| `folder_events` | `{userId, folderId, eventId}` | `(folderId, eventId)` unique, `userId` |
| `contacts` | `{ownerId, email, name, userId, +상세 10필드, createdAt}` | `(ownerId, email)` unique, `ownerId` |
| `pending_signups` | `{email, name, passwordHash, codeHash, expiresAt, tries}` | `email` unique, `expiresAt` **TTL** |
| `access_logs` | `{ts, method, path, statusCode, durationMs, userId, ip, userAgent}` | `ts` **TTL 60일**, `userId` |
| `meeting_records` | `{ownerId, eventId, eventName, meetingStart, date, startTime, endTime, status, enc(암호화), signatureFile, createdAt, updatedAt}` | `ownerId`, `(ownerId, eventId, meetingStart)` unique |

---

## 21. API 레퍼런스

### 인증 `/api/auth`

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/signup/send-code` | 인증 코드 발송 (계정 미생성) |
| POST | `/signup/verify` | 코드 확인 → 계정 생성 + 세션 |
| POST | `/login` | 로그인 |
| POST | `/logout` | 쿠키 삭제 |

### 이벤트 `/api/events`

| 메서드 | 경로 | 비고 |
|---|---|---|
| POST | `` | 생성 (비로그인 가능) |
| GET | `/{id}` | 메타 + 응답자 명단 (시간표 제외) |
| PUT | `/{id}` | 수정 (소유자) |
| DELETE | `/{id}` | 삭제 (소유자, 소프트/하드) |
| GET | `/{id}/ids` | shortId ↔ longId |
| GET | `/{id}/responses?timeMin&timeMax` | 시간 범위 시간표 |
| POST | `/{id}/response` | 응답 저장 (확정 시 409) |
| DELETE | `/{id}/response` | 응답 삭제 |
| POST | `/{id}/rename-user` | 게스트 이름 변경 |
| POST | `/{id}/decline` | 그룹 초대 거절 |
| GET | `/{id}/calendar-availabilities` | 그룹 멤버 구글 바쁜 시간 |
| POST | `/{id}/invite` | 초대 메일 (소유자, 최대 20명) |
| POST | `/{id}/duplicate` | 복제 |
| POST | `/{id}/archive?archived=` | 보관 |

### 확정 `/api/events/{id}/finalize`

`POST /proposal` (최적화 실행) · `POST /confirm` · `POST /cancel` — 모두 호스트 전용

### 사용자 `/api/user`

`GET /profile` · `PATCH /name` · `PATCH /password` · `PATCH /calendar-options` · `GET /events` · `POST /events/{id}/set-folder` · `DELETE ""` · `GET /calendars?timeMin&timeMax`

### 캘린더

`GET /calendar/google/connect` · `GET /calendar/google/callback` · `DELETE|POST /api/user/calendar-accounts[/toggle|/toggle-sub-calendar]`

### 연락처 `/api/contacts`

`GET ""` · `GET /search?q=` · `POST ""?overwrite=` · `PATCH /{id}` · `DELETE /{id}`

### 폴더 `/api/folders`

`GET ""` · `GET /{id}` · `POST ""` · `PATCH /{id}` · `DELETE /{id}`

### 면담 기록 `/api/records`

| 메서드 | 경로 | 비고 |
|---|---|---|
| GET | `` | `?eventId=`로 그 일정의 기록 목록 (짧은 공유 id도 허용) |
| GET | `/draft?eventId&meetingStart` | 저장본 또는 초안 |
| GET | `/{id}` | 단건 |
| POST | `` | 저장 (면담 단위 upsert) |
| PUT | `/{id}/signature` | 서명 dataURL (빈 문자열 = 삭제) |
| PUT | `/{id}/receipt/{index}` | 영수증 multipart |
| GET | `/{id}/file/{kind}` | 복호화 스트리밍 |
| DELETE | `/{id}` | 기록 + 첨부 삭제 |

### 관리자 `/api/admin`

`GET /users` · `GET /users/{id}` · `PATCH /users/{id}/role` · `GET /stats?days=` · `GET /logs?page&pageSize&userId` · `GET /mail-config` · `POST /test-mail`

### 페이지 라우트

`/` `/home` `/settings` `/contacts` `/records/{id}/print` `/admin` `/calendar` `/sign-in` `/sign-up` `/privacy-policy` `/e/{id}` `/e/{id}/finalize` `/g/{id}`

---

## 22. 운영: 환경변수·스크립트·인덱스

### 환경변수 (`.env.example` 참조)

**필수급**

| 변수 | 기본값 | 비고 |
|---|---|---|
| `SESSION_SECRET` | `dev-insecure-secret-change-me` | **반드시 변경.** 바꾸면 전원 로그아웃 + (파생 키 사용 시) 면담 기록 복호화 불가 |
| `MONGO_URI` | `mongodb://localhost:27017` | |
| `DB_NAME` | `commeet` | |
| `BASE_URL` | `http://localhost:8000` | 메일 링크와 OAuth 리다이렉트에 사용 |

**선택**

| 변수 | 기본값 | 효과 |
|---|---|---|
| `ALLOWED_EMAIL_DOMAIN` | `postech.ac.kr` | |
| `RESTRICT_SIGNUP_DOMAIN` | `true` | `false`면 도메인 무관 가입 (OTP는 유지) |
| `GOOGLE_CALENDAR_ENABLED` | `true` | `false`면 연동 기능과 **관련 UI가 전부 사라짐** |
| `GOOGLE_CLIENT_ID` / `_SECRET` | 빈 값 | 없으면 위 값과 무관하게 자동으로 꺼짐 |
| `MAIL_BACKEND` | `gmail` | `gmail` \| `postech` |
| `MAIL_SENDER` / `MAIL_PASSWORD` | 빈 값 | 없으면 콘솔 로그 대체 |
| `MAIL_MAX_CONNECTIONS` | `4` | 여러 명에게 보낼 때 동시에 여는 SMTP 연결 수 |
| `MAIL_VERIFY_DOMAIN` | `true` | 없는 도메인이면 발송을 건너뜀 (판단 불가 시 발송) |
| `MAIL_DNS_TIMEOUT` | `3` | 위 DNS 조회 제한 시간(초) |
| `RECORD_STORAGE_DIR` | 빈 값 | 빈 값이면 `<project>/instance/records` |
| `RECORD_ENCRYPTION_KEY` | 빈 값 | 빈 값이면 `SESSION_SECRET`에서 파생 |
| `GUIDANCE_FEE_CSE` | `30000` | 컴공 학생 1인 단가 |
| `GUIDANCE_FEE_MUUNJAE` | `15000` | 무은재 학부생 1인 단가 |

**프로덕션 권장**: `RECORD_ENCRYPTION_KEY`를 명시적으로 설정하세요.

```bash
uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### 실행

```bash
uv sync
cp .env.example .env
uv run python run.py                              # ENV=development면 --reload
uv run uvicorn app.main:app --reload              # 동등
```

> `--reload` 없이 띄우면 **소스를 고쳐도 반영되지 않습니다.** 문서 작성 중에도 이 때문에 수정한 코드가 적용 안 된 것으로 착각한 적이 있습니다.

### 스크립트

```bash
uv run python scripts/bootstrap_admin.py <email> [email2 ...]   # 최초 관리자
uv run python scripts/demo_records.py [--clean]                 # 면담 기록 데모
uv run python scripts/demo_finalize.py [--clean]                # 일정 확정 데모
uv run python scripts/demo_finalize.py --no-email               # ↑ 메일 안 나가는 변형
```

`--no-email`은 응답자를 전원 게스트(계정·이메일 없음)로 만들어 별도 일정을 추가합니다. 확정 시 메일은 `person["email"]`이 있는 사람에게만 나가므로(`finalize_service._notify`) 이 변형은 **확정해도 발송 0통**입니다. 계정을 만들지 않는 이유는 `users.email` 유니크 인덱스 때문이기도 합니다 — 이메일 없는 사용자는 하나만 존재할 수 있습니다.

두 데모 스크립트 모두 **`finalize_service.confirm()`을 호출하지 않고 DB에 직접 씁니다** — `confirm()`은 참석자 전원에게 실제 메일을 보내고 구글 캘린더 이벤트를 만들기 때문입니다. 각자 고유한 `demoTag`(`commeet-demo`, `commeet-demo-finalize`)를 달아 `--clean`이 자기가 만든 것만 지웁니다.

### 자동 정리

| 대상 | 방식 | 주기 |
|---|---|---|
| 만료된 가입 대기 | TTL 인덱스 | `expiresAt` 도달 즉시 |
| 접속 로그 | TTL 인덱스 | 60일 |
| 구글 캘린더 이벤트 | 백그라운드 태스크 | 방 삭제/재확정/취소 시 |
| 고아 영수증 파일 | `_keep_receipts()` | 기록 저장 시 |

### 이름 변경(PCTS → Commeet) 잔재

마이그레이션 비용 때문에 의도적으로 두었습니다. 바꾸려면 데이터 마이그레이션이 필요합니다.

| 위치 | 값 |
|---|---|
| 쿠키 이름 | `pcts_session` |
| DB 필드 | `calendarAccounts.*.pctsCalendarId` |
| localStorage | `pcts_*` (§18.5) |

> 세션 서명 salt는 이미 `commeet-session`으로 변경되었습니다.

### 미구현 (원본 timeful.app 대비 의도적 제외)

결제(Stripe), Slack/Discord 봇, 광고, 분석(PostHog), 브라우저 확장 API, 가입 폼 슬롯, "날짜만" 폴 모드, 예약 작업 큐(리마인더 메일은 초대 시 1회만 발송).

---

*문서 기준 커밋 시점: `IMPLEMENTATION.md` 최초 작성. 코드를 고치면 해당 섹션도 함께 갱신해 주세요.*
