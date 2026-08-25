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
      const pad = document.createElement("div");
      pad.className = "month-cell-empty";
      grid.appendChild(pad);
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
    // Always pad out to a fixed 6 rows (42 cells) - a month only needing 4
    // or 5 rows would otherwise leave a shorter grid, and since the dialog's
    // height follows its content, that made the whole "방 생성" window
    // resize every time you paged to a month with a different row count.
    // These trailing pads use the same .month-cell-empty class as the
    // leading ones (see CSS) so a row made up entirely of padding still
    // reserves a real cell's height in the grid instead of collapsing.
    while (grid.children.length < 42) {
      const pad = document.createElement("div");
      pad.className = "month-cell-empty";
      grid.appendChild(pad);
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

  // Markdown mode swaps the helper text for a live preview, so the author
  // can see exactly what participants will get before saving.
  function setDescriptionFormat(format) {
    state.descriptionFormat = format === "markdown" ? "markdown" : "text";
    document.querySelectorAll("#ne-desc-format button").forEach((b) => {
      b.classList.toggle("active", b.dataset.format === state.descriptionFormat);
    });
    document.getElementById("ne-desc-hint").textContent =
      state.descriptionFormat === "markdown"
        ? "# 제목, **굵게**, - 목록, [링크](https://…) 등을 쓸 수 있습니다."
        : "줄바꿈이 그대로 표시됩니다.";
    renderDescriptionPreview();
  }

  function renderDescriptionPreview() {
    const preview = document.getElementById("ne-desc-preview");
    const src = document.getElementById("ne-description").value;
    if (state.descriptionFormat !== "markdown" || !src.trim()) {
      preview.style.display = "none";
      preview.innerHTML = "";
      return;
    }
    preview.style.display = "";
    preview.innerHTML = `<div class="md-preview-label">미리보기</div>${renderMarkdown(src)}`;
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

  let contactsCache = null;
  async function loadContacts() {
    if (contactsCache) return contactsCache;
    try {
      contactsCache = await api.get("/api/contacts");
    } catch (e) {
      contactsCache = [];
    }
    return contactsCache;
  }

  // Lets a signed-in host pick from their saved 연락처 instead of typing
  // every email by hand - adds straight into the same chip array/input the
  // manual "이메일 입력 후 Enter" flow uses, so both paths stay in sync.
  // Also offers the same 과정/학적상태 filter bar as the 연락처 page and the
  // invite-by-email dialog, for contacts that have that roster detail.
  function wireContactPicker(fieldId, inputId, chipsId, stateKey) {
    const field = document.getElementById(fieldId);
    const btn = field && field.querySelector('[data-role="pick-contact-btn"]');
    const dropdown = field && field.querySelector(".contact-picker-dropdown");
    if (!field || !btn || !dropdown) return;

    const search = dropdown.querySelector('[data-role="pick-contact-search"]');
    const filtersRoot = dropdown.querySelector('[data-role="pick-contact-filters"]');
    const list = dropdown.querySelector('[data-role="pick-contact-list"]');
    const input = document.getElementById(inputId);
    const chipsEl = document.getElementById(chipsId);

    let filterPredicate = () => true;

    function renderList() {
      const contacts = contactsCache || [];
      const q = search.value.trim().toLowerCase();
      const arr = state[stateKey];
      const items = contacts.filter(
        (c) =>
          !arr.includes(c.email) &&
          filterPredicate(c) &&
          (!q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      );

      list.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.style.padding = "8px";
        empty.textContent = contacts.length ? "표시할 연락처가 없습니다" : "저장된 연락처가 없습니다";
        list.appendChild(empty);
        return;
      }
      items.forEach((c) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "contact-picker-row";
        const name = document.createElement("span");
        name.className = "contact-picker-name";
        name.textContent = c.name;
        const email = document.createElement("span");
        email.className = "contact-picker-email";
        email.textContent = c.email;
        row.appendChild(name);
        row.appendChild(email);
        row.addEventListener("click", () => {
          addChip(input, chipsEl, arr, c.email);
          renderList();
        });
        list.appendChild(row);
      });
    }

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const opening = dropdown.style.display === "none";
      document.querySelectorAll(".contact-picker-dropdown").forEach((d) => (d.style.display = "none"));
      if (opening) {
        dropdown.style.display = "";
        search.value = "";
        const contacts = await loadContacts();
        filterPredicate = setupContactFilterBar(filtersRoot, contacts, renderList);
        renderList();
        search.focus();
      }
    });
    search.addEventListener("input", renderList);
    dropdown.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => {
      dropdown.style.display = "none";
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
      descriptionFormat: "text",
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
    document.getElementById("ne-description").value = (event && event.description) || "";
    setDescriptionFormat((event && event.descriptionFormat) === "markdown" ? "markdown" : "text");
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

    document.getElementById("ne-desc-format").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-format]");
      if (btn) setDescriptionFormat(btn.dataset.format);
    });
    document.getElementById("ne-description").addEventListener("input", renderDescriptionPreview);

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
    wireContactPicker("ne-remindees-field", "ne-remindees-input", "ne-remindees-chips", "remindees");
    wireContactPicker("ne-attendees-field", "ne-attendees-input", "ne-attendees-chips", "attendees");
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
        description: document.getElementById("ne-description").value.trim(),
        descriptionFormat: state.descriptionFormat,
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
