/* Host-only screen: run the optimizer, adjust the proposal by hand, confirm. */

const CFG = window.COMMEET_FINALIZE;

// Latest proposal from the server, plus the host's manual edits on top of it.
let proposal = null;
// participant key -> slot start ISO, or null when deliberately left out
let choice = {};

// Maps each rendered .cal-cell element to the slot it represents (or null
// for a "host unavailable" cell), rebuilt on every renderCalendarGrid()
// call. Drag-and-drop reads this instead of re-parsing data attributes.
let cellSlotMap = new WeakMap();
// 최적화가 배정하지 못한 사람의 사유 (서버 계산). 호스트가 직접 빼낸
// 사람에게는 사유가 없으므로 undefined입니다.
let unassignedReasons = {};
// Active drag gesture, or null when nothing is being dragged.
let dragState = null;

/* Never compare timestamps as raw strings: the server may render the same
 * instant with a slightly different ISO representation on two different
 * requests (e.g. after a round-trip through MongoDB/pydantic). Epoch
 * milliseconds is the only representation both sides always agree on -
 * this bit us once already in the availability grid (event-grid.js). */
function timeKey(iso) {
  return new Date(iso).getTime();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function el(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]}) ${h}:${m}`;
}

function fmtRange(startIso, endIso) {
  const e = new Date(endIso);
  const h = String(e.getHours()).padStart(2, "0");
  const m = String(e.getMinutes()).padStart(2, "0");
  return `${fmtTime(startIso)} ~ ${h}:${m}`;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function populateSettings() {
  const capacity = document.getElementById("fin-capacity");
  for (let n = 1; n <= 20; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n === 1 ? "1명 (1:1 개별 약속)" : `${n}명`;
    capacity.appendChild(o);
  }

  // Meeting length must be a multiple of the grid increment and fit the window.
  const minutes = document.getElementById("fin-minutes");
  const inc = CFG.timeIncrement || 15;
  const maxMinutes = Math.max(inc, Math.floor((CFG.durationHours || 0) * 60));
  for (let v = inc; v <= maxMinutes; v += inc) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v >= 60 && v % 60 === 0 ? `${v / 60}시간` : `${v}분`;
    if (v === Math.min(30 >= inc ? Math.ceil(30 / inc) * inc : inc, maxMinutes)) o.selected = true;
    minutes.appendChild(o);
  }

  const fin = CFG.finalization;
  if (fin && fin.status === "confirmed") {
    capacity.value = String(fin.capacity);
    minutes.value = String(fin.meetingMinutes);
    document.getElementById("confirmed-banner").style.display = "";
    document.getElementById("fin-cancel-btn").style.display = "";
  }
}

/* 확정 버튼은 페이지 맨 위에 있지만, 확정할 배정이 계산되기 전에는
   의미가 없으므로 결과 영역과 항상 함께 나타났다 사라집니다. */
function setResultVisible(visible) {
  document.getElementById("fin-result").style.display = visible ? "" : "none";
  document.getElementById("fin-top-actions").style.display = visible ? "" : "none";
}

/* ------------------------------------------------------------------ */
/* Proposal                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetches a fresh proposal. When `restoreStored` is set we keep the host's
 * already-confirmed assignment instead of overwriting it with a new
 * optimization - the proposal is then only used for its slot/eligibility data.
 */
async function runOptimizer(restoreStored = false) {
  const errorEl = document.getElementById("fin-error");
  const btn = document.getElementById("fin-run-btn");
  errorEl.textContent = "";
  btn.disabled = true;

  try {
    setStaleNotice(false);
    proposal = await api.post(`/api/events/${CFG.eventId}/finalize/proposal`, {
      capacity: Number(document.getElementById("fin-capacity").value),
      meetingMinutes: Number(document.getElementById("fin-minutes").value),
      allowIfNeeded: document.getElementById("fin-allow-ifneeded").checked,
    });

    if (!proposal.participants.length) {
      setResultVisible(false);
      document.getElementById("fin-empty").style.display = "";
      return;
    }

    unassignedReasons = Object.fromEntries(
      (proposal.unassigned || []).filter((u) => u.reason).map((u) => [u.key, u.reason])
    );

    choice = {};
    const stored = restoreStored && CFG.finalization ? CFG.finalization.meetings || [] : null;
    if (stored) {
      // Re-key each stored meeting's start against *this* proposal's own slot
      // list by epoch time, so a harmless ISO-format difference between the
      // page-load payload and this fresh API response can't silently drop
      // the host's confirmed assignment (see timeKey() above).
      const slotByTime = new Map(proposal.slots.map((s) => [timeKey(s.start), s.start]));
      stored.forEach((m) => {
        const canonicalStart = slotByTime.get(timeKey(m.start));
        (m.participants || []).forEach((key) => {
          choice[key] = canonicalStart || null;
        });
      });
      proposal.participants.forEach((p) => {
        if (!(p.key in choice)) choice[p.key] = null;
      });
    } else {
      proposal.meetings.forEach((m) => {
        m.participants.forEach((p) => {
          choice[p.key] = m.start;
        });
      });
      proposal.unassigned.forEach((p) => {
        choice[p.key] = null;
      });
    }

    document.getElementById("fin-empty").style.display = "none";
    setResultVisible(true);
    render();
  } catch (err) {
    errorEl.textContent = err.message || "배정을 계산하지 못했습니다.";
  } finally {
    btn.disabled = false;
  }
}

/** Slots this participant can actually attend, from the server's eligibility map. */
function eligibleSlots(key) {
  return proposal.slots.filter((s) => s.eligible.includes(key));
}

/* ------------------------------------------------------------------ */
/* Calendar visualization (Google-Calendar-style day/time grid)        */
/* ------------------------------------------------------------------ */

function dayKeyOf(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function dayLabelOf(date) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${date.getMonth() + 1}/${date.getDate()}(${days[date.getDay()]})`;
}
function timeKeyOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}
function timeLabelOf(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Groups proposal.slots into a day-column / time-row grid, the way a
 * Google-Calendar-style view needs. Every slot is exactly one meeting-length
 * block (build_slots on the server guarantees this), so each grid cell maps
 * to exactly one slot - no multi-row event spans to compute.
 */
function buildCalendarModel() {
  const dayMap = new Map(); // dayKey -> {key, label, sortKey}
  const rowMap = new Map(); // timeOfDayKey -> label
  const cellIndex = new Map(); // `${dayKey}__${timeOfDayKey}` -> slot

  proposal.slots.forEach((s) => {
    const d = new Date(s.start);
    const dk = dayKeyOf(d);
    const tk = timeKeyOfDay(d);
    if (!dayMap.has(dk)) dayMap.set(dk, { key: dk, label: dayLabelOf(d), sortKey: d.getTime() });
    if (!rowMap.has(tk)) rowMap.set(tk, timeLabelOf(d));
    cellIndex.set(`${dk}__${tk}`, s);
  });

  const days = [...dayMap.values()].sort((a, b) => a.sortKey - b.sortKey);
  const rows = [...rowMap.entries()].sort((a, b) => a[0] - b[0]).map(([tk, label]) => ({ tk, label }));
  return { days, rows, cellIndex };
}

/** Builds one draggable participant card. `key` must be a real participant key. */
function buildChip(key, nameOf) {
  const chip = document.createElement("span");
  chip.className = "cal-chip";
  chip.textContent = nameOf[key] || key;
  chip.dataset.key = key;
  chip.addEventListener("pointerdown", (e) => startChipDrag(e, key, nameOf[key] || key));
  return chip;
}

function renderCalendarGrid(nameOf, meetings, capacity) {
  const grid = document.getElementById("fin-calendar");
  cellSlotMap = new WeakMap();

  if (!proposal.slots.length) {
    grid.innerHTML = `<p class="hint" style="margin:0;">호스트가 가능한 시간이 없어 표시할 수 없습니다.</p>`;
    return;
  }

  const { days, rows, cellIndex } = buildCalendarModel();
  // All of `choice`'s values are ISO strings sourced from this same
  // proposal.slots array (see eligibleSlots()/restore logic above), so a
  // plain string key here is safe - no cross-request format mismatch risk.
  const meetingByStart = new Map(meetings.map((m) => [m.start, m]));

  grid.style.gridTemplateColumns = `66px repeat(${days.length}, minmax(112px, 1fr))`;
  grid.style.gridTemplateRows = `34px repeat(${rows.length}, minmax(46px, auto))`;
  grid.innerHTML = "";

  grid.appendChild(el(`<div class="cal-corner"></div>`));
  days.forEach((d) => {
    grid.appendChild(el(`<div class="cal-day-header">${esc(d.label)}</div>`));
  });

  rows.forEach((row) => {
    grid.appendChild(el(`<div class="cal-time-label">${esc(row.label)}</div>`));
    days.forEach((d) => {
      const slot = cellIndex.get(`${d.key}__${row.tk}`);
      if (!slot) {
        const cell = el(`<div class="cal-cell cal-cell-unavailable" title="호스트가 이 시간에 참석할 수 없습니다"></div>`);
        cellSlotMap.set(cell, null);
        grid.appendChild(cell);
        return;
      }

      const meeting = meetingByStart.get(slot.start);
      let cell;
      if (meeting && meeting.participants.length) {
        const over = meeting.participants.length > capacity;
        cell = el(`
          <div class="cal-cell cal-cell-booked${over ? " cal-cell-over" : ""}">
            <div class="cal-block-names"></div>
            <div class="cal-block-count">${meeting.participants.length}${over ? `/${capacity}` : ""}명</div>
          </div>
        `);
        const namesEl = cell.querySelector(".cal-block-names");
        meeting.participants.forEach((key) => namesEl.appendChild(buildChip(key, nameOf)));
        // 카드 바탕을 잡으면 그 시간의 사람들이 통째로 움직입니다. 이름을
        // 잡으면 그 사람만 움직입니다 (startChipDrag이 전파를 끊습니다).
        cell.title = "카드를 끌면 이 시간의 참가자 전원이 함께 이동합니다";
        const groupKeys = [...meeting.participants];
        cell.addEventListener("pointerdown", (e) =>
          startGroupDrag(e, slot.start, groupKeys, nameOf)
        );
      } else if (slot.eligible.length) {
        cell = el(
          `<div class="cal-cell cal-cell-open" title="${slot.eligible.length}명이 가능한 시간입니다">${slot.eligible.length}명 가능</div>`
        );
      } else {
        cell = el(`<div class="cal-cell cal-cell-empty"></div>`);
      }
      cellSlotMap.set(cell, slot);
      grid.appendChild(cell);
    });
  });
}

function renderUnassignedTray(nameOf) {
  const tray = document.getElementById("fin-unassigned-chips");
  tray.innerHTML = "";
  const unassigned = proposal.participants.filter((p) => !choice[p.key]);
  if (!unassigned.length) {
    tray.innerHTML = `<span class="hint" style="margin:0;">없음 - 모두 배정되었습니다.</span>`;
    return;
  }
  unassigned.forEach((p) => tray.appendChild(buildChip(p.key, nameOf)));
}

/* ------------------------------------------------------------------ */
/* Drag-and-drop (pointer events - works for mouse and touch alike)    */
/* ------------------------------------------------------------------ */

function positionGhost(ghost, x, y) {
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
}

/* 드래그 중인 참가자가 참석할 수 있는 칸을 전부 칠합니다.
 * 어디로 옮길 수 있는지 한눈에 보이지 않으면 유효한 칸을 하나씩
 * 찍어 보며 찾아야 합니다. eligible 목록은 서버 제안에 이미 들어 있어
 * 추가 요청 없이 계산됩니다. */
function markEligibleCells(key) {
  const grid = document.getElementById("fin-calendar");
  if (!grid) return;
  grid.classList.add("cal-picking");
  grid.querySelectorAll(".cal-cell").forEach((cell) => {
    const slot = cellSlotMap.get(cell);
    if (slot && slot.eligible.includes(key)) cell.classList.add("cal-cell-eligible");
  });
}

function clearEligibleCells() {
  const grid = document.getElementById("fin-calendar");
  if (!grid) return;
  grid.classList.remove("cal-picking");
  grid.querySelectorAll(".cal-cell-eligible").forEach((c) =>
    c.classList.remove("cal-cell-eligible")
  );
}

function clearDropHighlights() {
  document
    .querySelectorAll(".cal-drop-target, .cal-drop-invalid")
    .forEach((el2) => el2.classList.remove("cal-drop-target", "cal-drop-invalid"));
}

function dropTargetAt(x, y) {
  const under = document.elementFromPoint(x, y);
  if (!under || !under.closest) return null;

  // Tray wins over any chip inside it: dropping on an unassigned person's
  // card still just means "unassign the dragged person" - they have no
  // slot of their own to trade back.
  const tray = under.closest("#fin-unassigned-tray");
  if (tray) return { kind: "tray", el: tray };

  const chip = under.closest(".cal-cell-booked .cal-chip");
  if (chip) {
    return { kind: "chip", el: chip, key: chip.dataset.key, slot: cellSlotMap.get(chip.closest(".cal-cell")) || null };
  }

  const cell = under.closest(".cal-cell");
  if (cell) return { kind: "cell", el: cell, slot: cellSlotMap.get(cell) || null };

  return null;
}

/**
 * Whether dropping `draggedKey` onto another participant's card (`otherKey`)
 * can go through, and what it means:
 *  - both currently hold slots -> a genuine swap, only valid if each person
 *    is eligible for the *other's* slot (both sides must actually be able
 *    to make the new time).
 *  - the dragged person had no slot (dragged in from the unassigned tray)
 *    -> a take-over: they claim the other's slot and the other becomes
 *    unassigned, valid as long as the dragged person is eligible for it.
 */
function resolveChipSwap(draggedKey, otherKey) {
  if (draggedKey === otherKey) return { ok: false, noop: true };

  const mySlotStart = choice[draggedKey] || null;
  const theirSlotStart = choice[otherKey] || null;
  const mySlotObj = mySlotStart ? proposal.slots.find((s) => s.start === mySlotStart) : null;
  const theirSlotObj = theirSlotStart ? proposal.slots.find((s) => s.start === theirSlotStart) : null;

  const iCanTakeTheirs = theirSlotObj && theirSlotObj.eligible.includes(draggedKey);
  const theyCanTakeMine = !mySlotObj || mySlotObj.eligible.includes(otherKey);

  return { ok: Boolean(iCanTakeTheirs && theyCanTakeMine), mySlotStart, theirSlotStart };
}

function startChipDrag(e, key, label) {
  if (e.button !== undefined && e.button !== 0) return; // left click / primary touch only
  e.preventDefault();
  // 칩은 셀 안에 있습니다. 막지 않으면 이름 하나를 집었을 뿐인데 셀의
  // 그룹 드래그(startGroupDrag)까지 같이 시작됩니다.
  e.stopPropagation();

  const ghost = el(`<div class="cal-drag-ghost">${esc(label)}</div>`);
  document.body.appendChild(ghost);
  positionGhost(ghost, e.clientX, e.clientY);
  document.body.classList.add("dragging-active");

  dragState = { key, ghost };
  markEligibleCells(key);

  const onMove = (ev) => {
    if (!dragState) return;
    positionGhost(dragState.ghost, ev.clientX, ev.clientY);
    clearDropHighlights();
    const target = dropTargetAt(ev.clientX, ev.clientY);
    if (!target) return;
    if (target.kind === "tray") {
      target.el.classList.add("cal-drop-target");
    } else if (target.kind === "chip") {
      const swap = resolveChipSwap(dragState.key, target.key);
      if (swap.noop) return; // hovering back over your own card - no feedback needed
      target.el.classList.add("cal-drop-target");
      if (!swap.ok) target.el.classList.add("cal-drop-invalid");
    } else if (target.slot && target.slot.eligible.includes(dragState.key)) {
      target.el.classList.add("cal-drop-target");
    } else {
      target.el.classList.add("cal-drop-target", "cal-drop-invalid");
    }
  };

  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    clearDropHighlights();
    clearEligibleCells();
    document.body.classList.remove("dragging-active");

    const target = dropTargetAt(ev.clientX, ev.clientY);
    const draggedKey = dragState.key;
    dragState.ghost.remove();
    dragState = null;

    if (!target) return; // dropped outside any target - leave assignment unchanged
    if (target.kind === "tray") {
      choice[draggedKey] = null;
      render();
    } else if (target.kind === "chip") {
      if (target.key === draggedKey) return; // dropped back onto your own card - no-op
      const swap = resolveChipSwap(draggedKey, target.key);
      if (swap.ok) {
        choice[target.key] = swap.mySlotStart; // null if the dragged person came from the tray
        choice[draggedKey] = swap.theirSlotStart;
        render();
        showSnackbar(swap.mySlotStart ? "두 사람의 시간을 맞바꿨습니다." : "시간을 넘겨받았습니다.", "success");
      } else {
        showSnackbar("두 사람이 서로 이 시간을 맞바꿀 수 없습니다.", "error");
      }
    } else if (target.slot && target.slot.eligible.includes(draggedKey)) {
      choice[draggedKey] = target.slot.start;
      render();
    } else {
      showSnackbar("이 참가자는 해당 시간에 참석할 수 없습니다.", "error");
    }
  };

  const onCancel = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    clearDropHighlights();
    clearEligibleCells();
    document.body.classList.remove("dragging-active");
    if (dragState) dragState.ghost.remove();
    dragState = null;
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/* 한 시간대의 참가자 전원을 함께 옮깁니다.
 *
 * 이름 칩만 옮길 수 있으면, 3명이 잡힌 시간을 통째로 미루려면 세 번을
 * 따로 끌어야 하고 그 사이 배정이 잠깐씩 흩어집니다. 카드 바탕을 잡으면
 * 전원이 같이 움직이고, **전원이 참석할 수 있는** 시간에만 놓입니다.
 */

/** 이 사람들 전부가 옮겨 갈 수 있는 시간인지. 이유까지 돌려줍니다. */
function groupDropCheck(keys, slot, fromStart, capacity) {
  if (!slot) return { ok: false, reason: "호스트가 참석할 수 없는 시간입니다." };
  if (slot.start === fromStart) return { ok: true, noop: true };

  const cannot = keys.filter((k) => !slot.eligible.includes(k));
  if (cannot.length) {
    return { ok: false, reason: `${cannot.length}명이 이 시간에 참석할 수 없습니다.` };
  }
  // 이미 다른 사람이 잡혀 있는 시간이면 합쳐집니다 - 정원을 넘기면 안 됩니다.
  const already = Object.entries(choice).filter(
    ([k, start]) => start === slot.start && !keys.includes(k)
  ).length;
  if (already + keys.length > capacity) {
    return {
      ok: false,
      reason: `정원 ${capacity}명을 넘습니다 (이미 ${already}명 배정됨).`,
    };
  }
  return { ok: true, merged: already > 0 };
}

/** 전원이 갈 수 있는 칸을 칠합니다 (한 명짜리 markEligibleCells의 그룹판). */
function markEligibleCellsForGroup(keys, fromStart, capacity) {
  const grid = document.getElementById("fin-calendar");
  if (!grid) return;
  grid.classList.add("cal-picking");
  grid.querySelectorAll(".cal-cell").forEach((cell) => {
    const slot = cellSlotMap.get(cell);
    const check = groupDropCheck(keys, slot, fromStart, capacity);
    if (check.ok && !check.noop) cell.classList.add("cal-cell-eligible");
  });
}

function startGroupDrag(e, fromStart, keys, nameOf) {
  if (e.button !== undefined && e.button !== 0) return;
  if (!keys.length) return;
  e.preventDefault();

  const capacity = Number(document.getElementById("fin-capacity").value);
  const label =
    keys.length === 1
      ? nameOf[keys[0]] || keys[0]
      : `${keys.map((k) => nameOf[k] || k).join(", ")} (${keys.length}명 함께)`;

  const ghost = el(`<div class="cal-drag-ghost cal-drag-ghost-group">${esc(label)}</div>`);
  document.body.appendChild(ghost);
  positionGhost(ghost, e.clientX, e.clientY);
  document.body.classList.add("dragging-active");

  dragState = { group: keys, ghost };
  markEligibleCellsForGroup(keys, fromStart, capacity);

  // 그룹을 옮길 때는 남의 이름 위에 놓아도 "그 시간으로"라는 뜻입니다.
  const cellTargetAt = (x, y) => {
    const target = dropTargetAt(x, y);
    if (!target) return null;
    if (target.kind === "tray") return target;
    if (target.kind === "chip") {
      const cell = target.el.closest(".cal-cell");
      return { kind: "cell", el: cell, slot: cellSlotMap.get(cell) || null };
    }
    return target;
  };

  const onMove = (ev) => {
    if (!dragState) return;
    positionGhost(dragState.ghost, ev.clientX, ev.clientY);
    clearDropHighlights();
    const target = cellTargetAt(ev.clientX, ev.clientY);
    if (!target) return;
    if (target.kind === "tray") {
      target.el.classList.add("cal-drop-target");
      return;
    }
    const check = groupDropCheck(keys, target.slot, fromStart, capacity);
    if (check.noop) return; // 원래 자리 위 - 알릴 것이 없습니다
    target.el.classList.add("cal-drop-target");
    if (!check.ok) target.el.classList.add("cal-drop-invalid");
  };

  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    clearDropHighlights();
    clearEligibleCells();
    document.body.classList.remove("dragging-active");
    if (dragState) dragState.ghost.remove();
    dragState = null;
  };

  const onUp = (ev) => {
    const target = cellTargetAt(ev.clientX, ev.clientY);
    finish();
    if (!target) return; // 아무 데도 아닌 곳 - 그대로 둡니다

    if (target.kind === "tray") {
      keys.forEach((k) => (choice[k] = null));
      render();
      showSnackbar(`${keys.length}명의 배정을 해제했습니다.`, "success");
      return;
    }

    const check = groupDropCheck(keys, target.slot, fromStart, capacity);
    if (check.noop) return;
    if (!check.ok) {
      showSnackbar(check.reason, "error");
      return;
    }
    keys.forEach((k) => (choice[k] = target.slot.start));
    render();
    showSnackbar(
      check.merged
        ? `${keys.length}명을 옮겨 기존 약속과 합쳤습니다.`
        : `${keys.length}명의 시간을 함께 옮겼습니다.`,
      "success"
    );
  };

  const onCancel = () => finish();

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

function currentMeetings() {
  const bySlot = new Map();
  Object.entries(choice).forEach(([key, start]) => {
    if (!start) return;
    if (!bySlot.has(start)) bySlot.set(start, []);
    bySlot.get(start).push(key);
  });
  return [...bySlot.entries()]
    .map(([start, participants]) => ({ start, participants }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function render() {
  const capacity = Number(document.getElementById("fin-capacity").value);
  const nameOf = Object.fromEntries(proposal.participants.map((p) => [p.key, p.name]));

  // --- per-participant editor ---
  const root = document.getElementById("fin-assignments");
  root.innerHTML = "";

  proposal.participants.forEach((p) => {
    const row = document.createElement("div");
    row.className = "assign-row";

    const label = document.createElement("div");
    label.className = "assign-name";
    label.innerHTML = `<span class="avatar sm">${esc((p.name || "?")[0].toUpperCase())}</span>
                       <span>${esc(p.name)}</span>`;
    if (!p.hasEmail) {
      label.innerHTML += ` <span class="badge badge-muted" title="이메일이 없어 안내 메일을 보낼 수 없습니다">메일 없음</span>`;
    }

    const select = document.createElement("select");
    select.className = "input";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "배정 안 함";
    select.appendChild(none);

    const options = eligibleSlots(p.key);
    options.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.start;
      o.textContent = fmtRange(s.start, s.end);
      select.appendChild(o);
    });
    select.value = choice[p.key] || "";

    if (!options.length) {
      select.disabled = true;
      none.textContent = "가능한 시간 없음";
    }

    // 왜 배정되지 못했는지 그 사람 줄에서 바로 보이게 합니다.
    const reason = !choice[p.key] && unassignedReasons[p.key];
    if (reason) {
      label.innerHTML += ` <span class="assign-reason" title="${esc(reason.text)}">?</span>`;
    }

    select.addEventListener("change", () => {
      choice[p.key] = select.value || null;
      render();
    });

    row.appendChild(label);
    row.appendChild(select);
    root.appendChild(row);
  });

  // --- resulting schedule ---
  const meetings = currentMeetings();
  const assignedCount = meetings.reduce((n, m) => n + m.participants.length, 0);
  const total = proposal.participants.length;

  document.getElementById("fin-summary").innerHTML =
    `전체 <b>${total}명</b> 중 <b>${assignedCount}명</b> 배정 · 약속 <b>${meetings.length}건</b>` +
    (assignedCount < total ? ` · 미배정 <b>${total - assignedCount}명</b>` : "");

  renderCalendarGrid(nameOf, meetings, capacity);
  renderUnassignedTray(nameOf);

  const preview = document.getElementById("fin-preview");
  preview.innerHTML = "";

  if (!meetings.length) {
    preview.innerHTML = `<p class="hint" style="margin:0;">배정된 약속이 없습니다.</p>`;
  }

  let overCapacity = false;
  meetings.forEach((m) => {
    const over = m.participants.length > capacity;
    if (over) overCapacity = true;

    const card = document.createElement("div");
    card.className = "meeting-card" + (over ? " over" : "");
    const end = (proposal.slots.find((s) => s.start === m.start) || {}).end;
    card.innerHTML = `
      <div class="meeting-time">${esc(end ? fmtRange(m.start, end) : fmtTime(m.start))}</div>
      <div class="meeting-people">${m.participants.map((k) => esc(nameOf[k] || k)).join(", ")}</div>
      <div class="meeting-count">${m.participants.length}명${over ? ` / 정원 ${capacity}명 초과` : ""}</div>
    `;
    preview.appendChild(card);
  });

  const unassigned = proposal.participants.filter((p) => !choice[p.key]);
  if (unassigned.length) {
    const box = document.createElement("div");
    box.className = "unassigned-box";
    box.innerHTML = `<strong>미배정 ${unassigned.length}명</strong>`;

    // 같은 사유끼리 묶습니다 - 한 명씩 나열하면 같은 문장이 반복되고,
    // 호스트가 취할 조치도 사유 단위라 묶어 보는 편이 읽기 쉽습니다.
    const groups = new Map();
    unassigned.forEach((p) => {
      const reason = unassignedReasons[p.key];
      const key = reason ? reason.code : "manual";
      const text = reason ? reason.text : "직접 배정을 해제했습니다.";
      if (!groups.has(key)) groups.set(key, { text, names: [] });
      groups.get(key).names.push(p.name);
    });

    groups.forEach((g) => {
      const row = document.createElement("div");
      row.className = "unassigned-reason-row";
      row.innerHTML = `<div class="unassigned-reason-names">${esc(g.names.join(", "))}</div>
                       <div class="unassigned-reason-text">${esc(g.text)}</div>`;
      box.appendChild(row);
    });
    preview.appendChild(box);
  }

  renderChangeSummary();

  document.getElementById("fin-confirm-btn").disabled = overCapacity || !meetings.length;
  document.getElementById("fin-error").textContent = overCapacity
    ? "정원을 초과한 약속이 있습니다. 인원을 조정해 주세요."
    : "";
}

/* ------------------------------------------------------------------ */
/* 확정 이후 바뀐 배정 표시                                             */
/* ------------------------------------------------------------------ */

/* 참가자별 예약을 (시작시각, 같이 오는 사람들)로 뽑습니다. 서버의
 * finalize_service._booking_by_key()와 같은 규칙이라, 화면에 "바뀌었다"고
 * 표시되는 사람과 실제로 메일을 받는 사람이 일치합니다. */
function bookingByKey(meetings) {
  const out = {};
  (meetings || []).forEach((m) => {
    const members = m.participants || [];
    members.forEach((key) => {
      out[key] = {
        start: m.start,
        others: members.filter((k) => k !== key).slice().sort().join("|"),
      };
    });
  });
  return out;
}

function savedMeetings() {
  const fin = CFG.finalization;
  return fin && fin.status === "confirmed" ? fin.meetings || [] : null;
}

/** 저장된 확정본과 지금 편집 중인 배정의 차이. */
function assignmentChanges() {
  const saved = savedMeetings();
  if (!saved) return null; // 아직 확정 전 - 비교할 대상이 없습니다.

  const before = bookingByKey(saved);
  const after = bookingByKey(currentMeetings());
  const nameOf = proposal
    ? Object.fromEntries(proposal.participants.map((p) => [p.key, p.name]))
    : {};

  const changes = [];
  new Set([...Object.keys(before), ...Object.keys(after)]).forEach((key) => {
    const b = before[key];
    const a = after[key];
    const name = nameOf[key] || key;
    if (!b && a) changes.push({ key, name, kind: "added", to: a.start });
    else if (b && !a) changes.push({ key, name, kind: "removed", from: b.start });
    else if (b && a && timeKey(b.start) !== timeKey(a.start)) {
      changes.push({ key, name, kind: "moved", from: b.start, to: a.start });
    } else if (b && a && b.others !== a.others) {
      // 시간은 그대로지만 같은 약속에 오는 사람이 달라졌습니다 - 그 사람에게도
      // 달라진 약속이므로 안내 대상입니다.
      changes.push({ key, name, kind: "party", to: a.start });
    }
  });

  changes.sort((x, y) => x.name.localeCompare(y.name, "ko"));
  return changes;
}

const CHANGE_LABELS = {
  added: "새로 배정",
  removed: "배정 해제",
  moved: "시간 변경",
  party: "함께하는 사람 변경",
};

function renderChangeSummary() {
  const box = document.getElementById("fin-changes");
  if (!box) return;
  const changes = assignmentChanges();

  if (!changes || !changes.length) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  document.getElementById("fin-changes-count").textContent =
    `${changes.length}명 · 다시 확정하면 이 분들에게만 안내 메일이 갑니다`;

  const list = document.getElementById("fin-changes-list");
  list.innerHTML = "";
  changes.forEach((c) => {
    const when =
      c.kind === "removed"
        ? `${esc(fmtTime(c.from))} → <span class="fin-change-none">배정 없음</span>`
        : c.kind === "added"
          ? `<span class="fin-change-none">배정 없음</span> → ${esc(fmtTime(c.to))}`
          : c.kind === "moved"
            ? `${esc(fmtTime(c.from))} → ${esc(fmtTime(c.to))}`
            : esc(fmtTime(c.to));
    list.appendChild(
      el(`<div class="fin-change-row">
            <span class="fin-change-name">${esc(c.name)}</span>
            <span class="fin-change-kind fin-change-${c.kind}">${CHANGE_LABELS[c.kind]}</span>
            <span class="fin-change-when">${when}</span>
          </div>`)
    );
  });
}

/* ------------------------------------------------------------------ */
/* Confirm / cancel                                                    */
/* ------------------------------------------------------------------ */

async function confirmSchedule() {
  const btn = document.getElementById("fin-confirm-btn");
  const errorEl = document.getElementById("fin-error");
  errorEl.textContent = "";

  const meetings = currentMeetings();
  const already = CFG.finalization && CFG.finalization.status === "confirmed";
  const changes = assignmentChanges();

  let question;
  if (!already) {
    question = `${meetings.length}건의 약속을 확정할까요? 참가자에게 안내 메일이 발송되고 응답이 잠깁니다.`;
  } else if (changes && changes.length) {
    // 누구에게 메일이 갈지 이름까지 보여 주고 확인받습니다.
    const names = changes.map((c) => c.name).join(", ");
    question = `배정이 바뀐 ${changes.length}명에게만 변경 안내 메일이 발송됩니다.\n\n${names}\n\n다시 확정할까요?`;
  } else {
    question = "바뀐 배정이 없습니다. 그대로 다시 확정할까요? (안내 메일은 발송되지 않습니다)";
  }
  if (!confirm(question)) return;

  btn.disabled = true;
  try {
    const result = await api.post(`/api/events/${CFG.eventId}/finalize/confirm`, {
      capacity: Number(document.getElementById("fin-capacity").value),
      meetingMinutes: Number(document.getElementById("fin-minutes").value),
      meetings,
    });
    // 메일은 서버가 백그라운드로 보냅니다. 발송이 끝나기 전에 페이지를 떠나도
    // 계속 나가므로, 기다릴 필요가 없다는 걸 분명히 알려 줍니다.
    const n = result && result.notifiedCount;
    showSnackbar(
      n
        ? `일정을 확정했습니다. 안내 메일 ${n}통을 백그라운드로 보내는 중입니다 — 이 페이지를 나가도 계속 전송됩니다.`
        : "일정을 확정했습니다.",
      "success"
    );
    live.stop(); // 곧 새로고침합니다 - 내 행동으로 알림이 뜨지 않게
    // 스낵바를 읽을 시간을 주고 새로고침합니다 (스낵바는 3.2초 뒤 사라집니다).
    setTimeout(() => window.location.reload(), n ? 2600 : 900);
  } catch (err) {
    errorEl.textContent = err.message || "확정하지 못했습니다.";
    btn.disabled = false;
  }
}

async function cancelSchedule() {
  if (!confirm("확정을 취소하고 다시 응답을 받을까요? 참가자에게 취소 안내 메일이 발송됩니다.")) return;
  try {
    await api.post(`/api/events/${CFG.eventId}/finalize/cancel`);
    showSnackbar(
      "확정을 취소했습니다. 취소 안내 메일은 백그라운드로 발송됩니다 — 이 페이지를 나가도 계속 전송됩니다.",
      "success"
    );
    live.stop(); // 곧 새로고침합니다 - 내 행동으로 알림이 뜨지 않게
    setTimeout(() => window.location.reload(), 2600);
  } catch (err) {
    showSnackbar(err.message || "취소하지 못했습니다.", "error");
  }
}

/* ------------------------------------------------------------------ */
/* 자동 갱신                                                            */
/* ------------------------------------------------------------------ */
//
// 주최자가 배정을 짜는 동안에도 참가자는 계속 가능한 시간을 고칩니다.
// 그렇다고 화면을 마음대로 다시 계산해 버리면 손으로 끌어다 놓은 배정이
// 통째로 날아갑니다 - 다른 화면과 달리 여기서는 **알리기만** 하고, 다시
// 계산할지는 주최자가 정합니다. 폴링 루프는 live.js.

function setStaleNotice(visible) {
  const el = document.getElementById("fin-stale");
  if (el) el.style.display = visible ? "" : "none";
}

const live = createLiveRefresh({
  url: () => `/api/events/${CFG.eventId}/version`,
  onChange: () => setStaleNotice(true),
  onGone: () => window.location.reload(), // 보는 사이에 일정이 지워졌습니다
});

document.addEventListener("DOMContentLoaded", () => {
  populateSettings();
  document.getElementById("fin-stale-rerun").addEventListener("click", () => runOptimizer(false));
  // 지금 화면이 어느 시점의 응답으로 만들어졌는지 기준점을 잡아 둡니다.
  api
    .get(`/api/events/${CFG.eventId}/version`)
    .then((r) => {
      live.sync(r.v);
      live.start();
    })
    .catch(() => {});
  // Wrapped in arrow functions so the click MouseEvent isn't forwarded as
  // runOptimizer's `restoreStored` argument.
  document.getElementById("fin-run-btn").addEventListener("click", () => runOptimizer(false));
  document.getElementById("fin-confirm-btn").addEventListener("click", confirmSchedule);
  document.getElementById("fin-cancel-btn").addEventListener("click", cancelSchedule);

  // Re-running is required after changing conditions, so clear stale output.
  ["fin-capacity", "fin-minutes", "fin-allow-ifneeded"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      setResultVisible(false);
      proposal = null;
    });
  });

  if (CFG.finalization && CFG.finalization.status === "confirmed") runOptimizer(true);
});
