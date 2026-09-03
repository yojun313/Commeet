# POVIS 자동 입력 확장 — 맥 세션 인수인계

이 문서는 우분투 서버의 Claude Code 세션에서 넘어온 것입니다. 맥 세션의 임무는
**POVIS 화면 구조 파악 하나**이고, 확장 개발과 Commeet API 작업은 서버 세션에서
이어서 합니다.

## 배경

- Commeet(이 저장소)은 교수용 면담 일정 조율 + 면담 기록 웹앱. 이 서버에서 운영.
- 교수는 면담 후 Commeet에 기록을 남기고, 같은 내용을 학교 포털 **POVIS**의
  지도면담입력 화면에 다시 손으로 옮겨 적어야 함. 이 이중 입력을 없애는 것이 목표.
- 방식은 **크롬 확장**으로 결정됨. 이유: POVIS는 학교 SSO 뒤에 있어 외부
  자동화(Playwright 등)는 로그인 처리를 떠안게 되지만, 확장은 사용자가 이미
  로그인한 브라우저 세션 위에서 동작하므로 인증을 건드릴 필요가 없음.

## 맥 세션이 할 일

Claude in Chrome 확장으로 사용자의 실제 Chrome을 조작한다. **POVIS 로그인은
사용자가 직접** 하고, 확장 설정에서 POVIS 도메인 권한을 허용받은 뒤:

1. POVIS → 학사 → 학생정보 → 지도학생면담 → **지도면담입력** 화면으로 이동
   (면담일정등록 / 학생신청면담결과등록 메뉴도 같은 그룹에 있음)
2. 다음을 확인하고 **파일로 저장**한다:
   - **프레임 구조**: 입력 화면이 iframe 안인지, 몇 겹인지, 각 프레임의 URL 패턴
   - **입력 필드**: 면담 내용을 적는 필드들의 정확한 셀렉터(id/name/class),
     일반 `<textarea>`인지 자체 리치 에디터인지
   - **항목 구성**: 입력 항목이 학업지도/생활지도/진로지도/기타사항처럼 나뉘어
     있는지, 자유 서술 한 칸인지 (Commeet 기록은 이 네 갈래로 저장되어 있음)
   - **학생 식별**: 화면 어디에서 학번을 읽을 수 있는지 (자동 매칭의 열쇠)
   - **값 반영 방식**: JS로 `field.value = ...` 후 어떤 이벤트(`input`/`change`)를
     흉내 내야 저장 시 값이 살아남는지 — 가능하면 콘솔에서 실제로 넣어 보고 확인
   - 해당 `<form>`(또는 프레임)의 **outerHTML 전체**와 스크린샷
3. 결과물을 `povis-findings/` 폴더에 모은다:
   `structure.md`(프레임·셀렉터·이벤트 정리), `form.html`(outerHTML), 스크린샷

끝나면 결과 폴더를 서버로 보낸다:
`scp -r povis-findings/ yojun@<서버>:~/Commeet/docs/`

## 확장 설계 (서버 세션에서 결정된 것)

- 데이터 출처: Commeet API `GET /api/records` (면담 기록, 서버에서 복호화되어 내려옴)
- 인증: 확장 `host_permissions`에 Commeet 도메인을 넣어 **기존 세션 쿠키 재사용**
  (별도 토큰 없음). Commeet 운영 주소: `https://commeet.postech.ac.kr`
  (구 주소 `https://commeet.knpu.re.kr`도 병행 운영 중 - 확장의
  `host_permissions`에는 둘 다 넣어 두는 것이 안전)
- 매칭: POVIS 화면의 **학번** → Commeet 기록의 `attendees[].studentId`.
  "학번으로 기록 조회" API는 서버 세션에서 추가 예정.
- Commeet 기록 구조 (참고):
  - 면담 내용: `sharedNotes` 또는 `perStudentNotes[key]`, 각각
    `{academic(학업지도), life(생활지도), career(진로지도), etc(기타사항)}`
  - 일시·장소: `date`, `startTime`, `endTime`, `place`
  - 참석자: `attendees[] = {key, name, studentId, affiliation, present}`

## 주의

- POVIS에 자격증명을 자동 입력하거나 저장하는 코드는 만들지 않는다.
  로그인은 항상 사용자 몫.
- 맥 세션에서는 **조사만** 한다. 실제 필드에 값을 넣는 실험은 저장 버튼을
  누르지 않는 선에서.

---

# 타당성 검증 결과 (2026-09-03, 맥 세션)

교수 계정이 없어 **지도면담입력 화면은 아직 못 봤습니다.** 대신 같은 POVIS
셸의 학생 화면(학사 → 미래설계/면담/SMP신청 → 미래설계,
`/zu4a/zuiep_1000`)에서 구조를 조사했습니다. 아래 결론 중 "플랫폼"에 관한
것은 그대로 옮겨갈 가능성이 높고, "필드 경로"는 그 화면에서 다시 떠야 합니다.

## 결론: 가능. 단, 방법이 하나로 정해진다

POVIS는 **SAPUI5 1.120.21** 앱입니다. 이것이 거의 모든 것을 결정했습니다.

### 유리하게 확인된 것

- **iframe이 없다.** 최상위 문서 하나. 문서가 걱정하던 "몇 겹 프레임" 리스크가
  이 화면에는 아예 없음.
- **CSP 헤더도 meta도 없다.** 스크립트 주입에 걸림돌 없음.
- 입력은 자체 리치 에디터가 아니라 **`sap.m.TextArea`** (속은 평범한 `<textarea>`).
- 필드가 **의미 있는 이름의 JSONModel 경로**에 바인딩되어 있음.

### 값 반영 방식 — 문서가 물었던 항목의 답

**"어떤 이벤트를 흉내 내야 하나"의 답은 "이벤트로는 안 된다"입니다.**

| 방법 | 화면 | UI5 모델 |
|---|---|---|
| `field.value = ...` + `input`/`change` | 새 값 | **옛 값** |
| `control.getModel().setProperty(path, v)` | 새 값 | 새 값 |

DOM에만 쓰면 사용자 눈에는 잘 채워진 것으로 보이는데 모델은 갱신되지 않아,
그대로 저장하면 **옛 값이 전송됩니다.** 에러도 없고 화면도 멀쩡해서 한참 뒤에야
발견되는 종류의 실패입니다. 반드시 모델에 써야 합니다.

저장 버튼은 POVIS 자체 프레임워크를 경유합니다
(`oU4A.f_UIattachEvent(..., 'EV_SAVE', ...)`). 모델이 데이터 소스라는 강한
정황이지만, 저장을 눌러 보지 않았으므로 최종 확인은 아닙니다.

### 필드 식별 — DOM id는 쓰면 안 된다

UI5가 붙이는 DOM id(`__area57-inner`)는 자동 생성이라 로드마다 바뀝니다.
대신 **바인딩 경로**로 찾습니다 — 백엔드 필드명이라 안정적이고, 조회하면
유일하게 매칭됩니다(검증함).

```js
sap.ui.core.Element.registry.forEach(c => {
  const b = c.getBinding && c.getBinding('value');
  if (b?.getPath?.() === path) hit = c;
});
```

미래설계 화면에서 뜬 경로 (참고용 — 교수 화면은 다름):
`/GS_GOAL/ZGOAL`, `Z1_1`, `Z1_S`, `Z1_2`, `Z1_W` … `Z4_W`, `ZMIL`(군복무),
`ZGRAD`(대학원), `ZCAREER`(취업), `ZAGE_30`~`ZAGE_60`

### 확장 구조가 이렇게 정해진다

1. **main world 주입 필수.** 콘텐츠 스크립트의 격리된 world에서는 `window.sap`이
   보이지 않음 → `chrome.scripting.executeScript({ world: "MAIN" })`.
2. **필드는 바인딩 경로로 조회.**
3. **쓰기는 `model.setProperty(path, value)`**, 그리고 넣은 뒤 되읽어
   화면·모델이 실제로 일치하는지 확인 (조용히 어긋나는 것이 가장 위험한 실패).

## 만들어 둔 것: `extension/` 데모

브라우저에 바로 로드되는 MV3 확장. Commeet 서버에는 아직 붙지 않고 하드코딩된
가짜 면담 기록을 씁니다. 설치·사용법은 `extension/README.md`.

- **현재 화면 필드 스캔** — 화면의 입력 필드와 바인딩 경로를 뽑음
  (값은 안 가져오고 글자 수만). **교수 계정이 생기면 지도면담입력 화면에서
  이걸 돌려 매핑표를 만드는 것이 다음 단계입니다.**
- **데모 데이터로 채우기** / **원래대로 되돌리기**
- 저장은 하지 않음. 화면 값만 바꾸며, 서버 반영은 사용자가 POVIS 저장 버튼을
  누를 때만 일어남.

## Commeet API 쪽에서 나온 것 (코드 대조)

- `GET /api/records`는 존재하고, 이 문서의 데이터 구조 설명은
  `record_service._public()` 반환값과 일치함.
- **학번 조회 API는 없음.** 게다가 `studentId`는 암호화된 `enc` blob 안에 있어
  **Mongo 쿼리로 못 거릅니다** — 해당 교수 기록을 전부 복호화한 뒤 파이썬에서
  필터해야 합니다. 교수 1인 기준이라 실용상 문제는 없지만 인덱스로는 안 됩니다.
- **인증이 가장 큰 미결.** "기존 세션 쿠키 재사용"은 그대로는 어려울 수 있음:
  세션 쿠키가 `samesite="lax"`, `httponly=True`이고 CORS가
  `allow_credentials=False`. CSRF 토큰도 없어 지금은 `samesite=lax`가 유일한
  방어라, 이를 풀어 확장을 통과시키는 건 권하지 않음. 대안은 (a) Commeet 탭의
  content script에서 same-origin fetch 후 메시지 전달, (b) 확장 전용 읽기 토큰.
- 문서가 빠뜨린, 틀리기 쉬운 필드들:
  - `notesMode`(`"shared"`|`"individual"`)가 `sharedNotes`/`perStudentNotes` 중
    무엇을 쓸지 결정함.
  - `perStudentNotes`의 키는 학번이 아니라 참석자 `key`. 화면 코드는
    `perStudentNotes[a.key || a.name]`로 **이름 폴백**까지 씀
    (`record-form.js:710`) — 동명이인 주의.
  - `present: false`(불참자), `status: "draft"`(작성 중 초안),
    `undecryptable: true`(복호화 실패, `attendees: []`로 내려옴)를 걸러야 함.

## 남은 일

1. 교수 계정으로 **지도면담입력** 화면에서 필드 스캔 → 매핑표 작성.
   (그 화면이 iframe으로 박혀 있을 가능성은 아직 배제 못 함)
2. Commeet 쪽: 학번 조회 API + 확장 인증 방식 결정.
3. `popup.js`의 `DEMO_RECORD`/`DEMO_MAPPING`을 실제 API 호출로 교체.
