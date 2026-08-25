function showSnackbar(message, type) {
  const root = document.getElementById("snackbar-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "snackbar" + (type ? " " + type : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

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
