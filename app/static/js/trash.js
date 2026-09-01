/* 휴지통 (/trash).
 *
 * 다른 사람이 응답한 일정을 삭제하면 event_service.delete_event()가 완전히
 * 지우지 않고 isDeleted 플래그만 세웁니다 - 남이 입력한 응답을 파괴하지
 * 않기 위해서입니다. 그렇게 숨겨진 일정을 다시 꺼내 보고, 되돌리거나
 * 완전히 지우는 화면입니다.
 */

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

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}`;
}

function dateRange(event) {
  const dates = (event.dates || []).map((d) => new Date(d)).sort((a, b) => a - b);
  if (!dates.length) return "";
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  return dates.length === 1
    ? fmt(dates[0])
    : `${fmt(dates[0])} ~ ${fmt(dates[dates.length - 1])}`;
}

let deleted = [];
let purgeTarget = null;

function render() {
  const root = document.getElementById("trash-root");
  root.innerHTML = "";

  if (!deleted.length) {
    root.innerHTML = `<div class="empty-state"><div class="icon">🗑</div>휴지통이 비어 있습니다.</div>`;
    return;
  }

  const head = el(
    `<p class="hint" style="margin: 0 0 10px;">${deleted.length}개 · ` +
      "앞으로 있을 일정은 “취소됨”, 이미 지난 일정은 “삭제됨”으로 표시됩니다.</p>"
  );
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "trash-list";

  deleted.forEach((event) => {
    const row = el(`
      <div class="card card-pad trash-row">
        <div class="trash-main">
          <div class="trash-name">
            ${esc(event.name)}
            <span class="badge ${event.isPast ? "badge-muted" : "trash-badge-cancelled"}">${
              esc(event.removalWord || "취소")
            }됨</span>
          </div>
          <div class="trash-meta">
            일정 ·
            ${esc(dateRange(event))} ·
            ${esc(fmtDate(event.createdAt))} 생성
          </div>
          <div class="trash-counts">
            응답 <b>${event.numResponses}</b>건${
              event.numRecords ? ` · 면담 기록 <b>${event.numRecords}</b>건` : ""
            }
          </div>
        </div>
        <div class="trash-actions">
          <button class="btn btn-sm btn-secondary" type="button" data-restore>되돌리기</button>
          <button class="btn btn-sm btn-ghost trash-purge" type="button" data-purge>완전히 삭제</button>
        </div>
      </div>
    `);

    row.querySelector("[data-restore]").addEventListener("click", async () => {
      // 삭제할 때 "취소되었습니다" 안내를 받은 사람들이 있으므로, 되돌릴 때도
      // 정정해 줄지 물어봅니다.
      const notify =
        event.numResponses > 0 &&
        confirm(
          `'${event.name}'을(를) 다시 엽니다.\n\n` +
            "삭제할 때 취소 안내를 받은 참가자에게 '다시 열렸습니다'라고 알릴까요?\n" +
            "(취소를 눌러도 일정은 되돌아옵니다)"
        );
      try {
        const res = await api.post(`/api/events/${event._id}/restore?notify=${notify}`);
        const n = res && res.notifiedCount;
        showSnackbar(
          n
            ? `'${event.name}'을(를) 되돌리고 ${n}명에게 안내를 보냅니다.`
            : `'${event.name}'을(를) 되돌렸습니다.`,
          "success"
        );
        await load();
      } catch (err) {
        showSnackbar(err.message || "되돌리지 못했습니다.", "error");
      }
    });

    row.querySelector("[data-purge]").addEventListener("click", () => {
      purgeTarget = event;
      document.getElementById("purge-target").textContent = event.name;
      // 무엇이 사라지는지 개수까지 보여 주고 확인받습니다 - 되돌릴 수 없으므로
      // "정말요?"만 묻는 것으로는 부족합니다.
      const items = [
        `일정 문서 1건`,
        `참가자 응답 ${event.numResponses}건`,
      ];
      if (event.numRecords) {
        items.push(`면담 기록 ${event.numRecords}건 (첨부한 서명·영수증 파일 포함)`);
      }
      items.push("초대 명단, 폴더 연결");
      document.getElementById("purge-list").innerHTML = items
        .map((t) => `<li>${esc(t)}</li>`)
        .join("");
      openDialog("purge-dialog");
    });

    list.appendChild(row);
  });

  root.appendChild(list);
}

async function load() {
  deleted = await api.get("/api/user/deleted-events");
  render();
}

onPageRestore(() => load().catch(() => {}));

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("confirm-purge-btn").addEventListener("click", async () => {
    if (!purgeTarget) return;
    const btn = document.getElementById("confirm-purge-btn");
    btn.disabled = true;
    try {
      const res = await api.del(`/api/events/${purgeTarget._id}/purge`);
      const r = (res && res.removed) || {};
      closeDialog("purge-dialog");
      showSnackbar(
        `'${purgeTarget.name}'을(를) 완전히 삭제했습니다. ` +
          `(응답 ${r.responses || 0}건, 기록 ${r.records || 0}건)`,
        "success"
      );
      purgeTarget = null;
      await load();
    } catch (err) {
      showSnackbar(err.message || "삭제하지 못했습니다.", "error");
    } finally {
      btn.disabled = false;
    }
  });

  load().catch((e) => showSnackbar(e.message, "error"));
});
