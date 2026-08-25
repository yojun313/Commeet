/* Shared between contacts.js (연락처 page) and new-event.js (contact picker
 * used everywhere someone gets invited) - the 과정/학적상태 checkbox filters
 * and the "붙여넣기로 여러 명 추가" parser both live here once instead of
 * being copied into each page script. */

const CONTACT_RELATION_OPTIONS = ["지도학생", "공동지도학생", "연구원", "교수", "기타"];
const CONTACT_DEGREE_OPTIONS = ["박사", "석사", "통합", "학사"];
const CONTACT_STATUS_OPTIONS = ["재학", "휴학", "제적", "졸업", "수료", "수료(연구생)", "정학", "휴학-수료(연구생)"];

// One shared filter preference across all three surfaces (연락처 page,
// new-event contact picker, invite dialog) - persisted so it survives a
// reload/navigation instead of resetting to "everyone" every time.
const CONTACT_FILTER_STORAGE_KEY = "pcts_contact_filters";

function loadSavedContactFilters() {
  try {
    const raw = localStorage.getItem(CONTACT_FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      degrees: Array.isArray(parsed.degrees) ? parsed.degrees : null,
      statuses: Array.isArray(parsed.statuses) ? parsed.statuses : null,
    };
  } catch (e) {
    return null;
  }
}

function saveContactFilters(selectedDegrees, selectedStatuses) {
  try {
    localStorage.setItem(
      CONTACT_FILTER_STORAGE_KEY,
      JSON.stringify({ degrees: [...selectedDegrees], statuses: [...selectedStatuses] })
    );
  } catch (e) {
    // localStorage unavailable (private mode, quota, etc.) - just don't persist.
  }
}

// A contact added the simple "name + email" way has none of these - filters
// only ever narrow contacts that actually have the field being filtered on.
function contactHasRosterDetails(c) {
  return Boolean(c.degree || c.status || c.department || c.relation || c.studentId);
}

function contactMatchesFilters(c, selectedDegrees, selectedStatuses) {
  if (c.degree && !selectedDegrees.has(c.degree)) return false;
  if (c.status && !selectedStatuses.has(c.status)) return false;
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
  const saved = loadSavedContactFilters();

  const persistAndNotify = () => {
    saveContactFilters(selectedDegrees, selectedStatuses);
    onChange();
  };

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
    makeGroup("과정"), CONTACT_DEGREE_OPTIONS, selectedDegrees, persistAndNotify,
    saved ? saved.degrees : null
  );
  buildContactFilterCheckboxes(
    makeGroup("학적상태"), CONTACT_STATUS_OPTIONS, selectedStatuses, persistAndNotify,
    saved ? saved.statuses : null
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
function parseBulkContacts(text) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];

  lines.forEach((line, idx) => {
    const cells = line.split("\t").map((c) => c.trim());
    let record;

    if (cells.length >= BULK_CONTACT_COLUMNS.length) {
      record = {};
      BULK_CONTACT_COLUMNS.forEach((key, i) => {
        record[key] = cells[i] || "";
      });
      record.name = normalizeContactName(record.name);
    } else {
      const email = cells.find((c) => EMAIL_RE.test(c)) || "";
      const phone = cells.find((c) => PHONE_RE.test(c)) || "";
      const name = cells.find((c) => c && c !== email && c !== phone) || "";
      record = { name: normalizeContactName(name), email, phone };
    }

    if (!record.email || !EMAIL_RE.test(record.email)) {
      errors.push(`${idx + 1}번째 줄: 이메일을 찾을 수 없습니다 ("${line.slice(0, 40)}")`);
      return;
    }
    parsed.push(record);
  });

  return { parsed, errors };
}
