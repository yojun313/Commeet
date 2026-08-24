# PCTS

**POSTECH CSE Time Scheduler** - 그룹 일정 조율 서비스. [timeful.app](https://timeful.app) (구 schej.it)의 핵심 스케줄링 기능을
FastAPI + MongoDB + Jinja2로 재구현한 프로젝트입니다.

## 기능

- **일정 만들기**: 특정 날짜(specific dates) 또는 요일(day of week) 기준으로 가능한 시간 투표를 생성
- **가용시간 응답**: 로그인 없이 게스트로도 그리드를 클릭/드래그해서 가능한 시간(가능 / 가능·선택) 표시
- **히트맵**: 응답자가 많이 겹치는 시간일수록 진하게 표시, "최적 시간만 보기" 토글
- **그룹(Group)**: 초대된 멤버만 볼 수 있는 반복 주간 일정. 요일 기준으로 저장되고, 실제 주 단위로 넘겨보기 가능
- **비공개 응답(blind availability)**: 켜면 생성자만 전체 응답을 보고, 나머지는 자기 응답만 볼 수 있음
- **폴더**: 대시보드에서 일정을 폴더로 정리
- **연락처**: 자주 초대하는 사람을 저장. 이름/이메일로 가입자를 검색하거나, 아직 가입하지 않은 사람도 직접 추가 가능
- **Google Calendar 연동** (선택): 설정에서 연결하면 그룹 일정에서 바쁜 시간을 자동으로 채워줌 — 연동 없이도 수동 입력은 항상 동작함
- **이메일 알림**: 가입 인증 코드, 그룹/일정 초대, 응답 알림, N명 응답 시 알림 (Gmail 설정 시 실제 발송, 없으면 콘솔 로그로 대체)

원본과 달리 **결제(Stripe), Slack/Discord 봇, 광고, 분석(PostHog), 브라우저 확장 플러그인 API,
가입 폼(sign-up form) 슬롯 기능, "날짜만" 폴 모드**는 스케줄링 핵심 기능이 아니라고 판단해 제외했습니다.
로그인은 원본의 Google OAuth 대신 **이메일+비밀번호** 방식을 사용하며, 회원가입은
**@postech.ac.kr 이메일로 제한**되고 메일로 받은 6자리 코드로 **이메일 인증**을 거쳐야 합니다
(인증 방식은 `/home/yojun/pcss`의 구현을 따랐습니다: 코드는 평문 저장 없이
`sha256(email|code|SESSION_SECRET)` 해시로만 보관, 10분 만료, 5회 시도 제한).
설정 페이지에서 현재 비밀번호를 확인한 뒤 비밀번호를 변경할 수 있습니다.

## 프로젝트 구조

```
app/
  main.py            FastAPI 앱 생성, 라우터/미들웨어/예외 핸들러 등록
  config.py           환경변수 기반 설정
  core/                경로, Jinja 템플릿 환경, 세션/비밀번호 보안, ObjectId/short-id 유틸, JSON 직렬화
  db/
    mongo.py           MongoDB 연결을 여는 유일한 곳 (Motor AsyncIOMotorClient)
    __init__.py         컬렉션 핸들 모음 - 다른 모든 코드는 여기서 import해서 사용
  schemas/             요청 바디 검증용 Pydantic 모델
  services/            비즈니스 로직 (auth, event, folder, user, contact, calendar, email)
  routes/              FastAPI 라우터 - JSON API(/api/...)와 페이지 라우트(page_routes.py)로 분리
  templates/           Jinja2 템플릿 (base.html + 페이지별 템플릿 + partials + 이메일 템플릿)
  static/              CSS(붉은색 테마 디자인 시스템) / 바닐라 JS (프레임워크 없이 fetch 기반)
```

MongoDB는 `app/db/mongo.py` 한 곳에서만 연결하고, 나머지 코드는 `app/db`가 노출하는
`events_col`, `users_col` 같은 컬렉션 핸들을 import해서 사용합니다.

## 실행 방법

```bash
uv sync
cp .env.example .env   # MONGO_URI 등 채워넣기
uv run python run.py   # 또는: uv run uvicorn app.main:app --reload
```

`http://localhost:8000` 접속. MongoDB는 기본적으로 `mongodb://localhost:27017`, DB 이름은 `pcts`를 사용합니다.

### 선택 사항

- **Google Calendar 연동**: Google Cloud Console에서 OAuth 클라이언트(웹 앱)를 만들고
  `{BASE_URL}/calendar/google/callback`을 승인된 리디렉션 URI로 등록한 뒤, `.env`의
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`을 채우세요. 비워두면 설정 페이지에서 연동 버튼이
  자동으로 숨겨지고 나머지 기능은 정상 동작합니다.
- **이메일 발송**: `.env`에 `MAIL_SENDER`(Gmail 주소)와 `MAIL_PASSWORD`(Google 앱 비밀번호)
  두 개만 채우면 `smtp.gmail.com:587`로 발송됩니다. 비워두면 콘솔 로그로 대체되며,
  이때 회원가입 인증 코드가 서버 콘솔에 출력되므로 메일 없이도 가입 흐름을 테스트할 수 있습니다.
  발송 함수(`app/services/email_service.py`의 `send_email`)는 `/home/yojun/pcss`의
  `app/libs/email.py`와 동일하며, 자격증명만 JSON 파일 대신 `.env`에서 읽습니다.
- **가입 허용 도메인**: `ALLOWED_EMAIL_DOMAIN` (기본 `postech.ac.kr`)
- **문의 이메일**: `SUPPORT_EMAIL` (기본 `yojun313@postech.ac.kr`)

## 디자인

붉은색 계열 색상 테마(`app/static/css/style.css`의 `--color-primary: #c8014f`)와 디렉토리 구조는
`/home/yojun/pcss` 레포의 컨벤션(FastAPI + Jinja2 + Motor, `app/core`, `app/db`, `app/routes`,
`app/services` 분리)을 참고했습니다.
