/* 면담 기록 폼 다이얼로그 (공유 모듈).
 *
 * 일정 페이지(/e/{id})의 캘린더 아래 "면담 기록 · 학생지도비"
 * 섹션에서 열립니다 - 시간대 한 줄당 기록 하나. 마크업은
 * partials/record_form_dialog.html, 호출은 event-grid.js입니다.
 * new-event.js / NewEventDialog와 같은 모듈 패턴입니다.
 *
 * 기록은 확정된 면담 하나에 붙고 (eventId, meetingStart)로 식별됩니다 -
 * finalization.meetings[]에는 고유 id가 없고 재확정하면 서브도큐먼트가
 * 통째로 교체되기 때문입니다.
 *
 * 첨부(서명·영수증)는 기록에 id가 생긴 뒤에만 올릴 수 있어, 저장 직후
 * 한꺼번에 올리도록 pendingReceipts에 모아 둡니다.
 */

const RecordDialog = (() => {
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

  function fmtMeeting(startIso, endIso) {
    const s = new Date(startIso);
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const pad = (n) => String(n).padStart(2, "0");
    let out = `${s.getFullYear()}. ${s.getMonth() + 1}. ${s.getDate()}(${days[s.getDay()]}) ${pad(s.getHours())}:${pad(s.getMinutes())}`;
    if (endIso) {
      const e = new Date(endIso);
      out += ` ~ ${pad(e.getHours())}:${pad(e.getMinutes())}`;
    }
    return out;
  }

  /* Splits a UTC instant into the date and clock time the host sees locally -
     the values the 신청서 is filled in with. */
  function localParts(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }

  function won(n) {
    return (n || 0).toLocaleString("ko-KR") + "원";
  }

  const CFG = window.RECORDS_CONFIG || {};
  const FEE_RATES = CFG.feeRates || { cse: 30000, muunjae: 15000 };

  const AFFILIATIONS = [
    { value: "cse", label: "컴퓨터공학과" },
    { value: "muunjae", label: "무은재학부" },
  ];
  const AFF_LABEL = Object.fromEntries(AFFILIATIONS.map((a) => [a.value, a.label]));

  const state = {
    form: null, // the record/draft currently open in the dialog
    recordId: null,
    pendingReceipts: {}, // settlement index -> File, uploaded after save
    signatureDirty: false,
    hasSignature: false,
  };

  // 저장/삭제 후 호출자에게 알려 목록이나 배지를 갱신하게 합니다.
  let onSaved = null;

  /* ------------------------------------------------------------------ */
  /* Attendees                                                           */
  /* ------------------------------------------------------------------ */

  function renderAttendees() {
    const root = document.getElementById("rec-attendees");
    const list = state.form.attendees;
    root.innerHTML = "";

    if (!list.length) {
      root.appendChild(el('<div class="empty-state">참석자가 없습니다.</div>'));
    }

    list.forEach((a, i) => {
      const row = el(`
        <div class="rec-attendee${a.present ? "" : " is-absent"}">
          <label class="rec-attendee-check">
            <input type="checkbox" ${a.present ? "checked" : ""} data-present />
          </label>
          <input class="input rec-attendee-name" value="${esc(a.name)}" data-name placeholder="이름" />
          <input class="input rec-attendee-sid" value="${esc(a.studentId)}" data-sid placeholder="학번" />
          <select class="input rec-attendee-aff" data-aff>
            ${AFFILIATIONS.map(
              (opt) => `<option value="${opt.value}"${a.affiliation === opt.value ? " selected" : ""}>${opt.label}</option>`
            ).join("")}
          </select>
          <button class="btn-icon rec-attendee-remove" type="button" data-remove aria-label="삭제">&times;</button>
        </div>
      `);

      row.querySelector("[data-present]").addEventListener("change", (e) => {
        list[i].present = e.target.checked;
        row.classList.toggle("is-absent", !e.target.checked);
        syncSettlements();
        renderNotes();
        updateAttendeeCount();
      });
      row.querySelector("[data-name]").addEventListener("input", (e) => {
        list[i].name = e.target.value;
        renderNotes();
      });
      row.querySelector("[data-sid]").addEventListener("input", (e) => {
        list[i].studentId = e.target.value;
      });
      row.querySelector("[data-aff]").addEventListener("change", (e) => {
        list[i].affiliation = e.target.value;
        syncSettlements();
      });
      row.querySelector("[data-remove]").addEventListener("click", () => {
        list.splice(i, 1);
        renderAttendees();
        syncSettlements();
        renderNotes();
        updateAttendeeCount();
      });

      root.appendChild(row);
    });

    updateAttendeeCount();
  }

  function updateAttendeeCount() {
    const present = state.form.attendees.filter((a) => a.present).length;
    document.getElementById("rec-attendee-count").textContent =
      `${present}명 참석 / 총 ${state.form.attendees.length}명`;
  }

  /* ------------------------------------------------------------------ */
  /* Notes                                                               */
  /* ------------------------------------------------------------------ */

  // 서버 쪽 같은 목록은 record_service.NOTE_CATEGORIES입니다. 순서까지
  // 맞춰야 인쇄 양식과 화면이 같은 차례로 보입니다.
  const NOTE_CATEGORIES = [
    { key: "academic", label: "학업지도" },
    { key: "life", label: "생활지도" },
    { key: "career", label: "진로지도" },
    { key: "etc", label: "기타사항" },
  ];

  function emptyNotes() {
    return { academic: "", life: "", career: "", etc: "" };
  }

  /* 저장된 값을 네 항목 형태로 맞춥니다. 항목이 나뉘기 전에 저장된 기록은
     문자열 하나라, 어느 갈래였는지 알 수 없으므로 "기타사항"에 넣습니다
     (서버 record_service._as_notes와 같은 규칙). */
  function asNotes(value) {
    const notes = emptyNotes();
    if (typeof value === "string") notes.etc = value;
    else if (value && typeof value === "object") {
      NOTE_CATEGORIES.forEach(({ key }) => {
        notes[key] = value[key] || "";
      });
    }
    return notes;
  }

  /* 네 항목 입력 묶음 하나. 공통 칸과 참석자별 칸이 같은 것을 씁니다 -
     한쪽에만 항목을 더하는 실수를 막고, 두 모드의 생김새도 같아집니다.
     `onInput(key, value)`로 바뀐 항목만 알려 줍니다. */
  function buildNoteFields(notes, onInput, placeholderFor) {
    const wrap = el('<div class="rec-note-fields"></div>');
    NOTE_CATEGORIES.forEach(({ key, label }) => {
      const field = el(`
        <label class="rec-note-field">
          <span class="rec-note-field-label">${esc(label)}</span>
          <textarea class="input rec-textarea rec-textarea-sm"
                    placeholder="${esc(placeholderFor ? placeholderFor(label) : "")}"></textarea>
        </label>
      `);
      const ta = field.querySelector("textarea");
      ta.value = notes[key] || "";
      ta.addEventListener("input", () => onInput(key, ta.value));
      wrap.appendChild(field);
    });
    return wrap;
  }

  function renderNotes() {
    const mode = state.form.notesMode;
    document.getElementById("rec-note-shared").hidden = mode !== "shared";
    const indiv = document.getElementById("rec-note-individual");
    indiv.hidden = mode !== "individual";
    document.querySelectorAll("#rec-notes-mode button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });

    // 안 보이는 쪽은 내용을 비웁니다. hidden만 믿으면 CSS가 조금만 어긋나도
    // 지난 모드의 입력칸이 그대로 남아 보입니다 (실제로 그랬습니다).
    const sharedHost = document.getElementById("rec-shared-note-fields");
    if (mode !== "shared") sharedHost.innerHTML = "";
    if (mode !== "individual") indiv.innerHTML = "";

    if (mode === "shared") {
      const host = sharedHost;
      host.innerHTML = "";
      host.appendChild(
        buildNoteFields(
          state.form.sharedNotes,
          (key, value) => {
            state.form.sharedNotes[key] = value;
          },
          (label) => `${label} 내용`
        )
      );
      return;
    }

    const present = state.form.attendees.filter((a) => a.present);
    indiv.innerHTML = "";
    if (!present.length) {
      indiv.appendChild(el('<div class="empty-state">참석자를 먼저 선택하세요.</div>'));
      return;
    }
    present.forEach((a) => {
      const key = a.key || a.name;
      if (!state.form.perStudentNotes[key]) {
        state.form.perStudentNotes[key] = emptyNotes();
      }
      const row = el(`
        <div class="rec-note-item">
          <label class="rec-note-label">${esc(a.name)}</label>
        </div>
      `);
      row.appendChild(
        buildNoteFields(
          state.form.perStudentNotes[key],
          (field, value) => {
            state.form.perStudentNotes[key][field] = value;
          },
          (label) => `${a.name} · ${label}`
        )
      );
      indiv.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Settlements                                                         */
  /* ------------------------------------------------------------------ */

  /* Recomputes the 소속별 settlements from who is present, keeping whatever the
     host already entered (receipt time, uploaded file) for groups that survive. */
  function syncSettlements() {
    const previous = {};
    (state.form.settlements || []).forEach((s) => {
      previous[s.affiliation] = s;
    });

    const next = [];
    AFFILIATIONS.forEach(({ value }) => {
      const people = state.form.attendees.filter((a) => a.present && a.affiliation === value);
      if (!people.length) return;
      const rate = FEE_RATES[value] || 0;
      const old = previous[value] || {};
      next.push({
        affiliation: value,
        headcount: people.length,
        unitPrice: rate,
        amount: rate * people.length,
        receiptTime: old.receiptTime || "",
        receiptFile: old.receiptFile || null,
        receiptName: old.receiptName || "",
      });
    });

    // Staged uploads are keyed by index, which just shifted under them.
    const staged = {};
    Object.entries(state.pendingReceipts).forEach(([oldIndex, file]) => {
      const aff = (state.form.settlements || [])[oldIndex]?.affiliation;
      const newIndex = next.findIndex((s) => s.affiliation === aff);
      if (newIndex >= 0) staged[newIndex] = file;
    });
    state.pendingReceipts = staged;

    state.form.settlements = next;
    renderSettlements();
  }

  function renderSettlements() {
    const root = document.getElementById("rec-settlements");
    root.innerHTML = "";
    const list = state.form.settlements;

    if (!list.length) {
      root.appendChild(el('<div class="empty-state">참석자를 선택하면 정산 금액이 계산됩니다.</div>'));
      return;
    }

    list.forEach((s, i) => {
      const staged = state.pendingReceipts[i];
      const attached = staged ? staged.name : s.receiptName || (s.receiptFile ? "첨부됨" : "");
      const node = el(`
        <div class="rec-settlement">
          <div class="rec-settlement-head">
            <span class="rec-settlement-aff">${esc(AFF_LABEL[s.affiliation] || s.affiliation)}</span>
            <span class="rec-settlement-amount">${esc(won(s.amount))}</span>
          </div>
          <div class="rec-settlement-calc">${esc(won(s.unitPrice))} &times; ${s.headcount}명</div>
          <div class="rec-settlement-fields">
            <div class="field">
              <label>영수증 시각</label>
              <input class="input" type="time" data-time value="${esc(s.receiptTime || "")}" />
            </div>
            <div class="field">
              <label>영수증 첨부</label>
              <div class="rec-file-row">
                <button class="btn btn-ghost btn-sm" type="button" data-pick>파일 선택</button>
                <span class="rec-file-name" title="${esc(attached)}">${esc(attached) || "없음"}</span>
                ${
                  s.receiptFile && !staged
                    ? `<a class="btn btn-ghost btn-sm" href="/api/records/${encodeURIComponent(state.recordId)}/file/${encodeURIComponent(s.receiptFile)}" target="_blank" rel="noopener">보기</a>`
                    : ""
                }
              </div>
              <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden data-file />
            </div>
          </div>
        </div>
      `);

      node.querySelector("[data-time]").addEventListener("change", (e) => {
        list[i].receiptTime = e.target.value;
        // The receipt's timestamp is what the 신청서 uses as the end time.
        if (e.target.value) document.getElementById("rec-end").value = e.target.value;
      });

      const fileInput = node.querySelector("[data-file]");
      node.querySelector("[data-pick]").addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          showSnackbar("파일은 8MB 이하만 첨부할 수 있습니다.", "error");
          fileInput.value = "";
          return;
        }
        state.pendingReceipts[i] = file;
        renderSettlements();
      });

      root.appendChild(node);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Signature                                                           */
  /* ------------------------------------------------------------------ */

  const signature = { canvas: null, ctx: null, drawing: false, empty: true };

  // 서명 이미지 업로드 제한. 서버(record_routes)도 같은 상한을 적용합니다.
  const SIGNATURE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const MAX_SIGNATURE_BYTES = 8 * 1024 * 1024;

  function setupSignature() {
    const canvas = document.getElementById("rec-signature-canvas");
    signature.canvas = canvas;

    const draw = (e) => {
      if (!signature.drawing) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      signature.ctx.lineTo(x, y);
      signature.ctx.stroke();
      e.preventDefault();
    };

    canvas.addEventListener("pointerdown", (e) => {
      // Deliberately no resize here: resizing resets the backing store, which
      // wipes the pad. Sizing is handled on open and by the observer below.
      if (!signature.ctx) resizeSignatureCanvas();
      signature.drawing = true;
      signature.empty = false;
      state.signatureDirty = true;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      signature.ctx.beginPath();
      signature.ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
      document.getElementById("rec-signature-hint").textContent = "저장하면 신청서에 반영됩니다.";
    });
    canvas.addEventListener("pointermove", draw);
    ["pointerup", "pointercancel", "pointerleave"].forEach((type) =>
      canvas.addEventListener(type, () => {
        signature.drawing = false;
      })
    );

    document.getElementById("rec-signature-clear").addEventListener("click", clearSignature);

    /* 서명 이미지 파일 올리기. 손으로 긋는 것과 같은 결과(캔버스 위의 그림)를
       만들어 두면 저장 경로가 하나로 유지됩니다 - 저장할 때 캔버스를
       toDataURL()로 떠서 올리고, 서버는 다른 첨부와 똑같이 암호화합니다. */
    const fileInput = document.getElementById("rec-signature-file");
    document
      .getElementById("rec-signature-upload")
      .addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      fileInput.value = ""; // 같은 파일을 다시 골라도 change가 뜨도록
      if (file) drawSignatureFile(file);
    });

    /* The pad's width follows its column, which shifts whenever the dialog's
       scrollbar appears or disappears (switching notes mode, adding
       attendees). Re-fit then, keeping whatever has been drawn. */
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!signature.drawing) resizeSignatureCanvas(true);
      }).observe(canvas);
    }
  }

  /* The canvas backing store must match its CSS size or strokes land offset;
     the dialog is hidden (zero-size) until opened, so this runs on open. */
  function resizeSignatureCanvas(preserve) {
    const canvas = signature.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width === width && canvas.height === height) return;

    const snapshot = preserve && !signature.empty ? canvas.toDataURL("image/png") : null;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    signature.ctx = ctx;
    if (snapshot) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = snapshot;
    }
  }

  /* Wipes the pad without recording an intent to change the saved signature -
     used when opening a record, before its stored signature is painted in. */
  function resetSignaturePad() {
    resizeSignatureCanvas();
    if (signature.ctx) {
      const rect = signature.canvas.getBoundingClientRect();
      // CSS pixels, not backing-store pixels - the context is already scaled.
      signature.ctx.clearRect(0, 0, rect.width, rect.height);
    }
    signature.empty = true;
    document.getElementById("rec-signature-hint").textContent =
      "이 칸에 마우스나 손가락으로 서명하세요.";
  }

  /* The 지우기 button: same wipe, but this one is a deliberate edit, so the
     save has to push the removal to the server. */
  function clearSignature() {
    resetSignaturePad();
    state.signatureDirty = state.hasSignature || state.signatureDirty;
  }

  /* 고른 이미지를 서명 칸에 맞춰 그립니다. 비율을 유지하고 가운데 놓아
     찌그러지지 않게 합니다. */
  function drawSignatureFile(file) {
    if (!SIGNATURE_TYPES.has(file.type)) {
      showSnackbar("PNG · JPG · WEBP 이미지만 올릴 수 있습니다.", "error");
      return;
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      showSnackbar("서명 이미지는 8MB 이하만 올릴 수 있습니다.", "error");
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resizeSignatureCanvas();
      const rect = signature.canvas.getBoundingClientRect();
      signature.ctx.clearRect(0, 0, rect.width, rect.height);
      const scale = Math.min(rect.width / img.width, rect.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      signature.ctx.drawImage(img, (rect.width - w) / 2, (rect.height - h) / 2, w, h);
      signature.empty = false;
      state.signatureDirty = true;
      document.getElementById("rec-signature-hint").textContent =
        `${file.name} — 저장하면 신청서에 반영됩니다.`;
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showSnackbar("이미지를 읽지 못했습니다.", "error");
    };
    img.src = url;
  }

  async function loadExistingSignature() {
    if (!state.hasSignature || !state.recordId) return;
    const url = `/api/records/${encodeURIComponent(state.recordId)}/file/signature.png`;
    const forRecord = state.recordId;
    const img = new Image();
    img.onload = () => {
      // The fetch is async, so by now the host may have started signing, or
      // moved on to another record. Either way, don't paint over them - and
      // don't resize here, which would reset the backing store and wipe it.
      if (state.recordId !== forRecord || state.signatureDirty || !signature.ctx) return;
      const rect = signature.canvas.getBoundingClientRect();
      signature.ctx.drawImage(img, 0, 0, rect.width, rect.height);
      signature.empty = false;
      document.getElementById("rec-signature-hint").textContent = "저장된 서명입니다. 다시 그리면 교체됩니다.";
    };
    img.src = url;
  }

  /* ------------------------------------------------------------------ */
  /* Form                                                                */
  /* ------------------------------------------------------------------ */

  async function openForm(eventId, meetingStart) {
    let data;
    try {
      data = await api.get(
        `/api/records/draft?eventId=${encodeURIComponent(eventId)}&meetingStart=${encodeURIComponent(meetingStart)}`
      );
    } catch (e) {
      showSnackbar(e.message, "error");
      return;
    }

    // A draft carries only the UTC instants; the 일자/시각 fields are filled in
    // here so they read in the host's own timezone. A saved record keeps the
    // strings the host actually confirmed.
    const startedAt = localParts(data.meetingStart || meetingStart);

    state.form = {
      eventId: data.eventId || eventId,
      meetingStart: data.meetingStart || meetingStart,
      eventName: data.eventName || "",
      date: data.date || startedAt.date,
      // 시각과 장소는 일정에서 끌어오지 않고 비워 둡니다. 신청서에 적을 것은
      // **실제로 면담한 시각**과 영수증 시각인데, 잡아 둔 시각이 미리 들어가
      // 있으면 그대로 두고 넘어가기 쉽습니다. 일정 시각은 창 제목에 그대로
      // 보이므로 참고할 것이 없어지지는 않습니다.
      startTime: data.startTime || "",
      endTime: data.endTime || "",
      place: data.place || "",
      professorName: data.professorName || CFG.professorName || "",
      attendees: (data.attendees || []).map((a) => ({ ...a })),
      notesMode: data.notesMode || "shared",
      sharedNotes: asNotes(data.sharedNotes ?? data.sharedNote),
      perStudentNotes: Object.fromEntries(
        Object.entries(data.perStudentNotes || {}).map(([k, v]) => [k, asNotes(v)])
      ),
      settlements: (data.settlements || []).map((s) => ({ ...s })),
    };
    state.recordId = data._id || null;
    state.pendingReceipts = {};
    state.signatureDirty = false;
    state.hasSignature = !!data.hasSignature;

    document.getElementById("rec-form-title").textContent =
      `${data.eventName || "면담 기록"} · ${fmtMeeting(state.form.meetingStart)}`;
    document.getElementById("rec-date").value = state.form.date;
    document.getElementById("rec-start").value = state.form.startTime;
    document.getElementById("rec-end").value = state.form.endTime;
    document.getElementById("rec-place").value = state.form.place;
    document.getElementById("rec-professor").value = state.form.professorName;
    document.getElementById("rec-delete").hidden = !state.recordId;
    document.getElementById("rec-print").hidden = !state.recordId;

    renderAttendees();
    renderNotes();
    if (!state.form.settlements.length) syncSettlements();
    else renderSettlements();

    savedSnapshot = formSnapshot();
    openDialog("rec-form-dialog");
    // Sizing needs the dialog to be laid out, which only happens once open.
    requestAnimationFrame(() => {
      resizeSignatureCanvas();
      resetSignaturePad();
      loadExistingSignature();
    });
  }

  /* 마지막으로 저장(또는 불러온) 시점의 폼 내용. 지금과 다르면 저장하지 않은
     변경이 있다는 뜻입니다. */
  let savedSnapshot = null;

  function formSnapshot() {
    // collectForm()은 화면의 값을 state로 끌어올릴 뿐이라 불러도 안전합니다.
    return JSON.stringify(collectForm());
  }

  /* 서명과 영수증은 폼 값이 아니라 따로 올라가므로 함께 봅니다 - 서명만
     새로 그리고 신청서를 열면 빈 서명란이 인쇄됩니다. */
  function hasUnsavedChanges() {
    if (savedSnapshot === null) return false;
    if (formSnapshot() !== savedSnapshot) return true;
    if (state.signatureDirty) return true;
    return Object.keys(state.pendingReceipts || {}).length > 0;
  }

  function collectForm() {
    const form = state.form;
    form.date = document.getElementById("rec-date").value;
    form.startTime = document.getElementById("rec-start").value;
    form.endTime = document.getElementById("rec-end").value;
    form.place = document.getElementById("rec-place").value.trim();
    form.professorName = document.getElementById("rec-professor").value.trim();
    // 면담 내용은 입력할 때마다 state에 바로 들어갑니다 (buildNoteFields).
    return form;
  }

  async function saveForm() {
    const btn = document.getElementById("rec-save");
    const form = collectForm();
    btn.disabled = true;
    try {
      const { id } = await api.post("/api/records", { ...form, status: "saved" });
      state.recordId = id;

      if (state.signatureDirty) {
        // An empty pad clears the stored signature instead of saving a blank.
        await api.put(`/api/records/${id}/signature`, {
          dataUrl: signature.empty ? "" : signature.canvas.toDataURL("image/png"),
        });
        state.hasSignature = !signature.empty;
        state.signatureDirty = false;
      }

      for (const [index, file] of Object.entries(state.pendingReceipts)) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(`/api/records/${id}/receipt/${index}`, {
          method: "PUT",
          body,
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error("영수증 업로드에 실패했습니다.");
      }
      state.pendingReceipts = {};

      document.getElementById("rec-delete").hidden = false;
      document.getElementById("rec-print").hidden = false;
      showSnackbar("면담 기록을 저장했습니다.", "success");
      if (onSaved) await onSaved();
      // Re-read so uploaded receipts come back with their stored filenames.
      await refreshOpenForm();
      savedSnapshot = formSnapshot();
      return true;
    } catch (e) {
      showSnackbar(e.message, "error");
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshOpenForm() {
    if (!state.recordId) return;
    const data = await api.get(`/api/records/${state.recordId}`);
    state.form.settlements = (data.settlements || []).map((s) => ({ ...s }));
    state.hasSignature = !!data.hasSignature;
    renderSettlements();
  }

  async function deleteRecord() {
    if (!state.recordId) {
      // 아직 저장 전이라 지울 것이 없습니다. 조용히 아무 일도 안 일어나면
      // 버튼이 고장 난 것처럼 보입니다.
      showSnackbar("아직 저장하지 않아 삭제할 기록이 없습니다.", "error");
      return;
    }
    if (!confirm("이 면담 기록과 첨부한 영수증·서명을 모두 삭제할까요?")) return;
    try {
      await api.del(`/api/records/${state.recordId}`);
      closeDialog("rec-form-dialog");
      showSnackbar("면담 기록을 삭제했습니다.", "success");
      if (onSaved) await onSaved();
    } catch (e) {
      showSnackbar(e.message, "error");
    }
  }


  /* ------------------------------------------------------------------ */

  function init() {
    setupSignature();

    document.getElementById("rec-add-attendee").addEventListener("click", () => {
      state.form.attendees.push({
        key: "",
        name: "",
        email: "",
        studentId: "",
        affiliation: "cse",
        present: true,
      });
      renderAttendees();
      syncSettlements();
      renderNotes();
    });

    document.querySelectorAll("#rec-notes-mode button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.form.notesMode = btn.dataset.mode;
        renderNotes();
      });
    });

    document.getElementById("rec-save").addEventListener("click", saveForm);
    document.getElementById("rec-delete").addEventListener("click", deleteRecord);
    document.getElementById("rec-print").addEventListener("click", async () => {
      // 신청서는 **저장된** 기록을 서버가 그려 주는 화면이라, 아직 저장하지
      // 않았으면 열 수 없습니다. 그대로 열면 "페이지를 찾을 수 없습니다"가
      // 뜨고 무엇이 잘못됐는지 알 수 없습니다.
      if (!state.recordId) {
        showSnackbar("먼저 저장한 뒤에 신청서를 열 수 있습니다.", "error");
        return;
      }
      // 신청서는 **저장된** 내용을 서버가 그립니다. 고치는 중에 그냥 열면
      // 방금 적은 것이 빠진 서류가 나오는데, 새 탭이라 눈치채기도 어렵습니다.
      if (hasUnsavedChanges()) {
        if (!confirm("저장하지 않은 변경이 있습니다.\n저장한 뒤 신청서를 열까요?")) return;
        if (!(await saveForm())) return; // 저장이 실패하면 열지 않습니다
      }
      window.open(`/records/${state.recordId}/print`, "_blank", "noopener");
    });
  }

  /** 한 면담의 기록 폼을 엽니다. `changed`는 저장/삭제 후 불립니다. */
  async function open(eventId, meetingStart, changed) {
    onSaved = changed || null;
    await openForm(eventId, meetingStart);
  }

  return { init, open };
})();
