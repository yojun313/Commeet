let profile = null;

function accountRow(account) {
  const wrapper = document.createElement("div");

  const row = document.createElement("div");
  row.className = "calendar-account-row";
  row.innerHTML = `
    <span class="avatar sm">${(account.email || "?")[0].toUpperCase()}</span>
    <div class="info">
      <div class="email">${account.email}</div>
      <div style="font-size: 12px; color: var(--color-text-faint);">Google Calendar</div>
    </div>
    <label class="switch">
      <input type="checkbox" ${account.enabled ? "checked" : ""} data-role="toggle-account" />
      <span class="track"></span>
    </label>
    <button class="btn-icon" type="button" data-role="remove-account" title="연결 해제">🗑</button>
  `;

  row.querySelector('[data-role="toggle-account"]').addEventListener("change", async (e) => {
    await api.post(`/api/user/calendar-accounts/toggle?email=${encodeURIComponent(account.email)}&enabled=${e.target.checked}`);
    showSnackbar("저장되었습니다.", "success");
  });
  row.querySelector('[data-role="remove-account"]').addEventListener("click", async () => {
    if (!confirm("연결을 해제할까요?")) return;
    await api.del(`/api/user/calendar-accounts?email=${encodeURIComponent(account.email)}`);
    loadProfile();
  });

  wrapper.appendChild(row);

  const subCalendars = Object.entries(account.subCalendars || {});
  if (subCalendars.length) {
    const subList = document.createElement("div");
    subList.className = "sub-calendar-list";
    subCalendars.forEach(([calId, sub]) => {
      const subRow = document.createElement("div");
      subRow.className = "sub-calendar-row";
      const label = document.createElement("span");
      label.textContent = sub.name || calId;
      const toggle = document.createElement("label");
      toggle.className = "switch";
      toggle.innerHTML = `<input type="checkbox" ${sub.enabled ? "checked" : ""} /><span class="track"></span>`;
      toggle.querySelector("input").addEventListener("change", async (e) => {
        await api.post(
          `/api/user/calendar-accounts/toggle-sub-calendar?email=${encodeURIComponent(account.email)}&subCalendarId=${encodeURIComponent(calId)}&enabled=${e.target.checked}`
        );
      });
      subRow.appendChild(label);
      subRow.appendChild(toggle);
      subList.appendChild(subRow);
    });
    wrapper.appendChild(subList);
  }

  return wrapper;
}

async function loadProfile() {
  profile = await api.get("/api/user/profile");
  document.getElementById("st-name").value = profile.name || "";
  document.getElementById("st-email").value = profile.email;
  document.getElementById("dac-email").textContent = profile.email;

  if (typeof GOOGLE_CALENDAR_ENABLED !== "undefined" && GOOGLE_CALENDAR_ENABLED) {
    const root = document.getElementById("calendar-accounts-root");
    root.innerHTML = "";
    const accounts = Object.values(profile.calendarAccounts || {});
    if (!accounts.length) {
      root.innerHTML = `<p class="hint">연결된 캘린더가 없습니다.</p>`;
    } else {
      accounts.forEach((account) => root.appendChild(accountRow(account)));
    }

    const options = profile.calendarOptions || {};
    const buffer = options.bufferTime || { enabled: false, time: 15 };
    const wh = options.workingHours || { enabled: false, startTime: 9, endTime: 17 };
    document.getElementById("st-buffer-enabled").checked = buffer.enabled;
    document.getElementById("st-buffer-time").value = buffer.time;
    document.getElementById("st-workinghours-enabled").checked = wh.enabled;
    document.getElementById("st-workinghours-start").value = wh.startTime;
    document.getElementById("st-workinghours-end").value = wh.endTime;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadProfile();

  const params = new URLSearchParams(window.location.search);
  if (params.get("calendar_connected")) showSnackbar("Google Calendar가 연결되었습니다.", "success");
  if (params.get("calendar_error")) showSnackbar("캘린더 연결에 실패했습니다.", "error");

  document.getElementById("st-name").addEventListener("input", () => {
    document.getElementById("st-save-name").style.display = "";
  });
  document.getElementById("st-save-name").addEventListener("click", async () => {
    const name = document.getElementById("st-name").value.trim();
    if (!name) {
      showSnackbar("이름을 입력해 주세요.", "error");
      return;
    }
    await api.patch("/api/user/name", { name });
    document.getElementById("st-save-name").style.display = "none";
    showSnackbar("저장되었습니다.", "success");
  });

  document.getElementById("st-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("st-password-error");
    errorEl.textContent = "";

    const currentPassword = document.getElementById("st-current-password").value;
    const newPassword = document.getElementById("st-new-password").value;
    const confirmPassword = document.getElementById("st-new-password2").value;

    if (newPassword !== confirmPassword) {
      errorEl.textContent = "새 비밀번호가 일치하지 않습니다.";
      return;
    }
    if (newPassword === currentPassword) {
      errorEl.textContent = "현재 비밀번호와 다른 비밀번호를 입력해 주세요.";
      return;
    }

    try {
      await api.patch("/api/user/password", { currentPassword, newPassword });
      e.target.reset();
      showSnackbar("비밀번호가 변경되었습니다.", "success");
    } catch (err) {
      errorEl.textContent = err.message || "비밀번호를 변경하지 못했습니다.";
    }
  });

  const saveOptionsBtn = document.getElementById("st-save-options");
  if (saveOptionsBtn) {
    saveOptionsBtn.addEventListener("click", async () => {
      await api.patch("/api/user/calendar-options", {
        bufferTime: {
          enabled: document.getElementById("st-buffer-enabled").checked,
          time: parseInt(document.getElementById("st-buffer-time").value, 10) || 0,
        },
        workingHours: {
          enabled: document.getElementById("st-workinghours-enabled").checked,
          startTime: parseFloat(document.getElementById("st-workinghours-start").value) || 0,
          endTime: parseFloat(document.getElementById("st-workinghours-end").value) || 24,
        },
      });
      showSnackbar("저장되었습니다.", "success");
    });
  }

  document.getElementById("st-delete-account-btn").addEventListener("click", () => openDialog("delete-account-dialog"));
  document.getElementById("dac-confirm-email").addEventListener("input", (e) => {
    document.getElementById("dac-confirm-btn").disabled = !profile || e.target.value.trim().toLowerCase() !== profile.email;
  });
  document.getElementById("dac-confirm-btn").addEventListener("click", async () => {
    try {
      await api.del("/api/user", { email: document.getElementById("dac-confirm-email").value.trim() });
      window.location.href = "/";
    } catch (err) {
      showSnackbar(err.message, "error");
    }
  });
});
