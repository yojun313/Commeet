function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function initial(text) {
  return (text || "?").trim().charAt(0).toUpperCase() || "?";
}

async function createContact(email, name, details) {
  return api.post("/api/contacts", Object.assign({ email, name: name || "" }, details || {}));
}

async function addContact(email, name) {
  await createContact(email, name);
  document.getElementById("contact-search").value = "";
  document.getElementById("search-results").innerHTML = "";
  showSnackbar("연락처에 추가했습니다.", "success");
  await loadContacts();
}

/* ------------------------------------------------------------------ */
/* Search registered users                                             */
/* ------------------------------------------------------------------ */

let searchTimer = null;

function renderSearchResults(results, query) {
  const root = document.getElementById("search-results");
  root.innerHTML = "";

  if (!query) return;

  if (!results.length) {
    root.innerHTML = `<p class="hint">"${esc(query)}"와 일치하는 가입자가 없습니다. 아래에서 직접 추가할 수 있어요.</p>`;
    document.getElementById("manual-add").open = true;
    const nameField = document.getElementById("manual-name");
    const emailField = document.getElementById("manual-email");
    // Pre-fill whichever field the query looks like, so the manual form is
    // one step away rather than a fresh start.
    if (query.includes("@")) emailField.value = query;
    else nameField.value = query;
    return;
  }

  results.forEach((u) => {
    const row = document.createElement("div");
    row.className = "contact-row";
    row.innerHTML = `
      <span class="avatar sm">${esc(initial(u.name || u.email))}</span>
      <div class="info">
        <div class="name">${esc(u.name || "(이름 없음)")}<span class="badge" style="margin-left:6px;">가입자</span></div>
        <div class="email">${esc(u.email)}</div>
      </div>
    `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm " + (u.alreadyAdded ? "btn-ghost" : "btn-primary");
    btn.textContent = u.alreadyAdded ? "추가됨" : "추가";
    btn.disabled = u.alreadyAdded;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await addContact(u.email, u.name);
      } catch (err) {
        showSnackbar(err.message, "error");
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
    root.appendChild(row);
  });
}

async function runSearch(query) {
  if (!query) {
    document.getElementById("search-results").innerHTML = "";
    return;
  }
  try {
    const results = await api.get(`/api/contacts/search?q=${encodeURIComponent(query)}`);
    renderSearchResults(results, query);
  } catch (err) {
    showSnackbar(err.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* Bulk paste add                                                      */
/* ------------------------------------------------------------------ */

async function submitBulkAdd() {
  const textarea = document.getElementById("bulk-add-textarea");
  const errorEl = document.getElementById("bulk-add-error");
  const previewEl = document.getElementById("bulk-add-preview");
  errorEl.textContent = "";

  const { parsed, errors } = parseBulkContacts(textarea.value);
  if (!parsed.length) {
    errorEl.textContent = errors.length ? errors.join("\n") : "붙여넣은 내용이 없습니다.";
    return;
  }

  let added = 0;
  let updated = 0;
  const failures = [];
  for (const record of parsed) {
    const { name, email, ...details } = record;
    try {
      // overwrite=true: an email already in the address book is refreshed
      // rather than rejected, so the same roster can be pasted repeatedly.
      const res = await api.post(
        "/api/contacts?overwrite=true",
        Object.assign({ email, name: name || "" }, details)
      );
      if (res && res.created === false) updated++;
      else added++;
    } catch (err) {
      failures.push(`${name || email}: ${err.message}`);
    }
  }

  errorEl.textContent = [...errors, ...failures].join("\n");
  const summary = [added ? `${added}명 추가` : "", updated ? `${updated}명 갱신` : ""]
    .filter(Boolean)
    .join(" · ");
  previewEl.textContent = `${summary || "변경 없음"} (총 ${parsed.length}건 시도)`;

  if (added || updated) {
    showSnackbar(`${summary}했습니다.`, "success");
    textarea.value = "";
    await loadContacts();
    if (!failures.length && !errors.length) document.getElementById("bulk-add").open = false;
  }
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

// Same optional detail fields on the "직접 입력해서 추가하기" form, so a new
// contact can be created with the full record instead of name+email only.
const MANUAL_FIELD_IDS = {
  relation: "manual-relation",
  degree: "manual-degree",
  gradSchool: "manual-gradschool",
  department: "manual-department",
  year: "manual-year",
  semester: "manual-semester",
  studentId: "manual-studentid",
  status: "manual-status",
  phone: "manual-phone",
  memo: "manual-memo",
};

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

function populateEditDropdowns() {
  [["ec-degree", CONTACT_DEGREE_OPTIONS], ["ec-status", CONTACT_STATUS_OPTIONS],
   ["ec-relation", CONTACT_RELATION_OPTIONS],
   ["manual-degree", CONTACT_DEGREE_OPTIONS], ["manual-status", CONTACT_STATUS_OPTIONS],
   ["manual-relation", CONTACT_RELATION_OPTIONS]].forEach(([id, opts]) => fillSelect(id, opts));
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

function renderContactList() {
  const list = document.getElementById("contacts-list");
  const visible = sortItems(
    allContacts.filter(contactFilterPredicate),
    contactSortMode,
    CONTACT_COMPARATORS,
    contactManualOrder,
    (c) => c._id
  );
  document.getElementById("contact-count").textContent = visible.length;

  list.classList.toggle("view-list", contactViewMode === "list");
  list.innerHTML = "";
  if (!visible.length) {
    list.innerHTML = allContacts.length
      ? `<div class="empty-state">필터 조건에 맞는 연락처가 없습니다.</div>`
      : `<div class="empty-state">아직 저장된 연락처가 없습니다.</div>`;
    return;
  }
  visible.forEach((c) => list.appendChild(contactRow(c)));
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

document.addEventListener("DOMContentLoaded", () => {
  populateEditDropdowns();
  syncContactViewToggle();
  buildSortSelect(
    document.getElementById("contact-sort-select"),
    CONTACT_SORT_OPTIONS,
    contactSortMode
  );
  loadContacts();

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

  document.getElementById("contact-search").addEventListener("input", (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(query), 250);
  });

  document.getElementById("manual-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("manual-error");
    errorEl.textContent = "";
    const name = document.getElementById("manual-name").value.trim();
    const email = document.getElementById("manual-email").value.trim();
    const details = {};
    Object.entries(MANUAL_FIELD_IDS).forEach(([field, id]) => {
      const el = document.getElementById(id);
      if (el && el.value.trim()) details[field] = el.value.trim();
    });
    try {
      await createContact(email, name, details);
      showSnackbar("연락처에 추가했습니다.", "success");
      document.getElementById("manual-add-form").reset();
      document.getElementById("manual-details").open = false;
      document.getElementById("manual-add").open = false;
      document.getElementById("contact-search").value = "";
      document.getElementById("search-results").innerHTML = "";
      await loadContacts();
    } catch (err) {
      errorEl.textContent = err.message || "추가하지 못했습니다.";
    }
  });

  document.getElementById("bulk-add-textarea").addEventListener("input", (e) => {
    const preview = document.getElementById("bulk-add-preview");
    if (!e.target.value.trim()) {
      preview.textContent = "";
      return;
    }
    const { parsed } = parseBulkContacts(e.target.value);
    preview.textContent = `${parsed.length}명 인식됨`;
  });
  document.getElementById("bulk-add-submit").addEventListener("click", submitBulkAdd);
});
