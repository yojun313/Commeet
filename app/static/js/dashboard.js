const FOLDER_COLORS = ["#FFB3B3", "#FFCCB3", "#FFFFB3", "#CDEBDC", "#B3B3FF", "#D1B3FF", "#D3D3D3"];

const VIEW_STORAGE_KEY = "pcts_dashboard_view";
const SORT_STORAGE_KEY = "pcts_dashboard";

const DASHBOARD_SORT_OPTIONS = [
  ["createdDesc", "최근 만든 순"],
  ["createdAsc", "먼저 만든 순"],
  ["nameAsc", "이름순 (가나다)"],
  ["dateAsc", "일정 날짜 빠른 순"],
  ["responsesDesc", "응답 많은 순"],
];

const firstDate = (e) => {
  const ds = (e.dates || []).map((d) => new Date(d).getTime()).filter((n) => !Number.isNaN(n));
  return ds.length ? Math.min(...ds) : Infinity;
};

const DASHBOARD_COMPARATORS = {
  createdDesc: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  createdAsc: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  nameAsc: (a, b) => (a.name || "").localeCompare(b.name || "", "ko"),
  dateAsc: (a, b) => firstDate(a) - firstDate(b),
  responsesDesc: (a, b) => (b.numResponses ?? 0) - (a.numResponses ?? 0),
};

let folders = [];
let events = [];
let deleteTargetId = null;
// "grid" (cards side by side, the default) or "list" (one compact row each).
let viewMode = localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid";

const savedSort = loadSortState(SORT_STORAGE_KEY, "createdDesc");
let sortMode = savedSort.sort;
let manualOrder = savedSort.order;

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

function fmtCreatedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
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
  // In list view every row is the same kind of thing, so the plain "일정"
  // badge is just noise - only the ones that actually say something
  // ("그룹", "확정됨") are kept there.
  const isList = viewMode === "list";
  const kind =
    event.type === "group"
      ? '<span class="badge">그룹</span>'
      : isList
        ? ""
        : '<span class="badge badge-muted">일정</span>';
  const closed = event.isClosed ? ' <span class="badge" style="background:var(--color-primary);color:#fff;">확정됨</span>' : "";
  return kind + closed;
}

const GRIP_HTML = `<span class="event-card-grip" title="끌어서 폴더로 이동"><i></i><i></i><i></i><i></i><i></i><i></i></span>`;

function eventCard(event) {
  const url = event.type === "group" ? `/g/${event.shortId || event._id}` : `/e/${event.shortId || event._id}`;
  const div = document.createElement("div");
  div.className = "event-card";
  div.dataset.eventId = event._id;
  // List view puts the drag handle first so it lines up down the left edge
  // of the rows; the card layout is a plain flex row there, so DOM order is
  // the position.
  const isList = viewMode === "list";
  div.innerHTML = `
    ${isList ? GRIP_HTML : ""}
    <div class="event-card-top">
      <div>
        <div class="event-card-title"><a href="${url}">${escapeHtml(event.name)}</a></div>
        <div class="event-card-meta">${fmtDateRange(event)} &middot; 응답 ${event.numResponses ?? 0}명</div>
        <div class="event-card-created">${fmtCreatedAt(event.createdAt)} 생성</div>
      </div>
      <div class="event-card-top-right">
        ${typeBadge(event)}
        ${isList ? "" : GRIP_HTML}
      </div>
    </div>
    <div class="event-card-actions">
      <a class="btn btn-sm btn-secondary" href="${url}">열기</a>
      <button class="btn btn-sm btn-ghost" data-action="edit">수정</button>
      <button class="btn btn-sm btn-ghost" data-action="duplicate">복제</button>
      <button class="btn btn-sm btn-ghost" data-action="archive">${event.isArchived ? "보관 해제" : "보관"}</button>
      <button class="btn btn-sm btn-ghost" data-action="delete" style="color: var(--color-danger);">삭제</button>
    </div>
  `;

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

  div.querySelector(".event-card-grip").addEventListener("pointerdown", (e) => startCardDrag(e, event, div));

  return div;
}

/* ------------------------------------------------------------------ */
/* Drag a card to reorder it, or onto another folder to move it        */
/* (pointer events - mouse+touch; mechanics live in card-sort.js)      */
/* ------------------------------------------------------------------ */

function clearFolderDropHighlights() {
  document.querySelectorAll(".folder-block.drop-target").forEach((el) => el.classList.remove("drop-target"));
}

// One drag does both jobs: released over a *different* folder it reassigns
// the event, released within its own folder it just keeps the new position
// the live reorder already put it in.
function startCardDrag(e, event, card) {
  const container = card.parentElement;
  const originFolder = card.closest(".folder-block[data-folder-id]");

  startReorderDrag(e, {
    card,
    container,
    itemSelector: ".event-card",
    ghostLabel: event.name,
    onMove: (x, y) => {
      clearFolderDropHighlights();
      const under = document.elementFromPoint(x, y);
      const target = under && under.closest ? under.closest(".folder-block[data-folder-id]") : null;
      // Only flag it when it's somewhere else - highlighting the folder the
      // card already lives in would suggest a move that isn't happening.
      if (target && target !== originFolder) target.classList.add("drop-target");
    },
    onDrop: async (x, y, reordered) => {
      clearFolderDropHighlights();
      const under = document.elementFromPoint(x, y);
      const target = under && under.closest ? under.closest(".folder-block[data-folder-id]") : null;

      if (target && target !== originFolder) {
        const folderId = target.dataset.folderId === "__none__" ? null : target.dataset.folderId;
        try {
          await api.post(`/api/user/events/${event._id}/set-folder`, { folderId });
          showSnackbar("폴더를 이동했습니다.", "success");
          loadDashboard();
        } catch (err) {
          showSnackbar(err.message, "error");
          loadDashboard();
        }
        return;
      }

      if (reordered) persistManualOrder();
    },
  });
}

// Hand-arranging switches the list to "사용자 정렬" for good - a sort option
// would otherwise silently discard the arrangement on the next render.
function persistManualOrder() {
  sortMode = "manual";
  manualOrder = [...document.querySelectorAll(".folder-body .event-card")].map((el) => el.dataset.eventId);
  saveSortState(SORT_STORAGE_KEY, sortMode, manualOrder);
  buildSortSelect(document.getElementById("sort-select"), DASHBOARD_SORT_OPTIONS, sortMode);
  showSnackbar("순서를 저장했습니다.", "success");
}

function folderEventList(folderId) {
  let list;
  if (folderId === "__none__") {
    const assigned = new Set(folders.flatMap((f) => f.eventIds || []));
    list = events.filter((e) => !assigned.has(e._id) && !e.isArchived);
  } else if (folderId === "__archived__") {
    list = events.filter((e) => e.isArchived);
  } else {
    const folder = folders.find((f) => f._id === folderId);
    const ids = new Set((folder && folder.eventIds) || []);
    list = events.filter((e) => ids.has(e._id) && !e.isArchived);
  }
  return sortItems(list, sortMode, DASHBOARD_COMPARATORS, manualOrder, (e) => e._id);
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
  // "보관됨" isn't a real folder assignment target, so it doesn't accept drops.
  if (id !== "__archived__") block.dataset.folderId = id;

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
  body.className =
    "folder-body" + (options.archived ? " archived" : "") + (viewMode === "list" ? " view-list" : "");

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

function syncViewToggle() {
  document
    .querySelectorAll("#view-toggle button[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === viewMode));
}

// Split from loadDashboard so switching the view mode can redraw from the
// folders/events already in memory instead of refetching them.
function renderFolders() {
  const root = document.getElementById("folders-root");
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

async function loadDashboard() {
  [folders, events] = await Promise.all([api.get("/api/folders"), api.get("/api/user/events")]);
  renderFolders();
}

document.addEventListener("DOMContentLoaded", () => {
  syncViewToggle();
  buildSortSelect(document.getElementById("sort-select"), DASHBOARD_SORT_OPTIONS, sortMode);
  loadDashboard();

  document.getElementById("sort-select").addEventListener("change", (e) => {
    sortMode = e.target.value;
    saveSortState(SORT_STORAGE_KEY, sortMode, manualOrder);
    // Drop "사용자 정렬" from the list once a real sort takes over.
    buildSortSelect(document.getElementById("sort-select"), DASHBOARD_SORT_OPTIONS, sortMode);
    renderFolders();
  });

  document.getElementById("view-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn || btn.dataset.view === viewMode) return;
    viewMode = btn.dataset.view;
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
    } catch (err) {
      /* localStorage unavailable (private mode) - the choice just won't persist */
    }
    syncViewToggle();
    // Re-render from the data already in memory; no refetch needed.
    renderFolders();
  });

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
