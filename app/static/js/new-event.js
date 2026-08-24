/* Shared "create/edit event" dialog. Used on the landing page (guest create)
 * and the dashboard (create + edit, event + group). Reference-week trick for
 * day-of-week events: weekday N is stored as REF_SUNDAY + N days, so the
 * server never needs to know about weekdays at all - it just stores dates. */
const NewEventDialog = (() => {
  const REF_SUNDAY = new Date(2024, 0, 7); // a Sunday
  const DOW_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

  let state = null;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function decimalToLabel(v) {
    const h = Math.floor(v);
    const m = Math.round((v - h) * 60);
    const hour24 = h % 24;
    return `${pad(hour24)}:${pad(m)}`;
  }

  function populateTimeSelect(select, defaultVal) {
    select.innerHTML = "";
    for (let v = 0; v <= 24; v += 0.5) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = decimalToLabel(v);
      if (v === defaultVal) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function renderCalendar() {
    const grid = document.getElementById("ne-calendar");
    const label = document.getElementById("ne-cal-label");
    const y = state.calMonth.getFullYear();
    const m = state.calMonth.getMonth();
    label.textContent = `${y}년 ${m + 1}월`;

    grid.innerHTML = "";
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
      grid.appendChild(document.createElement("div"));
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(y, m, day);
      const key = dateKey(d);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "month-cell" + (state.selectedDates.has(key) ? " available" : "");
      cell.textContent = String(day);
      cell.addEventListener("click", () => {
        if (state.selectedDates.has(key)) {
          state.selectedDates.delete(key);
        } else {
          state.selectedDates.add(key);
        }
        renderCalendar();
      });
      grid.appendChild(cell);
    }
  }

  function renderDowRow() {
    const row = document.getElementById("ne-dow-row");
    row.innerHTML = "";
    DOW_LABELS.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dow-toggle" + (state.selectedDow.has(idx) ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (state.selectedDow.has(idx)) state.selectedDow.delete(idx);
        else state.selectedDow.add(idx);
        renderDowRow();
      });
      row.appendChild(btn);
    });
  }

  function setDateMode(mode) {
    state.dateMode = mode;
    document.querySelectorAll("#ne-date-mode button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.getElementById("ne-specific-dates-field").style.display = mode === "specific_dates" ? "" : "none";
    document.getElementById("ne-dow-field").style.display = mode === "dow" ? "" : "none";
  }

  function setTab(tab) {
    state.tab = tab;
    const tabsEl = document.getElementById("ne-tabs");
    if (tabsEl) {
      tabsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    }
    const dateModeField = document.getElementById("ne-date-mode-field");
    const remindeesField = document.getElementById("ne-remindees-field");
    const attendeesField = document.getElementById("ne-attendees-field");

    if (tab === "group") {
      setDateMode("dow");
      if (dateModeField) dateModeField.style.display = "none";
      if (remindeesField) remindeesField.style.display = "none";
      if (attendeesField) attendeesField.style.display = "";
    } else {
      if (dateModeField) dateModeField.style.display = "";
      if (remindeesField) remindeesField.style.display = "";
      if (attendeesField) attendeesField.style.display = "none";
    }
  }

  function addChip(container, listEl, arr, value) {
    const trimmed = value.trim();
    if (!trimmed || !trimmed.includes("@") || arr.includes(trimmed)) return;
    arr.push(trimmed);
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = trimmed;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      const i = arr.indexOf(trimmed);
      if (i >= 0) arr.splice(i, 1);
      chip.remove();
    });
    chip.appendChild(removeBtn);
    listEl.insertBefore(chip, container);
  }

  function wireChipInput(inputId, containerId, stateKey) {
    const input = document.getElementById(inputId);
    const container = document.getElementById(containerId);
    if (!input || !container) return;
    input.addEventListener("keydown", (e) => {
      const arr = state[stateKey];
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addChip(input, container, arr, input.value);
        input.value = "";
      } else if (e.key === "Backspace" && !input.value && arr.length) {
        arr.pop();
        const chips = container.querySelectorAll(".chip");
        if (chips.length) chips[chips.length - 1].remove();
      }
    });
  }

  function resetChips(containerId, arr) {
    const container = document.getElementById(containerId);
    if (container) container.querySelectorAll(".chip").forEach((c) => c.remove());
    arr.length = 0;
  }

  function combine(date, decimalHour) {
    const h = Math.floor(decimalHour);
    const m = Math.round((decimalHour - h) * 60);
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0);
    return d;
  }

  function buildDates() {
    const startVal = parseFloat(document.getElementById("ne-start-time").value);
    const dates = [];
    if (state.dateMode === "specific_dates") {
      for (const key of state.selectedDates) {
        const [y, m, d] = key.split("-").map(Number);
        dates.push(combine(new Date(y, m - 1, d), startVal).toISOString());
      }
    } else {
      for (const idx of state.selectedDow) {
        const ref = new Date(REF_SUNDAY);
        ref.setDate(ref.getDate() + idx);
        dates.push(combine(ref, startVal).toISOString());
      }
    }
    return dates.sort();
  }

  function computeDuration() {
    const startVal = parseFloat(document.getElementById("ne-start-time").value);
    const endVal = parseFloat(document.getElementById("ne-end-time").value);
    let duration = endVal - startVal;
    if (duration <= 0) duration += 24;
    return duration;
  }

  function showError(msg) {
    document.getElementById("ne-error").textContent = msg || "";
  }

  function open(options) {
    options = options || {};
    const mode = options.mode || "create";
    const event = options.event || null;
    const defaultTab = options.tab || (event && event.type === "group" ? "group" : "event");

    state = {
      mode,
      event,
      dateMode: "specific_dates",
      tab: defaultTab,
      calMonth: new Date(),
      selectedDates: new Set(),
      selectedDow: new Set(),
      remindees: [],
      attendees: [],
    };

    document.getElementById("new-event-title").textContent =
      mode === "edit" ? "일정 수정" : defaultTab === "group" ? "새 그룹 만들기" : "새 일정 만들기";
    document.getElementById("ne-submit").textContent = mode === "edit" ? "저장" : "만들기";
    showError("");

    document.getElementById("ne-name").value = event ? event.name : "";
    populateTimeSelect(document.getElementById("ne-start-time"), 9);
    populateTimeSelect(document.getElementById("ne-end-time"), 17);
    document.getElementById("ne-time-increment").value = event ? String(event.timeIncrement || 15) : "15";

    const notify = document.getElementById("ne-notify");
    if (notify) notify.checked = !!(event && event.notificationsEnabled);
    const collectEmails = document.getElementById("ne-collect-emails");
    if (collectEmails) collectEmails.checked = !!(event && event.collectEmails);
    const blind = document.getElementById("ne-blind");
    if (blind) blind.checked = !!(event && event.blindAvailabilityEnabled);
    const thresholdEnable = document.getElementById("ne-threshold-enable");
    const thresholdCount = document.getElementById("ne-threshold-count");
    if (thresholdEnable) {
      const hasThreshold = !!(event && event.sendEmailAfterXResponses);
      thresholdEnable.checked = hasThreshold;
      thresholdCount.style.display = hasThreshold ? "" : "none";
      thresholdCount.value = hasThreshold ? event.sendEmailAfterXResponses : "";
      thresholdEnable.onchange = () => {
        thresholdCount.style.display = thresholdEnable.checked ? "" : "none";
      };
    }

    resetChips("ne-remindees-chips", state.remindees);
    resetChips("ne-attendees-chips", state.attendees);
    if (event && event.remindees) {
      event.remindees.forEach((r) => addChip(document.getElementById("ne-remindees-input"), document.getElementById("ne-remindees-chips"), state.remindees, r.email));
    }
    if (event && Array.isArray(event.attendees)) {
      event.attendees
        .map((a) => a.email)
        .filter(Boolean)
        .forEach((email) => addChip(document.getElementById("ne-attendees-input"), document.getElementById("ne-attendees-chips"), state.attendees, email));
    }

    if (event) {
      if (event.type === "dow" || event.type === "group") {
        state.selectedDow = new Set(
          event.dates.map((iso) => {
            const dt = new Date(iso);
            return dt.getDay();
          })
        );
        setDateMode("dow");
        document.getElementById("ne-start-time").value = String(dowStartValue(event.dates));
      } else {
        event.dates.forEach((iso) => {
          const dt = new Date(iso);
          state.selectedDates.add(dateKey(dt));
        });
        setDateMode("specific_dates");
        document.getElementById("ne-start-time").value = String(new Date(event.dates[0]).getHours() + new Date(event.dates[0]).getMinutes() / 60);
      }
      const endVal = (parseFloat(document.getElementById("ne-start-time").value) + (event.duration || 1)) % 24 || 24;
      document.getElementById("ne-end-time").value = String(endVal);
    } else {
      setDateMode("specific_dates");
    }

    setTab(mode === "edit" ? (event.type === "group" ? "group" : "event") : defaultTab);
    if (mode === "edit") {
      const tabsEl = document.getElementById("ne-tabs");
      if (tabsEl) tabsEl.style.display = "none"; // can't switch event<->group while editing
    } else {
      const tabsEl = document.getElementById("ne-tabs");
      if (tabsEl) tabsEl.style.display = "";
    }

    renderCalendar();
    renderDowRow();
    openDialog("new-event-dialog");
  }

  function dowStartValue(dates) {
    const dt = new Date(dates[0]);
    return dt.getHours() + dt.getMinutes() / 60;
  }

  function close() {
    closeDialog("new-event-dialog");
  }

  function init() {
    document.getElementById("ne-date-mode").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (btn) setDateMode(btn.dataset.mode);
    });

    const tabsEl = document.getElementById("ne-tabs");
    if (tabsEl) {
      tabsEl.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-tab]");
        if (btn) setTab(btn.dataset.tab);
      });
    }

    document.getElementById("ne-cal-prev").addEventListener("click", () => {
      state.calMonth.setMonth(state.calMonth.getMonth() - 1);
      renderCalendar();
    });
    document.getElementById("ne-cal-next").addEventListener("click", () => {
      state.calMonth.setMonth(state.calMonth.getMonth() + 1);
      renderCalendar();
    });

    wireChipInput("ne-remindees-input", "ne-remindees-chips", "remindees");
    wireChipInput("ne-attendees-input", "ne-attendees-chips", "attendees");
    document.getElementById("new-event-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      showError("");

      const name = document.getElementById("ne-name").value.trim();
      if (!name) {
        showError("이름을 입력해 주세요.");
        return;
      }

      const dates = buildDates();
      if (!dates.length) {
        showError(state.dateMode === "specific_dates" ? "날짜를 하나 이상 선택해 주세요." : "요일을 하나 이상 선택해 주세요.");
        return;
      }

      const isGroup = state.tab === "group";
      const payload = {
        name,
        duration: computeDuration(),
        dates,
        type: isGroup ? "group" : state.dateMode,
        timeIncrement: parseInt(document.getElementById("ne-time-increment").value, 10),
        notificationsEnabled: document.getElementById("ne-notify") ? document.getElementById("ne-notify").checked : false,
        collectEmails: document.getElementById("ne-collect-emails") ? document.getElementById("ne-collect-emails").checked : false,
        blindAvailabilityEnabled: document.getElementById("ne-blind") ? document.getElementById("ne-blind").checked : false,
        remindees: isGroup ? [] : state.remindees,
        attendees: isGroup ? state.attendees : [],
      };

      const thresholdEnable = document.getElementById("ne-threshold-enable");
      if (thresholdEnable && thresholdEnable.checked) {
        const n = parseInt(document.getElementById("ne-threshold-count").value, 10);
        if (n > 0) payload.sendEmailAfterXResponses = n;
      }

      const submitBtn = document.getElementById("ne-submit");
      submitBtn.disabled = true;
      try {
        let result;
        if (state.mode === "edit") {
          await api.put(`/api/events/${state.event._id}`, payload);
          result = { shortId: state.event.shortId, _id: state.event._id };
        } else {
          result = await api.post("/api/events", payload);
        }
        const id = result.shortId || result.eventId || result._id;
        window.location.href = isGroup ? `/g/${id}` : `/e/${id}`;
      } catch (err) {
        showError(err.message || "일정을 저장하지 못했습니다.");
        submitBtn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  return { open, close };
})();
