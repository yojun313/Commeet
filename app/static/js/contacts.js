function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function initial(text) {
  return (text || "?").trim().charAt(0).toUpperCase() || "?";
}

/* ------------------------------------------------------------------ */
/* Saved contacts                                                      */
/* ------------------------------------------------------------------ */

function contactDetailLine(contact) {
  const parts = [contact.degree, contact.department, contact.status, contact.studentId].filter(Boolean);
  return parts.join(" · ");
}

function contactRow(contact) {
  const row = document.createElement("div");
  row.className = "contact-row";
  row.dataset.contactId = contact._id;
  const detailLine = contactDetailLine(contact);
  // Avatar + text are wrapped together so the card can stack them above the
  // action buttons in grid view, while still sitting in one row in list view.
  row.innerHTML = `
    <div class="contact-main">
      <label class="contact-check" title="선택">
        <input type="checkbox" ${selectedContacts.has(contact._id) ? "checked" : ""} />
      </label>
      <span class="event-card-grip contact-grip" title="끌어서 순서 변경">
        <i></i><i></i><i></i><i></i><i></i><i></i>
      </span>
      <span class="avatar sm">${esc(initial(contact.name || contact.email))}</span>
      <div class="info">
        <div class="name">
          <span class="contact-name-text">${esc(contact.name)}</span>
          ${contact.registered ? '<span class="badge">가입자</span>' : '<span class="badge badge-muted">미가입</span>'}
        </div>
        <div class="email" title="${esc(contact.email)}">${esc(contact.email)}</div>
        ${detailLine ? `<div class="detail" title="${esc(detailLine)}">${esc(detailLine)}</div>` : ""}
      </div>
    </div>
  `;

  const actions = document.createElement("div");
  actions.className = "contact-actions";

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "btn btn-sm btn-ghost";
  detailBtn.textContent = "자세히";
  detailBtn.addEventListener("click", () => openContactDetail(contact));

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-sm btn-ghost";
  editBtn.textContent = "수정";
  editBtn.addEventListener("click", () => openEditContact(contact));

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn btn-sm btn-ghost";
  delBtn.style.color = "var(--color-danger)";
  delBtn.textContent = "삭제";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`${contact.name}님을 연락처에서 삭제할까요?`)) return;
    await api.del(`/api/contacts/${contact._id}`);
    await loadContacts();
  });

  actions.appendChild(detailBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  row.appendChild(actions);

  // 체크박스는 click에서 직접 처리합니다 - change 이벤트에는 Shift/Ctrl 상태가
  // 실려 오지 않아 범위 선택을 알 수 없습니다. 기본 토글은 막고 상태를
  // 우리가 관리한 뒤 목록을 다시 그립니다 (범위 선택은 여러 줄이 바뀝니다).
  const checkbox = row.querySelector(".contact-check input");
  checkbox.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applySelectionClick(contact._id, e, { fromCheckbox: true });
  });
  // 체크박스를 누르는 것이 카드 드래그로 이어지지 않게 합니다.
  row.querySelector(".contact-check").addEventListener("pointerdown", (e) =>
    e.stopPropagation()
  );

  // 카드의 빈 곳을 눌러도 선택됩니다 (탐색기처럼). 버튼·링크·드래그 손잡이
  // 위에서는 각자의 동작이 우선입니다.
  row.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, label, .contact-grip")) return;
    if (e.shiftKey) e.preventDefault(); // Shift+클릭의 텍스트 선택 방지
    applySelectionClick(contact._id, e);
  });
  row.classList.toggle("is-selected", checkbox.checked);

  row.querySelector(".contact-grip").addEventListener("pointerdown", (e) =>
    startReorderDrag(e, {
      card: row,
      container: document.getElementById("contacts-list"),
      itemSelector: ".contact-row",
      ghostLabel: contact.name || contact.email,
      onDrop: (x, y, reordered) => {
        if (reordered) persistContactOrder();
      },
    })
  );

  return row;
}

// Hand-arranging switches the list to "사용자 정렬"; a sort option would
// otherwise throw the arrangement away on the next render.
function persistContactOrder() {
  contactSortMode = "manual";
  contactManualOrder = readOrderFromDom(
    document.getElementById("contacts-list"),
    ".contact-row",
    "contactId"
  );
  saveSortState(CONTACT_SORT_STORAGE_KEY, contactSortMode, contactManualOrder);
  buildSortSelect(
    document.getElementById("contact-sort-select"),
    CONTACT_SORT_OPTIONS,
    contactSortMode
  );
  showSnackbar("순서를 저장했습니다.", "success");
}

/* ------------------------------------------------------------------ */
/* Detail dialog                                                       */
/* ------------------------------------------------------------------ */

// Field label order for the "자세히" view - only fields the contact
// actually has are rendered, so a plain name+email entry stays short.
const DETAIL_LABELS = [
  ["relation", "구분"],
  ["degree", "과정"],
  ["gradSchool", "대학원"],
  ["department", "학과"],
  ["year", "학년"],
  ["semester", "학기"],
  ["studentId", "학번"],
  ["status", "학적상태"],
  ["phone", "전화번호"],
];

function openContactDetail(contact) {
  document.getElementById("cd-title").textContent = contact.name || contact.email;

  const rows = [
    `<div class="cal-detail-row"><span class="cal-detail-label">이메일</span><span>${esc(contact.email)}</span></div>`,
    `<div class="cal-detail-row"><span class="cal-detail-label">가입 여부</span><span>${contact.registered ? "가입자" : "미가입"}</span></div>`,
  ];
  DETAIL_LABELS.forEach(([field, label]) => {
    if (contact[field]) {
      rows.push(
        `<div class="cal-detail-row"><span class="cal-detail-label">${label}</span><span>${esc(contact[field])}</span></div>`
      );
    }
  });
  if (contact.memo) {
    rows.push(
      `<div class="cal-detail-row contact-memo-row"><span class="cal-detail-label">메모</span><span>${esc(contact.memo)}</span></div>`
    );
  }
  document.getElementById("cd-body").innerHTML = rows.join("");

  const editBtn = document.getElementById("cd-edit-btn");
  editBtn.onclick = () => {
    closeDialog("contact-detail-dialog");
    openEditContact(contact);
  };
  openDialog("contact-detail-dialog");
}

/* ------------------------------------------------------------------ */
/* Edit dialog                                                         */
/* ------------------------------------------------------------------ */

// Free-text fields map straight to an <input>; 과정/학적상태 are fixed
// option sets (see contact-filters.js), so they're <select> dropdowns
// instead - picked from the list rather than typed, same as the filter bar.
const EDIT_FIELD_IDS = {
  relation: "ec-relation",
  degree: "ec-degree",
  gradSchool: "ec-gradschool",
  department: "ec-department",
  year: "ec-year",
  semester: "ec-semester",
  studentId: "ec-studentid",
  status: "ec-status",
  phone: "ec-phone",
  memo: "ec-memo",
};

// 수정 창의 선택 목록만 채웁니다 - 추가 패널 쪽은 ContactAdd.init()이 맡습니다.
function populateEditDropdowns() {
  [["ec-degree", CONTACT_DEGREE_OPTIONS], ["ec-status", CONTACT_STATUS_OPTIONS],
   ["ec-relation", CONTACT_RELATION_OPTIONS]].forEach(([id, opts]) => fillSelect(id, opts));
}

let editingContactId = null;

function openEditContact(contact) {
  editingContactId = contact._id;
  document.getElementById("edit-contact-error").textContent = "";
  document.getElementById("ec-name").value = contact.name || "";
  document.getElementById("ec-email").value = contact.email || "";
  Object.entries(EDIT_FIELD_IDS).forEach(([field, id]) => {
    document.getElementById(id).value = contact[field] || "";
  });
  openDialog("edit-contact-dialog");
}

async function submitEditContact() {
  const errorEl = document.getElementById("edit-contact-error");
  errorEl.textContent = "";

  const name = document.getElementById("ec-name").value.trim();
  const email = document.getElementById("ec-email").value.trim();
  const details = {};
  Object.entries(EDIT_FIELD_IDS).forEach(([field, id]) => {
    details[field] = document.getElementById(id).value.trim();
  });

  try {
    await api.patch(`/api/contacts/${editingContactId}`, Object.assign({ name, email }, details));
    closeDialog("edit-contact-dialog");
    showSnackbar("연락처를 수정했습니다.", "success");
    await loadContacts();
  } catch (err) {
    errorEl.textContent = err.message || "수정하지 못했습니다.";
  }
}

let allContacts = [];
let contactFilterPredicate = () => true;

/* 선택된 연락처 id. 정렬·필터·보기 방식을 바꿔도 유지되지만, 렌더할 때마다
   **화면에 보이는 것만** 남깁니다 - 필터로 가려진 연락처가 선택된 채로 남아
   있으면 "선택 삭제"가 보이지도 않는 사람을 지우게 됩니다. */
const selectedContacts = new Set();

/* 범위 선택(Shift)의 기준점. 마지막으로 "직접" 클릭한 연락처 id입니다.
   화면에 안 보이면(필터로 가려짐) 기준으로 쓰지 않습니다. */
let selectionAnchorId = null;

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.userAgent);
const MODIFIER_LABEL = IS_MAC ? "⌘" : "Ctrl";

/* 윈도우 탐색기와 같은 규칙:
 *   그냥 클릭        - 이것만 선택 (나머지 해제)
 *   Ctrl(⌘) + 클릭  - 이것만 켜고 끄기 (나머지 유지)
 *   Shift + 클릭     - 기준점부터 여기까지 범위 선택
 *
 * 단, 체크박스를 직접 누를 때는 "그냥 클릭"도 켜고 끄기입니다 - 체크박스를
 * 하나 켰다고 앞서 켠 것들이 사라지면 누구도 예상하지 못합니다.
 */
function applySelectionClick(id, event, { fromCheckbox = false } = {}) {
  const visible = visibleContacts().map((c) => c._id);
  // Shift+클릭은 이메일 같은 글자를 함께 선택해 버리는데, 파랗게 칠해진
  // 글자가 남아 있으면 무엇이 선택된 건지 헷갈립니다.
  if (event.shiftKey) window.getSelection().removeAllRanges();

  if (event.shiftKey && selectionAnchorId && visible.includes(selectionAnchorId)) {
    const a = visible.indexOf(selectionAnchorId);
    const b = visible.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      // 탐색기처럼 범위 선택은 기존 선택을 대체합니다 (Ctrl을 함께 누르면 더함).
      if (!(event.ctrlKey || event.metaKey)) selectedContacts.clear();
      visible.slice(from, to + 1).forEach((cid) => selectedContacts.add(cid));
      rerenderKeepingFocus(id, fromCheckbox);
      return;
    }
  }

  if (event.ctrlKey || event.metaKey || fromCheckbox) {
    if (selectedContacts.has(id)) selectedContacts.delete(id);
    else selectedContacts.add(id);
  } else {
    const onlyThis = selectedContacts.size === 1 && selectedContacts.has(id);
    selectedContacts.clear();
    // 이미 이것 하나만 선택된 상태에서 다시 누르면 해제 (토글처럼 동작).
    if (!onlyThis) selectedContacts.add(id);
  }
  selectionAnchorId = id;
  rerenderKeepingFocus(id, fromCheckbox);
}

/* 선택이 바뀌면 목록 전체를 다시 그립니다 (범위 선택은 여러 줄이 한꺼번에
   바뀌므로). 다시 그리면 방금 누른 체크박스가 새 요소로 교체되어 키보드
   포커스가 사라지므로, 같은 자리에 포커스를 돌려놓습니다. */
function rerenderKeepingFocus(id, hadFocus) {
  renderContactList();
  if (!hadFocus) return;
  const box = document.querySelector(
    `.contact-row[data-contact-id="${id}"] .contact-check input`
  );
  if (box) box.focus();
}

const CONTACT_VIEW_STORAGE_KEY = "pcts_contacts_view";
let contactViewMode =
  localStorage.getItem(CONTACT_VIEW_STORAGE_KEY) === "list" ? "list" : "grid";

const CONTACT_SORT_STORAGE_KEY = "pcts_contacts";
const CONTACT_SORT_OPTIONS = [
  ["nameAsc", "이름순 (가나다)"],
  ["emailAsc", "이메일순"],
  ["degreeAsc", "과정순"],
  ["studentIdAsc", "학번순"],
  ["registeredFirst", "가입자 먼저"],
];

// Degrees read in a natural academic order rather than alphabetically.
const DEGREE_RANK = { 박사: 0, 통합: 1, 석사: 2, 학사: 3 };
const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "ko");

const CONTACT_COMPARATORS = {
  nameAsc: byName,
  emailAsc: (a, b) => (a.email || "").localeCompare(b.email || ""),
  degreeAsc: (a, b) => {
    const ra = DEGREE_RANK[a.degree] ?? 99;
    const rb = DEGREE_RANK[b.degree] ?? 99;
    return ra - rb || byName(a, b);
  },
  // Missing student ids sort last rather than jumping to the front.
  studentIdAsc: (a, b) =>
    (a.studentId || "￿").localeCompare(b.studentId || "￿") || byName(a, b),
  registeredFirst: (a, b) => Number(b.registered) - Number(a.registered) || byName(a, b),
};

const savedContactSort = loadSortState(CONTACT_SORT_STORAGE_KEY, "nameAsc");
let contactSortMode = savedContactSort.sort;
let contactManualOrder = savedContactSort.order;

function syncContactViewToggle() {
  document
    .querySelectorAll("#contact-view-toggle button[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === contactViewMode));
}

/* 화면에 보이는 연락처 목록 (정렬·필터 적용 후). 전체 선택과 선택 삭제가
   모두 이 목록을 기준으로 동작합니다. */
function visibleContacts() {
  return sortItems(
    allContacts.filter(contactFilterPredicate),
    contactSortMode,
    CONTACT_COMPARATORS,
    contactManualOrder,
    (c) => c._id
  );
}

function syncSelectionUi() {
  const hint = document.getElementById("contact-select-hint");
  if (hint && !hint.textContent) {
    hint.textContent = `Shift+클릭으로 범위 선택 · ${MODIFIER_LABEL}+클릭으로 하나씩 추가`;
  }
  const visible = visibleContacts();
  const n = selectedContacts.size;
  const all = document.getElementById("contact-select-all");

  document.getElementById("contact-selected-count").textContent = `${n}개 선택됨`;
  const delBtn = document.getElementById("contact-delete-selected");
  delBtn.disabled = n === 0;
  delBtn.textContent = n ? `선택 삭제 (${n})` : "선택 삭제";

  // 일부만 선택된 상태를 체크박스가 스스로 나타내게 합니다.
  all.checked = visible.length > 0 && n === visible.length;
  all.indeterminate = n > 0 && n < visible.length;
  all.disabled = visible.length === 0;
}

async function deleteSelectedContacts() {
  const ids = [...selectedContacts];
  if (!ids.length) return;
  const names = visibleContacts()
    .filter((c) => selectedContacts.has(c._id))
    .map((c) => c.name || c.email);
  const preview = names.slice(0, 5).join(", ") + (names.length > 5 ? ` 외 ${names.length - 5}명` : "");
  if (!confirm(`${ids.length}명을 연락처에서 삭제할까요?\n\n${preview}`)) return;

  const btn = document.getElementById("contact-delete-selected");
  btn.disabled = true;
  try {
    const res = await api.post("/api/contacts/delete", { ids });
    selectedContacts.clear();
    selectionAnchorId = null;
    await loadContacts();
    showSnackbar(`${res.deleted}명을 삭제했습니다.`, "success");
  } catch (err) {
    showSnackbar(err.message || "삭제하지 못했습니다.", "error");
    btn.disabled = false;
  }
}

function renderContactList() {
  const list = document.getElementById("contacts-list");
  const visible = visibleContacts();
  document.getElementById("contact-count").textContent = visible.length;

  // 보이지 않게 된 연락처는 선택에서 뺍니다 (위 selectedContacts 주석 참고).
  const visibleIds = new Set(visible.map((c) => c._id));
  [...selectedContacts].forEach((id) => {
    if (!visibleIds.has(id)) selectedContacts.delete(id);
  });
  if (selectionAnchorId && !visibleIds.has(selectionAnchorId)) selectionAnchorId = null;

  list.classList.toggle("view-list", contactViewMode === "list");
  list.innerHTML = "";
  if (!visible.length) {
    list.innerHTML = allContacts.length
      ? `<div class="empty-state">필터 조건에 맞는 연락처가 없습니다.</div>`
      : `<div class="empty-state">아직 저장된 연락처가 없습니다.</div>`;
    syncSelectionUi();
    return;
  }
  visible.forEach((c) => list.appendChild(contactRow(c)));
  syncSelectionUi();
}

async function loadContacts() {
  allContacts = await api.get("/api/contacts");
  contactFilterPredicate = setupContactFilterBar(
    document.getElementById("contact-filters"),
    allContacts,
    renderContactList
  );
  renderContactList();
}

onPageRestore(loadContacts);

document.addEventListener("DOMContentLoaded", () => {
  populateEditDropdowns();
  syncContactViewToggle();
  buildSortSelect(
    document.getElementById("contact-sort-select"),
    CONTACT_SORT_OPTIONS,
    contactSortMode
  );
  loadContacts();

  document.getElementById("contact-select-all").addEventListener("change", (e) => {
    // 보이는 것만 전체 선택합니다 - 필터를 걸어 둔 채 눌렀을 때 가려진
    // 연락처까지 선택되면 다음 "선택 삭제"가 예상 밖으로 동작합니다.
    selectedContacts.clear();
    if (e.target.checked) visibleContacts().forEach((c) => selectedContacts.add(c._id));
    selectionAnchorId = null;
    renderContactList();
  });

  document
    .getElementById("contact-delete-selected")
    .addEventListener("click", deleteSelectedContacts);

  document.getElementById("contact-sort-select").addEventListener("change", (e) => {
    contactSortMode = e.target.value;
    saveSortState(CONTACT_SORT_STORAGE_KEY, contactSortMode, contactManualOrder);
    buildSortSelect(
      document.getElementById("contact-sort-select"),
      CONTACT_SORT_OPTIONS,
      contactSortMode
    );
    renderContactList();
  });

  document.getElementById("contact-view-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn || btn.dataset.view === contactViewMode) return;
    contactViewMode = btn.dataset.view;
    try {
      localStorage.setItem(CONTACT_VIEW_STORAGE_KEY, contactViewMode);
    } catch (err) {
      /* localStorage unavailable - the choice just won't persist */
    }
    syncContactViewToggle();
    renderContactList();
  });

  document.getElementById("edit-contact-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitEditContact();
  });

  // 검색 / 직접 입력 / 붙여넣기는 공용 모듈이 맡습니다 (contact-add.js).
  // 추가되면 저장된 연락처 목록만 다시 불러오면 됩니다.
  ContactAdd.init({ onAdded: loadContacts });
});
