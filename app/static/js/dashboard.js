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

  if (dates.length === 1) return fmt(dates[0]);
  return `${fmt(dates[0])} ~ ${fmt(dates[dates.length - 1])}`;
}

function typeBadge(event) {
  // 목록 보기에서는 모든 줄이 같은 종류라 "일정" 뱃지가 소음일 뿐입니다 -
  // 실제로 무언가를 말해 주는 "확정됨"만 남깁니다.
  const kind = viewMode === "list" ? "" : '<span class="badge badge-muted">일정</span>';
  const closed = event.isClosed ? ' <span class="badge" style="background:var(--color-primary);color:#fff;">확정됨</span>' : "";
  return kind + closed;
}

const GRIP_HTML = `<span class="event-card-grip" title="끌어서 폴더로 이동"><i></i><i></i><i></i><i></i><i></i><i></i></span>`;

/* 참여 중인 일정(내가 만들지 않은 일정)은 읽기 전용입니다 - 수정·복제·보관·
 * 삭제는 서버에서도 소유자만 허용하므로, 버튼을 두면 눌러 봐야 403만
 * 돌아옵니다. 폴더 이동과 순서 변경도 내 일정을 정리하는 기능이라 빼둡니다. */
/* 마지막 날짜 + 시간 범위가 이미 지났는지. 서버 event_service.is_past_event()와
 * 같은 규칙입니다. */
function isPastEvent(event) {
  const dates = (event.dates || []).map((d) => new Date(d));
  if (!dates.length) return false;
  const last = new Date(Math.max(...dates));
  last.setHours(last.getHours() + (event.duration || 0));
  return last < new Date();
}

function eventCard(event) {
  const readOnly = event.isOwner === false;
  const url = `/e/${event.shortId || event._id}`;
  const div = document.createElement("div");
  div.className = "event-card" + (readOnly ? " event-card-readonly" : "");
  div.dataset.eventId = event._id;
  // List view puts the drag handle first so it lines up down the left edge
  // of the rows; the card layout is a plain flex row there, so DOM order is
  // the position.
  const isList = viewMode === "list";
  const grip = readOnly ? "" : GRIP_HTML;
  div.innerHTML = `
    ${isList ? grip : ""}
    <div class="event-card-top">
      <div>
        <div class="event-card-title"><a href="${url}">${escapeHtml(event.name)}</a></div>
        <div class="event-card-meta">${fmtDateRange(event)} &middot; 응답 ${event.numResponses ?? 0}명</div>
        <div class="event-card-created">${
          readOnly
            ? `${escapeHtml(event.ownerName || "익명")}님의 일정`
            : `${fmtCreatedAt(event.createdAt)} 생성`
        }</div>
      </div>
      <div class="event-card-top-right">
        ${typeBadge(event)}
        ${isList ? "" : grip}
      </div>
    </div>
    <div class="event-card-actions">
      <a class="btn btn-sm btn-secondary" href="${url}">열기</a>
      ${
        readOnly
          ? `<span class="event-card-readonly-note">${
              event.hasResponded ? "응답함" : "응답 대기"
            }</span>`
          : `<button class="btn btn-sm btn-ghost" data-action="edit">수정</button>
             <button class="btn btn-sm btn-ghost" data-action="duplicate">복제</button>
             <button class="btn btn-sm btn-ghost" data-action="archive">${event.isArchived ? "보관 해제" : "보관"}</button>
             <button class="btn btn-sm btn-ghost" data-action="delete" style="color: var(--color-danger);">${
               isPastEvent(event) ? "삭제" : "취소"
             }</button>`
      }
    </div>
  `;

  if (readOnly) return div;

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
    // 앞으로 있을 일정은 참가자에게 "취소", 이미 지난 일정은 기록 "삭제"입니다.
    const word = isPastEvent(event) ? "삭제" : "취소";
    document.getElementById("delete-dialog-title").textContent = `일정 ${word}`;
    document.getElementById("delete-notify-label").textContent =
      `참가자에게 ${word} 안내 메일 보내기`;
    document.getElementById("delete-notify-desc").textContent =
      `응답한 사람과 초대받은 사람에게 일정이 ${word}되었다고 알립니다.`;
    document.getElementById("confirm-delete-event-btn").textContent =
      word === "삭제" ? "삭제" : "취소하기";
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

/* 폴더는 내가 만든 일정을 정리하는 도구입니다. 남의 일정은 폴더에 넣거나
   보관할 수 없으므로 이 계산에서 아예 제외합니다. */
function ownedEvents() {
  return events.filter((e) => e.isOwner !== false);
}

function joinedEvents() {
  return sortItems(
    events.filter((e) => e.isOwner === false),
    sortMode,
    DASHBOARD_COMPARATORS,
    manualOrder,
    (e) => e._id
  );
}

function folderEventList(folderId) {
  const mine = ownedEvents();
  let list;
  if (folderId === "__none__") {
    const assigned = new Set(folders.flatMap((f) => f.eventIds || []));
    list = mine.filter((e) => !assigned.has(e._id) && !e.isArchived);
  } else if (folderId === "__archived__") {
    list = mine.filter((e) => e.isArchived);
  } else {
    const folder = folders.find((f) => f._id === folderId);
    const ids = new Set((folder && folder.eventIds) || []);
    list = mine.filter((e) => ids.has(e._id) && !e.isArchived);
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
  // "보관됨"과 "참여 중인 일정"은 폴더 배정 대상이 아니라 드롭을 받지 않습니다.
  if (id !== "__archived__" && !options.notDroppable) block.dataset.folderId = id;

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

  // 섹션 제목이 이미 이름을 달고 있는 곳(참여 중인 일정)에서는 폴더 칩
  // 헤더가 같은 말을 두 번 하게 되므로 생략합니다.
  if (!options.noHeader) block.appendChild(header);
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
function sectionTitle(text, count) {
  const el = document.createElement("h2");
  el.className = "dashboard-section-title";
  el.innerHTML = `${escapeHtml(text)} <span class="dashboard-section-count">${count}</span>`;
  return el;
}

function renderFolders() {
  const root = document.getElementById("folders-root");
  root.innerHTML = "";

  if (!folders.length && !events.length) {
    root.innerHTML = `<div class="empty-state"><div class="icon">🗓️</div>아직 일정이 없습니다. 첫 일정을 만들어보세요!</div>`;
    return;
  }

  const mine = ownedEvents();
  const joined = joinedEvents();

  // 두 종류가 다 있을 때만 제목을 붙입니다 - 한 종류뿐이면 굳이 나눌
  // 것이 없고, 제목만 늘어나 화면이 길어집니다.
  const showTitles = mine.length > 0 && joined.length > 0;
  if (showTitles) root.appendChild(sectionTitle("내가 만든 일정", mine.length));

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

  if (joined.length) {
    // 이 블록은 폴더 헤더가 없으므로 제목을 항상 붙입니다.
    root.appendChild(sectionTitle("참여 중인 일정", joined.length));
    root.appendChild(
      renderFolderBlock("__joined__", "참여 중인 일정", "#9FB6CB", joined, {
        notDroppable: true,
        noHeader: true,
        emptyText: "참여 중인 일정이 없습니다",
      })
    );
  }
}

async function loadDashboard() {
  // 버전 지문을 목록과 함께 받아 둡니다. 따로 받으면 그 사이에 들어온
  // 변경을 놓칠 수 있고, 자동 갱신이 첫 차례에 괜히 한 번 더 받습니다.
  let version;
  [folders, events, version] = await Promise.all([
    api.get("/api/folders"),
    api.get("/api/user/events"),
    api.get("/api/user/events/version").catch(() => null),
  ]);
  renderFolders();
  if (version) live.sync(version.v);
}

/* 자동 갱신 - 내가 만든 일정에 누가 응답하거나, 참여 중인 일정이 확정·
   취소·삭제되면 새로고침 없이 목록이 바뀝니다. 폴링 루프는 live.js. */
const live = createLiveRefresh({
  url: "/api/user/events/version",
  // 다이얼로그가 떠 있거나 카드를 끌고 있는 동안에는 목록을 다시 그리지
  // 않습니다 - 무엇을 지우려던 참이었는지 알 수 없게 됩니다.
  isBusy: () => liveDialogOpen() || liveDragging(),
  onChange: () => loadDashboard(),
});

// 일정을 만들고 뒤로 돌아오면 새 일정이 보여야 합니다.
onPageRestore(loadDashboard);

document.addEventListener("DOMContentLoaded", () => {
  syncViewToggle();
  buildSortSelect(document.getElementById("sort-select"), DASHBOARD_SORT_OPTIONS, sortMode);
  // 첫 조회가 끝나 기준점(live.sync)이 잡힌 뒤에 폴링을 시작합니다.
  loadDashboard().then(() => live.start());

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
    const target = events.find((e) => e._id === deleteTargetId);
    const word = target && isPastEvent(target) ? "삭제" : "취소";
    const notify = document.getElementById("delete-notify").checked;
    try {
      const res = await api.del(`/api/events/${deleteTargetId}?notify=${notify}`);
      closeDialog("delete-event-dialog");
      deleteTargetId = null;
      const n = res && res.notifiedCount;
      showSnackbar(
        n
          ? `${word} 처리했습니다. ${n}명에게 안내 메일을 보내는 중입니다.`
          : `일정을 ${word}했습니다.`,
        "success"
      );
      loadDashboard();
    } catch (err) {
      showSnackbar(err.message || "삭제하지 못했습니다.", "error");
    }
  });
});
