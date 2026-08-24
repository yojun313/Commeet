function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function initial(text) {
  return (text || "?").trim().charAt(0).toUpperCase() || "?";
}

async function addContact(email, name) {
  await api.post("/api/contacts", { email, name });
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
/* Saved contacts                                                      */
/* ------------------------------------------------------------------ */

function contactRow(contact) {
  const row = document.createElement("div");
  row.className = "contact-row";
  row.innerHTML = `
    <span class="avatar sm">${esc(initial(contact.name || contact.email))}</span>
    <div class="info">
      <div class="name">
        ${esc(contact.name)}
        ${contact.registered ? '<span class="badge" style="margin-left:6px;">가입자</span>' : '<span class="badge badge-muted" style="margin-left:6px;">미가입</span>'}
      </div>
      <div class="email">${esc(contact.email)}</div>
    </div>
  `;

  const actions = document.createElement("div");
  actions.className = "contact-actions";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "btn btn-sm btn-ghost";
  renameBtn.textContent = "이름 수정";
  renameBtn.addEventListener("click", async () => {
    const name = prompt("이름", contact.name);
    if (name === null || !name.trim()) return;
    await api.patch(`/api/contacts/${contact._id}`, { name: name.trim() });
    await loadContacts();
  });

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

  actions.appendChild(renameBtn);
  actions.appendChild(delBtn);
  row.appendChild(actions);
  return row;
}

async function loadContacts() {
  const list = document.getElementById("contacts-list");
  const contacts = await api.get("/api/contacts");
  document.getElementById("contact-count").textContent = contacts.length;

  list.innerHTML = "";
  if (!contacts.length) {
    list.innerHTML = `<div class="empty-state">아직 저장된 연락처가 없습니다.</div>`;
    return;
  }
  contacts.forEach((c) => list.appendChild(contactRow(c)));
}

document.addEventListener("DOMContentLoaded", () => {
  loadContacts();

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
    try {
      await addContact(email, name);
      document.getElementById("manual-name").value = "";
      document.getElementById("manual-email").value = "";
      document.getElementById("manual-add").open = false;
    } catch (err) {
      errorEl.textContent = err.message || "추가하지 못했습니다.";
    }
  });
});
