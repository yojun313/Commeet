/* The core scheduling screen: an availability heatmap grid for /e/{id}.
 * Config comes from window.COMMEET_EVENT_CONFIG, rendered server-side by
 * app/routes/page_routes.py. */

const DOW_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const TOOL_HINTS = {
  available: "확실히 참여할 수 있는 시간을 칠하세요. 최적 시간 계산에 반영됩니다.",
  ifNeeded: "선택적으로 최적 배정에 사용 가능합니다.",
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

const ST = {
  eventId: null,
  currentUser: null,
  currentUserEmail: null,
  googleCalendarEnabled: false,
  event: null,
  dayColumns: [], // [{refDate, displayDate}]
  slotCount: 0,
  startHour: 9,
  responsesFull: {}, // userKey -> {availability:[iso], ifNeeded:[iso], user, name}
  responseSets: {}, // userKey -> {available: Set<slotKey>, ifNeeded: Set<slotKey>}
  editing: false,
  editTool: "available",
  ownMarks: {}, // slotKey -> 'available' | 'ifNeeded'
  cellGrid: [], // [row][col] -> cell element, for rectangle drag selection
  dragging: false,
  dragValue: null,
  dragAnchor: null, // {row, col} the drag started on
  dragBase: null, // ownMarks snapshot at drag start, so the rect can be recomputed live
  selectedRespondents: new Set(),
  hoverRespondent: null, // 응답자 목록에서 마우스를 올린 사람 (미리보기)
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
  const cfg = window.COMMEET_EVENT_CONFIG;
  ST.eventId = cfg.eventId;
  ST.currentUser = cfg.currentUser;
  ST.currentUserEmail = cfg.currentUserEmail;
  ST.googleCalendarEnabled = cfg.googleCalendarEnabled;
  ST.guestName = localStorage.getItem(`pcts_guest_name_${ST.eventId}`) || null;
  ST.viewerKey = ST.currentUser ? ST.currentUser._id : ST.guestName;

  wireStaticButtons();
  // `const RecordDialog`은 최상위 선언이라 window의 속성이 되지 않습니다
  // (var/function 선언과 다릅니다). window.RecordDialog로 확인하면 항상
  // undefined라 init()이 통째로 건너뛰어집니다.
  if (typeof RecordDialog !== "undefined") RecordDialog.init();

  try {
    await loadEvent();
  } catch (err) {
    showSnackbar(err.message || "일정을 불러오지 못했습니다.", "error");
  }
}

async function loadEvent() {
  const guestQuery = ST.guestName ? `?guestName=${encodeURIComponent(ST.guestName)}` : "";
  const event = await api.get(`/api/events/${ST.eventId}${guestQuery}`);
  ST.event = event;
  ST.isOwner = !!event.isOwner;

  document.getElementById("ev-title").textContent = event.name;
  document.title = `${event.name} - Commeet`;

  computeDayColumns();
  renderMeta();
  renderEventDescription();
  renderSkeleton();
  wireDynamicButtons();

  if (event.ownerId === null) {
    document.getElementById("guest-owner-banner").innerHTML = `
      <div class="guest-banner">이 일정은 로그인하지 않은 상태에서 만들어져서, 링크를 가진 누구나 수정할 수 있어요.</div>
    `;
  } else if (event.isClosed) {
    const link = `/e/${ST.eventId}/finalize`;
    document.getElementById("guest-owner-banner").innerHTML = `
      <div class="notice">
        <p><b>이 일정은 확정되어 마감되었습니다.</b></p>
        <p style="font-size: 13px; opacity: 0.8;">
          더 이상 가능한 시간을 추가하거나 수정할 수 없습니다.
          ${ST.isOwner ? `<a href="${link}">확정 내용 보기</a>에서 배정을 조정하거나 확정을 취소할 수 있습니다.` : ""}
        </p>
      </div>
    `;
  }
  if (event.adminView && !document.getElementById("admin-view-banner")) {
    // 관리자가 남의 일정을 여는 경우 - 응답은 주최자와 똑같이 보이지만
    // 수정·확정·메일 버튼은 주최자에게만 있습니다 (서버도 막습니다).
    document.getElementById("guest-owner-banner").insertAdjacentHTML(
      "beforeend",
      `<div class="guest-banner" id="admin-view-banner">관리자 보기: 주최자와 같은 응답 화면입니다. 일정 수정·확정·메일 발송은 주최자만 할 수 있습니다.</div>`
    );
  }

  await refreshResponses();
  renderRespondents();
  renderGridCells();

  updateRespondBtnVisibility();
  loadEventRecords();
  // 여기서부터는 다른 참가자의 입력이 자동으로 따라 들어옵니다.
  liveSyncVersion();
  startLive();
  if (event.isClosed) {
    // Availability is frozen once the schedule is confirmed - the server
    // rejects writes too (409), but hiding the controls avoids a round trip.
    document.getElementById("delete-response-btn").style.display = "none";
  }
}

// respond-btn ("가능한 시간 입력"/"가능한 시간 수정") sits in the toolbar
// directly above the calendar, since that's what it acts on. The host sees
// it too - they need to enter their own availability like everyone else
// (their separate "초대 보내기" action lives in the sidebar). Hidden only
// while already editing, or once the schedule is confirmed and frozen.
function updateRespondBtnVisibility() {
  const btn = document.getElementById("respond-btn");
  if (!btn) return;
  const hidden = ST.editing || (ST.event && ST.event.isClosed);
  btn.style.display = hidden ? "none" : "";
}

/* 서버 event_service.is_past_event()와 같은 규칙. */
function isPastEvent(event) {
  const dates = (event.dates || []).map((d) => new Date(d));
  if (!dates.length) return false;
  const last = new Date(Math.max(...dates));
  last.setHours(last.getHours() + (event.duration || 0));
  return last < new Date();
}

function computeDayColumns() {
  const uniqueRefTimes = [...new Set(ST.event.dates)].map((d) => new Date(d)).sort((a, b) => a - b);
  ST.dayColumns = uniqueRefTimes.map((refDate) => ({
    refDate,
    displayDate: refDate,
  }));
  // 행 라벨의 기준 시각. 보기 시간대(TZView)가 바뀌면 여기부터 다시 계산됩니다.
  ST.startHour = uniqueRefTimes.length ? TZView.hourFrac(uniqueRefTimes[0]) : 9;
  ST.slotCount = Math.max(1, Math.round((ST.event.duration * 60) / (ST.event.timeIncrement || 15)));
}

function renderMeta() {
  const cols = ST.dayColumns;
  if (!cols.length) return;
  const first = cols[0].displayDate;
  const last = cols[cols.length - 1].displayDate;
  const fmt = (d) => {
    const p = TZView.parts(d);
    return `${p.month}/${p.day}`;
  };
  const respCount = Object.keys(ST.event.responses || {}).length;
  document.getElementById("ev-meta").textContent = `${fmt(first)} ~ ${fmt(last)} · 응답 ${respCount}명`;
}

// 설명이 있으면 항상 펼쳐 보입니다 (없으면 카드째 숨김). markdown은 앱 내
// 뷰어(markdown.js - 렌더 전에 전부 이스케이프)를 거치고, 일반 텍스트는
// 줄바꿈을 유지합니다.
function renderEventDescription() {
  const wrap = document.getElementById("ev-description");
  const body = document.getElementById("ev-description-body");
  if (!wrap || !body) return;

  // renderDescription() comes from markdown.js - deliberately not reusing
  // that name here, since a same-named function declaration would shadow it.
  const html = renderDescription(ST.event.description, ST.event.descriptionFormat);
  if (!html) {
    wrap.style.display = "none";
    body.innerHTML = "";
    return;
  }
  wrap.style.display = "";
  body.innerHTML = html;
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
            <span class="legend-swatch if-needed-swatch"></span>가능(비선호)만 있음
          </span>
        </div>
      </div>
      <div class="grid-toolbar-right">
        <button class="btn btn-sm btn-ghost" id="toggle-best-times">최적 시간만 보기</button>
        <button class="btn btn-sm btn-ghost" id="toggle-hide-ifneeded">가능(비선호) 숨기기</button>
      </div>
    </div>

    <div class="tz-bar">
      <span class="tz-note" id="tz-note"></span>
      <label class="tz-select-wrap">시간대
        <select class="input input-sm" id="tz-select"></select>
      </label>
    </div>

    <div class="selection-bar" id="selection-bar" hidden>
      <span data-role="sel-text"></span>
      <button type="button" class="btn btn-ghost btn-sm" id="selection-clear">선택 해제</button>
    </div>

    <details class="term-help">
      <summary>“가능”과 “가능(비선호)”는 어떻게 다른가요?</summary>
      <dl class="term-help-body">
        <dt><span class="legend-swatch available-swatch"></span>가능</dt>
        <dd>이 시간에 <strong>확실히 참여할 수 있다</strong>는 뜻입니다. 최적의 시간을 고를 때는 이 응답만 집계합니다.</dd>
        <dt><span class="legend-swatch if-needed-swatch"></span>가능(비선호)</dt>
        <dd>
          <strong>꼭 필요하다면 맞출 수 있지만, 다른 시간이 더 좋다</strong>는 뜻입니다.
          차선책으로만 참고하며 <em>최적 시간만 보기</em>에는 포함되지 않습니다.
        </dd>
      </dl>
      <p class="term-help-note">
        칸의 색이 진할수록 “가능”이라고 답한 사람이 많습니다.
        “가능”인 사람이 아무도 없고 “가능(비선호)”만 있는 칸은 노란색으로 표시됩니다.
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
              <button type="button" data-tool="ifNeeded">가능(비선호)</button>
            </div>
            <span class="edit-hint" id="edit-tool-hint">${TOOL_HINTS.available}</span>
            <span class="edit-hint edit-host-legend" id="edit-host-legend" style="display: none;">
              <span class="host-dot"></span> 주최자 가능
              <span class="host-dot host-dot-soft"></span> 주최자 가능(비선호)
            </span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-sm btn-secondary" id="autofill-btn" style="display: none;">캘린더로 자동 채우기</button>
            <button class="btn btn-ghost btn-sm" id="cancel-edit-btn">취소</button>
            <button class="btn btn-primary btn-sm" id="save-edit-btn">저장</button>
          </div>
        </div>
      </div>

      <div class="sidebar-col">
        <button class="btn btn-primary respond-cta" id="respond-btn">가능한 시간 입력</button>
        <div class="card sidebar-card">
          <div class="sidebar-heading-row">
            <h3>응답자 (<span id="respondent-count">0</span>)</h3>
          </div>
          <div id="respondents-list"></div>
          <button class="btn btn-primary btn-block" id="invite-btn" style="display: none; margin-top: 14px;">초대 보내기</button>
          <button class="btn btn-secondary btn-block" id="message-btn" style="display: none; margin-top: 8px;">메일 보내기</button>
          <button class="btn btn-secondary btn-block" id="enable-records-btn" style="display: none; margin-top: 8px;">지도면담 기록 입력</button>
          <button class="btn btn-ghost btn-block" id="delete-response-btn" style="display: none; margin-top: 8px; color: var(--color-danger);">
            내 응답 삭제
          </button>
        </div>
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
  // 마지막 한 줄은 끝 시각 라벨 전용입니다 (아래 루프 끝 참고).
  grid.style.gridTemplateRows = `var(--grid-head-h) repeat(${ST.slotCount}, var(--grid-row-h)) var(--grid-row-h)`;
  grid.innerHTML = "";

  grid.appendChild(el(`<div class="avail-grid-corner"></div>`));
  cols.forEach((col) => {
    const p = TZView.parts(col.displayDate);
    grid.appendChild(
      el(`
        <div class="day-col-header">
          <div class="dow">${DOW_LABELS[p.dow]}</div>
          <div class="dnum">${p.month}/${p.day}</div>
        </div>
      `)
    );
  });

  const increment = ST.event.timeIncrement || 15;
  ST.cellGrid = [];
  for (let row = 0; row < ST.slotCount; row++) {
    const hour = ST.startHour + (row * increment) / 60;
    const isHourMark = Math.abs((hour * 60) % 60) < 0.01;
    // 정시에만 라벨을 달면, 12:30~13:30처럼 정시가 아닌 데서 시작하는 짧은
    // 일정은 라벨이 하나도 안 보입니다 - 첫 줄(시작 시각)은 항상 표시합니다.
    const showLabel = isHourMark || row === 0;
    const labelCell = el(`<div class="time-row-label">${showLabel ? timeLabel(hour) : ""}</div>`);
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

  // 끝 시각 줄: 칸은 없고 라벨만. 범위가 어디서 끝나는지(예: 오후 1:30)가
  // 항상 보이게 합니다.
  const endHour = ST.startHour + (ST.slotCount * increment) / 60;
  grid.appendChild(el(`<div class="time-row-label time-row-label-end">${timeLabel(endHour)}</div>`));
  const endFiller = document.createElement("div");
  endFiller.className = "grid-end-filler";
  endFiller.style.gridColumn = `2 / span ${cols.length}`;
  grid.appendChild(endFiller);

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
    document.getElementById("respond-btn").textContent = "가능한 시간 수정";
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

  // 편집 중에는 주최자가 표시해 둔 시간을 점으로 함께 보여 줍니다 - 초대받은
  // 사람이 주최자와 겹치는 칸을 고를 수 있게. 주최자 본인이 편집할 때는 자기
  // 표시가 곧 그 정보라 뺍니다. 비공개(blind) 일정은 서버가 남의 응답을 아예
  // 내려 주지 않으므로(apply_blind_filter) 자연히 아무것도 안 나옵니다.
  const hostSets =
    ST.editing && !ST.isOwner && ST.event.ownerId
      ? ST.responseSets[ST.event.ownerId]
      : null;

  // 미리보기(호버) > 선택 > 전체 순. 호버는 잠깐 보는 것이라 선택을 바꾸지 않습니다.
  const focusKeys = ST.hoverRespondent
    ? [ST.hoverRespondent]
    : ST.selectedRespondents.size
      ? [...ST.selectedRespondents]
      : null;
  syncSelectionBar();

  cells.forEach((cell) => {
    cell.classList.remove("available", "if-needed", "dim", "own-preview", "host-avail", "host-ifneeded", "all-selected");
    cell.style.background = "";
    const slot = cell.dataset.slot;

    if (ST.editing) {
      const mark = ST.ownMarks[slot];
      if (mark === "available") cell.classList.add("available");
      else if (mark === "ifNeeded") cell.classList.add("if-needed");
      if (hostSets) {
        if (hostSets.available.has(slot)) cell.classList.add("host-avail");
        else if (hostSets.ifNeeded.has(slot)) cell.classList.add("host-ifneeded");
      }
      return;
    }

    if (focusKeys) {
      // 고른 사람들만 집계합니다. 예전에는 합집합(한 명이라도 되면 꽉 찬
      // 색)이라 "몇 명이 되는지"가 안 보였습니다 - 이제 고른 인원 대비
      // 가능 인원으로 진하기를 정하고, 전원 가능한 칸은 테두리로 강조합니다.
      let avail = 0;
      let soft = 0;
      focusKeys.forEach((key) => {
        const sets = ST.responseSets[key];
        if (!sets) return;
        if (sets.available.has(slot)) avail++;
        else if (!ST.hideIfNeeded && sets.ifNeeded.has(slot)) soft++;
      });
      const n = focusKeys.length;
      if (avail > 0) {
        const opacity = n === 1 ? 0.85 : 0.18 + 0.82 * (avail / n);
        cell.style.background = `rgba(200, 1, 80, ${opacity.toFixed(2)})`;
      } else if (soft > 0) {
        const opacity = n === 1 ? 0.75 : 0.25 + 0.6 * (soft / n);
        cell.style.background = `rgba(245, 195, 68, ${opacity.toFixed(2)})`;
      }
      if (n > 1 && avail === n) cell.classList.add("all-selected");
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

/* 초대만 받고 아직 응답하지 않은 사람들 (주최자에게만 서버가 내려 줌 -
   event_routes의 pendingInvitees, "메일 보내기"의 리마인더 대상과 같은 계산).
   응답자 아래에 회색으로 붙여, 누구를 재촉해야 하는지 목록에서 바로 보입니다. */
function appendPendingInvitees(list) {
  const pending = ST.event.pendingInvitees || [];
  if (!pending.length) return;

  const head = document.createElement("div");
  head.className = "respondent-pending-head";
  head.textContent = `미응답 (${pending.length})`;
  list.appendChild(head);

  pending.forEach((p) => {
    const row = document.createElement("div");
    // 클릭할 것이 없습니다 - 표시할 가용시간이 아직 없으니까요.
    row.className = "respondent-row respondent-pending";
    row.title = `${p.email} - 아직 응답하지 않았습니다`;
    row.innerHTML = `
      <span class="avatar sm">${escapeHtml((p.name || p.email || "?")[0].toUpperCase())}</span>
      <span class="name">${escapeHtml(p.name || p.email)}<span class="respondent-pending-tag">미응답</span></span>
    `;
    list.appendChild(row);
  });
}

/* 응답 키 -> 화면에 보이는 이름 (응답자 목록과 같은 규칙). */
function respondentName(key) {
  const resp = (ST.event.responses || {})[key];
  if (!resp) return key;
  const isGuestEntry = !resp.user || !resp.user._id;
  return isGuestEntry
    ? resp.name || (resp.user ? resp.user.name : "") || key
    : (resp.user.name || "").trim() || resp.user.email;
}

/* 선택 중일 때 격자 위 안내줄: 무엇을 기준으로 칠했는지 + 해제 버튼. */
function syncSelectionBar() {
  const bar = document.getElementById("selection-bar");
  if (!bar) return;
  const n = ST.selectedRespondents.size;
  // 보이고 숨는 것은 "선택이 있느냐"로만 정합니다. 호버로 숨겼다 보였다 하면
  // 격자가 위아래로 밀려, 응답자 목록을 누르려던 줄이 옆 사람으로 바뀝니다.
  if (ST.editing || !n) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const names = [...ST.selectedRespondents].map(respondentName);
  bar.querySelector("[data-role=sel-text]").textContent = ST.hoverRespondent
    ? `${respondentName(ST.hoverRespondent)}님 미리보기 중 (마우스를 떼면 선택한 ${n}명 보기로 돌아갑니다)`
    : n === 1
      ? `${names[0]}님의 가능한 시간만 보고 있습니다.`
      : `선택한 ${n}명(${names.join(", ")}) 기준 · 진할수록 더 많은 사람이 가능 · 테두리 = 전원 가능`;
}

/* 셀 툴팁: 그 시간에 누가 되는지. 지연 없이 바로 뜨도록 브라우저 title
   대신 떠 있는 박스 하나를 재사용합니다. */
let cellTip = null;
function cellTooltipEl() {
  if (!cellTip) {
    cellTip = document.createElement("div");
    cellTip.className = "cell-tooltip";
    cellTip.hidden = true;
    document.body.appendChild(cellTip);
  }
  return cellTip;
}
function hideCellTooltip() {
  if (cellTip) cellTip.hidden = true;
}
function showCellTooltip(cell, x, y) {
  const slot = cell.dataset.slot;
  const keys = Object.keys(ST.responseSets || {});
  if (!keys.length) return hideCellTooltip();
  const yes = [];
  const soft = [];
  const no = [];
  keys.forEach((key) => {
    const sets = ST.responseSets[key];
    if (sets.available.has(slot)) yes.push(respondentName(key));
    else if (sets.ifNeeded.has(slot)) soft.push(respondentName(key));
    else no.push(respondentName(key));
  });
  const start = new Date(Number(slot));
  const end = new Date(start.getTime() + (ST.event.timeIncrement || 15) * 60000);
  const line = (label, cls, names) =>
    names.length
      ? `<div class="ct-row"><span class="ct-label ${cls}">${label} ${names.length}</span><span class="ct-names">${names.map(escapeHtml).join(", ")}</span></div>`
      : "";
  const tip = cellTooltipEl();
  tip.innerHTML =
    `<div class="ct-head">${escapeHtml(fmtMeetingRange(start.toISOString(), end.toISOString()))}</div>` +
    line("가능", "ct-yes", yes) +
    line("비선호", "ct-soft", soft) +
    line("불가", "ct-no", no);
  tip.hidden = false;
  // 커서 오른쪽 아래에 두되, 화면 밖으로 나가면 반대편으로 뒤집습니다.
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + pad;
  let top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + h > window.innerHeight - 8) top = y - h - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function renderRespondents() {
  const list = document.getElementById("respondents-list");
  const responses = ST.event.responses || {};
  const keys = Object.keys(responses);
  document.getElementById("respondent-count").textContent = keys.length;

  if (!keys.length) {
    list.innerHTML = `<p class="hint">아직 응답이 없습니다. 첫 응답자가 되어보세요!</p>`;
    appendPendingInvitees(list);
    // Still size the calendar - it has to fit the viewport whether or not
    // anyone has answered yet.
    syncLayoutHeights();
    return;
  }

  list.innerHTML = "";
  keys.forEach((key) => {
    const resp = responses[key];
    const isGuestEntry = !resp.user || !resp.user._id;
    const displayName = isGuestEntry
      ? resp.name || (resp.user ? resp.user.name : "")
      : (resp.user.name || "").trim() || resp.user.email;
    // 목록에서 내 줄을 바로 찾을 수 있게 표시합니다. viewerKey는 로그인했으면
    // 사용자 id, 게스트면 이름이고 응답 목록의 키와 같은 값입니다.
    const isMe = !!ST.viewerKey && key === ST.viewerKey;
    const canEditAsGuest = isGuestEntry && ST.isOwner && !ST.event.isClosed;

    const row = document.createElement("div");
    row.className = "respondent-row" + (ST.selectedRespondents.has(key) ? " selected" : "");
    row.innerHTML = `
      <span class="avatar sm">${(displayName || "?")[0].toUpperCase()}</span>
      <span class="name">${escapeHtml(displayName)}${isMe ? '<span class="respondent-me">(나)</span>' : ""}</span>
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
      ST.hoverRespondent = null;
      renderRespondents();
      renderGridCells();
    });
    // 마우스를 올리면 그 사람의 시간만 바로 미리보기 (터치 기기에선 탭=선택).
    row.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || ST.editing) return;
      ST.hoverRespondent = key;
      renderGridCells();
    });
    row.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse" || ST.hoverRespondent !== key) return;
      ST.hoverRespondent = null;
      renderGridCells();
    });
    list.appendChild(row);
  });

  appendPendingInvitees(list);
  syncLayoutHeights();
}

// Caps #respondents-list to whatever's left of the calendar's own
// (content-driven) height once the sidebar's other chrome (heading, action
// buttons, padding) is subtracted, so a long respondent list scrolls inside
// that fixed budget instead of growing past the calendar - re-measured
// after every render since respondent count changes it.
//
// CSS alone can't express this: `.event-layout` stretches both grid columns
// to a shared row height, but that row height is itself computed from BOTH
// columns' natural (unconstrained) content size - so before this ran, a
// long respondent list would inflate the row height, which then stretched
// the *calendar column wrapper* taller too (even though its actual content,
// .grid-scroll, stayed its own short natural height - the wrapper just
// gained empty space at the bottom). That's why this measures .grid-scroll
// and .edit-bar directly instead of the stretched wrapper itself: the
// wrapper's rendered height already echoes back whatever the sidebar
// demanded, not the calendar's true size.
function syncRespondentListHeight() {
  const calCol = document.querySelector(".event-layout > div:first-child");
  const sidebar = document.querySelector(".sidebar-card");
  const list = document.getElementById("respondents-list");
  if (!calCol || !sidebar || !list) return;

  // Below the layout's stacking breakpoint (see CSS @media max-width:1024px)
  // the sidebar sits above the calendar instead of beside it, so there's no
  // sibling height to match - the CSS max-height fallback there applies.
  if (window.innerWidth <= 1024) {
    list.style.maxHeight = "";
    return;
  }

  let calHeight = 0;
  [...calCol.children].forEach((child) => {
    const style = getComputedStyle(child);
    if (style.display === "none") return;
    calHeight += child.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  });

  // Everything sharing the right column with the list eats into its budget:
  // the "가능한 시간 입력" CTA stacked above the card, plus the card's own
  // padding, heading row and action buttons.
  const cardStyle = getComputedStyle(sidebar);
  let chromeHeight = parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom);

  const addBox = (child) => {
    const style = getComputedStyle(child);
    if (style.display === "none") return;
    chromeHeight +=
      child.getBoundingClientRect().height +
      parseFloat(style.marginTop) +
      parseFloat(style.marginBottom);
  };

  const sidebarCol = sidebar.parentElement;
  if (sidebarCol && sidebarCol.classList.contains("sidebar-col")) {
    [...sidebarCol.children].forEach((child) => {
      if (child !== sidebar) addBox(child);
    });
  }
  [...sidebar.children].forEach((child) => {
    if (child.id !== "respondents-list") addBox(child);
  });

  list.style.maxHeight = `${Math.max(120, calHeight - chromeHeight)}px`;
}

/* ---------------------------------------------------------------------- */
/* 면담 기록 · 학생지도비 (주최자 전용, 확정된 뒤에만)                      */
/* ---------------------------------------------------------------------- */

/* 확정된 시간대마다 한 줄씩 보여 주고, 각 줄에서 기록 폼(RecordDialog)을
 * 엽니다. 폼 마크업은 partials/record_form_dialog.html, 동작은
 * record-form.js의 RecordDialog입니다.
 *
 * 기준은 저장된 finalization.meetings입니다. 확정 화면의 편집 중인 배정과
 * 달리 이건 실제로 저장된 약속이라, 기록을 걸 수 있는 유일한 대상입니다. */

let recordsByStart = new Map();

function confirmedMeetings() {
  const fin = ST.event && ST.event.finalization;
  if (!fin || fin.status !== "confirmed") return [];
  return (fin.meetings || []).slice().sort((a, b) => new Date(a.start) - new Date(b.start));
}

function participantDisplayName(key) {
  const resp = (ST.event.responses || {})[key];
  if (!resp) return key; // 게스트 키는 이름 그 자체라 그대로 써도 맞습니다.
  const user = resp.user || {};
  return (user.name || "").trim() || resp.name || user.email || key;
}

function fmtMeetingRange(startIso, endIso) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const sp = TZView.parts(startIso);
  const ep = TZView.parts(endIso);
  return `${sp.month}/${sp.day}(${days[sp.dow]}) ${pad2(sp.hour)}:${pad2(sp.minute)} ~ ${pad2(ep.hour)}:${pad2(ep.minute)}`;
}

/* 이 일정에서 "면담 기록 · 학생지도비"를 쓰는가.

   값이 **없는** 일정은 켜진 것으로 봅니다 - 이 항목이 생기기 전에 만든
   일정에도 이미 적어 둔 기록이 있는데, 없다고 꺼 버리면 그 기록에 닿을 길이
   사라집니다. 서버 쪽 같은 규칙은 event_service.records_enabled()입니다. */
function recordsEnabled() {
  return !!ST.event && ST.event.guidanceRecordsEnabled !== false;
}

async function loadEventRecords() {
  const card = document.getElementById("ev-records-card");
  if (!card) return;
  // 기능을 끈 일정에서는 카드 대신 사이드바의 "지도면담 기록 입력" 버튼이
  // 보입니다 (wireDynamicButtons) - 누르면 기능을 켜고 이 카드가 나타납니다.
  if (!recordsEnabled() || !ST.isOwner) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  try {
    const data = await api.get(`/api/records?eventId=${encodeURIComponent(ST.eventId)}`);
    recordsByStart = new Map((data.records || []).map((r) => [slotKey(r.meetingStart), r]));
  } catch (err) {
    recordsByStart = new Map();
  }
  renderEventRecordRows();
}

function renderEventRecordRows() {
  const root = document.getElementById("ev-records-list");
  const meetings = confirmedMeetings();
  const now = Date.now();
  let done = 0;

  root.innerHTML = "";

  // 확정된 약속에 걸리지 않은 기록(직접 추가분). 확정 전에 쓴 기록이거나,
  // 재확정으로 시간대가 바뀌어 떨어져 나온 기록입니다 - 안 보이면 지울 수도
  // 고칠 수도 없게 되므로 반드시 목록에 남깁니다.
  const meetingKeys = new Set(meetings.map((m) => slotKey(m.start)));
  const adhoc = [...recordsByStart.entries()]
    .filter(([k]) => !meetingKeys.has(k))
    .map(([, r]) => r)
    .sort((a, b) => new Date(a.meetingStart) - new Date(b.meetingStart));

  // "직접 추가"는 매번 **새** 기록을 만드는 버튼이라, 이미 직접 추가한
  // 기록이 있으면 숨깁니다 - 남겨 두면 이어서 쓰려고 눌렀다가 빈 폼을
  // 만나게 됩니다. 수정은 각 기록의 "면담 정보 수정"으로 합니다.
  const addBtn = document.getElementById("ev-records-add");
  if (addBtn) addBtn.style.display = adhoc.length ? "none" : "";

  adhoc.forEach((record) => {
    const names = (record.attendees || []).map((a) => a.name).filter(Boolean);
    const amount = (record.settlements || []).reduce((sum, x) => sum + (x.amount || 0), 0);
    const row = el(`
      <div class="fin-record-row is-done">
        <div class="fin-record-when">
          <span class="fin-record-time">${escapeHtml(record.date || "")} ${escapeHtml(record.startTime || "")}</span>
          <span class="badge badge-muted">직접 추가</span>
        </div>
        <div class="fin-record-people" title="${escapeHtml(names.join(", "))}">${escapeHtml(names.join(", ")) || "-"}</div>
        <div class="fin-record-state">
          <span class="badge badge-muted">작성됨</span><span class="fin-record-amount">${escapeHtml(amount.toLocaleString("ko-KR"))}원</span>
        </div>
        <div class="fin-record-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-write>면담 정보 수정</button>
          ${(record.settlements || [])
            .map(
              (s) =>
                `<a class="btn btn-ghost btn-sm" href="/records/${encodeURIComponent(record._id)}/print?aff=${encodeURIComponent(s.affiliation)}" target="_blank" rel="noopener">${s.affiliation === "muunjae" ? "무은재" : "컴공"} 신청서</a>`
            )
            .join("")}
        </div>
      </div>
    `);
    row.querySelector("[data-write]").addEventListener("click", () =>
      RecordDialog.open(ST.eventId, record.meetingStart, loadEventRecords)
    );
    root.appendChild(row);
  });

  if (!meetings.length && !adhoc.length) {
    root.appendChild(
      el('<p class="hint" style="margin:0;">아직 기록이 없습니다. 위의 "면담 기록 직접 추가"로 시작하세요.</p>')
    );
  }

  meetings.forEach((m) => {
    const record = recordsByStart.get(slotKey(m.start));
    if (record) done++;
    const ended = new Date(m.end).getTime() <= now;
    const names = (m.participants || []).map(participantDisplayName);
    const amount = record
      ? (record.settlements || []).reduce((sum, x) => sum + (x.amount || 0), 0)
      : 0;

    const row = el(`
      <div class="fin-record-row${record ? " is-done" : ""}">
        <div class="fin-record-when">
          <span class="fin-record-time">${escapeHtml(fmtMeetingRange(m.start, m.end))}</span>
          ${ended ? "" : '<span class="badge badge-muted">예정</span>'}
        </div>
        <div class="fin-record-people" title="${escapeHtml(names.join(", "))}">${
          escapeHtml(names.join(", ")) || "-"
        }</div>
        <div class="fin-record-state">
          ${
            record
              ? `<span class="badge badge-muted">작성됨</span><span class="fin-record-amount">${escapeHtml(
                  amount.toLocaleString("ko-KR")
                )}원</span>`
              : '<span class="badge">기록 필요</span>'
          }
        </div>
        <div class="fin-record-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-write>${
            record ? "면담 정보 수정" : "기록 작성"
          }</button>
          ${
            record
              ? (record.settlements || [])
                  .map(
                    (s) =>
                      `<a class="btn btn-ghost btn-sm" href="/records/${encodeURIComponent(
                        record._id
                      )}/print?aff=${encodeURIComponent(s.affiliation)}" target="_blank" rel="noopener">${
                        s.affiliation === "muunjae" ? "무은재" : "컴공"
                      } 신청서</a>`
                  )
                  .join("")
              : ""
          }
        </div>
      </div>
    `);
    row.querySelector("[data-write]").addEventListener("click", () =>
      RecordDialog.open(ST.eventId, m.start, loadEventRecords)
    );
    root.appendChild(row);
  });

  const total = meetings.length + adhoc.length;
  document.getElementById("ev-records-summary").textContent =
    total ? `${total}건 중 ${done + adhoc.length}건 작성됨` : "";
}

/* ---------------------------------------------------------------------- */
/* Calendar vertical sizing                                                */
/* ---------------------------------------------------------------------- */

// An hour always occupies the same height regardless of the event's time
// increment - the model timeful.app uses (60px/hour, so a 15-min row is
// 15px and a 60-min row is 60px). That keeps the grid readable as a clock
// rather than as N equal-height slots: the old flat 16px-per-row made an
// 8-hour day at 30-min increments only half as tall as the same day at
// 15-min increments.
//
// The calendar is the page's priority, so nothing constrains it: a longer
// day simply makes a taller grid and a taller page, never an inner scroll
// area. The respondents sidebar then follows the calendar's height (see
// syncRespondentListHeight), scrolling internally if the roster outgrows it.
const HOUR_HEIGHT = 60;
// Phones get a denser hour so a full day doesn't turn into an endless scroll
// on a small screen.
const HOUR_HEIGHT_MOBILE = 44;
const MOBILE_GRID_BREAKPOINT = 768;

function syncCalendarHeight() {
  const grid = document.getElementById("avail-grid");
  if (!grid || !ST.slotCount || !ST.event) return;
  const scroll = grid.closest(".grid-scroll");
  if (!scroll) return;

  const increment = ST.event.timeIncrement || 15;
  const hourH = window.innerWidth <= MOBILE_GRID_BREAKPOINT ? HOUR_HEIGHT_MOBILE : HOUR_HEIGHT;
  grid.style.setProperty("--grid-row-h", `${(hourH * increment) / 60}px`);

  // Only the fixed-size "자세히 보기" modal caps the grid (its own CSS gives
  // it an inner scroll); on the page itself the grid is never height-capped.
  scroll.style.maxHeight = "";
}

// Calendar first: the sidebar's height follows the calendar's, so the
// respondent list can only be measured once the calendar has settled.
function syncLayoutHeights() {
  syncCalendarHeight();
  syncRespondentListHeight();
}

/* ---------------------------------------------------------------------- */
/* Editing / drag-select                                                   */
/* ---------------------------------------------------------------------- */

function wireGridInteraction(grid) {
  // 셀 툴팁. 마우스는 올리는 즉시, 터치는 탭하면 뜹니다. 편집(칠하기) 중에는
  // 손가락/커서를 가리므로 띄우지 않습니다.
  grid.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || ST.editing) return;
    const cell = e.target.closest && e.target.closest(".grid-cell");
    if (cell) showCellTooltip(cell, e.clientX, e.clientY);
    else hideCellTooltip();
  });
  grid.addEventListener("pointerleave", hideCellTooltip);
  grid.addEventListener("click", (e) => {
    if (ST.editing) return;
    const cell = e.target.closest && e.target.closest(".grid-cell");
    if (cell && matchMedia("(pointer: coarse)").matches) showCellTooltip(cell, e.clientX, e.clientY);
  });

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
  ST.hoverRespondent = null;
  hideCellTooltip();
  ST.ownMarks = {};

  if (prefillFromSelf && ST.viewerKey) {
    prefillMarksFrom(ST.responsesFull[ST.viewerKey]);
  }

  document.getElementById("edit-bar").style.display = "flex";
  updateRespondBtnVisibility();
  document.getElementById("avail-grid").classList.add("editing");
  document.getElementById("edit-tool-hint").textContent = TOOL_HINTS[ST.editTool];
  const hostLegend = document.getElementById("edit-host-legend");
  if (hostLegend) {
    const has = !ST.isOwner && ST.event.ownerId && ST.responseSets[ST.event.ownerId];
    hostLegend.style.display = has ? "" : "none";
  }
  const autofillBtn = document.getElementById("autofill-btn");
  if (autofillBtn) {
    autofillBtn.style.display = ST.googleCalendarEnabled && ST.currentUser ? "" : "none";
  }
  renderGridCells();
  // The edit bar that just appeared below the grid eats into its height budget.
  syncLayoutHeights();
}

function stopEditing() {
  ST.editing = false;
  ST.editingAsGuestKey = null;
  ST.dragging = false;
  ST.dragAnchor = null;
  ST.dragBase = null;
  document.getElementById("edit-bar").style.display = "none";
  updateRespondBtnVisibility();
  document.getElementById("avail-grid").classList.remove("editing");
  renderGridCells();
  syncLayoutHeights();
  // 편집하는 동안 폴링을 미뤄 두었으니 (live.js의 isBusy) 간격을 되돌립니다.
  live.wake();
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
    try {
      await api.post(`/api/events/${ST.eventId}/response`, {
        availability,
        ifNeeded,
        guest: true,
        name: editingGuestKey,
      });
      stopEditing();
      await refreshAll();
      showSnackbar("저장되었습니다.", "success");
    } catch (err) {
      showSnackbar(err.message, "error");
    }
    return;
  }

  if (ST.currentUser) {
    // 이번 저장이 "처음"인지는 저장하기 전에만 알 수 있습니다 (아래 초대 권유).
    const hadResponse = !!(ST.viewerKey && ST.responsesFull[ST.viewerKey]);
    try {
      await api.post(`/api/events/${ST.eventId}/response`, { availability, ifNeeded, guest: false });
      stopEditing();
      await refreshAll();
      showSnackbar("가용시간이 저장되었습니다.", "success");
      maybeOfferInvite(hadResponse);
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

// 격자 자체를 다시 세워야 하는 변화인지 판별합니다. 응답이 하나 늘어난
// 것뿐이라면 셀 색만 다시 칠하면 되지만, 후보 날짜나 길이가 바뀌었거나
// 일정이 확정되면 열 개수/안내 문구까지 달라지므로 loadEvent()로 처음부터
// 다시 그려야 합니다.
/* 이미 누군가를 초대해 둔 일정인지. */
function hasInvitedAnyone() {
  return ((ST.event.remindees || []).length) > 0;
}

/* 주최자가 **처음** 가능한 시간을 저장한 직후에 초대할지 물어봅니다.
 *
 * 일정을 만들 때는 초대 메일을 보내지 않습니다 (event_service.create_event).
 * 주최자는 보통 일정을 만든 다음에 자기 시간을 찍는데, 그 사이에 메일이
 * 나가면 받는 사람은 아무도 표시하지 않은 빈 화면을 열게 됩니다. 화면이
 * 볼 만해진 이 시점이 초대를 권하기에 맞는 자리입니다.
 *
 * 두 번째 저장부터는 묻지 않습니다 - 시간을 고칠 때마다 물으면 성가십니다.
 */
function maybeOfferInvite(hadResponseBefore) {
  if (hadResponseBefore) return; // 처음이 아님
  if (!ST.isOwner || !ST.event || ST.event.isClosed) return;
  if (hasInvitedAnyone()) return; // 이미 초대해 둔 일정

  const ask = "가능한 시간을 저장했습니다.\n참가자에게 초대 링크를 보낼까요?";
  if (confirm(ask)) openInviteDialog();
  else showSnackbar('나중에 사이드바의 "초대 보내기"로 보낼 수 있습니다.');
}

function structuralKey(event) {
  if (!event) return "";
  return JSON.stringify([
    event.isClosed,
    event.type,
    event.duration,
    event.timeIncrement,
    event.dates,
  ]);
}

async function refreshAll() {
  // 저장 직후처럼 다른 경로에서 부른 갱신이 도는 동안, 폴링이 같은 조회를
  // 한 번 더 쏘지 않도록 표시해 둡니다 (live.js가 이 값을 봅니다).
  live.setBusy(true);
  try {
    await refreshAllInner();
  } finally {
    live.setBusy(false);
  }
}

async function refreshAllInner() {
  const event = await api.get(`/api/events/${ST.eventId}${ST.guestName ? `?guestName=${encodeURIComponent(ST.guestName)}` : ""}`);
  const before = structuralKey(ST.event);
  ST.event = event;
  liveSyncVersion();

  if (before && structuralKey(event) !== before) {
    // 후보 날짜나 길이가 바뀌었거나 일정이 확정됨 - 뼈대부터 다시 그립니다.
    await loadEvent();
    return;
  }

  // 응답자 목록은 통째로 다시 그려지므로, 스크롤을 내려 보고 있었다면
  // 갱신될 때마다 맨 위로 튑니다.
  const list = document.getElementById("respondents-list");
  const scrollTop = list ? list.scrollTop : 0;

  renderMeta();
  await refreshResponses();
  renderRespondents();
  renderGridCells();

  if (list) list.scrollTop = scrollTop;
}

/* ---------------------------------------------------------------------- */
/* 자동 갱신                                                                */
/* ---------------------------------------------------------------------- */
//
// 다른 참가자가 가능한 시간을 찍거나 주최자가 일정을 확정하면, 이 화면을
// 열어 둔 사람들에게 새로고침 없이 반영됩니다. 폴링 루프 자체(탭 가시성,
// 백오프, 중복 요청 방지)는 live.js에 공통으로 있습니다.
//
// 확정된 일정도 계속(아주 느리게) 확인합니다 - 주최자가 확정을 취소하면
// 그것도 보여야 하기 때문입니다. 이미 지난 일정만 아예 멈춥니다.

const live = createLiveRefresh({
  url: () => `/api/events/${ST.eventId}/version`,
  // 편집 중에는 건드리지 않습니다 - 다시 그리면 아직 저장하지 않은 드래그
  // 선택(ST.ownMarks)이 통째로 날아갑니다. 저장이나 취소를 하면 stopEditing이
  // 곧바로 따라잡습니다.
  isBusy: () => ST.editing,
  onChange: () => refreshAllInner(),
  onGone: () => {
    // 보고 있는 사이에 일정이 지워졌습니다. 편집 중만 아니면 다시 읽어서
    // "취소되었습니다" 안내를 띄웁니다 (errors/removed_event.html).
    if (!ST.editing) window.location.reload();
  },
});

// 전체 조회에는 이벤트 문서의 v가 같이 실려 옵니다. 방금 받은 데이터의
// 버전을 기준점으로 삼아야 첫 차례에 괜히 한 번 더 받지 않습니다.
function liveSyncVersion() {
  live.sync(ST.event && ST.event.v ? ST.event.v : 0);
}

function startLive() {
  live.stop();
  if (!ST.event || isPastEvent(ST.event)) return;
  live.start();
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

/* 한 칸에 들어온 문자열을 이메일 여러 개로 나눕니다.
 *
 * 쉼표·세미콜론·줄바꿈·공백을 모두 구분자로 봅니다. 메일 프로그램이나 엑셀에서
 * 복사한 목록은 이 중 어느 것으로든 이어져 있어서, 하나만 받으면 통째로 한
 * 칸에 들어가 "@"가 있다는 이유로 엉뚱한 값이 그대로 등록됩니다.
 *
 * "홍길동 <a@b.com>" 처럼 이름이 붙은 형태도 흔해서 꺾쇠 안쪽만 꺼냅니다. */
function splitEmails(value) {
  return (value || "")
    .split(/[,;\s]+/)
    .map((part) => {
      const angled = part.match(/<([^>]+)>/);
      return (angled ? angled[1] : part).trim();
    })
    .filter(Boolean);
}

function addInviteChips(value) {
  splitEmails(value).forEach(addInviteChip);
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

let inviteContactsCache = [];
let inviteContactFilterPredicate = () => true;
// 방금 추가한 연락처. 목록을 다시 그릴 때 체크된 채로 나타나게 합니다 -
// 초대하려고 추가한 사람이니 다시 찾아 누르게 할 이유가 없습니다.
let invitePreChecked = new Set();

function renderInviteContactList() {
  const root = document.getElementById("invite-contacts");
  // Filter toggles re-render this list from scratch - keep whatever the
  // user had already checked so narrowing the filter doesn't silently
  // un-select someone they picked before.
  const previouslyChecked = new Set([
    ...[...root.querySelectorAll("input[type=checkbox]:checked")].map((cb) => cb.value),
    ...invitePreChecked,
  ]);
  const visible = inviteContactsCache.filter(inviteContactFilterPredicate);

  root.innerHTML = "";
  if (!inviteContactsCache.length) {
    // 연락처 페이지로 보내지 않습니다 - 초대하던 흐름이 끊깁니다.
    root.innerHTML = `
      <p class="hint" style="margin:0;">저장된 연락처가 없습니다.</p>
      <button type="button" class="btn btn-secondary btn-sm" style="margin-top:8px;" data-role="add-contact">
        연락처 추가하기
      </button>
    `;
    return;
  }
  if (!visible.length) {
    root.innerHTML = `<p class="hint" style="margin:0;">필터 조건에 맞는 연락처가 없습니다.</p>`;
    return;
  }
  visible.forEach((c) => {
    const label = document.createElement("label");
    label.className = "checkbox-row";
    label.style.marginBottom = "6px";
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(c.email)}" ${previouslyChecked.has(c.email) ? "checked" : ""} />
      <span class="checkbox-copy">
        ${escapeHtml(c.name)}
        <div class="desc">${escapeHtml(c.email)}</div>
      </span>
    `;
    root.appendChild(label);
  });
}

async function openInviteDialog() {
  document.getElementById("invite-error").textContent = "";

  openDialog("invite-dialog");

  invitePreChecked = new Set();
  await loadInviteContacts({ showLoading: true });
}

/* 초대 창의 연락처 목록을 서버에서 다시 받아 그립니다. 창을 열 때와 창 안에서
   연락처를 추가한 직후 둘 다 이 경로를 씁니다 - 필터 막대도 새 목록으로 다시
   만들어야 하므로 렌더링만 따로 부르면 안 됩니다. */
async function loadInviteContacts(options) {
  const root = document.getElementById("invite-contacts");
  if (options && options.showLoading) {
    root.innerHTML = `<p class="hint" style="margin:0;">불러오는 중...</p>`;
  }
  try {
    inviteContactsCache = await api.get("/api/contacts");
    inviteContactFilterPredicate = setupContactFilterBar(
      document.getElementById("invite-contacts-filters"),
      inviteContactsCache,
      renderInviteContactList
    );
    renderInviteContactList();
  } catch (err) {
    root.innerHTML = `<p class="hint" style="margin:0;">연락처를 불러오지 못했습니다.</p>`;
  }
}

/* ---------------------------------------------------------------------- */
/* 초대 창 안에서 연락처 추가                                                */
/* ---------------------------------------------------------------------- */
//
// 연락처 페이지와 같은 패널을 그대로 띄웁니다 (contact-add.js /
// partials/contact_add_panel.html) - 검색·직접 입력·붙여넣기가 모두 됩니다.
// 여기서 정할 것은 "추가된 뒤에 무엇을 새로 고칠까" 하나뿐입니다.

function openQuickContactDialog() {
  ContactAdd.reset();
  openDialog("quick-contact-dialog");
  const search = document.getElementById("contact-search");
  if (search) search.focus();
}

/* ---------------------------------------------------------------------- */
/* 참가자에게 메일 보내기                                                    */
/* ---------------------------------------------------------------------- */
//
// 초대와 나눠 둔 이유: 초대는 "링크를 받아 보세요"이고 이쪽은 이미 링크를 받은
// 사람에게 보내는 알림입니다. 주 용도는 아직 응답하지 않은 사람에게 보내는
// 리마인더라, 받는 사람이 **응답 여부로 나뉘어** 나오고 묶음째 고를 수 있습니다.

let messageTargets = { responded: [], pending: [] };

function renderMessageTargets() {
  const root = document.getElementById("msg-targets");
  const groups = [
    { key: "pending", label: "아직 응답하지 않은 사람", people: messageTargets.pending },
    { key: "responded", label: "응답한 사람", people: messageTargets.responded },
  ];
  const total = groups.reduce((n, g) => n + g.people.length, 0);

  root.innerHTML = "";
  if (!total) {
    root.innerHTML = `<p class="hint" style="margin:0;">보낼 사람이 없습니다. 먼저 초대를 보내 주세요.</p>`;
    return;
  }

  groups.forEach((group) => {
    if (!group.people.length) return;
    // 이메일을 모르는 사람은 고를 수 없지만 목록에는 남깁니다 - 조용히 빼면
    // 왜 빠졌는지 알 수 없습니다.
    const head = el(`
      <div class="msg-target-group">
        <span class="msg-target-title">${escapeHtml(group.label)} (${group.people.length}명)</span>
        <button type="button" class="btn btn-ghost btn-sm" data-role="msg-toggle-all">모두 선택</button>
      </div>
    `);
    head.querySelector("[data-role=msg-toggle-all]").addEventListener("click", () => {
      const boxes = [...root.querySelectorAll(`input[data-group="${group.key}"]`)];
      const turnOn = boxes.some((b) => !b.checked);
      boxes.forEach((b) => (b.checked = turnOn));
    });
    root.appendChild(head);

    group.people.forEach((p) => {
      const label = document.createElement("label");
      label.className = "checkbox-row" + (p.email ? "" : " msg-target-nomail");
      label.style.marginBottom = "6px";
      label.innerHTML = `
        <input type="checkbox" data-group="${group.key}" value="${escapeHtml(p.email)}"
               ${p.email ? (group.key === "pending" ? "checked" : "") : "disabled"} />
        <span class="checkbox-copy">
          ${escapeHtml(p.name || p.email)}
          <div class="desc">${p.email ? escapeHtml(p.email) : "이메일을 몰라 보낼 수 없습니다"}</div>
        </span>
      `;
      root.appendChild(label);
    });
  });
}

async function openMessageDialog() {
  document.getElementById("msg-error").textContent = "";
  document.getElementById("msg-body").value = "";
  document.getElementById("msg-subject").value = "";
  document.getElementById("msg-combined").checked = true;
  openDialog("message-dialog");

  const root = document.getElementById("msg-targets");
  root.innerHTML = `<p class="hint" style="margin:0;">불러오는 중...</p>`;
  try {
    messageTargets = await api.get(`/api/events/${ST.eventId}/mail-targets`);
    renderMessageTargets();
  } catch (err) {
    root.innerHTML = `<p class="hint" style="margin:0;">받는 사람을 불러오지 못했습니다.</p>`;
  }
}

async function sendEventMessage() {
  const errorEl = document.getElementById("msg-error");
  const btn = document.getElementById("msg-send-btn");
  errorEl.textContent = "";

  const emails = [
    ...document.querySelectorAll("#msg-targets input[type=checkbox]:checked"),
  ].map((cb) => cb.value);
  if (!emails.length) {
    errorEl.textContent = "받는 사람을 한 명 이상 선택해 주세요.";
    return;
  }
  const message = document.getElementById("msg-body").value.trim();
  if (!message) {
    errorEl.textContent = "보낼 내용을 입력해 주세요.";
    return;
  }

  btn.disabled = true;
  try {
    const res = await api.post(`/api/events/${ST.eventId}/message`, {
      emails,
      message,
      subject: document.getElementById("msg-subject").value.trim(),
      combined: document.getElementById("msg-combined").checked,
    });
    closeDialog("message-dialog");
    showSnackbar(
      `${res.sent || emails.length}명에게 메일을 보내는 중입니다. 이 페이지를 나가도 전송됩니다.`,
      "success"
    );
  } catch (err) {
    errorEl.textContent = err.message || "메일을 보내지 못했습니다.";
  } finally {
    btn.disabled = false;
  }
}

async function sendInvites() {
  const errorEl = document.getElementById("invite-error");
  const btn = document.getElementById("invite-send-btn");
  errorEl.textContent = "";

  // Fold in whatever is still sitting in the input but not yet chipped.
  const pending = document.getElementById("invite-email-input");
  if (pending.value.trim()) {
    addInviteChips(pending.value);
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
    // 발송은 백그라운드로 넘어갑니다 - "보냈습니다"가 아니라 "보내는 중"입니다.
    showSnackbar(
      `${result.sent}명에게 초대 메일을 보내는 중입니다. 이 페이지를 나가도 전송됩니다.`,
      "success"
    );

    inviteTypedEmails.length = 0;
    document.querySelectorAll("#invite-email-chips .chip").forEach((c) => c.remove());
    document.getElementById("invite-message").value = "";
  } catch (err) {
    errorEl.textContent = err.message || "초대를 보내지 못했습니다.";
  } finally {
    btn.disabled = false;
  }
}

function wireStaticButtons() {
  // "+ 연락처 추가"는 초대 창 머리와 (연락처가 없을 때) 목록 자리 두 군데에
  // 있고, 목록 쪽은 다시 그려질 때마다 새 노드가 됩니다. 위임으로 한 번만 겁니다.
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-role="add-contact"]')) openQuickContactDialog();
  });
  // 추가된 사람은 초대 목록에 바로 나타나고, 초대하려고 넣은 사람이니
  // 선택까지 되어 있게 합니다.
  ContactAdd.init({
    onAdded: async (emails) => {
      // 서버가 소문자로 정규화해 저장하므로(auth_service.normalize_email)
      // 체크박스 값과 맞으려면 같은 모양으로 넣어야 합니다.
      (emails || []).forEach((email) => invitePreChecked.add(email.trim().toLowerCase()));
      await loadInviteContacts();
    },
  });

  document.getElementById("copy-link-btn").addEventListener("click", async () => {
    if (await copyToClipboard(window.location.href)) {
      showSnackbar("링크가 복사되었습니다.", "success");
    } else {
      showSnackbar("복사하지 못했습니다. 주소창의 주소를 직접 복사해 주세요.", "error");
    }
  });

  document.getElementById("invite-send-btn").addEventListener("click", sendInvites);
  document.getElementById("invite-copy-link").addEventListener("click", async () => {
    const link = `${window.location.origin}/e/${ST.eventId}`;
    if (await copyToClipboard(link)) {
      showSnackbar("일정 링크를 복사했습니다.", "success");
    } else {
      showSnackbar("복사하지 못했습니다. 주소창의 주소를 직접 복사해 주세요.", "error");
    }
  });
  document.getElementById("msg-send-btn").addEventListener("click", sendEventMessage);
  const inviteInput = document.getElementById("invite-email-input");
  inviteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === " ") {
      e.preventDefault();
      addInviteChips(e.target.value);
      e.target.value = "";
    }
  });
  // 목록을 통째로 붙여넣는 경우. 구분자가 없으면(주소 하나) 그냥 붙여넣게
  // 두어 오타를 고칠 수 있게 합니다.
  inviteInput.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text") || "";
    if (!/[,;\s]/.test(text.trim())) return;
    e.preventDefault();
    addInviteChips(`${e.target.value} ${text}`);
    e.target.value = "";
  });
  // 적어 두고 그냥 다른 곳을 눌렀을 때 입력이 사라지지 않게 합니다.
  inviteInput.addEventListener("blur", () => {
    if (!inviteInput.value.trim()) return;
    addInviteChips(inviteInput.value);
    inviteInput.value = "";
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

  // 시간대 보기: 안내("기기 시간대 기준으로 자동 표시") + 직접 선택.
  // 칸은 절대 시각으로 저장되어 있어, 바꾸면 라벨/머리글만 다시 그리면
  // 됩니다 - 편집 중이던 선택(ownMarks)도 그대로 살아 있습니다.
  const tzNote = document.getElementById("tz-note");
  const syncTzNote = () => {
    tzNote.textContent = TZView.isAuto()
      ? `시간은 내 기기 시간대(${TZView.deviceZone()}) 기준으로 자동 표시됩니다.`
      : `시간을 ${TZView.zone()} 기준으로 표시하고 있습니다.`;
  };
  syncTzNote();
  TZView.buildSelector(document.getElementById("tz-select"), () => {
    syncTzNote();
    computeDayColumns();
    buildGridDom();
    renderGridCells();
    renderMeta();
    syncLayoutHeights();
    if (ST.editing) document.getElementById("avail-grid").classList.add("editing");
  });

  document.getElementById("selection-clear").addEventListener("click", () => {
    ST.selectedRespondents.clear();
    renderRespondents();
    renderGridCells();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest || !e.target.closest(".grid-cell")) hideCellTooltip();
  });
  window.addEventListener("scroll", hideCellTooltip, { passive: true });

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
    if (!confirm("내 응답을 삭제할까요?")) return;
    const payload = ST.currentUser ? { guest: false, userId: ST.currentUser._id } : { guest: true, name: ST.guestName };
    await api.del(`/api/events/${ST.eventId}/response`, payload);
    document.getElementById("delete-response-btn").style.display = "none";
    document.getElementById("respond-btn").textContent = "가능한 시간 입력";
    await refreshAll();
    showSnackbar("삭제되었습니다.", "success");
  });

  if (ST.isOwner) {
    // Only the host can mail the link out (server enforces this too), so
    // this pinned-to-the-bottom sidebar action only exists for them.
    const inviteBtn = document.getElementById("invite-btn");
    inviteBtn.style.display = "";
    inviteBtn.addEventListener("click", openInviteDialog);
    const messageBtn = document.getElementById("message-btn");
    messageBtn.style.display = "";
    messageBtn.addEventListener("click", openMessageDialog);
    // 지도면담 기능을 안 켠 일정 - 사이드바에서 바로 켤 수 있게.
    // ("일정 정보 수정"의 체크박스를 못 찾는 문제 방지)
    const enableBtn = document.getElementById("enable-records-btn");
    if (enableBtn && !recordsEnabled()) {
      enableBtn.style.display = "";
      enableBtn.addEventListener("click", async () => {
        try {
          await api.post(`/api/events/` + ST.eventId + `/guidance-records?enabled=true`);
          ST.event.guidanceRecordsEnabled = true;
          enableBtn.style.display = "none";
          showSnackbar("지도 면담 기능을 켰습니다.", "success");
          await loadEventRecords();
          document.getElementById("ev-records-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (err) {
          showSnackbar(err.message || "켜지 못했습니다.", "error");
        }
      });
    }
    const addRecordBtn = document.getElementById("ev-records-add");
    if (addRecordBtn) {
      addRecordBtn.addEventListener("click", () => {
        // 확정된 약속 없이 쓰는 기록. 식별자(meetingStart)는 "지금"으로 잡고
        // - (일정, 시각) 고유 키라 겹칠 일이 사실상 없습니다 - 실제 면담
        // 일시·시간은 폼에서 고칩니다.
        const now = new Date();
        now.setSeconds(0, 0);
        RecordDialog.open(ST.eventId, now.toISOString(), loadEventRecords);
      });
    }
    document.getElementById("finalize-link-btn").style.display = "";
    // Only swap the label span's text, not the whole button - the button
    // also contains an SVG icon that a plain .textContent assignment here
    // would silently wipe out.
    document.getElementById("finalize-link-label").textContent = ST.event.isClosed
      ? "확정 내용 보기/수정"
      : "최적 배정 계산하기";

    const editBtn = document.getElementById("edit-event-btn");
    editBtn.style.display = "";
    editBtn.addEventListener("click", () => NewEventDialog.open({ mode: "edit", event: ST.event }));

    const deleteBtn = document.getElementById("delete-event-btn");
    deleteBtn.style.display = "";
    // 앞으로 있을 일정은 참가자에게 "취소", 이미 지난 일정은 기록 "삭제"입니다.
    const word = isPastEvent(ST.event) ? "삭제" : "취소";
    document.getElementById("delete-event-btn-word").textContent = word;
    deleteBtn.addEventListener("click", () => {
      document.getElementById("delete-page-title").textContent = `일정 ${word}`;
      document.getElementById("delete-page-notify-label").textContent =
        `참가자에게 ${word} 안내 메일 보내기`;
      document.getElementById("confirm-delete-event-page-btn").textContent =
        word === "삭제" ? "삭제" : "취소하기";
      openDialog("delete-event-page-dialog");
    });
    document.getElementById("confirm-delete-event-page-btn").addEventListener("click", async () => {
      const notify = document.getElementById("delete-notify-page").checked;
      try {
        await api.del(`/api/events/${ST.event._id}?notify=${notify}`);
        window.location.href = "/home";
      } catch (err) {
        showSnackbar(err.message || "삭제하지 못했습니다.", "error");
      }
    });
  } else if (!ST.event.ownerId) {
    // Guest-created event: anyone with the link may edit it.
    const editBtn = document.getElementById("edit-event-btn");
    editBtn.style.display = "";
    editBtn.addEventListener("click", () => NewEventDialog.open({ mode: "edit", event: ST.event }));
  }
}

// 확정 화면에 갔다 돌아오면 배정이 바뀌어 있을 수 있습니다.
onPageRestore(() => {
  if (ST.event) refreshAll().catch(() => {});
});

document.addEventListener("DOMContentLoaded", init);

let resizeSyncTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeSyncTimer);
  resizeSyncTimer = setTimeout(syncLayoutHeights, 150);
});
