function nextUrl() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  // Only allow internal paths, so a crafted ?next= can't bounce users off-site.
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/home";
}

if (AUTH_MODE === "sign-in") {
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("auth-error");
    const submitBtn = document.getElementById("auth-submit");
    errorEl.textContent = "";
    submitBtn.disabled = true;

    try {
      await api.post("/api/auth/login", {
        email: document.getElementById("auth-email").value.trim(),
        password: document.getElementById("auth-password").value,
      });
      window.location.href = nextUrl();
    } catch (err) {
      errorEl.textContent = err.message || "로그인에 실패했습니다.";
      submitBtn.disabled = false;
    }
  });
} else {
  const signupForm = document.getElementById("signup-form");
  const verifyForm = document.getElementById("verify-form");
  const steps = document.getElementById("signup-steps");
  let pendingEmail = null;

  function showStep(n) {
    signupForm.style.display = n === 1 ? "" : "none";
    verifyForm.style.display = n === 2 ? "" : "none";
    steps.querySelectorAll("li").forEach((li) => {
      li.classList.toggle("active", Number(li.dataset.step) === n);
      li.classList.toggle("done", Number(li.dataset.step) < n);
    });
  }

  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("signup-error");
    const submitBtn = document.getElementById("signup-submit");
    errorEl.textContent = "";

    const name = document.getElementById("signup-name").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;

    if (!name) {
      errorEl.textContent = "이름을 입력해 주세요.";
      return;
    }

    submitBtn.disabled = true;
    try {
      await api.post("/api/auth/signup/send-code", { email, password, name });
      pendingEmail = email;
      document.getElementById("verify-email").textContent = email;
      document.getElementById("verify-code").value = "";
      document.getElementById("verify-error").textContent = "";
      showStep(2);
      document.getElementById("verify-code").focus();
      showSnackbar("인증 코드를 메일로 보냈습니다.", "success");
    } catch (err) {
      errorEl.textContent = err.message || "인증 코드를 보내지 못했습니다.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  verifyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("verify-error");
    const submitBtn = document.getElementById("verify-submit");
    errorEl.textContent = "";
    submitBtn.disabled = true;

    try {
      await api.post("/api/auth/signup/verify", {
        email: pendingEmail,
        code: document.getElementById("verify-code").value.trim(),
      });
      window.location.href = nextUrl();
    } catch (err) {
      errorEl.textContent = err.message || "인증에 실패했습니다.";
      submitBtn.disabled = false;
    }
  });

  document.getElementById("verify-back").addEventListener("click", () => showStep(1));
}
