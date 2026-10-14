let profile = null;

async function loadProfile() {
  profile = await api.get("/api/user/profile");
  document.getElementById("st-name").value = profile.name || "";
  document.getElementById("st-email").value = profile.email;
  document.getElementById("dac-email").textContent = profile.email;
  document.getElementById("st-professor").checked = !!profile.professorFeatures;
}

document.addEventListener("DOMContentLoaded", () => {
  loadProfile();

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

  document.getElementById("st-professor").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    try {
      await api.patch("/api/user/professor-features", { enabled });
      window.PROFESSOR_FEATURES = enabled;
      showSnackbar(enabled ? "교수용 기능을 켰습니다." : "교수용 기능을 껐습니다.", "success");
    } catch (err) {
      e.target.checked = !enabled;
      showSnackbar(err.message || "저장하지 못했습니다.", "error");
    }
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
