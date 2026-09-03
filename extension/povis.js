// POVIS 페이지(MAIN world)에서 실행되는 코드.
//
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
// 이 함수들은 chrome.scripting이 문자열로 직렬화해 페이지 컨텍스트에서
// 실행합니다 - 콘텐츠 스크립트의 격리된 world에서는 window.sap이 보이지
// 않기 때문입니다. 그래서 클로저를 쓰지 못하고 전부 자기완결적입니다.

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
      let node = dom.closest("div");
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        const text = node.previousElementSibling?.textContent?.trim();
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

    // 넣고 나서 되읽습니다. 화면과 모델이 조용히 어긋나는 것이 이 작업에서
    // 가장 위험한 실패라서, 넣었다는 사실만으로 성공으로 치지 않습니다.
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
