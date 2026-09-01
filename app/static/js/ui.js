function showSnackbar(message, type) {
  const root = document.getElementById("snackbar-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "snackbar" + (type ? " " + type : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* 페이지를 옮겨 가며 보여 줘야 하는 알림.
 *
 * 일정을 만들면 곧바로 새 일정 페이지로 이동하기 때문에, 만들기 창에서
 * 스낵바를 띄워 봐야 그 화면과 함께 사라집니다. 여기에 맡겨 두면 다음
 * 페이지가 뜨자마자 대신 띄워 줍니다. */
const PENDING_SNACKBAR_KEY = "pcts_pending_snackbar";

function queueSnackbar(message, type) {
  try {
    sessionStorage.setItem(PENDING_SNACKBAR_KEY, JSON.stringify({ message, type }));
  } catch (e) {
    // sessionStorage를 못 쓰면 알림 하나 못 보여 줄 뿐이므로 그냥 넘어갑니다.
  }
}

function flushQueuedSnackbar() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(PENDING_SNACKBAR_KEY);
    sessionStorage.removeItem(PENDING_SNACKBAR_KEY);
  } catch (e) {
    return;
  }
  if (!raw) return;
  try {
    const { message, type } = JSON.parse(raw);
    if (message) showSnackbar(message, type);
  } catch (e) {
    // 남은 값이 깨졌으면 이미 지웠으니 그대로 둡니다.
  }
}

/* 뒤로 가기로 돌아왔을 때 목록을 다시 불러오기.
 *
 * 브라우저가 페이지 전체를 통째로 얼려 뒀다가(bfcache) 되살리면 스크립트가
 * 다시 실행되지 않습니다. 그러면 일정을 만들고 뒤로 온 대시보드가 만들기
 * 전 상태 그대로입니다. pageshow의 persisted가 그 복원을 알려 줍니다.
 * (API 응답 캐시는 서버가 no-store로 막습니다 - app/main.py) */
const pageRestoreHandlers = [];

function onPageRestore(fn) {
  pageRestoreHandlers.push(fn);
}

window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return; // 평범한 첫 로드는 각 페이지가 알아서 불러옵니다.
  pageRestoreHandlers.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      /* 한 화면이 실패해도 나머지는 새로 고쳐지게 둡니다. */
    }
  });
});

function openDialog(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("open");
}

function closeDialog(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("open");
}

document.addEventListener("click", (e) => {
  document.querySelectorAll(".dialog-backdrop.open").forEach((backdrop) => {
    if (e.target === backdrop) backdrop.classList.remove("open");
  });
  const closeBtn = e.target.closest("[data-dialog-close]");
  if (closeBtn) {
    const backdrop = closeBtn.closest(".dialog-backdrop");
    if (backdrop) backdrop.classList.remove("open");
  }
});

document.addEventListener("DOMContentLoaded", () => {
  flushQueuedSnackbar();

  const trigger = document.querySelector("[data-user-menu-trigger]");
  const dropdown = document.querySelector("[data-user-menu-dropdown]");
  if (trigger && dropdown) {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
    document.addEventListener("click", () => dropdown.classList.remove("open"));
  }

  const signOutBtn = document.querySelector("[data-sign-out]");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      try {
        await api.post("/api/auth/logout");
      } catch (e) {
        /* ignore */
      }
      window.location.href = "/";
    });
  }

  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("pcts_theme", next);
      } catch (e) {
        /* localStorage unavailable - theme still applies for this page view */
      }
    });
  }
});
