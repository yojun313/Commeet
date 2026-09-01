/* 연락처를 추가하는 세 가지 방법을 한 곳에 모은 모듈.
 *
 *   1. 가입자 검색 후 추가
 *   2. 직접 입력 (이름·이메일 + 구분/과정/학번 등 세부 정보)
 *   3. 표 붙여넣기로 여러 명 한 번에
 *
 * 연락처 페이지(/contacts)와 일정 화면의 "초대 보내기 → 연락처 추가" 창이
 * 이 모듈을 함께 씁니다. 마크업도 partials/contact_add_panel.html 하나를
 * 공유합니다 - 예전에는 초대 창에서 이름·이메일만 받을 수 있어서, 명단을
 * 붙여넣으려면 연락처 페이지로 갔다가 돌아와야 했습니다.
 *
 * 추가된 **다음에** 무엇을 새로 고칠지는 화면마다 다르므로(연락처 목록이냐
 * 초대 목록이냐) 부르는 쪽이 onAdded로 정합니다.
 *
 * 의존: api.js, ui.js(showSnackbar), contact-filters.js(parseBulkContacts,
 * fillSelect, CONTACT_*_OPTIONS).
 */
const ContactAdd = (() => {
  // 세부 정보 칸. 서버 필드 이름 -> 입력 요소 id.
  const FIELD_IDS = {
    relation: "manual-relation",
    degree: "manual-degree",
    gradSchool: "manual-gradschool",
    department: "manual-department",
    year: "manual-year",
    semester: "manual-semester",
    studentId: "manual-studentid",
    status: "manual-status",
    phone: "manual-phone",
    memo: "manual-memo",
  };

  let onAdded = async () => {};
  let searchTimer = null;

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  function initial(text) {
    return (text || "?").trim().charAt(0).toUpperCase() || "?";
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /* ---------------------------------------------------------------- */
  /* 가입자 검색                                                        */
  /* ---------------------------------------------------------------- */

  function renderSearchResults(results, query) {
    const root = byId("search-results");
    root.innerHTML = "";
    if (!query) return;

    if (!results.length) {
      root.innerHTML = `<p class="hint">"${esc(query)}"와 일치하는 가입자가 없습니다. 아래에서 직접 추가할 수 있어요.</p>`;
      byId("manual-add").open = true;
      // 검색어가 이메일처럼 보이면 이메일 칸에, 아니면 이름 칸에 미리 넣어
      // 둡니다 - 직접 입력이 처음부터가 아니라 한 걸음 앞에서 시작합니다.
      if (query.includes("@")) byId("manual-email").value = query;
      else byId("manual-name").value = query;
      return;
    }

    results.forEach((u) => {
      const row = document.createElement("div");
      row.className = "contact-row";
      row.innerHTML = `
        <span class="avatar sm">${esc(initial(u.name || u.email))}</span>
        <div class="info">
          <div class="name">${esc(u.name || "(이름 없음)")}<span class="badge" style="margin-left:6px;">가입자</span></div>
          <div class="email">${esc(u.email)}</div>
        </div>
      `;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm " + (u.alreadyAdded ? "btn-ghost" : "btn-primary");
      btn.textContent = u.alreadyAdded ? "추가됨" : "추가";
      btn.disabled = u.alreadyAdded;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.post("/api/contacts", { email: u.email, name: u.name || "" });
          byId("contact-search").value = "";
          byId("search-results").innerHTML = "";
          showSnackbar("연락처에 추가했습니다.", "success");
          await onAdded([u.email]);
        } catch (err) {
          showSnackbar(err.message, "error");
          btn.disabled = false;
        }
      });
      row.appendChild(btn);
      root.appendChild(row);
    });
  }

  async function runSearch(query) {
    if (!query) {
      byId("search-results").innerHTML = "";
      return;
    }
    try {
      renderSearchResults(
        await api.get(`/api/contacts/search?q=${encodeURIComponent(query)}`),
        query
      );
    } catch (err) {
      showSnackbar(err.message, "error");
    }
  }

  /* ---------------------------------------------------------------- */
  /* 직접 입력                                                          */
  /* ---------------------------------------------------------------- */

  async function submitManual(e) {
    e.preventDefault();
    const errorEl = byId("manual-error");
    errorEl.textContent = "";

    const name = byId("manual-name").value.trim();
    const email = byId("manual-email").value.trim();
    const details = {};
    Object.entries(FIELD_IDS).forEach(([field, id]) => {
      const el = byId(id);
      if (el && el.value.trim()) details[field] = el.value.trim();
    });

    try {
      await api.post("/api/contacts", Object.assign({ email, name }, details));
      showSnackbar("연락처에 추가했습니다.", "success");
      byId("manual-add-form").reset();
      byId("manual-details").open = false;
      byId("manual-add").open = false;
      byId("contact-search").value = "";
      byId("search-results").innerHTML = "";
      await onAdded([email]);
    } catch (err) {
      errorEl.textContent = err.message || "추가하지 못했습니다.";
    }
  }

  /* ---------------------------------------------------------------- */
  /* 붙여넣기                                                           */
  /* ---------------------------------------------------------------- */

  function renderBulkPreview(text) {
    const preview = byId("bulk-add-preview");
    if (!text.trim()) {
      preview.textContent = "";
      return;
    }
    const { parsed, skipped } = parseBulkContacts(text);
    // 건너뛴 줄 수를 같이 보여 줍니다 - 40줄을 붙여넣었는데 "3명 인식됨"만
    // 뜨면 나머지가 조용히 사라진 것처럼 보입니다.
    preview.textContent =
      `${parsed.length}명 인식됨` + (skipped ? ` · 명단이 아닌 ${skipped}줄은 건너뜀` : "");
  }

  async function submitBulk() {
    const textarea = byId("bulk-add-textarea");
    const errorEl = byId("bulk-add-error");
    const previewEl = byId("bulk-add-preview");
    errorEl.textContent = "";

    const { parsed, errors, skipped } = parseBulkContacts(textarea.value);
    if (!parsed.length) {
      if (errors.length) errorEl.textContent = errors.join("\n");
      else if (skipped) {
        // 학사 시스템 화면을 통째로 붙여넣은 경우 - 메뉴와 검색 조건만 들어왔습니다.
        errorEl.textContent = "명단 줄을 찾지 못했습니다. 표의 데이터 행을 붙여넣어 주세요.";
      } else errorEl.textContent = "붙여넣은 내용이 없습니다.";
      return;
    }

    let added = 0;
    let updated = 0;
    const failures = [];
    const emails = [];
    for (const record of parsed) {
      const { name, email, ...details } = record;
      try {
        // overwrite=true: 이미 있는 이메일이면 거절하지 않고 새 정보로
        // 갱신합니다 - 같은 명단을 몇 번이고 다시 붙여넣을 수 있게.
        const res = await api.post(
          "/api/contacts?overwrite=true",
          Object.assign({ email, name: name || "" }, details)
        );
        if (res && res.created === false) updated++;
        else added++;
        emails.push(email);
      } catch (err) {
        failures.push(`${name || email}: ${err.message}`);
      }
    }

    errorEl.textContent = [...errors, ...failures].join("\n");
    const summary = [added ? `${added}명 추가` : "", updated ? `${updated}명 갱신` : ""]
      .filter(Boolean)
      .join(" · ");
    previewEl.textContent = `${summary || "변경 없음"} (총 ${parsed.length}건 시도)`;

    if (added || updated) {
      showSnackbar(`${summary}했습니다.`, "success");
      textarea.value = "";
      await onAdded(emails);
      if (!failures.length && !errors.length) byId("bulk-add").open = false;
    }
  }

  /* ---------------------------------------------------------------- */

  /** 패널을 열어 둔 화면에서 한 번 부릅니다. `onAdded(emails)`는 추가가
   *  성공할 때마다 불리며, 그 화면이 자기 목록을 새로 고치는 자리입니다. */
  function init(options) {
    const root = byId("manual-add-form");
    if (!root) return; // 이 화면에는 추가 패널이 없음
    onAdded = (options && options.onAdded) || (async () => {});

    [
      ["manual-degree", CONTACT_DEGREE_OPTIONS],
      ["manual-status", CONTACT_STATUS_OPTIONS],
      ["manual-relation", CONTACT_RELATION_OPTIONS],
    ].forEach(([id, opts]) => fillSelect(id, opts));

    byId("contact-search").addEventListener("input", (e) => {
      const query = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(query), 250);
    });
    root.addEventListener("submit", submitManual);
    byId("bulk-add-textarea").addEventListener("input", (e) =>
      renderBulkPreview(e.target.value)
    );
    byId("bulk-add-submit").addEventListener("click", submitBulk);
  }

  /** 창을 다시 열 때 지난 입력과 안내를 지웁니다. */
  function reset() {
    if (!byId("manual-add-form")) return;
    byId("contact-search").value = "";
    byId("search-results").innerHTML = "";
    byId("manual-add-form").reset();
    byId("manual-error").textContent = "";
    byId("manual-add").open = false;
    byId("manual-details").open = false;
    byId("bulk-add-textarea").value = "";
    byId("bulk-add-error").textContent = "";
    byId("bulk-add-preview").textContent = "";
    byId("bulk-add").open = false;
  }

  return { init, reset };
})();
