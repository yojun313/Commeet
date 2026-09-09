// POVIS 페이지(MAIN world)에서 실행되는 코드.
//
// POVIS는 SAPUI5 앱입니다. 값을 넣는 방법이 하나로 정해집니다:
//
//   DOM에 직접 쓰면 (field.value = ... + input/change 이벤트) 화면에는
//   보이지만 UI5 모델은 갱신되지 않습니다. 그 상태로 저장하면 **옛 값이**
//   전송됩니다 - 에러도 안 나고 화면도 멀쩡해서 늦게 발견되는 종류입니다.
//
//   그렇다고 model.setProperty(path, value)로 끝나지도 않습니다 (2026-09-09
//   실측). POVIS 프레임워크(U4A)는 모델의 propertyChange 이벤트로 "바뀐
//   필드"를 추적해서 서버에 보내는데, setProperty는 그 이벤트를 내지 않습니다.
//   결과: 화면과 모델에는 값이 있는데 서버는 "면담결과를 입력하세요"라고 답함.
//   propertyChange는 **바인딩을 통한 변경**에만 발생하므로 반드시
//   control.getBinding("value").setValue(value) 로 쓰고, 화면 반영을 위해
//   model.checkUpdate(true)를 한 번 부릅니다.
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
    ctrl.getBinding("value").setValue(value); // propertyChange를 내야 서버로 갑니다 (파일 머리 주석)
    model.checkUpdate(true);

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
    if (ctrl) { ctrl.getBinding("value").setValue(value); ctrl.getModel().checkUpdate(true); n++; }
  }
  delete window.__commeetBackup;
  return { restored: n };
}

// ---------------------------------------------------------------------------
// 지도면담입력 화면 자동화 단계 (2026-09-09 교수 계정으로 실측)
//
// 화면 구조 (URL /zu4a/zuiep_1000, iframe 없음, 모델은 JSONModel 하나):
//   목록 화면  sap.m.Table items → "/GT_HD"  행 = {STDID, ST_NAME, ...}
//              학번 셀은 sap.m.Link. firePress()하면 "/GS_ST_INFO"에
//              {STDID, ST_NAME}가 잡히고 "/GT_LIST"(면담내역, {ZCON_DATE,...})가 로드됨
//              우측 버튼 "지도면담 입력" → 입력 화면으로 전환 (같은 페이지, 뷰 교체)
//   입력 화면  "/GS_DT_LIST/ZCON_DATE"  면담일 (DatePicker, "YYYYMMDD")
//              "/GS_DT_LIST/ZITV_01_S"  학업지도   (왼쪽부터 순서대로)
//              "/GS_DT_LIST/ZITV_02_S"  생활지도
//              "/GS_DT_LIST/ZITV_03_S"  진로지도
//              "/GS_DT_LIST/ZITV_04_S"  기타사항
//              버튼 "저장"(EV_SAVE_CREATE) / "이전"(EV_BACK)
//              저장 성공 시 토스트 "저장되었습니다" 후 목록으로 자동 복귀, GT_LIST +1.
//              값이 서버에 안 실리면 토스트 "면담결과를 입력하세요." 후 화면 유지.
//              GS_DT_LIST는 구조체 하나라 다음 학생의 입력 화면에도 이전 값이
//              남을 수 있음 → 네 항목을 매번 전부(빈 값 포함) 씁니다.
//
// DOM id(__table3, __button32)는 로드마다 달라지므로 절대 쓰지 않고,
// 바인딩 경로와 버튼 텍스트로 찾습니다. 한 단계 = 한 번의 executeScript.
// 서버 왕복은 명시적 완료 신호가 없어서 모델/화면 상태를 폴링합니다.
async function povisStep(step, arg) {
  if (!window.sap?.ui?.core?.Element?.registry) {
    return { error: "이 페이지에서 SAPUI5를 찾지 못했습니다. POVIS 지도면담입력 화면인지 확인해 주세요." };
  }
  const registry = sap.ui.core.Element.registry;
  const typeOf = (c) => c.getMetadata().getName();
  const visible = (c) => { const d = c?.getDomRef?.(); return !!d && d.offsetParent !== null; };
  const first = (pred) => { let hit = null; registry.forEach((c) => { if (!hit && pred(c)) hit = c; }); return hit; };
  const byValuePath = (path) => first((c) => c.getBinding?.("value")?.getPath?.() === path);
  const buttonByText = (text) => first((c) => /\.Button$/.test(typeOf(c)) && visible(c) && c.getText?.() === text);
  const studentTable = () => first((c) => /\.Table$/.test(typeOf(c)) && c.getBinding?.("items")?.getPath?.() === "/GT_HD");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, timeout = 15000, every = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (pred()) return true; } catch { /* 다시 */ } await sleep(every); }
    return false;
  };
  const formOpen = () => visible(byValuePath("/GS_DT_LIST/ZITV_01_S"));
  const listOpen = () => visible(studentTable());
  const openDialog = () => first((c) => typeOf(c) === "sap.m.Dialog" && c.isOpen?.() && visible(c));
  const dialogInfo = (d) => ({
    title: d.getTitle?.() || "",
    text: (d.getContent?.() || []).map((c) => c.getText?.() || c.getDomRef?.()?.textContent || "").join(" ").trim().slice(0, 300),
    buttons: [d.getBeginButton?.(), d.getEndButton?.(), ...(d.getButtons?.() || [])].filter(Boolean).map((b) => b.getText()),
  });
  // 확인창은 긍정 버튼을 누릅니다. "예/확인/OK"가 없으면 첫 버튼.
  const pressDialog = (d) => {
    const btns = [d.getBeginButton?.(), d.getEndButton?.(), ...(d.getButtons?.() || [])].filter(Boolean);
    const positive = btns.find((b) => /^(확인|예|OK|Yes|저장)$/i.test(b.getText())) || btns[0];
    if (positive) positive.firePress(); else d.close();
    return positive ? positive.getText() : "(close)";
  };
  // 서버 왕복 동안 뜨는 확인/안내창을 처리하면서 `done`이 될 때까지 기다립니다.
  // 만난 창의 내용을 모두 돌려주어, 팝업이 사용자에게 보여줄 수 있게 합니다.
  const toastText = () => document.querySelector(".sapMMessageToast")?.textContent?.trim() || "";
  const settle = async (done, timeout = 20000) => {
    const dialogs = [];
    const toasts = [];
    const t0 = Date.now();
    let quiet = 0;
    let lastDialogAt = 0;
    while (Date.now() - t0 < timeout) {
      const toast = toastText();
      if (toast && toasts[toasts.length - 1] !== toast) { toasts.push(toast); lastDialogAt = Date.now(); }
      const d = openDialog();
      if (d) {
        const info = dialogInfo(d);
        info.pressed = pressDialog(d);
        dialogs.push(info);
        lastDialogAt = Date.now();
        await sleep(400);
        quiet = 0;
        continue;
      }
      if (done()) { quiet += 1; if (quiet >= 3) return { settled: true, dialogs, toasts }; } else quiet = 0;
      // 안내창·토스트(예: "면담결과를 입력하세요")가 뜬 뒤에도 화면이 그대로면
      // 더 기다릴 것이 없습니다. 실패를 timeout까지 끌지 않고 바로 돌려줍니다.
      if (lastDialogAt && Date.now() - lastDialogAt > 6000) return { settled: false, dialogs, toasts };
      await sleep(250);
    }
    return { settled: false, dialogs, toasts };
  };
  const model = () => (studentTable() || byValuePath("/GS_DT_LIST/ZITV_01_S"))?.getModel();

  try {
    switch (step) {
      case "status": {
        const m = model();
        return {
          list: listOpen(), form: formOpen(), dialog: openDialog() ? dialogInfo(openDialog()) : null,
          selected: m?.getProperty("/GS_ST_INFO") || null,
          students: (m?.getProperty("/GT_HD") || []).length,
        };
      }

      case "students": {
        const m = model();
        if (!m) return { error: "학생 목록을 찾지 못했습니다. 지도면담입력 목록 화면을 열어 주세요." };
        return { students: (m.getProperty("/GT_HD") || []).map((r) => ({ studentId: r.STDID, name: r.ST_NAME, status: r.ZSTAT_CDT })) };
      }

      // 학번 링크를 눌러 학생을 선택합니다. 선택이 끝나면 면담내역(GT_LIST)이
      // 로드되므로, 같은 날짜의 면담이 이미 있는지도 여기서 알려 줍니다.
      case "select": {
        const { studentId, date } = arg;
        if (formOpen()) {
          buttonByText("이전")?.firePress();
          await settle(() => !formOpen() && listOpen(), 30000);
          if (formOpen()) return { error: "이전 학생의 입력 화면이 닫히지 않았습니다." };
        }
        const table = studentTable();
        if (!table) return { error: "학생 목록을 찾지 못했습니다." };
        const item = table.getItems().find((it) => it.getBindingContext()?.getProperty("STDID") === studentId);
        if (!item) return { error: "지도학생 목록에 없는 학번입니다.", notFound: true };
        const link = item.getCells().find((c) => /\.Link$/.test(typeOf(c)));
        if (!link) return { error: "학번 링크를 찾지 못했습니다." };
        const m = table.getModel();
        link.firePress();
        const ok = await waitFor(() => m.getProperty("/GS_ST_INFO/STDID") === studentId);
        if (!ok) return { error: "학생 선택이 반영되지 않았습니다 (시간 초과)." };
        await sleep(600); // GT_LIST가 뒤따라 옵니다
        const history = m.getProperty("/GT_LIST") || [];
        return {
          selected: m.getProperty("/GS_ST_INFO"),
          historyCount: history.length,
          duplicate: !!date && history.some((h) => h.ZCON_DATE === date),
        };
      }

      case "open": {
        if (formOpen()) return { opened: true, already: true };
        const btn = buttonByText("지도면담 입력");
        if (!btn) return { error: "'지도면담 입력' 버튼을 찾지 못했습니다." };
        btn.firePress();
        const r = await settle(formOpen);
        if (!r.settled) return { error: "입력 화면이 열리지 않았습니다 (시간 초과).", dialogs: r.dialogs };
        return { opened: true, dialogs: r.dialogs };
      }

      // 바인딩을 통해 쓰고(파일 머리 주석) 되읽어 확인합니다. 네 항목은 빈 값이라도
      // 전부 씁니다 - GS_DT_LIST가 학생 사이에 재사용되어 이전 학생의 글이 남습니다.
      case "fill": {
        const { date, notes } = arg;
        if (!formOpen()) return { error: "입력 화면이 열려 있지 않습니다." };
        const m = model();
        const mapping = {
          "/GS_DT_LIST/ZITV_01_S": notes.academic,
          "/GS_DT_LIST/ZITV_02_S": notes.life,
          "/GS_DT_LIST/ZITV_03_S": notes.career,
          "/GS_DT_LIST/ZITV_04_S": notes.etc,
        };
        if (date) mapping["/GS_DT_LIST/ZCON_DATE"] = date;
        const report = [];
        let written = 0;
        for (const [path, raw] of Object.entries(mapping)) {
          const value = (raw || "").trim();
          const ctrl = byValuePath(path);
          if (!ctrl) { report.push({ path, status: "필드 없음" }); continue; }
          if (ctrl.getEditable && !ctrl.getEditable()) { report.push({ path, status: "읽기 전용" }); continue; }
          ctrl.getBinding("value").setValue(value);
          report.push({ path, status: "pending", value, ctrl });
        }
        m.checkUpdate(true);
        await sleep(150);
        for (const r of report) {
          if (r.status !== "pending") continue;
          const ok = m.getProperty(r.path) === r.value && (r.path.endsWith("ZCON_DATE") || r.ctrl.getValue() === r.value);
          r.status = ok ? "OK" : "불일치";
          if (ok && r.value) written += 1;
          delete r.ctrl; delete r.value;
        }
        const bad = report.filter((r) => r.status !== "OK");
        return { filled: written, report, ok: bad.length === 0 && written > 0 };
      }

      case "save": {
        if (!formOpen()) return { error: "입력 화면이 열려 있지 않습니다." };
        const m = model();
        const before = (m.getProperty("/GT_LIST") || []).length;
        const btn = buttonByText("저장");
        if (!btn) return { error: "'저장' 버튼을 찾지 못했습니다." };
        btn.firePress();
        // 성공하면 "저장되었습니다" 토스트 후 목록으로 돌아가고 면담내역이 하나 늡니다.
        // 실패하면 안내 토스트("면담결과를 입력하세요" 등)만 뜨고 화면이 남습니다.
        const r = await settle(() => !formOpen() || (m.getProperty("/GT_LIST") || []).length > before, 30000);
        const after = (m.getProperty("/GT_LIST") || []).length;
        return {
          saved: r.settled && after > before, formStillOpen: formOpen(),
          historyBefore: before, historyAfter: after, dialogs: r.dialogs, toasts: r.toasts,
        };
      }

      // EV_BACK도 서버 왕복이라 느릴 때가 있습니다(20초 넘게 걸린 적 있음).
      // 폼이 사라지는 것을 기준으로 넉넉히 기다리고, 그래도 남아 있으면 한 번 더 누릅니다.
      case "back": {
        if (!formOpen()) return { back: true, already: true };
        let r = { dialogs: [] };
        for (let attempt = 0; attempt < 2 && formOpen(); attempt++) {
          const btn = buttonByText("이전");
          if (!btn) return { error: "'이전' 버튼을 찾지 못했습니다." };
          btn.firePress();
          r = await settle(() => !formOpen() && listOpen(), 30000);
        }
        return { back: !formOpen(), dialogs: r.dialogs };
      }

      default:
        return { error: `알 수 없는 단계: ${step}` };
    }
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}
