function esc(s) {
  const d = document.createElement("div");
  d.textContent = s === undefined || s === null ? "" : String(s);
  return d.innerHTML;
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Stats + traffic chart                                               */
/* ------------------------------------------------------------------ */

let currentDays = 30;

function deltaBadge(today, yesterday) {
  if (!yesterday) return "";
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct === 0) return `<span class="admin-delta flat">전일과 동일</span>`;
  const cls = pct > 0 ? "up" : "down";
  const arrow = pct > 0 ? "▲" : "▼";
  return `<span class="admin-delta ${cls}">${arrow} ${Math.abs(pct)}% 전일 대비</span>`;
}

function renderStatCards(stats) {
  const root = document.getElementById("admin-stat-cards");
  const g = stats.growth || {};
  const err4 = (stats.statusGroups && stats.statusGroups["4xx"]) || 0;
  const err5 = (stats.statusGroups && stats.statusGroups["5xx"]) || 0;
  const people = stats.people || {};
  const cards = [
    {
      label: "누적 이용자",
      value: people.total || 0,
      sub: `회원 ${Number(people.members || 0).toLocaleString()} · 비회원 ${Number(people.guests || 0).toLocaleString()}`,
      action: "people",
    },
    {
      label: "전체 사용자",
      value: stats.totalUsers,
      sub: g.newUsers7d ? `최근 7일 +${g.newUsers7d}` : "최근 7일 신규 없음",
    },
    {
      label: "전체 방",
      value: stats.totalEvents,
      sub: `확정 ${Number(stats.closedEvents || 0).toLocaleString()} · 7일 +${g.newEvents7d || 0}`,
    },
    {
      label: `최근 ${stats.windowDays}일 요청`,
      value: stats.requestsInWindow,
      sub: `오늘 ${Number(stats.requestsToday || 0).toLocaleString()}건 ` +
        deltaBadge(stats.requestsToday, stats.requestsYesterday),
    },
    {
      label: "순사용자",
      value: stats.uniques ? stats.uniques.users : 0,
      sub: stats.uniques ? `방문 IP ${stats.uniques.ips.toLocaleString()}개` : "",
    },
    {
      label: "평균 응답",
      value: stats.perf ? `${stats.perf.avgMs}ms` : "-",
      raw: true,
      sub: stats.perf ? `상위 5% 이내 ${stats.perf.p95Ms}ms` : "",
    },
    {
      label: "오류 응답",
      value: err4 + err5,
      sub: `4xx ${err4.toLocaleString()} · 5xx ${err5.toLocaleString()}`,
      danger: err5 > 0,
    },
  ];
  root.innerHTML = "";
  cards.forEach((c) => {
    const div = document.createElement("div");
    div.className = "admin-stat-card" + (c.danger ? " danger" : "") + (c.action ? " clickable" : "");
    if (c.action === "people") {
      div.title = "눌러서 이용자 목록 크게 보기";
      div.tabIndex = 0;
      div.setAttribute("role", "button");
      div.addEventListener("click", () => openBrowse("people"));
      div.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBrowse("people"); }
      });
    }
    const val = c.raw ? esc(c.value) : Number(c.value).toLocaleString();
    div.innerHTML =
      `<div class="admin-stat-label">${esc(c.label)}</div>` +
      `<div class="admin-stat-value">${val}</div>` +
      (c.sub ? `<div class="admin-stat-sub">${c.sub}</div>` : "");
    root.appendChild(div);
  });
}

// Hand-rolled SVG bar chart (no charting library dependency) - a viewBox
// makes it scale responsively without any resize-observer wiring.
function renderTrafficChart(container, daily) {
  container.innerHTML = "";
  if (!daily.length) {
    container.innerHTML = `<p class="hint">아직 트래픽 데이터가 없습니다.</p>`;
    return;
  }

  const width = 900;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 24, left: 36 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const maxVal = Math.max(1, ...daily.map((d) => d.requests));
  const barWidth = chartW / daily.length;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "admin-chart-svg");
  svg.setAttribute("preserveAspectRatio", "none");

  [0, 0.5, 1].forEach((frac) => {
    const y = padding.top + chartH * (1 - frac);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", padding.left);
    line.setAttribute("x2", width - padding.right);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("class", "admin-chart-gridline");
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", padding.left - 6);
    label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "admin-chart-axis-label");
    label.textContent = Math.round(maxVal * frac);
    svg.appendChild(label);
  });

  const labelStride = Math.max(1, Math.ceil(daily.length / 10));
  daily.forEach((d, i) => {
    const barH = (d.requests / maxVal) * chartH;
    const x = padding.left + i * barWidth;
    const y = padding.top + (chartH - barH);

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", x + barWidth * 0.15);
    rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(1, barWidth * 0.7));
    rect.setAttribute("height", Math.max(0, barH));
    rect.setAttribute("class", "admin-chart-bar");
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${d.date}: 요청 ${d.requests}건, 순사용자 ${d.uniqueUsers}명`;
    rect.appendChild(title);
    svg.appendChild(rect);

    if (daily.length <= 14 || i % labelStride === 0) {
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", x + barWidth / 2);
      label.setAttribute("y", height - 6);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "admin-chart-axis-label");
      label.textContent = d.date.slice(5);
      svg.appendChild(label);
    }
  });

  // 순사용자 꺾은선 - 요청 수와 축이 달라(수십 vs 수천) 같은 축에 그리면
  // 바닥에 붙어 버리므로, 자기 최대값 기준으로 따로 정규화해 "모양"만
  // 겹쳐 보입니다. 정확한 수치는 막대의 툴팁에 있습니다.
  const maxUsers = Math.max(1, ...daily.map((d) => d.uniqueUsers));
  const points = daily
    .map((d, i) => {
      const x = padding.left + i * barWidth + barWidth / 2;
      const y = padding.top + chartH * (1 - d.uniqueUsers / maxUsers);
      return `${x},${y}`;
    })
    .join(" ");
  const line = document.createElementNS(svgNS, "polyline");
  line.setAttribute("points", points);
  line.setAttribute("class", "admin-chart-line");
  svg.appendChild(line);

  container.appendChild(svg);
}

/* 24개의 짧은 막대 - 시간대별 사용 패턴. 심야 봇과 낮 사용자의 구분이
 * 한눈에 보입니다. */
function renderHourlyChart(container, hourly) {
  container.innerHTML = "";
  const max = Math.max(1, ...hourly);
  const wrap = document.createElement("div");
  wrap.className = "admin-hourly";
  hourly.forEach((count, h) => {
    const col = document.createElement("div");
    col.className = "admin-hourly-col";
    const bar = document.createElement("div");
    bar.className = "admin-hourly-bar";
    bar.style.height = `${Math.max(2, (count / max) * 78)}px`;
    bar.title = `${h}시: ${count.toLocaleString()}건`;
    col.appendChild(bar);
    if (h % 6 === 0) {
      const lb = document.createElement("span");
      lb.className = "admin-hourly-label";
      lb.textContent = `${h}시`;
      col.appendChild(lb);
    }
    wrap.appendChild(col);
  });
  container.appendChild(wrap);
}

/* 2xx/3xx/4xx/5xx를 하나의 누적 막대 + 색 범례로. */
function renderStatusDist(container, groups) {
  container.innerHTML = "";
  const order = ["2xx", "3xx", "4xx", "5xx"];
  const total = order.reduce((a, k) => a + (groups[k] || 0), 0);
  if (!total) {
    container.innerHTML = `<p class="hint" style="margin:0;">아직 기록이 없습니다.</p>`;
    return;
  }
  const bar = document.createElement("div");
  bar.className = "admin-status-bar";
  order.forEach((k) => {
    const n = groups[k] || 0;
    if (!n) return;
    const seg = document.createElement("div");
    seg.className = `admin-status-seg s${k}`;
    seg.style.width = `${(n / total) * 100}%`;
    seg.title = `${k}: ${n.toLocaleString()}건`;
    bar.appendChild(seg);
  });
  container.appendChild(bar);
  const legend = document.createElement("div");
  legend.className = "admin-status-legend";
  order.forEach((k) => {
    const n = groups[k] || 0;
    legend.insertAdjacentHTML(
      "beforeend",
      `<span><i class="legend-dot s${k}"></i>${k} <b>${n.toLocaleString()}</b> <em>${total ? Math.round((n / total) * 100) : 0}%</em></span>`
    );
  });
  container.appendChild(legend);
}

function statusPill(code) {
  const cls = code >= 500 ? "s5xx" : code >= 400 ? "s4xx" : code >= 300 ? "s3xx" : "s2xx";
  return `<span class="admin-status-pill ${cls}">${code}</span>`;
}

function renderRecentErrors(container, errors) {
  container.innerHTML = "";
  if (!errors.length) {
    container.innerHTML = `<p class="hint" style="margin:0;">이 기간에는 오류 응답이 없습니다.</p>`;
    return;
  }
  errors.forEach((e) => {
    container.insertAdjacentHTML(
      "beforeend",
      `<div class="admin-error-row">${statusPill(e.statusCode)}
        <span class="admin-error-path" title="${esc(e.path)}">${esc(e.method)} ${esc(e.path)}</span>
        <span class="admin-error-time">${fmtDateTime(e.ts).slice(5)}</span>
      </div>`
    );
  });
}

/* 라벨 + 수평 비율 막대 목록 (브라우저·기기·상위 사용자 공용). */
function renderBarList(container, rows, { valueLabel } = {}) {
  container.innerHTML = "";
  if (!rows.length) {
    container.innerHTML = `<p class="hint" style="margin:0;">아직 기록이 없습니다.</p>`;
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  rows.forEach((r) => {
    container.insertAdjacentHTML(
      "beforeend",
      `<div class="admin-bar-row" ${r.title ? `title="${esc(r.title)}"` : ""}>
        <span class="admin-bar-name">${esc(r.name)}</span>
        <span class="admin-bar-track"><span class="admin-bar-fill" style="width:${(r.count / max) * 100}%"></span></span>
        <span class="admin-bar-count">${r.count.toLocaleString()}${valueLabel || ""}</span>
      </div>`
    );
  });
}

function renderSlowest(container, slowest) {
  container.innerHTML = "";
  if (!slowest.length) {
    container.innerHTML = `<p class="hint" style="margin:0;">표본이 부족합니다 (5회 이상 호출된 경로만).</p>`;
    return;
  }
  slowest.forEach((r) => {
    container.insertAdjacentHTML(
      "beforeend",
      `<div class="admin-slow-row">
        <span class="admin-method-badge">${esc(r.method)}</span>
        <span class="admin-error-path" title="${esc(r.path)}">${esc(r.path)}</span>
        <span class="admin-slow-ms">${r.avgMs.toLocaleString()}ms</span>
        <span class="admin-slow-count">${r.count.toLocaleString()}회</span>
      </div>`
    );
  });
}

/* 신규 가입/일정 - 날짜 합집합 위에 두 계열 묶음 막대. */
function renderGrowthChart(container, growth) {
  container.innerHTML = "";
  const users = growth.newUsersDaily || [];
  const events = growth.newEventsDaily || [];
  const byDate = {};
  users.forEach((r) => { (byDate[r.date] = byDate[r.date] || { u: 0, e: 0 }).u = r.count; });
  events.forEach((r) => { (byDate[r.date] = byDate[r.date] || { u: 0, e: 0 }).e = r.count; });
  const dates = Object.keys(byDate).sort();
  if (!dates.length) {
    container.innerHTML = `<p class="hint" style="margin:0;">이 기간에는 신규 가입/일정이 없습니다.</p>`;
    return;
  }
  const width = 900, height = 170;
  const padding = { top: 10, right: 10, bottom: 24, left: 30 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const maxVal = Math.max(1, ...dates.map((d) => Math.max(byDate[d].u, byDate[d].e)));
  const group = chartW / dates.length;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "admin-chart-svg");
  svg.setAttribute("preserveAspectRatio", "none");

  [0, 0.5, 1].forEach((frac) => {
    const y = padding.top + chartH * (1 - frac);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", padding.left); line.setAttribute("x2", width - padding.right);
    line.setAttribute("y1", y); line.setAttribute("y2", y);
    line.setAttribute("class", "admin-chart-gridline");
    svg.appendChild(line);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", padding.left - 6); label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "admin-chart-axis-label");
    label.textContent = Math.round(maxVal * frac);
    svg.appendChild(label);
  });

  const stride = Math.max(1, Math.ceil(dates.length / 10));
  dates.forEach((date, i) => {
    const { u, e } = byDate[date];
    const x0 = padding.left + i * group;
    [[e, "admin-chart-bar", 0], [u, "admin-chart-bar2", 1]].forEach(([v, cls, slot]) => {
      const h = (v / maxVal) * chartH;
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", x0 + group * (0.15 + slot * 0.36));
      rect.setAttribute("y", padding.top + chartH - h);
      rect.setAttribute("width", Math.max(1, group * 0.32));
      rect.setAttribute("height", Math.max(0, h));
      rect.setAttribute("class", cls);
      const t = document.createElementNS(svgNS, "title");
      t.textContent = `${date}: 신규 일정 ${e}건, 신규 가입 ${u}명`;
      rect.appendChild(t);
      svg.appendChild(rect);
    });
    if (dates.length <= 14 || i % stride === 0) {
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", x0 + group / 2);
      label.setAttribute("y", height - 6);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "admin-chart-axis-label");
      label.textContent = date.slice(5);
      svg.appendChild(label);
    }
  });
  container.appendChild(svg);
}

function renderTopPaths(container, topPaths) {
  container.innerHTML = "";
  if (!topPaths.length) {
    container.innerHTML = `<p class="hint" style="margin:0;">아직 기록이 없습니다.</p>`;
    return;
  }
  topPaths.forEach((p) => {
    const row = document.createElement("div");
    row.className = "admin-top-path-row";
    row.innerHTML = `<span class="admin-top-path-path">${esc(p.path)}</span><span class="admin-top-path-count">${p.count.toLocaleString()}</span>`;
    container.appendChild(row);
  });
}

async function loadStats() {
  try {
    const stats = await api.get(`/api/admin/stats?days=${currentDays}`);
    renderStatCards(stats);
    renderTrafficChart(document.getElementById("admin-traffic-chart"), stats.dailyTraffic);
    renderTopPaths(document.getElementById("admin-top-paths"), stats.topPaths);
    renderHourlyChart(document.getElementById("admin-hourly-chart"), stats.hourly || []);
    renderStatusDist(document.getElementById("admin-status-dist"), stats.statusGroups || {});
    renderRecentErrors(document.getElementById("admin-recent-errors"), stats.recentErrors || []);
    renderSlowest(document.getElementById("admin-slowest"), (stats.perf && stats.perf.slowest) || []);
    renderBarList(
      document.getElementById("admin-top-users"),
      (stats.topUsers || []).map((u) => ({
        name: u.name || u.email, count: u.count,
        title: `${u.email} · 마지막 활동 ${fmtDateTime(u.lastSeen)}`,
      })),
      { valueLabel: "건" }
    );
    renderBarList(document.getElementById("admin-browsers"), stats.browsers || []);
    renderBarList(document.getElementById("admin-devices"), stats.devices || []);
    renderGrowthChart(document.getElementById("admin-growth-chart"), stats.growth || {});
  } catch (err) {
    showSnackbar(err.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* User list                                                           */
/* ------------------------------------------------------------------ */

let allUsers = [];

function renderUserTable() {
  const tbody = document.getElementById("admin-user-tbody");
  const q = document.getElementById("admin-user-search").value.trim().toLowerCase();
  const visible = allUsers.filter((u) => !q || (u.name || "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  document.getElementById("admin-user-count").textContent = visible.length;

  tbody.innerHTML = "";
  visible.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(u.name || "-")}</td>
      <td>${esc(u.email)}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>${u.numEventsOwned}</td>
      <td>${u.isAdmin ? '<span class="badge" style="background:var(--color-primary);color:#fff;">관리자</span>' : ""}</td>
      <td></td>
    `;
    const actionsTd = tr.lastElementChild;

    const detailBtn = document.createElement("button");
    detailBtn.type = "button";
    detailBtn.className = "btn btn-sm btn-ghost";
    detailBtn.textContent = "상세";
    detailBtn.addEventListener("click", () => openUserDetail(u._id));
    actionsTd.appendChild(detailBtn);

    const roleBtn = document.createElement("button");
    roleBtn.type = "button";
    roleBtn.className = "btn btn-sm " + (u.isAdmin ? "btn-ghost" : "btn-secondary");
    roleBtn.style.marginLeft = "6px";
    roleBtn.textContent = u.isAdmin ? "관리자 해제" : "관리자 지정";
    roleBtn.addEventListener("click", async () => {
      if (!confirm(`${u.name || u.email}님을 ${u.isAdmin ? "관리자에서 해제" : "관리자로 지정"}할까요?`)) return;
      try {
        await api.patch(`/api/admin/users/${u._id}/role`, { isAdmin: !u.isAdmin });
        showSnackbar("변경되었습니다.", "success");
        await loadUsers();
      } catch (err) {
        showSnackbar(err.message, "error");
      }
    });
    actionsTd.appendChild(roleBtn);

    tbody.appendChild(tr);
  });
}

async function loadUsers() {
  try {
    allUsers = await api.get("/api/admin/users");
    renderUserTable();
  } catch (err) {
    showSnackbar(err.message, "error");
  }
}

async function openUserDetail(userId) {
  openDialog("admin-user-detail-dialog");
  const body = document.getElementById("admin-detail-body");
  body.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;
  try {
    const detail = await api.get(`/api/admin/users/${userId}`);
    document.getElementById("admin-detail-title").textContent = detail.name || detail.email;

    const rows = [
      `<div class="cal-detail-row"><span class="cal-detail-label">이메일</span><span>${esc(detail.email)}</span></div>`,
      `<div class="cal-detail-row"><span class="cal-detail-label">가입일</span><span>${fmtDate(detail.createdAt)}</span></div>`,
      `<div class="cal-detail-row"><span class="cal-detail-label">만든 방 수</span><span>${detail.numEventsCreated}</span></div>`,
      // 연동을 꺼 둔 서버에서는 이 줄 자체가 의미가 없으므로 빼 둡니다.
      GOOGLE_CALENDAR_ENABLED
        ? `<div class="cal-detail-row"><span class="cal-detail-label">Google Calendar</span><span>${detail.hasGoogleCalendar ? "연결됨" : "-"}</span></div>`
        : "",
    ];

    const eventsHtml = detail.events.length
      ? detail.events
          .map(
            (e) => `
        <div class="admin-event-row">
          <div>
            <div class="admin-event-name">${esc(e.name)}</div>
            <div class="admin-event-meta">일정 &middot; 응답 ${e.numResponses}명${e.isClosed ? " &middot; 확정됨" : ""}${e.isArchived ? " &middot; 보관됨" : ""}</div>
          </div>
          <a class="btn btn-sm btn-ghost" href="/e/${esc(e.shortId || e._id)}" target="_blank" rel="noopener">열기</a>
        </div>`
          )
          .join("")
      : `<p class="hint">만든 방이 없습니다.</p>`;

    body.innerHTML =
      rows.join("") +
      `<h3 style="font-size: 14px; margin: 16px 0 8px;">보유한 방 (${detail.events.length})</h3>` +
      eventsHtml;
  } catch (err) {
    body.innerHTML = `<p class="hint">불러오지 못했습니다.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* People (members + guests) / rooms - sortable tables & big view      */
/* ------------------------------------------------------------------ */

let peopleData = null; // {summary, people}
let allRooms = [];

const fmtShort = (iso) => (iso ? fmtDate(iso).slice(2) : "-");

function roomStatus(r) {
  if (r.isDeleted) return { key: "deleted", label: "휴지통", cls: "badge-muted" };
  if (r.isArchived) return { key: "archived", label: "보관", cls: "badge-muted" };
  if (r.isClosed) return { key: "closed", label: "확정", cls: "admin-badge-closed" };
  return { key: "open", label: "진행 중", cls: "admin-badge-open" };
}

function roomOwnerHtml(r) {
  if (!r.ownerId) return `<span class="hint-inline">비로그인 생성</span>`;
  const label = esc(r.ownerName || r.ownerEmail || "(탈퇴)");
  return `<button type="button" class="admin-link" data-owner="${esc(r.ownerId)}" title="${esc(r.ownerEmail)}">${label}</button>`;
}

function roomOpenHtml(r) {
  return r.isDeleted
    ? `<span class="hint-inline">-</span>`
    : `<a class="btn btn-sm btn-ghost" href="/e/${esc(r.shortId || r._id)}" target="_blank" rel="noopener">열기</a>`;
}

/* 열 정의: sort(r)는 정렬 값, html(r)은 칸 내용. compact는 대시보드 카드에도 나오는 열. */
const ROOM_COLUMNS = [
  { label: "방 이름", sort: (r) => r.name, html: (r) => `<span class="admin-cell-strong">${esc(r.name || "(이름 없음)")}</span>`, compact: true, wrap: true },
  { label: "주최자", sort: (r) => r.ownerName || r.ownerEmail || "", html: roomOwnerHtml, compact: true },
  { label: "응답", sort: (r) => r.numResponses, html: (r) => `${r.numResponses}`, num: true, compact: true },
  { label: "일정 날짜", sort: (r) => r.firstDate || "", html: (r) => r.firstDate ? `${fmtShort(r.firstDate)}${r.lastDate && fmtDate(r.lastDate) !== fmtDate(r.firstDate) ? ` ~ ${fmtShort(r.lastDate)}` : ""}` : "-" },
  { label: "최근 응답", sort: (r) => r.lastResponseAt || "", html: (r) => fmtShort(r.lastResponseAt) },
  { label: "만든 날", sort: (r) => r.createdAt || "", html: (r) => fmtShort(r.createdAt), compact: true },
  { label: "상태", sort: (r) => roomStatus(r).key, html: (r) => {
      const st = roomStatus(r);
      const extra = (r.blind ? ` <span class="badge badge-muted">비공개</span>` : "") + (r.records ? ` <span class="badge badge-muted">면담기록</span>` : "");
      return `<span class="badge ${st.cls}">${st.label}</span>${extra}`;
    }, compact: true },
  { label: "", html: roomOpenHtml, compact: true },
];

const PEOPLE_COLUMNS = [
  { label: "이름", sort: (p) => p.name || p.email, html: (p) => `<span class="admin-cell-strong">${esc(p.name || "-")}</span>${p.isAdmin ? ` <span class="badge" style="background:var(--color-primary);color:#fff;">관리자</span>` : ""}` },
  { label: "구분", sort: (p) => p.kind, html: (p) => p.kind === "member"
      ? `<span class="badge admin-badge-open">회원</span>${p.alsoGuest ? ` <span class="hint-inline" title="같은 이름으로 비회원 응답도 있어 한 사람으로 셌습니다">+비회원 응답</span>` : ""}`
      : `<span class="badge badge-muted">비회원</span>` },
  { label: "이메일", sort: (p) => p.email || "", html: (p) => esc(p.email || "-") },
  { label: "처음 이용", sort: (p) => p.firstSeen || "", html: (p) => fmtShort(p.firstSeen) },
  { label: "최근 활동", sort: (p) => p.lastActive || "", html: (p) => fmtShort(p.lastActive) },
  { label: "만든 방", sort: (p) => p.eventsOwned, html: (p) => `${p.eventsOwned}`, num: true },
  { label: "응답한 방", sort: (p) => p.eventsResponded, html: (p) => `${p.eventsResponded}`, num: true },
  { label: "", html: () => `<button type="button" class="btn btn-sm btn-ghost" data-detail>상세</button>` },
];

/* 머리글을 누르면 그 열로 정렬 (같은 열을 다시 누르면 방향 반전). */
function renderSortableTable(thead, tbody, columns, rows, sortState, onRow, rerender) {
  thead.innerHTML = "";
  const tr = document.createElement("tr");
  columns.forEach((c, i) => {
    const th = document.createElement("th");
    if (c.num) th.className = "num";
    if (c.sort) {
      const arrow = sortState.col === i ? (sortState.dir > 0 ? " ▲" : " ▼") : "";
      th.innerHTML = `<button type="button" class="admin-sort">${esc(c.label)}${arrow}</button>`;
      th.firstChild.addEventListener("click", () => {
        sortState.dir = sortState.col === i ? -sortState.dir : (c.num || /날|활동|응답|이용/.test(c.label) ? -1 : 1);
        sortState.col = i;
        rerender();
      });
    } else {
      th.textContent = c.label;
    }
    tr.appendChild(th);
  });
  thead.appendChild(tr);

  const col = columns[sortState.col];
  const sorted = col && col.sort
    ? [...rows].sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
        return cmp * sortState.dir;
      })
    : rows;

  tbody.innerHTML = "";
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="hint" style="padding: 14px;">해당하는 항목이 없습니다.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  sorted.forEach((r) => {
    const row = document.createElement("tr");
    row.innerHTML = columns
      .map((c) => `<td class="${[c.num ? "num" : "", c.wrap ? "wrap" : ""].join(" ").trim()}">${c.html(r)}</td>`)
      .join("");
    onRow(row, r);
    frag.appendChild(row);
  });
  tbody.appendChild(frag);
}

function wireRoomRow(tr) {
  tr.querySelectorAll("[data-owner]").forEach((b) =>
    b.addEventListener("click", () => openUserDetail(b.dataset.owner))
  );
}

function wirePersonRow(tr, p) {
  tr.querySelector("[data-detail]").addEventListener("click", () => {
    if (p.kind === "member") openUserDetail(p._id);
    else openGuestDetail(p);
  });
}

function roomMatches(r, filter, q) {
  if (filter !== "all" && roomStatus(r).key !== filter) return false;
  if (!q) return true;
  return [r.name, r.ownerName, r.ownerEmail, r.shortId].some((v) => (v || "").toLowerCase().includes(q));
}

function personMatches(p, filter, q) {
  if (filter !== "all" && p.kind !== filter) return false;
  if (!q) return true;
  return [p.name, p.email].some((v) => (v || "").toLowerCase().includes(q));
}

/* ---- dashboard rooms card ---- */
const roomCardState = { filter: "all", sort: { col: 5, dir: -1 } };

function renderRoomCard() {
  const q = document.getElementById("admin-room-search").value.trim().toLowerCase();
  const rows = allRooms.filter((r) => roomMatches(r, roomCardState.filter, q));
  document.getElementById("admin-room-count").textContent = rows.length;
  const cols = ROOM_COLUMNS.filter((c) => c.compact);
  // 정렬 기준 열 번호는 전체 열 기준이라, 간단 표에서는 위치를 다시 찾습니다.
  const sortCol = ROOM_COLUMNS[roomCardState.sort.col];
  const state = { col: Math.max(0, cols.indexOf(sortCol)), dir: roomCardState.sort.dir };
  renderSortableTable(
    document.getElementById("admin-room-thead"),
    document.getElementById("admin-room-tbody"),
    cols, rows, state, wireRoomRow,
    () => {
      roomCardState.sort = { col: ROOM_COLUMNS.indexOf(cols[state.col]), dir: state.dir };
      renderRoomCard();
    }
  );
}

async function loadRooms() {
  try {
    allRooms = await api.get("/api/admin/events");
    renderRoomCard();
  } catch (err) {
    showSnackbar(err.message, "error");
  }
}

/* ---- big view ---- */
const browse = { mode: null, filter: "all", sort: { col: 0, dir: 1 } };

const BROWSE_FILTERS = {
  people: [["all", "전체"], ["member", "회원"], ["guest", "비회원"]],
  rooms: [["all", "전체"], ["open", "진행 중"], ["closed", "확정"], ["archived", "보관"], ["deleted", "휴지통"]],
};

function browseSummaryHtml() {
  if (browse.mode === "people") {
    const s = (peopleData && peopleData.summary) || {};
    const items = [
      ["누적 이용자", s.total], ["회원", s.members], ["비회원", s.guests],
      ["회원 중 비회원 응답도 있음", s.membersAlsoGuest],
    ];
    return items.map(([k, v]) => `<div class="admin-browse-stat"><span>${k}</span><b>${Number(v || 0).toLocaleString()}</b></div>`).join("") +
      `<p class="hint admin-browse-note">비회원은 시간을 입력할 때 적은 이름으로 셉니다. 같은 이름은 한 사람으로, 회원과 이름이 같으면 그 회원으로 합쳤습니다.</p>`;
  }
  const count = (k) => allRooms.filter((r) => roomStatus(r).key === k).length;
  const totalResp = allRooms.reduce((a, r) => a + r.numResponses, 0);
  const items = [
    ["전체 방", allRooms.length], ["진행 중", count("open")], ["확정", count("closed")],
    ["보관", count("archived")], ["휴지통", count("deleted")], ["누적 응답", totalResp],
  ];
  return items.map(([k, v]) => `<div class="admin-browse-stat"><span>${k}</span><b>${Number(v || 0).toLocaleString()}</b></div>`).join("");
}

function renderBrowse() {
  const q = document.getElementById("admin-browse-search").value.trim().toLowerCase();
  const isPeople = browse.mode === "people";
  const source = isPeople ? (peopleData ? peopleData.people : []) : allRooms;
  const rows = source.filter((r) => (isPeople ? personMatches(r, browse.filter, q) : roomMatches(r, browse.filter, q)));
  document.getElementById("admin-browse-count").textContent = `${rows.length.toLocaleString()}개 표시`;
  document.getElementById("admin-browse-summary").innerHTML = browseSummaryHtml();
  document.querySelectorAll("#admin-browse-filter button").forEach((b) =>
    b.classList.toggle("active", b.dataset.f === browse.filter)
  );
  renderSortableTable(
    document.getElementById("admin-browse-thead"),
    document.getElementById("admin-browse-tbody"),
    isPeople ? PEOPLE_COLUMNS : ROOM_COLUMNS,
    rows, browse.sort,
    isPeople ? wirePersonRow : wireRoomRow,
    renderBrowse
  );
}

async function openBrowse(mode) {
  browse.mode = mode;
  browse.filter = "all";
  browse.sort = mode === "people" ? { col: 4, dir: -1 } : { col: 5, dir: -1 };
  document.getElementById("admin-browse-title").textContent = mode === "people" ? "이용자 (회원 + 비회원)" : "방 목록";
  const search = document.getElementById("admin-browse-search");
  search.value = "";
  search.placeholder = mode === "people" ? "이름 또는 이메일로 검색" : "방 이름, 주최자, 링크 ID로 검색";
  document.getElementById("admin-browse-filter").innerHTML = BROWSE_FILTERS[mode]
    .map(([k, label]) => `<button type="button" data-f="${k}">${label}</button>`)
    .join("");
  document.getElementById("admin-browse-tbody").innerHTML =
    `<tr><td class="hint" style="padding: 14px;"><span class="spinner"></span></td></tr>`;
  openDialog("admin-browse-dialog");
  try {
    if (mode === "people") peopleData = await api.get("/api/admin/people");
    else allRooms = await api.get("/api/admin/events");
    renderBrowse();
  } catch (err) {
    document.getElementById("admin-browse-tbody").innerHTML =
      `<tr><td class="hint" style="padding: 14px;">불러오지 못했습니다: ${esc(err.message)}</td></tr>`;
  }
  search.focus();
}

/* 비회원은 계정이 없어 상세 API가 없습니다 - 목록에 같이 온 응답 방을 보여 줍니다. */
function openGuestDetail(p) {
  openDialog("admin-user-detail-dialog");
  document.getElementById("admin-detail-title").textContent = `${p.name} (비회원)`;
  const rows = [
    `<div class="cal-detail-row"><span class="cal-detail-label">이메일</span><span>${esc(p.email || "-")}</span></div>`,
    `<div class="cal-detail-row"><span class="cal-detail-label">처음 응답</span><span>${fmtDateTime(p.firstSeen)}</span></div>`,
    `<div class="cal-detail-row"><span class="cal-detail-label">최근 응답</span><span>${fmtDateTime(p.lastActive)}</span></div>`,
  ];
  const events = p.events || [];
  const list = events.length
    ? events.map((e) => `
        <div class="admin-event-row">
          <div><div class="admin-event-name">${esc(e.name)}</div>
          <div class="admin-event-meta">${e.isDeleted ? "휴지통" : "일정"}</div></div>
          ${e.isDeleted ? "" : `<a class="btn btn-sm btn-ghost" href="/e/${esc(e.shortId || e._id)}" target="_blank" rel="noopener">열기</a>`}
        </div>`).join("")
    : `<p class="hint">남아 있는 방이 없습니다.</p>`;
  document.getElementById("admin-detail-body").innerHTML =
    rows.join("") + `<h3 style="font-size: 14px; margin: 16px 0 8px;">응답한 방 (${events.length})</h3>` + list;
}

/* ------------------------------------------------------------------ */
/* Recent activity log                                                 */
/* ------------------------------------------------------------------ */

let logsPage = 1;
const LOGS_PAGE_SIZE = 30;

async function loadLogs() {
  try {
    const data = await api.get(`/api/admin/logs?page=${logsPage}&pageSize=${LOGS_PAGE_SIZE}`);
    const tbody = document.getElementById("admin-log-tbody");
    tbody.innerHTML = "";
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="hint" style="padding: 12px;">기록이 없습니다.</td></tr>`;
    } else {
      data.items.forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${fmtDateTime(r.ts)}</td>
          <td>${esc(r.userEmail || "익명")}</td>
          <td>${esc(r.method)}</td>
          <td class="admin-log-path">${esc(r.path)}</td>
          <td>${r.statusCode}</td>
          <td>${r.durationMs}ms</td>
        `;
        tbody.appendChild(tr);
      });
    }

    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    document.getElementById("admin-logs-page-label").textContent = `${data.page} / ${totalPages}`;
    document.getElementById("admin-logs-prev").disabled = data.page <= 1;
    document.getElementById("admin-logs-next").disabled = data.page >= totalPages;
  } catch (err) {
    showSnackbar(err.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* Mail send test                                                      */
/* ------------------------------------------------------------------ */

async function loadMailConfig() {
  try {
    const cfg = await api.get("/api/admin/mail-config");
    document.getElementById("admin-mail-config").textContent = cfg.enabled
      ? `백엔드: ${cfg.backend} · 보내는 주소: ${cfg.sender}`
      : `메일이 설정되어 있지 않습니다 (백엔드: ${cfg.backend}). 콘솔 로그로만 출력됩니다.`;
  } catch (err) {
    document.getElementById("admin-mail-config").textContent = "";
  }
}

async function sendTestMail() {
  const btn = document.getElementById("admin-mail-send");
  const errorEl = document.getElementById("admin-mail-error");
  const resultEl = document.getElementById("admin-mail-result");
  const to = document.getElementById("admin-mail-to").value.trim();
  errorEl.textContent = "";
  resultEl.textContent = "";

  if (!to) {
    errorEl.textContent = "받는 주소를 입력해 주세요.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "보내는 중...";
  try {
    const res = await api.post("/api/admin/test-mail", { to });
    resultEl.textContent = `발송 완료 · ${res.backend} (${res.host}:${res.port}) · ${res.sentAt}`;
    showSnackbar("테스트 메일을 보냈습니다.", "success");
  } catch (err) {
    errorEl.textContent = err.message || "발송하지 못했습니다.";
  } finally {
    btn.disabled = false;
    btn.textContent = "테스트 메일 보내기";
  }
}

/* ------------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", () => {
  loadStats();
  loadUsers();
  loadRooms();
  loadLogs();

  document.getElementById("admin-people-open").addEventListener("click", () => openBrowse("people"));
  document.getElementById("admin-rooms-open").addEventListener("click", () => openBrowse("rooms"));
  document.getElementById("admin-room-search").addEventListener("input", renderRoomCard);
  document.getElementById("admin-room-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    roomCardState.filter = b.dataset.f;
    document.querySelectorAll("#admin-room-filter button").forEach((x) => x.classList.toggle("active", x === b));
    renderRoomCard();
  });
  document.getElementById("admin-browse-search").addEventListener("input", renderBrowse);
  document.getElementById("admin-browse-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    browse.filter = b.dataset.f;
    renderBrowse();
  });
  loadMailConfig();

  document.getElementById("admin-mail-send").addEventListener("click", sendTestMail);
  document.getElementById("admin-mail-to").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendTestMail();
    }
  });

  document.getElementById("admin-traffic-range").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-days]");
    if (!btn) return;
    currentDays = parseInt(btn.dataset.days, 10);
    document.querySelectorAll("#admin-traffic-range button").forEach((b) => b.classList.toggle("active", b === btn));
    loadStats();
  });

  document.getElementById("admin-user-search").addEventListener("input", renderUserTable);

  document.getElementById("admin-logs-refresh").addEventListener("click", () => {
    logsPage = 1;
    loadLogs();
  });
  document.getElementById("admin-logs-prev").addEventListener("click", () => {
    if (logsPage > 1) {
      logsPage--;
      loadLogs();
    }
  });
  document.getElementById("admin-logs-next").addEventListener("click", () => {
    logsPage++;
    loadLogs();
  });
});
