// POVIS는 SAPUI5 앱입니다. 값을 넣는 방법이 하나로 정해집니다:
//
//   DOM에 직접 쓰면 (field.value = ... + input/change 이벤트) 화면에는
//   보이지만 UI5 모델은 갱신되지 않습니다. 그 상태로 저장하면 **옛 값이**
//   전송됩니다 - 에러도 안 나고 화면도 멀쩡해서 늦게 발견되는 종류입니다.
//   그래서 반드시 모델에 씁니다: control.getModel().setProperty(path, value)
//
// 그리고 UI5가 붙여 주는 DOM id(__area57-inner)는 로드마다 바뀌므로 필드는
// **바인딩 경로**(/GS_GOAL/ZGOAL)로 찾습니다. 이건 백엔드 필드명이라 안정적입니다.
//
// 아래 page* 함수들은 chrome.scripting이 문자열로 직렬화해 페이지의 MAIN
// world에서 실행합니다 - 콘텐츠 스크립트의 격리된 world에서는 window.sap이
// 보이지 않기 때문입니다. 그래서 클로저를 쓰지 못하고 전부 자기완결적입니다.

const POVIS_HOST = "povis.postech.ac.kr";

// 데모용 가짜 Commeet 면담 기록. 실제 확장은 이 자리에서
// GET /api/records 응답을 씁니다 (sharedNotes 또는 perStudentNotes[key]).
const DEMO_RECORD = {
  academic: "[데모] 학업지도: 자료구조 성적이 올랐고, 다음 학기 알고리즘 수강을 권유함.",
  life: "[데모] 생활지도: 기숙사 생활 적응에 문제 없음. 동아리 활동 병행 중.",
  career: "[데모] 진로지도: 대학원 진학과 취업을 함께 고민 중. 인턴 경험을 먼저 권유함.",
  etc: "[데모] 기타사항: 다음 면담은 기말고사 이후로 예정.",
};

// 미래설계 화면에는 학업/생활/진로/기타 칸이 없어서, 동작 확인용으로
// 30·40·50·60대 칸을 빌려 씁니다. 교수 화면(지도면담입력)의 진짜 경로는
// 그 화면에서 "필드 스캔"을 돌려 채워 넣으면 됩니다.
const DEMO_MAPPING = {
  "/GS_GOAL/ZAGE_30": DEMO_RECORD.academic,
  "/GS_GOAL/ZAGE_40": DEMO_RECORD.life,
  "/GS_GOAL/ZAGE_50": DEMO_RECORD.career,
  "/GS_GOAL/ZAGE_60": DEMO_RECORD.etc,
};

// ---------------------------------------------------------------------------
// 페이지(MAIN world)에서 실행되는 코드
// ---------------------------------------------------------------------------

/** UI5 컨트롤 하나의 사람이 읽을 라벨을 추측합니다. 스캔 결과를 눈으로
 *  훑어 매핑표를 만들 때 쓰는 힌트일 뿐이라 실패해도 무방합니다. */
function pageScan() {
  if (!window.sap?.ui?.core?.Element?.registry) {
    return { error: "이 페이지에서 SAPUI5를 찾지 못했습니다. POVIS 화면이 맞는지 확인해 주세요." };
  }
  const labelOf = (ctrl) => {
    try {
      const dom = ctrl.getDomRef();
      if (!dom) return null;
      const via = dom.getAttribute("aria-labelledby");
      if (via) {
        const text = via.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
        if (text) return text.slice(0, 40);
      }
      // 라벨이 앞 형제로 놓인 흔한 배치
      let node = dom.closest("div");
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        const prev = node.previousElementSibling;
        const text = prev?.textContent?.trim();
        if (text && text.length < 40) return text;
      }
    } catch { /* 라벨은 있으면 좋은 정도 */ }
    return null;
  };

  const fields = [];
  sap.ui.core.Element.registry.forEach((c) => {
    const binding = c.getBinding && c.getBinding("value");
    if (!binding?.getPath) return;
    const type = c.getMetadata().getName();
    if (!/TextArea|Input|TextField/.test(type)) return;
    fields.push({
      path: binding.getPath(),
      type: type.split(".").pop(),
      label: labelOf(c),
      len: (c.getValue?.() || "").length, // 값 자체는 개인정보라 길이만
      editable: c.getEditable ? c.getEditable() : null,
    });
  });
  return { url: location.href, ui5: sap.ui.version, count: fields.length, fields };
}

/** 매핑대로 모델에 씁니다. 원래 값은 되돌리기용으로 페이지에 보관합니다. */
function pageFill(mapping) {
  if (!window.sap?.ui?.core?.Element?.registry) {
    return { error: "이 페이지에서 SAPUI5를 찾지 못했습니다." };
  }
  const find = (path) => {
    let hit = null;
    sap.ui.core.Element.registry.forEach((c) => {
      const b = c.getBinding && c.getBinding("value");
      if (!hit && b?.getPath && b.getPath() === path) hit = c;
    });
    return hit;
  };

  window.__commeetBackup = window.__commeetBackup || {};
  const report = [];
  for (const [path, value] of Object.entries(mapping)) {
    const ctrl = find(path);
    if (!ctrl) { report.push({ path, status: "필드 없음" }); continue; }
    if (ctrl.getEditable && !ctrl.getEditable()) { report.push({ path, status: "읽기 전용" }); continue; }

    const model = ctrl.getModel();
    if (!(path in window.__commeetBackup)) window.__commeetBackup[path] = model.getProperty(path);
    model.setProperty(path, value);

    // 화면·모델이 실제로 같아졌는지 확인합니다. 조용히 어긋나는 것이
    // 이 작업에서 가장 위험한 실패라서, 넣고 나서 반드시 되읽습니다.
    const ok = ctrl.getValue() === value && model.getProperty(path) === value;
    report.push({ path, status: ok ? "OK" : "불일치" });
  }
  return { filled: report.filter((r) => r.status === "OK").length, report };
}

function pageRestore() {
  const backup = window.__commeetBackup;
  if (!backup || !Object.keys(backup).length) return { error: "되돌릴 내용이 없습니다." };
  const find = (path) => {
    let hit = null;
    sap.ui.core.Element.registry.forEach((c) => {
      const b = c.getBinding && c.getBinding("value");
      if (!hit && b?.getPath && b.getPath() === path) hit = c;
    });
    return hit;
  };
  let n = 0;
  for (const [path, value] of Object.entries(backup)) {
    const ctrl = find(path);
    if (ctrl) { ctrl.getModel().setProperty(path, value); n++; }
  }
  delete window.__commeetBackup;
  return { restored: n };
}

// ---------------------------------------------------------------------------
// 팝업 쪽
// ---------------------------------------------------------------------------

const out = document.getElementById("out");

function show(value) {
  out.hidden = false;
  out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

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

document.getElementById("scan").addEventListener("click", async () => {
  show("스캔 중…");
  show(await runInPage(pageScan));
});

document.getElementById("fill").addEventListener("click", async () => {
  show("채우는 중…");
  show(await runInPage(pageFill, [DEMO_MAPPING]));
});

document.getElementById("restore").addEventListener("click", async () => {
  show(await runInPage(pageRestore));
});
