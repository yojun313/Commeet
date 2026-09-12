/* Shared between contacts.js (연락처 page) and new-event.js (contact picker
 * used everywhere someone gets invited) - the 과정/학적상태 checkbox filters
 * and the "붙여넣기로 여러 명 추가" parser both live here once instead of
 * being copied into each page script. */

const CONTACT_RELATION_OPTIONS = ["지도학생", "공동지도학생", "연구원", "교수", "기타"];
const CONTACT_DEGREE_OPTIONS = ["박사", "석사", "통합", "학사"];
const CONTACT_STATUS_OPTIONS = ["재학", "휴학", "제적", "졸업", "수료", "수료(연구생)", "정학", "휴학-수료(연구생)"];
// 소속학과 선택지. 컴퓨터공학과(주 사용 학과) -> 무은재학부 -> 나머지 가나다순.
const CONTACT_DEPARTMENT_OPTIONS = [
  "컴퓨터공학과",
  "무은재학부",
  "기계공학과",
  "물리학과",
  "반도체공학과",
  "산업경영공학과",
  "생명과학과",
  "수학과",
  "신소재공학과",
  "의공학과",
  "전자전기공학과",
  "화학공학과",
  "화학과",
];

// 필터는 화면을 열 때마다 전체 선택으로 시작합니다. 예전에는 localStorage에
// 저장해 복원했는데, 지난번에 좁혀 둔 필터가 남아 있으면 "연락처가 사라졌다"
// 고 보이는 문제가 잦아 저장을 없앴습니다.

/* 선택 목록을 채웁니다. 연락처 "수정" 창과 "추가" 패널이 같은 항목을 쓰므로
   한 곳에 둡니다 (contacts.js / contact-add.js). */
function fillSelect(id, options) {
  const select = document.getElementById(id);
  if (!select) return;
  select.innerHTML = `<option value="">(선택 안 함)</option>`;
  options.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt;
    el.textContent = opt;
    select.appendChild(el);
  });
}

// A contact added the simple "name + email" way has none of these - filters
// only ever narrow contacts that actually have the field being filtered on.
function contactHasRosterDetails(c) {
  return Boolean(c.degree || c.status || c.department || c.relation || c.studentId);
}

// 목록에 없는 값(예: 과정 "방문학생")을 가진 연락처는 어떤 체크박스로도
// 되돌릴 수 없으므로 걸러내지 않습니다. 필드가 비어 있는 연락처를 남겨 두는
// 것과 같은 이유입니다 - 필터는 "아는 값을 좁히는" 것이지 "모르는 값을
// 숨기는" 것이 아닙니다.
function contactMatchesFilters(c, selectedDegrees, selectedStatuses) {
  if (c.degree && CONTACT_DEGREE_OPTIONS.includes(c.degree) && !selectedDegrees.has(c.degree)) {
    return false;
  }
  if (c.status && CONTACT_STATUS_OPTIONS.includes(c.status) && !selectedStatuses.has(c.status)) {
    return false;
  }
  return true;
}

// Renders one row of checkboxes into `root`, keeping `selectedSet` in sync
// and calling `onChange` on every toggle. Defaults to "everyone checked"
// unless `initiallyChecked` (a saved preference) says otherwise.
function buildContactFilterCheckboxes(root, options, selectedSet, onChange, initiallyChecked) {
  root.innerHTML = "";
  const checkedSet = initiallyChecked ? new Set(initiallyChecked) : new Set(options);
  options.forEach((opt) => {
    const isChecked = checkedSet.has(opt);
    if (isChecked) selectedSet.add(opt);
    const label = document.createElement("label");
    label.className = "checkbox-row";
    label.style.cssText = "display: inline-flex; width: auto; margin: 0 14px 6px 0;";
    label.innerHTML = `<input type="checkbox" ${isChecked ? "checked" : ""} /><span class="checkbox-copy">${opt}</span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selectedSet.add(opt);
      else selectedSet.delete(opt);
      onChange();
    });
    root.appendChild(label);
  });
}

// Builds (or hides) a full 과정/학적상태 filter bar into `root` for browsing
// `contacts`, calling `onChange()` on every toggle. Used identically by the
// 연락처 page, the new-event contact picker, and the invite-by-email dialog,
// so all three filter the same way instead of drifting apart. Returns a
// predicate - `contacts.filter(predicate)` gives the currently-visible set.
// If `root` is missing or none of `contacts` have roster details, the bar is
// hidden/skipped and the predicate matches everyone (no-op filter).
function setupContactFilterBar(root, contacts, onChange) {
  if (!root || !contacts.some(contactHasRosterDetails)) {
    if (root) root.style.display = "none";
    return () => true;
  }

  root.style.display = "";
  root.innerHTML = "";
  const selectedDegrees = new Set();
  const selectedStatuses = new Set();

  const makeGroup = (labelText) => {
    const group = document.createElement("div");
    group.className = "contact-filter-group";
    const label = document.createElement("div");
    label.className = "contact-filter-label";
    label.textContent = labelText;
    const opts = document.createElement("div");
    group.appendChild(label);
    group.appendChild(opts);
    root.appendChild(group);
    return opts;
  };

  buildContactFilterCheckboxes(
    makeGroup("과정"), CONTACT_DEGREE_OPTIONS, selectedDegrees, onChange, null
  );
  buildContactFilterCheckboxes(
    makeGroup("학적상태"), CONTACT_STATUS_OPTIONS, selectedStatuses, onChange, null
  );

  return (c) => contactMatchesFilters(c, selectedDegrees, selectedStatuses);
}

/* ------------------------------------------------------------------ */
/* Bulk paste parsing                                                  */
/* ------------------------------------------------------------------ */

// Matches the column order of a typical department advisee-roster export:
// 구분  과정  대학원  학과  학년  학기  학번  이름  학적상태  이메일  전화번호
const BULK_CONTACT_COLUMNS = [
  "relation", "degree", "gradSchool", "department",
  "year", "semester", "studentId", "name", "status", "email", "phone",
];
const EMAIL_RE = /\S+@\S+\.\S+/;
const PHONE_RE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;

// 학사 시스템의 표 머리글. 표를 헤더까지 함께 복사하면 한 줄 딸려 오는데,
// 명단 줄이 아니므로 "이메일이 없다"고 나무랄 대상이 아닙니다.
const ROSTER_HEADER_LABELS = new Set([
  "지도학생유형", "구분", "과정", "소속", "대학원", "소속학과", "학과",
  "학년", "학기", "학번", "이름", "성명", "학적변동", "학적상태",
  "email", "e-mail", "이메일", "메일", "연락처", "전화번호", "휴대전화",
]);

/** 칸 안에서 이메일 부분만 꺼냅니다. 칸 전체를 그대로 쓰면 공백으로
 *  구분된 줄을 붙여넣었을 때 줄 전체가 이메일로 들어갑니다. */
function extractEmail(text) {
  const found = (text || "").match(EMAIL_RE);
  return found ? found[0] : "";
}

/* 붙여넣은 줄이 **명단 행으로 보이는지** 판단합니다.
 *
 * 학사 시스템 화면을 통째로 복사하면 메뉴("홈", "ERP 결재")와 검색 조건
 * 라벨("과정", "재학", "학번")이 한 줄에 하나씩 40줄 넘게 딸려 옵니다.
 * 예전에는 그 줄들까지 전부 "이메일을 찾을 수 없습니다"로 쏟아져서, 정작
 * 확인해야 할 진짜 명단 줄의 문제가 그 안에 묻혔습니다.
 *
 * 명단 행의 조건은 둘 중 하나입니다 - 이메일이 들어 있거나, 탭으로 나뉜
 * 칸이 둘 이상이거나. 화면 장식은 둘 다 아니어서 조용히 걸러집니다.
 */
function looksLikeContactRow(cells, line) {
  if (EMAIL_RE.test(line)) return true;
  return cells.length >= 2;
}

/** 표 머리글 줄인지. 값이 아니라 열 이름이 늘어선 줄입니다. */
function looksLikeHeaderRow(cells) {
  const hits = cells.filter((c) => ROSTER_HEADER_LABELS.has(c.toLowerCase())).length;
  return hits >= 2;
}

function normalizeContactName(name) {
  const trimmed = (name || "").trim();
  // Only "성, 이름" (comma-separated) style names get their space collapsed
  // ("최, 윤호" -> "최윤호") - a plain space-separated name like "John Doe"
  // must NOT lose its space, so this only kicks in when a comma is present.
  if (trimmed.includes(",")) {
    return trimmed.replace(/,/g, " ").replace(/\s+/g, "");
  }
  return trimmed;
}

// Parses pasted, newline-separated rows into contact records. Each line can
// either be the full 11-column roster format above, or just be a couple of
// cells (e.g. "이름<TAB>이메일") - whichever cell looks like an email is
// used as the email, and the remaining non-phone cell as the name.
//
// 명단 행이 아닌 줄(화면 메뉴, 검색 조건, 표 머리글)은 조용히 건너뛰고
// `skipped`로만 세어 돌려줍니다. 오류는 **명단 행인데 이메일이 없는 경우**
// 에만 냅니다 - 그래야 정말 손봐야 할 줄이 눈에 들어옵니다.
function parseBulkContacts(text) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];
  let skipped = 0;

  lines.forEach((line, idx) => {
    const cells = line.split("\t").map((c) => c.trim());

    if (!looksLikeContactRow(cells, line) || looksLikeHeaderRow(cells)) {
      skipped++;
      return;
    }

    let record;
    if (cells.length >= BULK_CONTACT_COLUMNS.length) {
      record = {};
      BULK_CONTACT_COLUMNS.forEach((key, i) => {
        // 없는 칸은 그대로 빈 값입니다 - 연락처에서 전부 선택 항목입니다.
        record[key] = cells[i] || "";
      });
      record.name = normalizeContactName(record.name);
      record.email = extractEmail(record.email);
      if (!record.email) {
        // 열이 하나 늘거나 줄어 자리가 밀렸을 수 있습니다. 자리를 고집하지
        // 않고 줄 안에서 이메일처럼 생긴 칸을 찾아봅니다.
        record.email = cells.map(extractEmail).find(Boolean) || "";
      }
    } else {
      const email = cells.map(extractEmail).find(Boolean) || "";
      const phone = cells.find((c) => PHONE_RE.test(c)) || "";
      const name = cells.find((c) => c && !c.includes(email) && c !== phone) || "";
      record = { name: normalizeContactName(name), email, phone };
    }

    if (!record.email) {
      // 이메일은 연락처를 구분하는 열쇠라(같은 주소면 같은 사람) 비워 둘 수도,
      // 학번 같은 것으로 지어낼 수도 없습니다 - 지어낸 주소로 초대가 나가면
      // 엉뚱한 사람에게 갑니다. 누구인지 짚어 주고 건너뜁니다.
      const who = record.name || record.studentId || line.slice(0, 30);
      errors.push(`${idx + 1}번째 줄 ${who}: 이메일이 없어 건너뛰었습니다.`);
      return;
    }
    parsed.push(record);
  });

  return { parsed, errors, skipped };
}
