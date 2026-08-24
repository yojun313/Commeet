/* The core scheduling screen: an availability heatmap grid, shared by
 * /e/{id} (plain events) and /g/{id} (groups - same grid + weekly paging +
 * calendar overlay). Config comes from window.PCTS_EVENT_CONFIG, rendered
 * server-side by app/routes/page_routes.py. */

const REF_SUNDAY = new Date(2024, 0, 7); // must match static/js/new-event.js
const DOW_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const TOOL_HINTS = {
  available: "확실히 참여할 수 있는 시간을 칠하세요. 최적 시간 계산에 반영됩니다.",
  ifNeeded: "꼭 필요하다면 맞출 수 있는 시간입니다. 최적 시간 계산에는 반영되지 않습니다.",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

/* Canonical key for one time slot. Never compare timestamps as strings: the
 * server emits "...T09:00:00Z" while JS toISOString() emits "...T09:00:00.000Z",
 * so epoch milliseconds is the only representation both sides agree on. */
function slotKey(value) {
  return String(new Date(value).getTime());
}

function slotKeyToIso(key) {
  return new Date(Number(key)).toISOString();
}

function timeLabel(decimalHour) {
  const h = Math.floor(decimalHour) % 24;
  const m = Math.round((decimalHour - Math.floor(decimalHour)) * 60);
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${ampm} ${h12}시` : `${ampm} ${h12}:${pad2(m)}`;
}

function thisWeekSunday(weekOffset) {
  const now = new Date();
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  sunday.setDate(sunday.getDate() + weekOffset * 7);
  return sunday;
}

function dayDiffFromRefSunday(refDate) {
  const refMidnight = new Date(REF_SUNDAY.getFullYear(), REF_SUNDAY.getMonth(), REF_SUNDAY.getDate());
  const dateMidnight = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  return Math.round((dateMidnight - refMidnight) / 86400000);
}

function projectToWeek(refDate, weekOffset) {
  const sunday = thisWeekSunday(weekOffset);
  const result = new Date(sunday);
  result.setDate(result.getDate() + dayDiffFromRefSunday(refDate));
  result.setHours(refDate.getHours(), refDate.getMinutes(), 0, 0);
  return result;
}

const ST = {
  eventId: null,
  isGroup: false,
  currentUser: null,
  currentUserEmail: null,
  googleCalendarEnabled: false,
  event: null,
  dayColumns: [], // [{refDate, displayDate}]
  slotCount: 0,
  startHour: 9,
  responsesFull: {}, // userKey -> {availability:[iso], ifNeeded:[iso], user, name}
  responseSets: {}, // userKey -> {available: Set<slotKey>, ifNeeded: Set<slotKey>}
  weekOffset: 0,
  editing: false,
  editTool: "available",
  ownMarks: {}, // slotKey -> 'available' | 'ifNeeded'
  cellGrid: [], // [row][col] -> cell element, for rectangle drag selection
  dragging: false,
  dragValue: null,
  dragAnchor: null, // {row, col} the drag started on
  dragBase: null, // ownMarks snapshot at drag start, so the rect can be recomputed live
  selectedRespondents: new Set(),
  showBestTimes: false,
  hideIfNeeded: false,
  viewerKey: null,
  guestName: null,
  isOwner: false,
};

function el(html) {
  const div = document.createElement("div");
  div.innerHTML = html.trim();
  return div.firstElementChild;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

/* ---------------------------------------------------------------------- */
/* Load                                                                    */
/* ---------------------------------------------------------------------- */

async function init() {
  const cfg = window.PCTS_EVENT_CONFIG;
  ST.eventId = cfg.eventId;
  ST.isGroup = cfg.isGroup;
  ST.currentUser = cfg.currentUser;
  ST.currentUserEmail = cfg.currentUserEmail;
  ST.googleCalendarEnabled = cfg.googleCalendarEnabled;
  ST.guestName = localStorage.getItem(`pcts_guest_name_${ST.eventId}`) || null;
  ST.viewerKey = ST.currentUser ? ST.currentUser._id : ST.guestName;

  wireStaticButtons();

  try {
    await loadEvent();
  } catch (err) {
    if (err.status === 401) {
      renderSignInRequired();
    } else if (err.status === 403) {
      renderAccessDenied();
    } else {
      showSnackbar(err.message || "일정을 불러오지 못했습니다.", "error");
    }
  }
}

function renderSignInRequired() {
  document.getElementById("event-body-root").innerHTML = `
    <div class="access-denied">
      <div class="icon">🔒</div>
      <h2>로그인이 필요합니다</h2>
      <p>그룹 일정은 초대받은 사람만 볼 수 있어요.</p>
      <a class="btn btn-primary" href="/sign-in?next=${encodeURIComponent(window.location.pathname)}">로그인</a>
    </div>
  `;
}

function renderAccessDenied() {
  document.getElementById("event-body-root").innerHTML = `
    <div class="access-denied">
      <div class="icon">🚫</div>
      <h2>접근 권한이 없습니다</h2>
      <p>이 그룹에 초대받지 못한 것 같아요. 그룹 생성자에게 문의해 주세요.</p>
    </div>
  `;
}

async function loadEvent() {
  const guestQuery = ST.guestName ? `?guestName=${encodeURIComponent(ST.guestName)}` : "";
  const event = await api.get(`/api/events/${ST.eventId}${guestQuery}`);
  ST.event = event;
  ST.isOwner = !!event.isOwner;

  document.getElementById("ev-title").textContent = event.name;
  document.title = `${event.name} - PCTS`;

  computeDayColumns();
  renderMeta();
  renderSkeleton();
  wireDynamicButtons();

  if (ST.isGroup) {
    document.getElementById("week-nav").style.display = "";
    renderWeekLabel();
  }

  if (event.ownerId === null && !ST.isGroup) {
    document.getElementById("guest-owner-banner").innerHTML = `
      <div class="guest-banner">이 일정은 로그인하지 않은 상태에서 만들어져서, 링크를 가진 누구나 수정할 수 있어요.</div>
    `;
  }

  await refreshResponses();
  renderRespondents();
  renderGridCells();
}

function computeDayColumns() {
  const uniqueRefTimes = [...new Set(ST.event.dates)].map((d) => new Date(d)).sort((a, b) => a - b);
  ST.dayColumns = uniqueRefTimes.map((refDate) => ({
    refDate,
    displayDate: ST.isGroup ? projectToWeek(refDate, ST.weekOffset) : refDate,
  }));
  ST.startHour = uniqueRefTimes.length ? uniqueRefTimes[0].getHours() + uniqueRefTimes[0].getMinutes() / 60 : 9;
  ST.slotCount = Math.max(1, Math.round((ST.event.duration * 60) / (ST.event.timeIncrement || 15)));
}

function renderMeta() {
  const cols = ST.dayColumns;
  if (!cols.length) return;
  const first = cols[0].displayDate;
  const last = cols[cols.length - 1].displayDate;
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const respCount = Object.keys(ST.event.responses || {}).length;
  document.getElementById("ev-meta").textContent = `${fmt(first)} ~ ${fmt(last)} · 응답 ${respCount}명`;
}

function renderWeekLabel() {
  const sunday = thisWeekSunday(ST.weekOffset);
  const sat = new Date(sunday);
  sat.setDate(sat.getDate() + 6);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  document.getElementById("week-label").textContent = `${fmt(sunday)} - ${fmt(sat)}`;
}

/* ---------------------------------------------------------------------- */
/* Skeleton                                                                */
/* ---------------------------------------------------------------------- */

function renderSkeleton() {
  const root = document.getElementById("event-body-root");
  root.innerHTML = `
    <div class="grid-toolbar">
      <div class="grid-toolbar-left">
        <div class="legend">
          <span>가능한 사람 적음</span>
          <span class="legend-ramp">
            <span style="background:rgba(200,1,80,.18)"></span>
            <span style="background:rgba(200,1,80,.4)"></span>
            <span style="background:rgba(200,1,80,.6)"></span>
            <span style="background:rgba(200,1,80,.8)"></span>
            <span style="background:rgba(200,1,80,1)"></span>
          </span>
          <span>많음</span>
          <span class="legend-item">
            <span class="legend-swatch if-needed-swatch"></span>가능(선택)만 있음
          </span>
        </div>
      </div>
      <div class="grid-toolbar-right">
        <button class="btn btn-sm btn-ghost" id="toggle-best-times">최적 시간만 보기</button>
        <button class="btn btn-sm btn-ghost" id="toggle-hide-ifneeded">가능(선택) 숨기기</button>
      </div>
    </div>

    <details class="term-help">
      <summary>“가능”과 “가능(선택)”은 어떻게 다른가요?</summary>
      <dl class="term-help-body">
        <dt><span class="legend-swatch available-swatch"></span>가능</dt>
        <dd>이 시간에 <strong>확실히 참여할 수 있다</strong>는 뜻입니다. 최적의 시간을 고를 때는 이 응답만 집계합니다.</dd>
        <dt><span class="legend-swatch if-needed-swatch"></span>가능(선택)</dt>
        <dd>
          <strong>꼭 필요하다면 맞출 수 있지만, 다른 시간이 더 좋다</strong>는 뜻입니다.
          차선책으로만 참고하며 <em>최적 시간만 보기</em>에는 포함되지 않습니다.
        </dd>
      </dl>
      <p class="term-help-note">
        칸의 색이 진할수록 “가능”이라고 답한 사람이 많습니다.
        “가능”인 사람이 아무도 없고 “가능(선택)”만 있는 칸은 노란색으로 표시됩니다.
      </p>
    </details>

    <div class="event-layout">
      <div>
        <div class="grid-scroll">
          <div class="avail-grid" id="avail-grid"></div>
        </div>
        <div class="edit-bar" id="edit-bar" style="display: none;">
          <div class="edit-bar-left">
            <div class="toggle-group" id="edit-tool-toggle">
              <button type="button" class="active" data-tool="available">가능</button>
              <button type="button" data-tool="ifNeeded">가능(선택)</button>
            </div>
            <span class="edit-hint" id="edit-tool-hint">${TOOL_HINTS.available}</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-sm btn-secondary" id="autofill-btn" style="display: none;">캘린더로 자동 채우기</button>
            <button class="btn btn-ghost btn-sm" id="cancel-edit-btn">취소</button>
            <button class="btn btn-primary btn-sm" id="save-edit-btn">저장</button>
          </div>
        </div>
      </div>

      <div class="card sidebar-card">
        <h3>응답자 (<span id="respondent-count">0</span>)</h3>
        <div id="respondents-list"></div>
        <button class="btn btn-primary btn-block" id="respond-btn" style="margin-top: 14px;">가능한 시간 추가</button>
        <button class="btn btn-ghost btn-block" id="delete-response-btn" style="display: none; margin-top: 8px; color: var(--color-danger);">
          ${ST.isGroup ? "그룹 나가기" : "내 응답 삭제"}
        </button>
        <button class="btn btn-ghost btn-block" id="decline-invite-btn" style="display: none; margin-top: 8px; color: var(--color-danger);">
          초대 거절
        </button>
      </div>
    </div>
  `;

  buildGridDom();
}

function buildGridDom() {
  const grid = document.getElementById("avail-grid");
  const cols = ST.dayColumns;
  // Sizes come from CSS custom properties so media queries can shrink the
  // grid on phones - an inline pixel value here would override them.
  grid.style.gridTemplateColumns = `var(--grid-label-w) repeat(${cols.length}, minmax(var(--grid-col-min), 1fr))`;
  grid.style.gridTemplateRows = `var(--grid-head-h) repeat(${ST.slotCount}, var(--grid-row-h))`;
  grid.innerHTML = "";

  grid.appendChild(el(`<div class="avail-grid-corner"></div>`));
  cols.forEach((col) => {
    const d = col.displayDate;
    grid.appendChild(
      el(`
        <div class="day-col-header">
          <div class="dow">${DOW_LABELS[d.getDay()]}</div>
          <div class="dnum">${d.getMonth() + 1}/${d.getDate()}</div>
        </div>
      `)
    );
  });

  const increment = ST.event.timeIncrement || 15;
  ST.cellGrid = [];
  for (let row = 0; row < ST.slotCount; row++) {
    const hour = ST.startHour + (row * increment) / 60;
    const isHourMark = Math.abs((hour * 60) % 60) < 0.01;
    const labelCell = el(`<div class="time-row-label">${isHourMark ? timeLabel(hour) : ""}</div>`);
    grid.appendChild(labelCell);

    const rowCells = [];
    cols.forEach((col, colIdx) => {
      const refSlot = new Date(col.refDate.getTime() + row * increment * 60000);
      const cell = document.createElement("div");
      cell.className = "grid-cell" + (isHourMark ? " hour-mark" : "");
      cell.dataset.slot = slotKey(refSlot);
      cell.dataset.row = String(row);
      cell.dataset.col = String(colIdx);
      grid.appendChild(cell);
      rowCells.push(cell);
    });
    ST.cellGrid.push(rowCells);
  }

  wireGridInteraction(grid);
}

/* ---------------------------------------------------------------------- */
/* Responses + rendering                                                   */
/* ---------------------------------------------------------------------- */

async function refreshResponses() {
  const cols = ST.dayColumns;
  if (!cols.length) return;
  const timeMin = cols[0].refDate.toISOString();
  const timeMax = new Date(cols[cols.length - 1].refDate.getTime() + ST.event.duration * 3600000).toISOString();
  const guestQuery = ST.guestName ? `&guestName=${encodeURIComponent(ST.guestName)}` : "";
  ST.responsesFull = await api.get(`/api/events/${ST.eventId}/responses?timeMin=${timeMin}&timeMax=${timeMax}${guestQuery}`);

  // Index each respondent's slots up front so cell rendering is a set lookup
  // instead of a linear scan over every timestamp.
  ST.responseSets = {};
  for (const key in ST.responsesFull) {
    const resp = ST.responsesFull[key];
    ST.responseSets[key] = {
      available: new Set((resp.availability || []).map(slotKey)),
      ifNeeded: new Set((resp.ifNeeded || []).map(slotKey)),
    };
  }

  if (ST.viewerKey && ST.responsesFull[ST.viewerKey]) {
    document.getElementById("delete-response-btn").style.display = "";
    document.getElementById("respond-btn").textContent = "가용시간 수정";
  }
}

function countsForCell(slot) {
  let available = 0;
  let ifNeeded = 0;
  for (const key in ST.responseSets) {
    const sets = ST.responseSets[key];
    if (sets.available.has(slot)) available++;
    else if (!ST.hideIfNeeded && sets.ifNeeded.has(slot)) ifNeeded++;
  }
  return { available, ifNeeded };
}

function renderGridCells() {
  const grid = document.getElementById("avail-grid");
  if (!grid) return;
  const cells = grid.querySelectorAll(".grid-cell");

  let maxAvailable = 0;
  if (ST.showBestTimes) {
    cells.forEach((cell) => {
      const { available } = countsForCell(cell.dataset.slot);
      if (available > maxAvailable) maxAvailable = available;
    });
  }

  cells.forEach((cell) => {
    cell.classList.remove("available", "if-needed", "dim", "own-preview");
    cell.style.background = "";
    const slot = cell.dataset.slot;

    if (ST.editing) {
      const mark = ST.ownMarks[slot];
      if (mark === "available") cell.classList.add("available");
      else if (mark === "ifNeeded") cell.classList.add("if-needed");
      return;
    }

    if (ST.selectedRespondents.size > 0) {
      let anyAvailable = false;
      let anyIfNeeded = false;
      ST.selectedRespondents.forEach((key) => {
        const sets = ST.responseSets[key];
        if (!sets) return;
        if (sets.available.has(slot)) anyAvailable = true;
        else if (sets.ifNeeded.has(slot)) anyIfNeeded = true;
      });
      if (anyAvailable) cell.classList.add("available");
      else if (anyIfNeeded && !ST.hideIfNeeded) cell.classList.add("if-needed");
      return;
    }

    const { available, ifNeeded } = countsForCell(slot);
    if (ST.showBestTimes) {
      if (available > 0 && available === maxAvailable) {
        cell.style.background = "var(--color-primary)";
      } else if (available > 0 || ifNeeded > 0) {
        cell.classList.add("dim");
        cell.style.background = available > 0 ? "var(--color-primary)" : "var(--color-accent-yellow)";
      }
      return;
    }

    const totalRespondents = Math.max(1, Object.keys(ST.responsesFull).length);
    if (available > 0) {
      const opacity = 0.18 + 0.82 * (available / totalRespondents);
      cell.style.background = `rgba(200, 1, 80, ${opacity.toFixed(2)})`;
    } else if (ifNeeded > 0) {
      const opacity = 0.25 + 0.6 * (ifNeeded / totalRespondents);
      cell.style.background = `rgba(245, 195, 68, ${opacity.toFixed(2)})`;
    }
  });
}

function renderRespondents() {
  const list = document.getElementById("respondents-list");
  const responses = ST.event.responses || {};
  const keys = Object.keys(responses);
  document.getElementById("respondent-count").textContent = keys.length;

  if (!keys.length) {
    list.innerHTML = `<p class="hint">아직 응답이 없습니다. 첫 응답자가 되어보세요!</p>`;
    return;
  }

  list.innerHTML = "";
  keys.forEach((key) => {
    const resp = responses[key];
    const isGuestEntry = !resp.user || !resp.user._id;
    const displayName = isGuestEntry
      ? resp.name || (resp.user ? resp.user.name : "")
      : (resp.user.name || "").trim() || resp.user.email;
    const canEditAsGuest = isGuestEntry && ST.isOwner;

    const row = document.createElement("div");
    row.className = "respondent-row" + (ST.selectedRespondents.has(key) ? " selected" : "");
    row.innerHTML = `
      <span class="avatar sm">${(displayName || "?")[0].toUpperCase()}</span>
      <span class="name">${escapeHtml(displayName)}</span>
      <span class="edit-icon">${canEditAsGuest ? "✎" : ""}</span>
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".edit-icon") && canEditAsGuest) {
        e.stopPropagation();
        startEditingAs(key, displayName);
        return;
      }
      if (ST.selectedRespondents.has(key)) ST.selectedRespondents.delete(key);
      else ST.selectedRespondents.add(key);
      renderRespondents();
      renderGridCells();
    });
    list.appendChild(row);
  });
}

/* ---------------------------------------------------------------------- */
/* Editing / drag-select                                                   */
/* ---------------------------------------------------------------------- */

function wireGridInteraction(grid) {
  grid.addEventListener("pointerdown", (e) => {
    if (!ST.editing) return;
    const cell = e.target.closest(".grid-cell");
    if (!cell) return;
    e.preventDefault();

    // Painting toggles: starting on a cell that already carries the active
    // tool erases the dragged region instead of filling it.
    ST.dragValue = ST.ownMarks[cell.dataset.slot] === ST.editTool ? null : ST.editTool;
    ST.dragAnchor = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
    ST.dragBase = { ...ST.ownMarks };
    ST.dragging = true;

    // Keep receiving moves even when the pointer leaves the grid mid-drag.
    try {
      grid.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }

    paintDragRect(ST.dragAnchor.row, ST.dragAnchor.col);
  });

  grid.addEventListener("pointermove", (e) => {
    if (!ST.editing || !ST.dragging) return;
    // Look up the cell under the cursor instead of waiting for per-cell
    // pointerover events: those fire only as fast as the browser samples the
    // pointer, so a quick drag skips right over intermediate tiles.
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const cell = target && target.closest ? target.closest(".grid-cell") : null;
    if (!cell || !grid.contains(cell)) return;
    paintDragRect(Number(cell.dataset.row), Number(cell.dataset.col));
  });

  const endDrag = () => {
    ST.dragging = false;
    ST.dragAnchor = null;
    ST.dragBase = null;
  };
  grid.addEventListener("pointerup", endDrag);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
}

/** Fills every cell in the rectangle between the drag anchor and (row, col). */
function paintDragRect(row, col) {
  const anchor = ST.dragAnchor;
  if (!anchor || Number.isNaN(row) || Number.isNaN(col)) return;

  const rowStart = Math.min(anchor.row, row);
  const rowEnd = Math.max(anchor.row, row);
  const colStart = Math.min(anchor.col, col);
  const colEnd = Math.max(anchor.col, col);

  // Recompute from the pre-drag snapshot so shrinking the rectangle releases
  // cells the pointer has moved back off of.
  ST.ownMarks = { ...ST.dragBase };
  for (let r = rowStart; r <= rowEnd; r++) {
    const rowCells = ST.cellGrid[r];
    if (!rowCells) continue;
    for (let c = colStart; c <= colEnd; c++) {
      const cell = rowCells[c];
      if (!cell) continue;
      if (ST.dragValue) ST.ownMarks[cell.dataset.slot] = ST.dragValue;
      else delete ST.ownMarks[cell.dataset.slot];
    }
  }
  paintOwnMarks();
}

/** Repaints only the editing marks - lighter than a full renderGridCells(). */
function paintOwnMarks() {
  for (const rowCells of ST.cellGrid) {
    for (const cell of rowCells) {
      const mark = ST.ownMarks[cell.dataset.slot];
      cell.classList.toggle("available", mark === "available");
      cell.classList.toggle("if-needed", mark === "ifNeeded");
    }
  }
}

function prefillMarksFrom(resp) {
  if (!resp) return;
  (resp.availability || []).forEach((iso) => (ST.ownMarks[slotKey(iso)] = "available"));
  (resp.ifNeeded || []).forEach((iso) => (ST.ownMarks[slotKey(iso)] = "ifNeeded"));
}

function startEditing(prefillFromSelf) {
  ST.editing = true;
  ST.selectedRespondents.clear();
  ST.ownMarks = {};

  if (prefillFromSelf && ST.viewerKey) {
    prefillMarksFrom(ST.responsesFull[ST.viewerKey]);
  }

  document.getElementById("edit-bar").style.display = "flex";
  document.getElementById("respond-btn").style.display = "none";
  document.getElementById("avail-grid").classList.add("editing");
  document.getElementById("edit-tool-hint").textContent = TOOL_HINTS[ST.editTool];
  const autofillBtn = document.getElementById("autofill-btn");
  if (autofillBtn) {
    autofillBtn.style.display = ST.googleCalendarEnabled && ST.currentUser ? "" : "none";
  }
  renderGridCells();
}

function stopEditing() {
  ST.editing = false;
  ST.editingAsGuestKey = null;
  ST.dragging = false;
  ST.dragAnchor = null;
  ST.dragBase = null;
  document.getElementById("edit-bar").style.display = "none";
  document.getElementById("respond-btn").style.display = "";
  document.getElementById("avail-grid").classList.remove("editing");
  renderGridCells();
}

function startEditingAs(guestKey, displayName) {
  ST.editingAsGuestKey = guestKey;
  startEditing(false);
  prefillMarksFrom(ST.responsesFull[guestKey]);
  renderGridCells();
  showSnackbar(`${displayName}님의 가용시간을 대신 수정하고 있습니다.`);
}

async function saveEditing() {
  const availability = [];
  const ifNeeded = [];
  Object.entries(ST.ownMarks).forEach(([slot, val]) => {
    if (val === "available") availability.push(slotKeyToIso(slot));
    else if (val === "ifNeeded") ifNeeded.push(slotKeyToIso(slot));
  });

  const editingGuestKey = ST.editingAsGuestKey;

  if (editingGuestKey) {
    await api.post(`/api/events/${ST.eventId}/response`, {
      availability,
      ifNeeded,
      guest: true,
      name: editingGuestKey,
    });
    stopEditing();
    await refreshAll();
    showSnackbar("저장되었습니다.", "success");
    return;
  }

  if (ST.currentUser) {
    try {
      await api.post(`/api/events/${ST.eventId}/response`, { availability, ifNeeded, guest: false });
      stopEditing();
      await refreshAll();
      showSnackbar("가용시간이 저장되었습니다.", "success");
    } catch (err) {
      showSnackbar(err.message, "error");
    }
    return;
  }

  // Guest (not signed in)
  ST.pendingAvailability = { availability, ifNeeded };
  document.getElementById("guest-name-input").value = ST.guestName || "";
  document.getElementById("guest-email-field").style.display = ST.event.collectEmails ? "" : "none";
  document.getElementById("guest-name-error").textContent = "";
  openDialog("guest-name-dialog");
}

async function refreshAll() {
  const event = await api.get(`/api/events/${ST.eventId}${ST.guestName ? `?guestName=${encodeURIComponent(ST.guestName)}` : ""}`);
  ST.event = event;
  renderMeta();
  await refreshResponses();
  renderRespondents();
  renderGridCells();
}

/* ---------------------------------------------------------------------- */
/* Calendar autofill (best effort - own calendar only)                     */
/* ---------------------------------------------------------------------- */

async function autofillFromCalendar() {
  if (!ST.dayColumns.length) return;
  const timeMin = ST.dayColumns[0].displayDate.toISOString();
  const last = ST.dayColumns[ST.dayColumns.length - 1];
  const timeMax = new Date(last.displayDate.getTime() + ST.event.duration * 3600000).toISOString();

  try {
    const byAccount = await api.get(`/api/user/calendars?timeMin=${timeMin}&timeMax=${timeMax}`);
    const busyBlocks = [];
    Object.values(byAccount).forEach((acc) => {
      (acc.calendarEvents || []).forEach((evt) => {
        if (!evt.free) busyBlocks.push([new Date(evt.startDate), new Date(evt.endDate)]);
      });
    });

    ST.dayColumns.forEach((col) => {
      for (let row = 0; row < ST.slotCount; row++) {
        const increment = ST.event.timeIncrement || 15;
        const slotStart = new Date(col.displayDate.getTime() + row * increment * 60000);
        const slotEnd = new Date(slotStart.getTime() + increment * 60000);
        const isBusy = busyBlocks.some(([s, e]) => slotStart < e && slotEnd > s);
        const slot = slotKey(col.refDate.getTime() + row * increment * 60000);
        if (!isBusy) ST.ownMarks[slot] = "available";
      }
    });
    renderGridCells();
    showSnackbar("캘린더를 기반으로 채웠습니다. 필요하면 직접 수정해 주세요.", "success");
  } catch (err) {
    showSnackbar("캘린더를 불러오지 못했습니다. Google Calendar가 연결되어 있는지 확인해 주세요.", "error");
  }
}

/* ---------------------------------------------------------------------- */
/* Wiring                                                                   */
/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- */
/* Invite by email                                                         */
/* ---------------------------------------------------------------------- */

const inviteTypedEmails = [];

function inviteSelectedEmails() {
  const checked = [...document.querySelectorAll("#invite-contacts input[type=checkbox]:checked")].map(
    (cb) => cb.value
  );
  return [...new Set([...checked, ...inviteTypedEmails])];
}

function addInviteChip(value) {
  const email = value.trim();
  if (!email || !email.includes("@") || inviteTypedEmails.includes(email)) return;
  inviteTypedEmails.push(email);

  const container = document.getElementById("invite-email-chips");
  const input = document.getElementById("invite-email-input");
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = email;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const i = inviteTypedEmails.indexOf(email);
    if (i >= 0) inviteTypedEmails.splice(i, 1);
    chip.remove();
  });
  chip.appendChild(remove);
  container.insertBefore(chip, input);
}

async function openInviteDialog() {
  document.getElementById("invite-error").textContent = "";
  openDialog("invite-dialog");

  const root = document.getElementById("invite-contacts");
  try {
    const contacts = await api.get("/api/contacts");
    root.innerHTML = "";
    if (!contacts.length) {
      root.innerHTML = `<p class="hint" style="margin:0;">저장된 연락처가 없습니다. <a href="/contacts">연락처 추가하기</a></p>`;
      return;
    }
    contacts.forEach((c) => {
      const label = document.createElement("label");
      label.className = "checkbox-row";
      label.style.marginBottom = "6px";
      label.innerHTML = `
        <input type="checkbox" value="${escapeHtml(c.email)}" />
        <span class="checkbox-copy">
          ${escapeHtml(c.name)}
          <div class="desc">${escapeHtml(c.email)}</div>
        </span>
      `;
      root.appendChild(label);
    });
  } catch (err) {
    root.innerHTML = `<p class="hint" style="margin:0;">연락처를 불러오지 못했습니다.</p>`;
  }
}

async function sendInvites() {
  const errorEl = document.getElementById("invite-error");
  const btn = document.getElementById("invite-send-btn");
  errorEl.textContent = "";

  // Fold in whatever is still sitting in the input but not yet chipped.
  const pending = document.getElementById("invite-email-input");
  if (pending.value.trim()) {
    addInviteChip(pending.value);
    pending.value = "";
  }

  const emails = inviteSelectedEmails();
  if (!emails.length) {
    errorEl.textContent = "보낼 사람을 한 명 이상 선택하거나 입력해 주세요.";
    return;
  }

  btn.disabled = true;
  try {
    const result = await api.post(`/api/events/${ST.eventId}/invite`, {
      emails,
      message: document.getElementById("invite-message").value.trim(),
    });
    closeDialog("invite-dialog");
    showSnackbar(`${result.sent}명에게 초대 메일을 보냈습니다.`, "success");

    inviteTypedEmails.length = 0;
    document.querySelectorAll("#invite-email-chips .chip").forEach((c) => c.remove());
    document.getElementById("invite-message").value = "";
    if (ST.isGroup) await refreshAll();
  } catch (err) {
    errorEl.textContent = err.message || "초대 메일을 보내지 못했습니다.";
  } finally {
    btn.disabled = false;
  }
}

function wireStaticButtons() {
  document.getElementById("copy-link-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(window.location.href);
    showSnackbar("링크가 복사되었습니다.", "success");
  });

  document.getElementById("invite-btn").addEventListener("click", openInviteDialog);
  document.getElementById("invite-send-btn").addEventListener("click", sendInvites);
  document.getElementById("invite-email-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      addInviteChip(e.target.value);
      e.target.value = "";
    }
  });

  document.getElementById("guest-name-submit").addEventListener("click", async () => {
    const name = document.getElementById("guest-name-input").value.trim();
    const email = document.getElementById("guest-email-input").value.trim();
    const errorEl = document.getElementById("guest-name-error");
    if (!name) {
      errorEl.textContent = "이름을 입력해 주세요.";
      return;
    }
    try {
      await api.post(`/api/events/${ST.eventId}/response`, {
        ...ST.pendingAvailability,
        guest: true,
        name,
        email,
      });
      localStorage.setItem(`pcts_guest_name_${ST.eventId}`, name);
      ST.guestName = name;
      ST.viewerKey = name;
      closeDialog("guest-name-dialog");
      stopEditing();
      await refreshAll();
      showSnackbar("가용시간이 저장되었습니다.", "success");
    } catch (err) {
      errorEl.textContent = err.message || "저장하지 못했습니다.";
    }
  });
}

function wireDynamicButtons() {
  document.getElementById("toggle-best-times").addEventListener("click", (e) => {
    ST.showBestTimes = !ST.showBestTimes;
    e.target.classList.toggle("active", ST.showBestTimes);
    renderGridCells();
  });
  document.getElementById("toggle-hide-ifneeded").addEventListener("click", (e) => {
    ST.hideIfNeeded = !ST.hideIfNeeded;
    e.target.classList.toggle("active", ST.hideIfNeeded);
    renderGridCells();
  });

  document.getElementById("respond-btn").addEventListener("click", () => {
    ST.editingAsGuestKey = null;
    startEditing(true);
  });
  document.getElementById("cancel-edit-btn").addEventListener("click", () => stopEditing());
  document.getElementById("save-edit-btn").addEventListener("click", () => saveEditing());

  const autofillBtn = document.getElementById("autofill-btn");
  if (autofillBtn) autofillBtn.addEventListener("click", () => autofillFromCalendar());

  document.getElementById("edit-tool-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tool]");
    if (!btn) return;
    ST.editTool = btn.dataset.tool;
    document.querySelectorAll("#edit-tool-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("edit-tool-hint").textContent = TOOL_HINTS[ST.editTool];
  });

  document.getElementById("delete-response-btn").addEventListener("click", async () => {
    if (!confirm(ST.isGroup ? "그룹에서 나가시겠어요?" : "내 응답을 삭제할까요?")) return;
    const payload = ST.currentUser ? { guest: false, userId: ST.currentUser._id } : { guest: true, name: ST.guestName };
    await api.del(`/api/events/${ST.eventId}/response`, payload);
    document.getElementById("delete-response-btn").style.display = "none";
    document.getElementById("respond-btn").textContent = "가능한 시간 추가";
    await refreshAll();
    showSnackbar("삭제되었습니다.", "success");
  });

  if (ST.isOwner) {
    // Only the host can mail the link out (server enforces this too).
    document.getElementById("invite-btn").style.display = "";

    const editBtn = document.getElementById("edit-event-btn");
    editBtn.style.display = "";
    editBtn.addEventListener("click", () => NewEventDialog.open({ mode: "edit", event: ST.event }));

    const deleteBtn = document.getElementById("delete-event-btn");
    deleteBtn.style.display = "";
    deleteBtn.addEventListener("click", () => openDialog("delete-event-page-dialog"));
    document.getElementById("confirm-delete-event-page-btn").addEventListener("click", async () => {
      await api.del(`/api/events/${ST.event._id}`);
      window.location.href = "/home";
    });
  } else if (!ST.event.ownerId && !ST.isGroup) {
    // Guest-created event: anyone with the link may edit it.
    const editBtn = document.getElementById("edit-event-btn");
    editBtn.style.display = "";
    editBtn.addEventListener("click", () => NewEventDialog.open({ mode: "edit", event: ST.event }));
  }

  if (ST.isGroup) {
    document.getElementById("week-prev").addEventListener("click", () => changeWeek(-1));
    document.getElementById("week-next").addEventListener("click", () => changeWeek(1));
    document.getElementById("week-today").addEventListener("click", () => changeWeek(0, true));

    const hasResponded = ST.viewerKey && !!ST.event.responses[ST.viewerKey];
    if (ST.currentUser && !ST.isOwner && !hasResponded) {
      const declineBtn = document.getElementById("decline-invite-btn");
      declineBtn.style.display = "";
      declineBtn.addEventListener("click", async () => {
        if (!confirm("이 그룹 초대를 거절할까요?")) return;
        await api.post(`/api/events/${ST.event._id}/decline`);
        window.location.href = "/home";
      });
    }
  }
}

async function changeWeek(delta, absolute) {
  ST.weekOffset = absolute ? 0 : ST.weekOffset + delta;
  computeDayColumns();
  renderWeekLabel();
  renderMeta();
  buildGridDom();
  await refreshResponses();
  renderGridCells();
}

document.addEventListener("DOMContentLoaded", init);
