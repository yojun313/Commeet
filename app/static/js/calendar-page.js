const CFG = window.COMMEET_CALENDAR || {};
const CURRENT_USER_ID = String(CFG.userId || "");
const DOW_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const MAX_PILLS_SHOWN = 3;
const ROW_HEIGHT = 48; // px per hour in the week/day time-grid

let viewMode = "month"; // "month" | "week" | "day"
let viewDate = new Date();
viewDate.setHours(0, 0, 0, 0);
let placementsByDay = new Map();

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function startOfWeek(d) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

function fmtTimeShort(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${ampm} ${h12}시` : `${ampm} ${h12}:${pad(m)}`;
}

function fmtFullDate(d) {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_LABELS[d.getDay()]})`;
}

function fmtFullRange(start, end) {
  return `${fmtFullDate(start)} ${fmtTimeShort(start)} ~ ${fmtTimeShort(end)}`;
}

function eventUrl(event) {
  return `/e/${event.shortId || event._id}`;
}

// Meetings only store raw participant keys; the backend resolves registered
// users' keys into real names on `meeting.participantNames` (guest keys are
// already the guest's literal name, see user_service._attach_participant_names).
function participantLabel(names) {
  if (!names || !names.length) return "(참여자 없음)";
  if (names.length <= 2) return names.join(", ");
  return `${names[0]} 외 ${names.length - 1}명`;
}

/* ------------------------------------------------------------------ */
/* Turn the raw /api/user/events list into per-day calendar placements */
/* ------------------------------------------------------------------ */

function buildPlacements(events) {
  const map = new Map();
  const add = (key, placement) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(placement);
  };

  events.forEach((event) => {
    // 공동주최자도 주최자처럼 그 일정의 약속 전체를 봅니다.
    const isOwner = String(event.ownerId) === CURRENT_USER_ID || !!event.isCoHost;
    const fin = event.finalization;

    if (event.isClosed && fin && Array.isArray(fin.meetings)) {
      fin.meetings.forEach((meeting) => {
        const mine = isOwner || (meeting.participants || []).some((p) => String(p) === CURRENT_USER_ID);
        if (!mine) return;
        const start = new Date(meeting.start);
        const names = meeting.participantNames || meeting.participants || [];
        add(dateKey(start), {
          event,
          kind: "confirmed",
          start,
          end: new Date(meeting.end),
          participantNames: names,
        });
      });
      return;
    }

    const seen = new Set();
    (event.dates || []).forEach((iso) => {
      const d = new Date(iso);
      const key = dateKey(d);
      if (seen.has(key)) return;
      seen.add(key);
      add(key, { event, kind: "tentative", start: d });
    });
  });

  return map;
}

/* ------------------------------------------------------------------ */
/* Detail dialog                                                       */
/* ------------------------------------------------------------------ */

function openEventDetail(p) {
  const event = p.event;
  document.getElementById("cal-detail-title").textContent = event.name;

  const rows = [];
  rows.push(
    `<div class="cal-detail-row"><span class="cal-detail-label">종류</span><span>일정</span></div>`
  );
  if (p.kind === "confirmed") {
    rows.push(
      `<div class="cal-detail-row"><span class="cal-detail-label">상태</span><span><span class="badge" style="background:var(--color-primary);color:#fff;">확정됨</span></span></div>`
    );
    rows.push(`<div class="cal-detail-row"><span class="cal-detail-label">시간</span><span>${fmtFullRange(p.start, p.end)}</span></div>`);
    rows.push(
      `<div class="cal-detail-row"><span class="cal-detail-label">참여자</span><span>${escapeHtml((p.participantNames || []).join(", ") || "-")}</span></div>`
    );
  } else {
    rows.push(`<div class="cal-detail-row"><span class="cal-detail-label">상태</span><span>미확정 (응답 대기 중)</span></div>`);
    rows.push(`<div class="cal-detail-row"><span class="cal-detail-label">날짜</span><span>${fmtFullDate(p.start)}</span></div>`);
    rows.push(`<div class="cal-detail-row"><span class="cal-detail-label">응답</span><span>${event.numResponses ?? 0}명</span></div>`);
  }
  document.getElementById("cal-detail-body").innerHTML = rows.join("");

  const link = document.getElementById("cal-detail-link");
  link.href = eventUrl(event);
  link.style.display = "";

  openDialog("cal-detail-dialog");
}

function openDayList(key, placements) {
  const d = new Date(`${key}T00:00:00`);
  document.getElementById("cal-detail-title").textContent = fmtFullDate(d);

  const list = document.createElement("div");
  list.className = "cal-page-day-list";
  placements
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach((p) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cal-page-day-list-item";
      const label = p.kind === "confirmed" ? participantLabel(p.participantNames) : p.event.name;
      row.innerHTML = `<span class="cal-page-dot ${p.kind}"></span><span>${p.kind === "confirmed" ? fmtTimeShort(p.start) + " &middot; " : ""}${escapeHtml(label)}</span>`;
      row.addEventListener("click", () => openEventDetail(p));
      list.appendChild(row);
    });

  const body = document.getElementById("cal-detail-body");
  body.innerHTML = "";
  body.appendChild(list);

  document.getElementById("cal-detail-link").style.display = "none";
  openDialog("cal-detail-dialog");
}

/* ------------------------------------------------------------------ */
/* Month grid                                                          */
/* ------------------------------------------------------------------ */

function renderWeekdayHeader() {
  document.getElementById("cal-weekdays").innerHTML = DOW_LABELS.map((l) => `<div class="cal-page-weekday">${l}</div>`).join("");
}

function renderMonthGrid() {
  const root = document.getElementById("cal-grid-root");
  const y = viewDate.getFullYear();
  const m = viewDate.getMonth();

  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();
  const todayKey = dateKey(new Date());

  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ date: new Date(y, m - 1, daysInPrevMonth - i), otherMonth: true });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: new Date(y, m, day), otherMonth: false });
  }
  // Always fill a fixed 6 rows (42 cells). Padding only to the end of the
  // last week would leave some months at 5 rows and others at 6, so the grid
  // - and the whole page - changed height every time you paged between them.
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    cells.push({ date: addDays(last, 1), otherMonth: true });
  }

  root.innerHTML = "";
  cells.forEach(({ date, otherMonth }) => {
    const key = dateKey(date);
    const placements = (placementsByDay.get(key) || []).slice().sort((a, b) => a.start - b.start);

    const cell = document.createElement("div");
    cell.className = "cal-page-cell" + (otherMonth ? " other-month" : "") + (key === todayKey ? " today" : "");

    const dateEl = document.createElement("div");
    dateEl.className = "cal-page-cell-date";
    dateEl.textContent = String(date.getDate());
    cell.appendChild(dateEl);

    const pillsWrap = document.createElement("div");
    pillsWrap.className = "cal-page-pills";
    placements.slice(0, MAX_PILLS_SHOWN).forEach((p) => {
      const pill = document.createElement("div");
      pill.className = "cal-page-pill " + p.kind;
      pill.textContent =
        p.kind === "confirmed" ? `${fmtTimeShort(p.start)} ${participantLabel(p.participantNames)}` : p.event.name;
      pillsWrap.appendChild(pill);
    });
    if (placements.length > MAX_PILLS_SHOWN) {
      const more = document.createElement("div");
      more.className = "cal-page-more";
      more.textContent = `+${placements.length - MAX_PILLS_SHOWN}개 더보기`;
      pillsWrap.appendChild(more);
    }
    cell.appendChild(pillsWrap);

    if (placements.length) {
      cell.classList.add("has-events");
      cell.addEventListener("click", () => {
        if (placements.length === 1) openEventDetail(placements[0]);
        else openDayList(key, placements);
      });
    }

    root.appendChild(cell);
  });
}

/* ------------------------------------------------------------------ */
/* Week / day time-grid                                                */
/* ------------------------------------------------------------------ */

// Sweep-line column packing so overlapping confirmed meetings sit side by
// side instead of stacking on top of each other.
function layoutTimedBlocks(placements) {
  const timed = placements
    .filter((p) => p.kind === "confirmed")
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const blocks = timed.map((p) => ({ p, col: 0, colCount: 1 }));
  let active = [];
  let cluster = [];
  const flushCluster = () => {
    if (!cluster.length) return;
    const maxCol = Math.max(...cluster.map((b) => b.col)) + 1;
    cluster.forEach((b) => (b.colCount = maxCol));
    cluster = [];
  };

  blocks.forEach((b) => {
    active = active.filter((a) => a.p.end > b.p.start);
    if (active.length === 0) flushCluster();
    const usedCols = new Set(active.map((a) => a.col));
    let col = 0;
    while (usedCols.has(col)) col++;
    b.col = col;
    active.push(b);
    cluster.push(b);
  });
  flushCluster();

  return blocks;
}

function renderTimeHeaderAndAllDay(days) {
  const todayKey = dateKey(new Date());
  const template = `44px repeat(${days.length}, 1fr)`;

  const header = document.getElementById("cal-tv-header");
  header.style.gridTemplateColumns = template;
  header.innerHTML =
    `<div class="cal-page-tv-header-cell"></div>` +
    days
      .map(
        (d) =>
          `<div class="cal-page-tv-header-cell${dateKey(d) === todayKey ? " today" : ""}">${DOW_LABELS[d.getDay()]}<span class="cal-page-tv-date-num">${d.getDate()}</span></div>`
      )
      .join("");

  const allday = document.getElementById("cal-tv-allday");
  allday.style.gridTemplateColumns = template;
  allday.innerHTML = "";
  const gutter = document.createElement("div");
  allday.appendChild(gutter);
  days.forEach((d) => {
    const cell = document.createElement("div");
    cell.className = "cal-page-tv-allday-cell";
    const placements = placementsByDay.get(dateKey(d)) || [];
    placements
      .filter((p) => p.kind === "tentative")
      .forEach((p) => {
        const pill = document.createElement("div");
        pill.className = "cal-page-pill tentative";
        pill.textContent = p.event.name;
        pill.style.cursor = "pointer";
        pill.addEventListener("click", () => openEventDetail(p));
        cell.appendChild(pill);
      });
    allday.appendChild(cell);
  });
}

function renderTimeColumns(days) {
  const rows = document.getElementById("cal-tv-rows");
  rows.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const row = document.createElement("div");
    row.className = "cal-page-tv-hour-row";
    rows.appendChild(row);
  }

  const labels = document.getElementById("cal-tv-timelabels");
  labels.innerHTML = "";
  for (let h = 1; h < 24; h++) {
    const label = document.createElement("div");
    label.className = "cal-page-tv-timelabel";
    label.style.top = `${h * ROW_HEIGHT}px`;
    label.textContent = `${h}시`;
    labels.appendChild(label);
  }

  const columns = document.getElementById("cal-tv-columns");
  columns.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
  columns.innerHTML = "";

  let earliestHour = 8;
  days.forEach((d) => {
    const key = dateKey(d);
    const placements = placementsByDay.get(key) || [];
    const column = document.createElement("div");
    column.className = "cal-page-tv-column";

    // Two stacked lines (time + participant names) need ~34px to avoid the
    // bottom line getting clipped by the block's `overflow: hidden` - a
    // 30-minute meeting is only 24px tall at this row height, so short
    // blocks collapse to a single ellipsized line instead of losing their
    // second line silently.
    const TWO_LINE_MIN_HEIGHT = 34;

    const blocks = layoutTimedBlocks(placements);
    blocks.forEach(({ p, col, colCount }) => {
      const top = (p.start.getHours() + p.start.getMinutes() / 60) * ROW_HEIGHT;
      const height = Math.max(((p.end - p.start) / 3600000) * ROW_HEIGHT, 19);
      earliestHour = Math.min(earliestHour, p.start.getHours());

      const block = document.createElement("div");
      block.className = "cal-page-tv-block confirmed";
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `calc(${(100 / colCount) * col}% + 2px)`;
      block.style.width = `calc(${100 / colCount}% - 4px)`;
      const names = escapeHtml(participantLabel(p.participantNames));
      block.innerHTML =
        height >= TWO_LINE_MIN_HEIGHT
          ? `<span class="cal-page-tv-block-time">${fmtTimeShort(p.start)}</span><span class="cal-page-tv-block-title">${names}</span>`
          : `<span class="cal-page-tv-block-line">${fmtTimeShort(p.start)} &middot; ${names}</span>`;
      block.addEventListener("click", () => openEventDetail(p));
      column.appendChild(block);
    });

    columns.appendChild(column);
  });

  document.getElementById("cal-tv-body").scrollTop = Math.max(0, (earliestHour - 1) * ROW_HEIGHT);
}

function renderTimeView() {
  const days = viewMode === "day" ? [viewDate] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(viewDate), i));
  renderTimeHeaderAndAllDay(days);
  renderTimeColumns(days);
}

/* ------------------------------------------------------------------ */
/* View / navigation                                                   */
/* ------------------------------------------------------------------ */

function updateLabel() {
  const label = document.getElementById("cal-label");
  if (viewMode === "month") {
    label.textContent = `${viewDate.getFullYear()}년 ${viewDate.getMonth() + 1}월`;
  } else if (viewMode === "day") {
    label.textContent = fmtFullDate(viewDate);
  } else {
    const start = startOfWeek(viewDate);
    const end = addDays(start, 6);
    label.textContent =
      start.getMonth() === end.getMonth()
        ? `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일 - ${end.getDate()}일`
        : `${start.getMonth() + 1}월 ${start.getDate()}일 - ${end.getMonth() + 1}월 ${end.getDate()}일`;
  }
}

function render() {
  document.getElementById("cal-weekdays").style.display = viewMode === "month" ? "" : "none";
  document.getElementById("cal-grid-root").style.display = viewMode === "month" ? "" : "none";
  document.getElementById("cal-timeview").classList.toggle("active", viewMode !== "month");

  updateLabel();
  if (viewMode === "month") renderMonthGrid();
  else renderTimeView();
}

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll("#cal-view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === mode));
  render();
}

function navigate(delta) {
  // Built as a new Date (day pinned to 1) rather than viewDate.setMonth(...)
  // in place - mutating the day-of-month across a month boundary rolls over
  // to the wrong month whenever the current day doesn't exist in the target
  // month (e.g. Aug 31 - 1 month -> "Jul 31" doesn't exist -> jumps to Aug 1).
  if (viewMode === "month") viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1);
  else if (viewMode === "week") viewDate = addDays(viewDate, delta * 7);
  else viewDate = addDays(viewDate, delta);
  render();
}

/* ------------------------------------------------------------------ */
/* Google Calendar connection management (moved here from Settings, so it   */
/* lives next to the calendar it actually affects)                          */
/* ------------------------------------------------------------------ */

function googleAccountRow(account) {
  const wrapper = document.createElement("div");

  const row = document.createElement("div");
  row.className = "calendar-account-row";
  row.innerHTML = `
    <span class="avatar sm">${(account.email || "?")[0].toUpperCase()}</span>
    <div class="info">
      <div class="email">${account.email}</div>
      <div style="font-size: 12px; color: var(--color-text-faint);">Google Calendar</div>
      ${
        account.hasWriteScope
          ? ""
          : `<div style="font-size: 12px; color: var(--color-danger-text); margin-top: 2px;">확정된 일정을 자동으로 동기화하려면 다시 연결해 주세요.</div>`
      }
    </div>
    <label class="switch">
      <input type="checkbox" ${account.enabled ? "checked" : ""} data-role="toggle-account" />
      <span class="track"></span>
    </label>
    <button class="btn-icon" type="button" data-role="remove-account" title="연결 해제">🗑</button>
  `;

  row.querySelector('[data-role="toggle-account"]').addEventListener("change", async (e) => {
    await api.post(`/api/user/calendar-accounts/toggle?email=${encodeURIComponent(account.email)}&enabled=${e.target.checked}`);
    showSnackbar("저장되었습니다.", "success");
  });
  row.querySelector('[data-role="remove-account"]').addEventListener("click", async () => {
    if (!confirm("연결을 해제할까요?")) return;
    await api.del(`/api/user/calendar-accounts?email=${encodeURIComponent(account.email)}`);
    loadGoogleAccounts();
  });

  wrapper.appendChild(row);

  const subCalendars = Object.entries(account.subCalendars || {});
  if (subCalendars.length) {
    const subList = document.createElement("div");
    subList.className = "sub-calendar-list";
    subCalendars.forEach(([calId, sub]) => {
      const subRow = document.createElement("div");
      subRow.className = "sub-calendar-row";
      const label = document.createElement("span");
      label.textContent = sub.name || calId;
      const toggle = document.createElement("label");
      toggle.className = "switch";
      toggle.innerHTML = `<input type="checkbox" ${sub.enabled ? "checked" : ""} /><span class="track"></span>`;
      toggle.querySelector("input").addEventListener("change", async (e) => {
        await api.post(
          `/api/user/calendar-accounts/toggle-sub-calendar?email=${encodeURIComponent(account.email)}&subCalendarId=${encodeURIComponent(calId)}&enabled=${e.target.checked}`
        );
      });
      subRow.appendChild(label);
      subRow.appendChild(toggle);
      subList.appendChild(subRow);
    });
    wrapper.appendChild(subList);
  }

  return wrapper;
}

async function loadGoogleAccounts() {
  if (typeof GOOGLE_CALENDAR_ENABLED === "undefined" || !GOOGLE_CALENDAR_ENABLED) return;
  const root = document.getElementById("cal-google-accounts-root");
  if (!root) return;

  const profile = await api.get("/api/user/profile");
  const accounts = Object.values(profile.calendarAccounts || {});
  root.innerHTML = "";
  if (!accounts.length) {
    root.innerHTML = `<p class="hint">연결된 캘린더가 없습니다.</p>`;
  } else {
    accounts.forEach((account) => root.appendChild(googleAccountRow(account)));
  }

  // Availability auto-fill options live in this same dialog (they only
  // affect the Google-Calendar-driven "캘린더로 자동 채우기" action), so
  // they're filled from the same profile fetch.
  const options = profile.calendarOptions || {};
  const buffer = options.bufferTime || { enabled: false, time: 15 };
  const wh = options.workingHours || { enabled: false, startTime: 9, endTime: 17 };
  document.getElementById("gc-buffer-enabled").checked = buffer.enabled;
  document.getElementById("gc-buffer-time").value = buffer.time;
  document.getElementById("gc-workinghours-enabled").checked = wh.enabled;
  document.getElementById("gc-workinghours-start").value = wh.startTime;
  document.getElementById("gc-workinghours-end").value = wh.endTime;
}

async function saveCalendarOptions() {
  const btn = document.getElementById("gc-save-options");
  btn.disabled = true;
  try {
    await api.patch("/api/user/calendar-options", {
      bufferTime: {
        enabled: document.getElementById("gc-buffer-enabled").checked,
        time: parseInt(document.getElementById("gc-buffer-time").value, 10) || 0,
      },
      workingHours: {
        enabled: document.getElementById("gc-workinghours-enabled").checked,
        startTime: parseFloat(document.getElementById("gc-workinghours-start").value) || 0,
        endTime: parseFloat(document.getElementById("gc-workinghours-end").value) || 24,
      },
    });
    showSnackbar("저장되었습니다.", "success");
  } catch (err) {
    showSnackbar(err.message || "저장하지 못했습니다.", "error");
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */

async function load() {
  let events = [];
  try {
    // 버전 지문을 목록과 함께 받습니다 - 따로 받으면 그 사이의 변경을
    // 놓치고, 자동 갱신이 첫 차례에 괜히 한 번 더 받습니다.
    const [list, version] = await Promise.all([
      api.get("/api/user/events"),
      api.get("/api/user/events/version").catch(() => null),
    ]);
    events = list;
    if (version) live.sync(version.v);
  } catch (err) {
    showSnackbar(err.message, "error");
  }
  placementsByDay = buildPlacements(events);
  render();
}

/* 자동 갱신 - 주최자가 일정을 확정하면 그 약속이 내 캘린더에 바로
   나타나고, 확정이 취소되면 사라집니다. 폴링 루프는 live.js. */
const live = createLiveRefresh({
  url: "/api/user/events/version",
  // 약속 상세 다이얼로그가 떠 있는 동안에는 그 뒤를 다시 그리지 않습니다.
  isBusy: () => liveDialogOpen(),
  onChange: () => load(),
});

onPageRestore(() => load().catch(() => {}));

document.addEventListener("DOMContentLoaded", () => {
  renderWeekdayHeader();
  // 첫 조회가 끝나 기준점(live.sync)이 잡힌 뒤에 폴링을 시작합니다.
  load().then(() => live.start());
  loadGoogleAccounts();

  const settingsBtn = document.getElementById("cal-google-settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", () => openDialog("cal-google-dialog"));

  const saveOptionsBtn = document.getElementById("gc-save-options");
  if (saveOptionsBtn) saveOptionsBtn.addEventListener("click", saveCalendarOptions);

  const params = new URLSearchParams(window.location.search);
  if (params.get("calendar_connected")) {
    showSnackbar("Google Calendar가 연결되었습니다.", "success");
    openDialog("cal-google-dialog");
  }
  if (params.get("calendar_error")) {
    showSnackbar("캘린더 연결에 실패했습니다.", "error");
    openDialog("cal-google-dialog");
  }

  document.getElementById("cal-prev").addEventListener("click", () => navigate(-1));
  document.getElementById("cal-next").addEventListener("click", () => navigate(1));
  document.getElementById("cal-today").addEventListener("click", () => {
    viewDate = new Date();
    viewDate.setHours(0, 0, 0, 0);
    render();
  });
  document.getElementById("cal-view-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) setViewMode(btn.dataset.view);
  });
});
