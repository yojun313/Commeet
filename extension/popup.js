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

// 지도면담입력 화면을 아직 못 봐서(교수 계정 필요) 진짜 경로를 모릅니다.
// 그래서 동작 확인용으로 미래설계 화면의 30·40·50·60대 칸을 빌려 씁니다.
// 교수 화면에서 "필드 스캔"을 돌려 나온 경로로 여기를 바꾸면 그대로 씁니다.
const DEMO_FIELD_MAP = {
  academic: "/GS_GOAL/ZAGE_30",
  life: "/GS_GOAL/ZAGE_40",
  career: "/GS_GOAL/ZAGE_50",
  etc: "/GS_GOAL/ZAGE_60",
};

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
  view("studentsView", false); view("povisView", false);
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
      view("recordsView", false); view("studentsView", false); view("povisView", false);
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
  view("recordsView", false); view("studentsView", false); view("povisView", false);
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
      view("studentsView", false); view("povisView", false);
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
    view("studentsView", true); view("povisView", false);
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
  view("studentsView", true);
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
  for (const [key, path] of Object.entries(DEMO_FIELD_MAP)) {
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
  $("mappingHint").textContent =
    `임시 매핑 (교수 화면 미확인): ${NOTE_CATEGORIES.map(([k, l]) => `${l}→${DEMO_FIELD_MAP[k]}`).join(", ")}`;
  try {
    await showLoggedIn(await Commeet.profile());
  } catch (err) {
    await showLoggedOut(err.status === 401 ? null : err.message);
  }
})();
