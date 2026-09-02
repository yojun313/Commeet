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
  (별도 토큰 없음). Commeet 운영 주소: `https://commeet.knpu.re.kr`
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
