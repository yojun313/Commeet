/* Shared "create/edit event" dialog. Used on the landing page (guest create)
 * and the dashboard (create + edit). 일정은 고른 날짜에 대해서만 만듭니다 -
 * 요일 반복과 그룹은 쓰지 않게 되어 걷어냈습니다. */
const NewEventDialog = (() => {

  let state = null;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function decimalToLabel(v) {
    // 끝 시간의 마지막 칸은 자정입니다. 0시로 적으면 목록 맨 아래에 "00:00"이
    // 나와 하루의 시작처럼 보이므로 "24:00"으로 둡니다.
    if (v === 24) return "24:00";
    const h = Math.floor(v);
    const m = Math.round((v - h) * 60);
    const hour24 = h % 24;
    return `${pad(hour24)}:${pad(m)}`;
  }

  /* `min`/`max`는 고를 수 있는 범위(30분 단위, 양끝 포함)입니다.
     끝 시간 목록을 시작 시간 뒤로 좁힐 때 씁니다. */
  function populateTimeSelect(select, defaultVal, min, max) {
    const from = min === undefined ? 0 : min;
    const to = max === undefined ? 24 : max;
    select.innerHTML = "";
    for (let v = from; v <= to; v += 0.5) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = decimalToLabel(v);
      if (v === defaultVal) opt.selected = true;
      select.appendChild(opt);
    }
  }

  /* 끝 시간이 시작 시간을 앞서지 못하게 목록 자체를 좁힙니다.
   *
   * 예전에는 끝이 앞서면 자정을 넘긴 것으로 쳐서 24시간을 더했습니다
   * (computeDuration). 그래서 09:00~17:00을 거꾸로 고르면 8시간짜리가
   * 16시간짜리 일정으로 조용히 만들어졌고, 화면에는 그런 티가 나지 않았습니다.
   * 고를 수 없게 막는 편이 경고를 띄우는 것보다 확실합니다.
   */
  function syncEndTimeOptions() {
    const startSel = document.getElementById("ne-start-time");
    const endSel = document.getElementById("ne-end-time");
    const startVal = parseFloat(startSel.value);
    const previous = parseFloat(endSel.value);
    // 고르던 끝 시간이 아직 유효하면 지킵니다. 아니면 기본 8시간짜리로,
    // 그마저 자정을 넘으면 자정에 맞춥니다.
    const wanted =
      previous > startVal ? previous : Math.min(startVal + 8, 24);
    populateTimeSelect(endSel, wanted, startVal + 0.5, 24);
    endSel.value = String(wanted);
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
    // 오늘 날짜를 표시해 두면 "며칠 뒤"를 세기 쉽습니다. calendar-page.js와
    // 같은 today 클래스 이름을 씁니다.
    const todayKey = dateKey(new Date());
    // 지난 날짜는 고를 수 없습니다. 오늘은 지난 날이 아니므로 자정 기준으로
    // 자릅니다 - 오전에 오늘 일정을 잡는 것은 정상적인 사용입니다.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(y, m, day);
      const key = dateKey(d);
      const isToday = key === todayKey;
      const selected = state.selectedDates.has(key);
      // 이미 선택된 날짜는 지났더라도 누를 수 있게 둡니다. 지난 일정을
      // 수정할 때 그 날짜를 빼낼 방법이 없어지기 때문입니다.
      const blocked = d < todayStart && !selected;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className =
        "month-cell" +
        (selected ? " available" : "") +
        (isToday ? " today" : "");
      if (isToday) cell.title = "오늘";
      if (blocked) {
        cell.disabled = true;
        cell.title = "지난 날짜는 선택할 수 없습니다";
      }
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

  /* 새로 만들 때는 초대 칸을 보여 주지 않습니다 - 여기서 받으면 주최자가
     시간을 찍기도 전에 메일이 나갑니다. 대신 안내 한 줄만 둡니다. */
  function syncInviteFields() {
    const creating = state.mode !== "edit";
    const laterHint = document.getElementById("ne-invite-later-hint");
    if (laterHint) laterHint.style.display = creating ? "" : "none";
    const remindeesField = document.getElementById("ne-remindees-field");
    if (remindeesField) remindeesField.style.display = creating ? "none" : "";
  }

  /* 공동주최자 명단은 주최자만 바꿉니다 (서버도 무시합니다). 공동주최자가
     수정 창을 열면 칸 대신 지금 명단만 보여 줍니다. 주인 없는(게스트가 만든)
     일정은 공동주최자를 둘 수 없습니다. */
  function coHostsEditable() {
    if (state.mode !== "edit") return true;
    return !!(state.event && state.event.ownerId && state.event.isOwner);
  }

  function syncCoHostFields() {
    const field = document.getElementById("ne-cohosts-field");
    const readonly = document.getElementById("ne-cohosts-readonly");
    if (!field) return;
    const editable = coHostsEditable();
    field.style.display = editable ? "" : "none";
    if (!readonly) return;
    const list = (state.event && state.event.coHosts) || [];
    const showNote = !editable && state.event && state.event.isCoHost;
    readonly.style.display = showNote ? "" : "none";
    readonly.textContent = showNote
      ? `공동주최자: ${list.map((c) => c.name || c.email).join(", ") || "-"} (명단은 주최자만 바꿀 수 있습니다)`
      : "";
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

  /** 이메일로 칩을 찾아 지웁니다. 연락처 체크를 해제할 때 씁니다. */
  function removeChip(listEl, arr, value) {
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1);
    [...listEl.querySelectorAll(".chip")].forEach((chip) => {
      // chip.textContent는 삭제 버튼의 "×"까지 포함하므로 앞부분만 비교합니다.
      if (chip.firstChild && chip.firstChild.nodeValue === value) chip.remove();
    });
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
      // 이미 고른 사람도 체크된 채로 남겨 둡니다 - 목록에서 사라지면 누구를
      // 골랐는지 여기서 확인할 수 없고, 잘못 고른 사람을 되돌리려면 칩까지
      // 내려가야 합니다.
      const items = contacts.filter(
        (c) =>
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
        const row = document.createElement("label");
        row.className = "checkbox-row contact-picker-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = arr.includes(c.email);
        const copy = document.createElement("span");
        copy.className = "checkbox-copy contact-picker-copy";
        const name = document.createElement("span");
        name.className = "contact-picker-name";
        name.textContent = c.name;
        const email = document.createElement("span");
        email.className = "contact-picker-email";
        email.textContent = c.email;
        copy.appendChild(name);
        copy.appendChild(email);
        box.addEventListener("change", () => {
          if (box.checked) addChip(input, chipsEl, arr, c.email);
          else removeChip(chipsEl, arr, c.email);
          updatePickedCount();
        });
        row.appendChild(box);
        row.appendChild(copy);
        list.appendChild(row);
      });
    }

    /** 드롭다운을 닫은 뒤에도 몇 명 골랐는지 보이게 버튼에 표시합니다. */
    function updatePickedCount() {
      const n = state[stateKey].length;
      const label = btn.querySelector("[data-role='pick-contact-count']");
      if (label) label.textContent = n ? ` (${n})` : "";
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
        updatePickedCount();
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
    for (const key of state.selectedDates) {
      const [y, m, d] = key.split("-").map(Number);
      dates.push(combine(new Date(y, m - 1, d), startVal).toISOString());
    }
    return dates.sort();
  }

  function computeDuration() {
    const startVal = parseFloat(document.getElementById("ne-start-time").value);
    const endVal = parseFloat(document.getElementById("ne-end-time").value);
    // 끝 시간 목록이 시작 시간 뒤로 좁혀져 있어(syncEndTimeOptions) 음수가
    // 나올 수 없습니다. 그래도 0이 서버로 나가면 검증에 걸리므로 최소 30분은
    // 보장합니다.
    return Math.max(endVal - startVal, 0.5);
  }

  function showError(msg) {
    document.getElementById("ne-error").textContent = msg || "";
  }

  function open(options) {
    options = options || {};
    const mode = options.mode || "create";
    const event = options.event || null;

    state = {
      mode,
      event,
      descriptionFormat: "text",
      // 1일로 맞춰 둡니다 (위 goMonth와 같은 이유). 달력은 연·월만 쓰므로
      // 며칠인지는 화면에 영향이 없습니다.
      calMonth: (() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
      })(),
      selectedDates: new Set(),
      remindees: [],
      coHosts: [],
    };

    document.getElementById("new-event-title").textContent =
      mode === "edit" ? "일정 수정" : "새 일정 만들기";
    document.getElementById("ne-submit").textContent = mode === "edit" ? "저장" : "만들기";
    showError("");

    document.getElementById("ne-name").value = event ? event.name : "";
    document.getElementById("ne-description").value = (event && event.description) || "";
    setDescriptionFormat((event && event.descriptionFormat) === "markdown" ? "markdown" : "text");
    // 시작은 23:30까지만 - 24:00을 고르면 그 뒤에 놓을 끝 시간이 없습니다.
    populateTimeSelect(document.getElementById("ne-start-time"), 9, 0, 23.5);
    populateTimeSelect(document.getElementById("ne-end-time"), 17, 9.5, 24);
    document.getElementById("ne-time-increment").value = event ? String(event.timeIncrement || 15) : "15";

    // 새로 만들 때는 세 옵션 모두 켠 채로 시작합니다 - 실제 사용 방식이
    // 그쪽이라서입니다. 수정할 때는 그 일정에 저장된 값을 그대로 보여 줍니다.
    const notify = document.getElementById("ne-notify");
    if (notify) notify.checked = event ? !!event.notificationsEnabled : true;
    const collectEmails = document.getElementById("ne-collect-emails");
    if (collectEmails) collectEmails.checked = event ? !!event.collectEmails : true;
    const blind = document.getElementById("ne-blind");
    if (blind) blind.checked = event ? !!event.blindAvailabilityEnabled : true;
    const guidance = document.getElementById("ne-guidance-records");
    // 값이 없는 예전 일정은 켜진 것으로 봅니다 (event_service.records_enabled와
    // 같은 규칙) - 이 항목이 생기기 전에 적어 둔 기록이 사라지면 안 됩니다.
    if (guidance) {
      guidance.checked = event ? event.guidanceRecordsEnabled !== false : false;
    }
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
    if (event && event.remindees) {
      event.remindees.forEach((r) => addChip(document.getElementById("ne-remindees-input"), document.getElementById("ne-remindees-chips"), state.remindees, r.email));
    }
    resetChips("ne-cohosts-chips", state.coHosts);
    if (event && event.coHosts) {
      event.coHosts.forEach((c) => addChip(document.getElementById("ne-cohosts-input"), document.getElementById("ne-cohosts-chips"), state.coHosts, c.email));
    }

    if (event) {
      event.dates.forEach((iso) => {
        const dt = new Date(iso);
        state.selectedDates.add(dateKey(dt));
      });
      document.getElementById("ne-start-time").value = String(new Date(event.dates[0]).getHours() + new Date(event.dates[0]).getMinutes() / 60);
      // 자정을 넘겨 저장된 옛 일정은 자정에서 자릅니다. 이제 끝이 시작을
      // 앞서는 시간대는 고를 수 없으므로 (syncEndTimeOptions) 그대로 되살릴
      // 방법이 없습니다 - 그런 일정을 수정하면 범위를 다시 골라야 합니다.
      const startVal = parseFloat(document.getElementById("ne-start-time").value);
      const endVal = Math.min(startVal + Math.max(event.duration || 1, 0.5), 24);
      // 목록을 먼저 좁힌 뒤에 값을 넣습니다. 순서가 반대면 새 시작 시간
      // 기준으로 범위 밖인 값은 조용히 무시되고 엉뚱한 시간이 남습니다.
      populateTimeSelect(
        document.getElementById("ne-end-time"), endVal, startVal + 0.5, 24
      );
      document.getElementById("ne-end-time").value = String(endVal);
    } else {
      syncEndTimeOptions();
    }

    syncInviteFields();
    syncCoHostFields();
    renderCalendar();
    openDialog("new-event-dialog");
  }


  function close() {
    closeDialog("new-event-dialog");
  }

  function init() {
    document.getElementById("ne-desc-format").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-format]");
      if (btn) setDescriptionFormat(btn.dataset.format);
    });
    document.getElementById("ne-description").addEventListener("input", renderDescriptionPreview);

    // 날짜를 1일로 고정한 새 Date를 만듭니다. setMonth()로 제자리에서 바꾸면
    // **오늘이 며칠인지에 따라 달을 건너뜁니다** - 8/31에서 setMonth(+1)은
    // "9월 31일"을 만들고, 그런 날이 없으니 10월 1일로 밀려납니다.
    // calendar-page.js의 navigate()도 같은 이유로 이렇게 되어 있습니다.
    const goMonth = (delta) => {
      state.calMonth = new Date(
        state.calMonth.getFullYear(),
        state.calMonth.getMonth() + delta,
        1
      );
      renderCalendar();
    };
    // 시작 시간을 바꾸면 끝 시간 목록을 그 뒤로 다시 좁힙니다.
    document.getElementById("ne-start-time").addEventListener("change", syncEndTimeOptions);
    document.getElementById("ne-cal-prev").addEventListener("click", () => goMonth(-1));
    document.getElementById("ne-cal-next").addEventListener("click", () => goMonth(1));

    wireChipInput("ne-remindees-input", "ne-remindees-chips", "remindees");
    wireContactPicker("ne-remindees-field", "ne-remindees-input", "ne-remindees-chips", "remindees");
    wireChipInput("ne-cohosts-input", "ne-cohosts-chips", "coHosts");
    wireContactPicker("ne-cohosts-field", "ne-cohosts-input", "ne-cohosts-chips", "coHosts");
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
        showError("날짜를 하나 이상 선택해 주세요.");
        return;
      }

      const payload = {
        name,
        description: document.getElementById("ne-description").value.trim(),
        descriptionFormat: state.descriptionFormat,
        duration: computeDuration(),
        dates,
        type: "specific_dates",
        timeIncrement: parseInt(document.getElementById("ne-time-increment").value, 10),
        notificationsEnabled: document.getElementById("ne-notify") ? document.getElementById("ne-notify").checked : false,
        collectEmails: document.getElementById("ne-collect-emails") ? document.getElementById("ne-collect-emails").checked : false,
        blindAvailabilityEnabled: document.getElementById("ne-blind") ? document.getElementById("ne-blind").checked : false,
        guidanceRecordsEnabled: document.getElementById("ne-guidance-records")
          ? document.getElementById("ne-guidance-records").checked
          : false,
        remindees: state.remindees,
      };
      // 칸이 있을 때만 보냅니다. 빠지면 서버는 명단을 그대로 둡니다 -
      // 공동주최자가 저장해도 명단이 지워지지 않습니다.
      if (document.getElementById("ne-cohosts-field") && coHostsEditable()) {
        // 입력만 하고 Enter를 안 누른 주소도 담습니다 (가장 흔한 실수).
        const pending = document.getElementById("ne-cohosts-input");
        if (pending && pending.value.trim()) {
          addChip(pending, document.getElementById("ne-cohosts-chips"), state.coHosts, pending.value);
          pending.value = "";
        }
        payload.coHosts = state.coHosts;
      }

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
          const url = `/api/events/${state.event._id}`;
          let res;
          try {
            res = await api.put(url, payload);
          } catch (err) {
            // 이미 응답이 있는 일정의 시간 단위를 바꾸면 기존 응답은 새
            // 칸과 맞지 않아 지워야 합니다 - 서버가 409로 알려 오면 확인을
            // 받고, 동의했을 때만 다시 보냅니다.
            const detail = err.data && err.data.detail;
            if (err.status !== 409 || !detail || detail.code !== "increment_reset_required") throw err;
            const ok = confirm(
              `시간 단위를 바꾸면 이미 받은 응답 ${detail.responses}건(가능한 시간)이 모두 삭제됩니다.\n` +
                "참가자들은 새 단위로 다시 입력해야 합니다. 계속할까요?"
            );
            if (!ok) {
              submitBtn.disabled = false;
              return;
            }
            res = await api.put(`${url}?resetResponses=true`, payload);
          }
          result = { shortId: state.event.shortId, _id: state.event._id, ...res };
        } else {
          result = await api.post("/api/events", payload);
        }
        // 초대 메일은 서버가 백그라운드로 보냅니다. 여기서 기다리지 않는
        // 대신, 옮겨 갈 페이지에서 몇 명에게 나가는 중인지 알려 줍니다.
        const queued = result.invitesQueued || 0;
        if (queued) {
          queueSnackbar(
            `${queued}명에게 초대 메일을 보내는 중입니다. 이 페이지를 나가도 전송됩니다.`,
            "success"
          );
        }
        const id = result.shortId || result.eventId || result._id;
        const link = `${window.location.origin}/e/${id}`;
        // 만든 직후에 하는 일은 거의 링크 공유라, 누르지 않아도 복사해 둡니다.
        // "만들기"를 누른 그 클릭이 곧 사용자 동작이므로 브라우저가 막지
        // 않습니다. 복사가 막히는 환경(비-https 등)에서는 알리지 않습니다.
        if (state.mode !== "edit") {
          const copied = await copyToClipboard(link);
          queueSnackbar(
            copied
              ? "일정을 만들었습니다. 링크를 복사했으니 바로 붙여넣어 공유하세요."
              : "일정을 만들었습니다.",
            "success"
          );
        }
        window.location.href = `/e/${id}`;
      } catch (err) {
        showError(err.message || "일정을 저장하지 못했습니다.");
        submitBtn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  return { open, close };
})();
