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
    proposal = await api.post(`/api/events/${CFG.eventId}/finalize/proposal`, {
      capacity: Number(document.getElementById("fin-capacity").value),
      meetingMinutes: Number(document.getElementById("fin-minutes").value),
      allowIfNeeded: document.getElementById("fin-allow-ifneeded").checked,
    });

    if (!proposal.participants.length) {
      document.getElementById("fin-result").style.display = "none";
      document.getElementById("fin-empty").style.display = "";
      return;
    }

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
    document.getElementById("fin-result").style.display = "";
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

  const ghost = el(`<div class="cal-drag-ghost">${esc(label)}</div>`);
  document.body.appendChild(ghost);
  positionGhost(ghost, e.clientX, e.clientY);
  document.body.classList.add("dragging-active");

  dragState = { key, ghost };

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
    document.body.classList.remove("dragging-active");
    if (dragState) dragState.ghost.remove();
    dragState = null;
  };

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
    box.innerHTML = `<strong>미배정 ${unassigned.length}명</strong><div>${unassigned
      .map((p) => esc(p.name))
      .join(", ")}</div>`;
    preview.appendChild(box);
  }

  document.getElementById("fin-confirm-btn").disabled = overCapacity || !meetings.length;
  document.getElementById("fin-error").textContent = overCapacity
    ? "정원을 초과한 약속이 있습니다. 인원을 조정해 주세요."
    : "";
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
  const question = already
    ? "변경된 내용으로 다시 확정할까요? 참가자에게 변경 안내 메일이 발송됩니다."
    : `${meetings.length}건의 약속을 확정할까요? 참가자에게 안내 메일이 발송되고 응답이 잠깁니다.`;
  if (!confirm(question)) return;

  btn.disabled = true;
  try {
    await api.post(`/api/events/${CFG.eventId}/finalize/confirm`, {
      capacity: Number(document.getElementById("fin-capacity").value),
      meetingMinutes: Number(document.getElementById("fin-minutes").value),
      meetings,
    });
    showSnackbar("일정이 확정되었습니다. 안내 메일을 보냈습니다.", "success");
    setTimeout(() => window.location.reload(), 900);
  } catch (err) {
    errorEl.textContent = err.message || "확정하지 못했습니다.";
    btn.disabled = false;
  }
}

async function cancelSchedule() {
  if (!confirm("확정을 취소하고 다시 응답을 받을까요? 참가자에게 취소 안내 메일이 발송됩니다.")) return;
  try {
    await api.post(`/api/events/${CFG.eventId}/finalize/cancel`);
    showSnackbar("확정이 취소되었습니다.", "success");
    setTimeout(() => window.location.reload(), 900);
  } catch (err) {
    showSnackbar(err.message || "취소하지 못했습니다.", "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  populateSettings();
  // Wrapped in arrow functions so the click MouseEvent isn't forwarded as
  // runOptimizer's `restoreStored` argument.
  document.getElementById("fin-run-btn").addEventListener("click", () => runOptimizer(false));
  document.getElementById("fin-confirm-btn").addEventListener("click", confirmSchedule);
  document.getElementById("fin-cancel-btn").addEventListener("click", cancelSchedule);

  // Re-running is required after changing conditions, so clear stale output.
  ["fin-capacity", "fin-minutes", "fin-allow-ifneeded"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      document.getElementById("fin-result").style.display = "none";
      proposal = null;
    });
  });

  if (CFG.finalization && CFG.finalization.status === "confirmed") runOptimizer(true);
});
