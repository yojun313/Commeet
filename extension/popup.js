// 팝업 UI. Commeet에서 면담 기록을 불러와(commeet.js) POVIS 화면에 채웁니다(povis.js).

const POVIS_HOST = "povis.postech.ac.kr";

// Commeet 면담 내용의 네 갈래. 순서와 라벨은 서버의
// record_service.NOTE_CATEGORIES와 같습니다.
const NOTE_CATEGORIES = [
  ["academic", "학업지도"],
  ["life", "생활지도"],
  ["career", "진로지도"],
  ["etc", "기타사항"],
];

// 지도면담입력 → 면담결과입력 화면의 바인딩 경로 (2026-09-09 교수 계정 실측).
// 화면 왼쪽부터 학업지도·생활지도·진로지도·기타사항 순서입니다.
const FIELD_MAP = {
  academic: "/GS_DT_LIST/ZITV_01_S",
  life: "/GS_DT_LIST/ZITV_02_S",
  career: "/GS_DT_LIST/ZITV_03_S",
  etc: "/GS_DT_LIST/ZITV_04_S",
};
const DATE_PATH = "/GS_DT_LIST/ZCON_DATE"; // 면담일, "YYYYMMDD"

const $ = (id) => document.getElementById(id);
const out = $("out");
const state = { records: [], record: null, attendee: null };

function show(value, isError = false) {
  out.hidden = false;
  out.classList.toggle("error", isError);
  out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function clearOut() { out.hidden = true; out.textContent = ""; }
function view(id, on) { $(id).hidden = !on; }

// ---------------------------------------------------------------------------
// 기록에서 값 꺼내기
// ---------------------------------------------------------------------------

/** 한 참석자에게 적용되는 면담 내용.
 *
 *  notesMode가 무엇을 쓸지 결정합니다 - "individual"이면 학생별 노트,
 *  아니면 공통 노트. 그리고 perStudentNotes의 키는 학번이 아니라 참석자
 *  key이고, 화면 코드(record-form.js)가 이름으로도 폴백하므로 여기서도
 *  같은 순서로 찾습니다. 규칙이 어긋나면 엉뚱한 학생의 기록을 넣게 됩니다. */
function notesFor(record, attendee) {
  const empty = { academic: "", life: "", career: "", etc: "" };
  if (record.notesMode !== "individual") return record.sharedNotes || empty;
  const per = record.perStudentNotes || {};
  return per[attendee.key] || per[attendee.name] || empty;
}

/** 기록의 면담일을 POVIS 형식("YYYYMMDD")으로. 폼의 일자(YYYY-MM-DD)를
 *  우선하고, 없으면 확정 일정(UTC 순간)을 이 브라우저의 시간대로 풀어 씁니다 -
 *  Commeet 화면이 일자를 만드는 방식과 같습니다(record-form.js). */
function povisDate(record) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(record.date || "")) return record.date.replace(/-/g, "");
  if (!record.meetingStart) return "";
  const d = new Date(record.meetingStart);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function recordLabel(r) {
  const when = r.date || (r.meetingStart || "").slice(0, 10);
  const time = [r.startTime, r.endTime].filter(Boolean).join("~");
  const bits = [when, time, r.place].filter(Boolean).join(" · ");
  const flags = [];
  if (r.status === "draft") flags.push("작성 중");
  if (r.undecryptable) flags.push("복호화 실패");
  return bits + (flags.length ? ` [${flags.join(", ")}]` : "");
}

function renderNotes() {
  const box = $("notes");
  box.innerHTML = "";
  if (!state.record || !state.attendee) return;
  const notes = notesFor(state.record, state.attendee);
  for (const [key, label] of NOTE_CATEGORIES) {
    const text = (notes[key] || "").trim();
    const el = document.createElement("div");
    el.className = "note";
    el.innerHTML = `<b>${label}</b>`;
    const p = document.createElement("p");
    if (text) p.textContent = text;
    else { p.textContent = "(비어 있음)"; p.className = "empty"; }
    el.appendChild(p);
    box.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// 화면 전환
// ---------------------------------------------------------------------------

async function showLoggedOut(message) {
  view("account", false); view("eventsView", false); view("recordsView", false);
  view("studentsView", false); view("povisView", false); view("batchView", false);
  view("loginView", true);
  $("baseUrl").value = await Commeet.baseUrl();
  if (message) show(message, true);
}

async function showLoggedIn(profile) {
  view("loginView", false);
  view("account", true);
  $("who").textContent = `${profile.name || profile.email} 님으로 로그인됨`;
  view("eventsView", true);
  await loadEvents();
}

// ---------------------------------------------------------------------------
// 데이터 로딩
// ---------------------------------------------------------------------------

async function loadEvents() {
  const sel = $("events");
  sel.innerHTML = `<option>불러오는 중…</option>`;
  try {
    // 기록 수는 따로, 그리고 함께 받습니다. 실패해도 목록 자체는 떠야 하므로
    // 개수 쪽만 조용히 비웁니다 - 배지가 없는 것이 목록이 없는 것보다 낫습니다.
    const [events, counts] = await Promise.all([
      Commeet.myEvents(),
      Commeet.recordCounts().catch(() => ({})),
    ]);
    sel.innerHTML = "";
    if (!events.length) {
      sel.innerHTML = `<option value="">내가 만든 일정이 없습니다</option>`;
      view("recordsView", false); view("studentsView", false); view("povisView", false); view("batchView", false);
      return;
    }

    // 기록이 있는 일정을 위로 올립니다. 옮겨 적을 것이 있는 일정이 목적이라,
    // 그것부터 보이는 편이 매번 훑는 것보다 빠릅니다.
    const withCount = events.map((e) => ({ event: e, count: counts[e._id] || null }));
    withCount.sort((a, b) => (b.count?.total || 0) - (a.count?.total || 0));

    for (const { event, count } of withCount) {
      const opt = document.createElement("option");
      opt.value = event._id;
      const name = event.name || "(이름 없는 일정)";
      if (!count) {
        opt.textContent = `${name} · 기록 없음`;
      } else {
        const draft = count.draft ? `, 초안 ${count.draft}` : "";
        opt.textContent = `📝 ${name} · 기록 ${count.total}건${draft}`;
      }
      sel.appendChild(opt);
    }
    onEventChanged();
  } catch (err) {
    sel.innerHTML = `<option value="">불러오지 못했습니다</option>`;
    await handleError(err);
  }
}

/** 일정을 바꾸면 아래 단계는 지웁니다 - 이전 일정의 기록이 남아 있으면
 *  다른 일정의 내용을 옮겨 적게 됩니다. */
function onEventChanged() {
  state.records = []; state.record = null; state.attendee = null;
  view("recordsView", false); view("studentsView", false); view("povisView", false); view("batchView", false);
}

async function loadRecords() {
  const eventId = $("events").value;
  if (!eventId) return;
  clearOut();
  view("recordsView", true);
  const sel = $("records");
  sel.innerHTML = `<option>불러오는 중…</option>`;
  try {
    // 면담 기록이 실제로 있는 것만 씁니다. 초안(draft)도 남겨 두되
    // 목록에 그렇게 표시해, 작성 중인 내용을 모르고 옮기지 않도록 합니다.
    state.records = await Commeet.recordsFor(eventId);
    sel.innerHTML = "";
    if (!state.records.length) {
      sel.innerHTML = `<option value="">이 일정에는 면담 기록이 없습니다</option>`;
      $("recordMeta").textContent = "";
      view("studentsView", false); view("povisView", false); view("batchView", false);
      return;
    }
    state.records.forEach((r, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = recordLabel(r);
      sel.appendChild(opt);
    });
    selectRecord(0);
  } catch (err) {
    sel.innerHTML = `<option value="">불러오지 못했습니다</option>`;
    await handleError(err);
  }
}

function selectRecord(index) {
  const r = state.records[index];
  state.record = r;
  if (!r) return;

  $("recordMeta").innerHTML =
    `${r.eventName || ""} · 내용 방식: <b>${r.notesMode === "individual" ? "학생별" : "공통"}</b>` +
    (r.undecryptable ? ` <span class="badge">복호화 실패 - 내용을 읽을 수 없습니다</span>` : "");

  // 불참자는 제외합니다 - 참석하지 않은 학생의 면담 기록을 옮길 이유가 없습니다.
  const attendees = (r.attendees || []).filter((a) => a.present !== false);
  const sel = $("students");
  sel.innerHTML = "";
  if (!attendees.length) {
    sel.innerHTML = `<option value="">참석한 학생이 없습니다</option>`;
    view("studentsView", true); view("povisView", false); view("batchView", false);
    $("notes").innerHTML = "";
    return;
  }
  attendees.forEach((a, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${a.name || "(이름 없음)"}${a.studentId ? ` (${a.studentId})` : ""}`;
    sel.appendChild(opt);
  });
  state.attendeeList = attendees;
  state.attendee = attendees[0];
  renderNotes();
  renderPlan();
  view("studentsView", true);
  view("batchView", true);
  view("povisView", true);
}

// ---------------------------------------------------------------------------
// POVIS 쪽
// ---------------------------------------------------------------------------

async function runInPage(func, args = []) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !tab.url.includes(POVIS_HOST)) {
    return { error: `POVIS 탭에서 실행해 주세요. (현재: ${tab?.url || "알 수 없음"})` };
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // 격리된 world에서는 window.sap이 보이지 않으므로 페이지 컨텍스트로 들어갑니다.
      world: "MAIN",
      func,
      args,
    });
    return result.result;
  } catch (err) {
    return { error: String(err) };
  }
}

async function fillPovis() {
  if (!state.record || !state.attendee) return show("먼저 학생을 선택해 주세요.", true);
  const notes = notesFor(state.record, state.attendee);
  const mapping = {};
  for (const [key, path] of Object.entries(FIELD_MAP)) {
    const text = (notes[key] || "").trim();
    if (text) mapping[path] = text; // 빈 항목으로 기존 값을 덮지 않습니다
  }
  if (!Object.keys(mapping).length) {
    return show("이 학생의 면담 내용이 비어 있어 채울 것이 없습니다.", true);
  }
  show("채우는 중…");
  show(await runInPage(pageFill, [mapping]));
}

// ---------------------------------------------------------------------------
// 일괄 입력 (background.js가 실행, 여기서는 계획을 만들고 진행을 보여 줍니다)
// ---------------------------------------------------------------------------

/** 선택한 기록의 참석 학생 전원에 대한 작업 목록. 학번이 없거나 내용이 빈
 *  학생은 계획에 넣되 `skip` 사유를 달아, 왜 빠지는지 팝업에서 보이게 합니다. */
function buildPlan() {
  const r = state.record;
  if (!r) return [];
  const date = povisDate(r);
  return (r.attendees || [])
    .filter((a) => a.present !== false)
    .map((a) => {
      const notes = notesFor(r, a);
      const hasNotes = NOTE_CATEGORIES.some(([k]) => (notes[k] || "").trim());
      let skip = null;
      if (!a.studentId) skip = "학번 없음";
      else if (!hasNotes) skip = "내용 없음";
      return { studentId: a.studentId || "", name: a.name || "", date, notes, skip, eventName: r.eventName || "면담" };
    });
}

function renderPlan() {
  const ul = $("plan");
  ul.innerHTML = "";
  const plan = buildPlan();
  const date = povisDate(state.record || {});
  for (const item of plan) {
    const li = document.createElement("li");
    if (item.skip) li.className = "skip";
    const left = document.createElement("span");
    left.textContent = `${item.name}${item.studentId ? ` (${item.studentId})` : ""}`;
    const right = document.createElement("span");
    right.textContent = item.skip || "입력 예정";
    li.append(left, right);
    ul.appendChild(li);
  }
  const ready = plan.filter((i) => !i.skip).length;
  $("startBatch").disabled = !ready || !date;
  $("startBatch").textContent = date
    ? `${ready}명 자동 입력 (면담일 ${date.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3")})`
    : "면담일을 알 수 없어 실행할 수 없습니다";
}

async function findPovisTab() {
  const tabs = await chrome.tabs.query({ url: `https://${POVIS_HOST}/*` });
  if (!tabs.length) return null;
  // 여러 개면 활성 탭을 우선합니다.
  return tabs.find((t) => t.active) || tabs[0];
}

async function startBatch() {
  const plan = buildPlan().filter((i) => !i.skip);
  if (!plan.length) return show("입력할 학생이 없습니다.", true);
  const tab = await findPovisTab();
  if (!tab) return show("POVIS 탭을 찾지 못했습니다. 지도면담입력 화면을 열어 두세요.", true);
  clearOut();
  const options = {
    allowDuplicate: $("allowDuplicate").checked,
    screenshot: $("screenshot").checked,
    screenshotFolder: $("screenshotFolder").value.trim(),
  };
  await chrome.storage.local.set({ screenshot: options.screenshot, screenshotFolder: options.screenshotFolder });
  $("startBatch").disabled = true;
  // 응답은 작업이 다 끝나야 오므로 기다리지 않습니다. 진행은 storage로 받습니다.
  chrome.runtime.sendMessage({ type: "batch:start", tabId: tab.id, plan, options }, (res) => {
    if (chrome.runtime.lastError) return; // 팝업이 닫혔다 열리면 여기로 옵니다 - 무시
    if (res?.error) { show(res.error, true); $("startBatch").disabled = false; }
  });
}

function statusClass(status) {
  if (status === "저장됨") return "st-ok";
  if (status === "실패" || status === "목록에 없음") return "st-bad";
  return "st-warn";
}

function renderProgress(batch) {
  const box = $("progress");
  if (!batch) { box.hidden = true; $("stopBatch").hidden = true; return; }
  box.hidden = false;
  $("stopBatch").hidden = !batch.running;
  $("startBatch").disabled = batch.running;

  const pct = batch.total ? Math.round((batch.done / batch.total) * 100) : 0;
  const head = batch.running
    ? `진행 중 ${batch.done}/${batch.total}${batch.current ? ` — ${batch.current.name} (${batch.current.studentId})` : ""}`
    : `${batch.stopped ? "중단됨" : "완료"} ${batch.done}/${batch.total}`;
  const counts = {};
  for (const r of batch.results) counts[r.status] = (counts[r.status] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ");

  box.innerHTML = "";
  const h = document.createElement("div"); h.textContent = head; box.appendChild(h);
  const bar = document.createElement("div"); bar.className = "bar";
  const fill = document.createElement("i"); fill.style.width = `${pct}%`; bar.appendChild(fill); box.appendChild(bar);
  if (summary) { const s = document.createElement("div"); s.textContent = summary; box.appendChild(s); }
  if (batch.error) { const e = document.createElement("div"); e.className = "st-bad"; e.textContent = batch.error; box.appendChild(e); }

  const table = document.createElement("table");
  for (const r of batch.results) {
    const tr = document.createElement("tr");
    const name = document.createElement("td"); name.textContent = `${r.name} (${r.studentId})`;
    const st = document.createElement("td"); st.className = `st ${statusClass(r.status)}`; st.textContent = r.status;
    const detail = document.createElement("td"); detail.textContent = r.detail || "";
    tr.append(name, st, detail);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

async function loadProgress() {
  const { batch } = await chrome.storage.session.get("batch");
  renderProgress(batch || null);
  // 스크린샷 설정은 지난번 값을 그대로 씁니다 - 매번 폴더를 다시 적지 않도록.
  const { screenshot, screenshotFolder } = await chrome.storage.local.get(["screenshot", "screenshotFolder"]);
  if (screenshot !== undefined) $("screenshot").checked = !!screenshot;
  if (screenshotFolder) $("screenshotFolder").value = screenshotFolder;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.batch) renderProgress(changes.batch.newValue || null);
});

$("startBatch").addEventListener("click", startBatch);
$("stopBatch").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "batch:stop" }, () => { void chrome.runtime.lastError; });
  $("stopBatch").disabled = true;
});

// ---------------------------------------------------------------------------
// 에러 / 이벤트 배선
// ---------------------------------------------------------------------------

async function handleError(err) {
  if (err instanceof Commeet.Error && err.status === 401) {
    await showLoggedOut("세션이 만료되었습니다. 다시 로그인해 주세요.");
  } else {
    show(err.message || String(err), true);
  }
}

$("settingsToggle").addEventListener("click", async () => {
  const s = $("settings");
  s.hidden = !s.hidden;
  if (!s.hidden) $("baseUrl").value = await Commeet.baseUrl();
});

$("saveBaseUrl").addEventListener("click", async () => {
  await Commeet.setBaseUrl($("baseUrl").value);
  $("settings").hidden = true;
  show(`서버 주소를 ${await Commeet.baseUrl()} 로 저장했습니다.`);
});

$("login").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) return show("이메일과 비밀번호를 입력해 주세요.", true);
  clearOut();
  $("login").disabled = true;
  try {
    await Commeet.login(email, password);
    $("password").value = ""; // 비밀번호는 남기지 않습니다
    await showLoggedIn(await Commeet.profile());
  } catch (err) {
    const message = err.message || String(err);
    show(message, true);
    // 서버가 어느 쪽이 틀렸는지 알려 주므로, 고칠 칸으로 커서를 옮깁니다.
    if (message.includes("비밀번호")) { $("password").select(); }
    else if (message.includes("아이디") || message.includes("이메일")) { $("email").select(); }
  } finally {
    $("login").disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  try { await Commeet.logout(); } catch { /* 어차피 로그아웃 화면으로 갑니다 */ }
  await showLoggedOut("로그아웃했습니다.");
});

$("events").addEventListener("change", onEventChanged);
$("loadRecords").addEventListener("click", loadRecords);
$("records").addEventListener("change", (e) => selectRecord(Number(e.target.value)));
$("students").addEventListener("change", (e) => {
  state.attendee = state.attendeeList?.[Number(e.target.value)];
  renderNotes();
});

$("fill").addEventListener("click", fillPovis);
$("restore").addEventListener("click", async () => show(await runInPage(pageRestore)));
$("scan").addEventListener("click", async () => {
  show("스캔 중…");
  show(await runInPage(pageScan));
});

for (const id of ["email", "password"]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") $("login").click(); });
}

// 시작: 이미 로그인돼 있으면 바로 일정 목록으로.
(async () => {
  await loadProgress();
  try {
    await showLoggedIn(await Commeet.profile());
  } catch (err) {
    await showLoggedOut(err.status === 401 ? null : err.message);
  }
})();
