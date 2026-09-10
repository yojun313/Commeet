// 일괄 입력 러너 (서비스 워커).
//
// 팝업에서 돌리지 않는 이유: 팝업은 사용자가 다른 곳을 클릭하는 순간 닫히고,
// 닫히면 그 안의 JS도 함께 죽습니다. 학생 수십 명을 한 명씩 서버 왕복하며
// 처리하는 작업이 그렇게 끊기면 "몇 번째까지 저장됐는지"를 알 수 없게 됩니다.
// 그래서 작업은 여기서 돌리고, 진행 상황은 chrome.storage.session에 적어
// 팝업이 언제 다시 열려도 이어서 보여 줍니다.
//
// POVIS 화면 조작 자체는 povis.js의 povisStep 한 함수로, 단계마다
// chrome.scripting.executeScript(MAIN world)로 들여보냅니다.

importScripts("povis.js");

const STORAGE_KEY = "batch";
let current = null; // { stop: boolean }

async function step(tabId, name, arg = null) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: povisStep,
      args: [name, arg],
    });
    return r?.result || { error: `'${name}' 단계가 결과를 돌려주지 않았습니다.` };
  } catch (err) {
    return { error: `'${name}' 단계 실행 실패: ${String(err?.message || err)}` };
  }
}

async function publish(state) {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
}

/** 한 학생의 결과 한 줄. status는 팝업이 그대로 보여 줍니다. */
function outcome(item, status, detail, extra = {}) {
  return { studentId: item.studentId, name: item.name, status, detail: detail || "", ...extra };
}

function dialogText(dialogs, toasts) {
  const parts = (dialogs || []).map((d) => [d.title, d.text].filter(Boolean).join(": "));
  return [...parts, ...(toasts || [])].filter(Boolean).join(" / ");
}

/** 파일명에 못 쓰는 글자를 치우고 길이를 줄입니다. 폴더 구분자도 여기서 걸러,
 *  회의 이름에 "/"가 있어도 엉뚱한 하위 폴더가 생기지 않습니다. */
function safeName(text, max = 60) {
  return String(text || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, max) || "_";
}

/** 채운 입력 화면을 PNG로 저장합니다: {폴더}/{회의}_{면담일}_{이름}.png
 *  captureVisibleTab은 그 창에서 보이는 탭만 찍으므로, 다른 탭이 앞에 있으면
 *  POVIS 탭을 앞으로 가져옵니다. downloads API는 다운로드 폴더 아래로만 저장할
 *  수 있어서 "폴더"는 다운로드 폴더 기준 하위 경로입니다. */
async function screenshot(tabId, item, options) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 400));
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const folder = (options.screenshotFolder || "").split(/[\\/]+/).map((s) => safeName(s, 40)).filter((s) => s && s !== "_").join("/");
  const file = `${safeName(item.eventName)}_${item.date}_${safeName(item.name, 20)}.png`;
  const filename = folder ? `${folder}/${file}` : file;
  const id = await chrome.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify", saveAs: false });
  return { id, filename };
}

/** plan: [{studentId, name, date(YYYYMMDD), notes:{academic,life,career,etc}}]
 *  options: { allowDuplicate: 같은 날짜 면담이 있어도 입력 } */
async function runBatch(tabId, plan, options) {
  if (current) return { error: "이미 실행 중인 작업이 있습니다." };
  current = { stop: false };
  const state = {
    running: true, startedAt: Date.now(), finishedAt: null, tabId,
    total: plan.length, done: 0, stopped: false, error: null,
    results: [],
  };
  await publish(state);

  try {
    const status = await step(tabId, "status");
    if (status.error) throw new Error(status.error);
    if (!status.students) throw new Error("POVIS 지도면담입력 목록에 학생이 없습니다. 검색 조건을 확인해 주세요.");

    for (const item of plan) {
      if (current.stop) { state.stopped = true; break; }
      state.current = item;
      await publish(state);

      const result = await processOne(tabId, item, options);
      state.results.push(result);
      state.done += 1;
      await publish(state);
    }
  } catch (err) {
    state.error = String(err?.message || err);
  } finally {
    // 어떤 이유로 끝났든 입력 화면을 열어 둔 채 나오지 않습니다.
    await step(tabId, "back").catch(() => {});
    state.running = false;
    state.current = null;
    state.finishedAt = Date.now();
    await publish(state);
    current = null;
  }
  return { ok: true };
}

async function processOne(tabId, item, options) {
  const notes = item.notes || {};
  if (!Object.values(notes).some((v) => (v || "").trim())) {
    return outcome(item, "건너뜀", "면담 내용이 비어 있음");
  }

  const sel = await step(tabId, "select", { studentId: item.studentId, date: item.date });
  if (sel.error) return outcome(item, sel.notFound ? "목록에 없음" : "실패", sel.error);
  if (sel.duplicate && !options.allowDuplicate) {
    return outcome(item, "건너뜀", `POVIS에 같은 날짜(${item.date}) 면담이 이미 있음`);
  }

  const opened = await step(tabId, "open");
  if (opened.error) return outcome(item, "실패", [opened.error, dialogText(opened.dialogs)].filter(Boolean).join(" · "));

  const filled = await step(tabId, "fill", { date: item.date, notes });
  if (filled.error || !filled.ok) {
    await step(tabId, "back");
    const bad = (filled.report || []).filter((r) => r.status !== "OK").map((r) => `${r.path.split("/").pop()}: ${r.status}`).join(", ");
    return outcome(item, "실패", filled.error || `채우기 검증 실패 (${bad})`);
  }

  // 저장 전에 찍습니다 - 저장되면 POVIS가 바로 목록으로 돌아가 화면이 사라집니다.
  let shot = "";
  if (options.screenshot) {
    try {
      const { filename } = await screenshot(tabId, item, options);
      shot = `스크린샷 ${filename}`;
    } catch (err) {
      shot = `스크린샷 실패: ${String(err?.message || err)}`;
    }
  }
  const detail = (...parts) => parts.filter(Boolean).join(" · ");

  const saved = await step(tabId, "save");
  const back = await step(tabId, "back");
  const msgs = dialogText([...(saved.dialogs || []), ...(back.dialogs || [])], saved.toasts);
  if (saved.error) return outcome(item, "실패", detail(saved.error, msgs, shot));
  if (saved.saved) return outcome(item, "저장됨", detail(msgs, shot), { historyAfter: saved.historyAfter });
  // 값이 서버에 안 실리면 "면담결과를 입력하세요" 토스트가 뜹니다 - 그 문구를 그대로 보여 줍니다.
  return outcome(item, "실패", detail("저장되지 않음", msgs, shot));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "batch:start") {
    runBatch(msg.tabId, msg.plan, msg.options || {}).then(sendResponse);
    return true;
  }
  if (msg?.type === "batch:stop") {
    if (current) current.stop = true;
    sendResponse({ ok: true, running: !!current });
    return false;
  }
  return false;
});
