const FOLDER_COLORS = ["#FFB3B3", "#FFCCB3", "#FFFFB3", "#CDEBDC", "#B3B3FF", "#D1B3FF", "#D3D3D3"];

let folders = [];
let events = [];
let deleteTargetId = null;

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

function fmtDateRange(event) {
  if (!event.dates || !event.dates.length) return "";
  const dates = event.dates.map((d) => new Date(d)).sort((a, b) => a - b);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

  if (event.type === "dow" || event.type === "group") {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const set = new Set(dates.map((d) => d.getDay()));
    return [...set].sort().map((i) => days[i]).join(", ");
  }
  if (dates.length === 1) return fmt(dates[0]);
  return `${fmt(dates[0])} ~ ${fmt(dates[dates.length - 1])}`;
}

function typeBadge(event) {
  return event.type === "group" ? '<span class="badge">그룹</span>' : '<span class="badge badge-muted">일정</span>';
}

function eventCard(event) {
  const url = event.type === "group" ? `/g/${event.shortId || event._id}` : `/e/${event.shortId || event._id}`;
  const div = document.createElement("div");
  div.className = "event-card";
  div.innerHTML = `
    <div class="event-card-top">
      <div>
        <div class="event-card-title"><a href="${url}">${escapeHtml(event.name)}</a></div>
        <div class="event-card-meta">${fmtDateRange(event)} &middot; 응답 ${event.numResponses ?? 0}명</div>
      </div>
      ${typeBadge(event)}
    </div>
    <div class="event-card-actions">
      <a class="btn btn-sm btn-secondary" href="${url}">열기</a>
      <button class="btn btn-sm btn-ghost" data-action="edit">수정</button>
      <button class="btn btn-sm btn-ghost" data-action="duplicate">복제</button>
      <button class="btn btn-sm btn-ghost" data-action="archive">${event.isArchived ? "보관 해제" : "보관"}</button>
      <button class="btn btn-sm btn-ghost" data-action="delete" style="color: var(--color-danger);">삭제</button>
    </div>
    <select class="input" data-role="move-select" style="margin-top: 8px; font-size: 13px; padding: 6px 8px;">
      <option value="">폴더로 이동...</option>
    </select>
  `;

  const select = div.querySelector('[data-role="move-select"]');
  folders.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f._id;
    opt.textContent = f.name;
    select.appendChild(opt);
  });
  const noneOpt = document.createElement("option");
  noneOpt.value = "__none__";
  noneOpt.textContent = "폴더 없음으로 이동";
  select.appendChild(noneOpt);

  select.addEventListener("change", async () => {
    if (!select.value) return;
    const folderId = select.value === "__none__" ? null : select.value;
    try {
      await api.post(`/api/user/events/${event._id}/set-folder`, { folderId });
      loadDashboard();
    } catch (err) {
      showSnackbar(err.message, "error");
    }
  });

  div.querySelector('[data-action="edit"]').addEventListener("click", async () => {
    const full = await api.get(`/api/events/${event._id}`);
    NewEventDialog.open({ mode: "edit", event: full });
  });
  div.querySelector('[data-action="duplicate"]').addEventListener("click", async () => {
    const name = prompt("새 일정 이름", `${event.name} (복사본)`);
    if (!name) return;
    await api.post(`/api/events/${event._id}/duplicate`, { eventName: name, copyAvailability: true });
    showSnackbar("복제되었습니다.", "success");
    loadDashboard();
  });
  div.querySelector('[data-action="archive"]').addEventListener("click", async () => {
    await api.post(`/api/events/${event._id}/archive?archived=${!event.isArchived}`);
    loadDashboard();
  });
  div.querySelector('[data-action="delete"]').addEventListener("click", () => {
    deleteTargetId = event._id;
    openDialog("delete-event-dialog");
  });

  return div;
}

function folderEventList(folderId) {
  if (folderId === "__none__") {
    const assigned = new Set(folders.flatMap((f) => f.eventIds || []));
    return events.filter((e) => !assigned.has(e._id) && !e.isArchived);
  }
  if (folderId === "__archived__") {
    return events.filter((e) => e.isArchived);
  }
  const folder = folders.find((f) => f._id === folderId);
  const ids = new Set((folder && folder.eventIds) || []);
  return events.filter((e) => ids.has(e._id) && !e.isArchived);
}

function renameFolderPrompt(id, currentName) {
  const name = prompt("폴더 이름", currentName);
  if (name === null || !name.trim()) return;
  api.patch(`/api/folders/${id}`, { name: name.trim() }).then(loadDashboard);
}

function renderFolderBlock(id, name, color, list, options) {
  options = options || {};
  const block = document.createElement("div");
  block.className = "folder-block";

  const header = document.createElement("div");
  header.className = "folder-header";
  header.innerHTML = `
    <span class="folder-chevron">▾</span>
    <span class="folder-chip" style="background:${color}33;">
      <span class="dot" style="background:${color};"></span>${escapeHtml(name)}
    </span>
    <span class="folder-count">${list.length}개</span>
    <span style="flex: 1;"></span>
  `;

  if (options.editable) {
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:4px;";
    const editBtn = document.createElement("button");
    editBtn.className = "btn-icon";
    editBtn.type = "button";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameFolderPrompt(id, name);
    });
    const delBtn = document.createElement("button");
    delBtn.className = "btn-icon";
    delBtn.type = "button";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm("이 폴더와 폴더 안의 일정을 모두 삭제할까요?")) {
        await api.del(`/api/folders/${id}`);
        loadDashboard();
      }
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    header.appendChild(actions);
  }

  const body = document.createElement("div");
  body.className = "folder-body" + (options.archived ? " archived" : "");

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty-folder";
    empty.textContent = options.emptyText || "이 폴더에 일정이 없습니다";
    body.appendChild(empty);
  } else {
    list.forEach((event) => body.appendChild(eventCard(event)));
  }

  header.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    header.classList.toggle("collapsed");
  });

  block.appendChild(header);
  block.appendChild(body);
  return block;
}

async function loadDashboard() {
  const root = document.getElementById("folders-root");
  [folders, events] = await Promise.all([api.get("/api/folders"), api.get("/api/user/events")]);

  root.innerHTML = "";

  if (!folders.length && !events.length) {
    root.innerHTML = `<div class="empty-state"><div class="icon">🗓️</div>아직 일정이 없습니다. 첫 일정을 만들어보세요!</div>`;
    return;
  }

  folders.forEach((folder) => {
    const list = folderEventList(folder._id);
    root.appendChild(renderFolderBlock(folder._id, folder.name, folder.color || "#D3D3D3", list, { editable: true }));
  });

  const noFolderList = folderEventList("__none__");
  if (noFolderList.length) {
    root.appendChild(renderFolderBlock("__none__", "폴더 없음", "#D3D3D3", noFolderList, { emptyText: "일정이 없습니다" }));
  }

  const archivedList = folderEventList("__archived__");
  if (archivedList.length) {
    root.appendChild(
      renderFolderBlock("__archived__", "보관됨", "#BDBDBD", archivedList, { archived: true, emptyText: "보관된 일정이 없습니다" })
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadDashboard();

  document.getElementById("new-event-btn").addEventListener("click", () => NewEventDialog.open({ mode: "create" }));
  document.getElementById("fab-new-event").addEventListener("click", () => NewEventDialog.open({ mode: "create" }));

  const colorsRoot = document.getElementById("nf-colors");
  let selectedColor = FOLDER_COLORS[0];
  FOLDER_COLORS.forEach((color, idx) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.style.cssText = `width:28px;height:28px;border-radius:50%;background:${color};border:2px solid ${idx === 0 ? "var(--color-text)" : "transparent"};cursor:pointer;`;
    sw.addEventListener("click", () => {
      selectedColor = color;
      colorsRoot.querySelectorAll("button").forEach((b) => (b.style.borderColor = "transparent"));
      sw.style.borderColor = "var(--color-text)";
    });
    colorsRoot.appendChild(sw);
  });

  document.getElementById("new-folder-btn").addEventListener("click", () => openDialog("new-folder-dialog"));
  document.getElementById("new-folder-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("nf-name").value.trim();
    if (!name) return;
    await api.post("/api/folders", { name, color: selectedColor });
    closeDialog("new-folder-dialog");
    document.getElementById("nf-name").value = "";
    loadDashboard();
  });

  document.getElementById("confirm-delete-event-btn").addEventListener("click", async () => {
    if (!deleteTargetId) return;
    await api.del(`/api/events/${deleteTargetId}`);
    closeDialog("delete-event-dialog");
    deleteTargetId = null;
    loadDashboard();
  });
});
