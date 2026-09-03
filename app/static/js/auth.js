// 로그인/가입이 끝난 뒤 돌아갈 곳. 초대 링크(/e/...)로 들어왔다가
// 로그인 화면으로 튕긴 사람을 원래 링크로 되돌려 보냅니다.
// 서버 쪽 같은 규칙은 app/core/redirects.py 의 safe_next 를 보세요.
function nextUrl() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  // Only allow internal paths, so a crafted ?next= can't bounce users off-site.
  // "//evil.com" 과 "/\\evil.com" 은 브라우저가 외부 주소로 읽습니다.
  if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) {
    return next;
  }
  return "/home";
}

/* "다시 발송"의 연타 방지. 보내고 나면 30초 동안 남은 초를 보여 주며 잠급니다 -
   메일이 늦게 오는 동안 여러 번 눌러 코드가 계속 바뀌는 것을 막습니다
   (새 코드가 발송되면 이전 코드는 무효가 됩니다). */
function startResendCooldown(btn, seconds) {
  const label = btn.textContent;
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    btn.textContent = `다시 발송 (${left}초 후 가능)`;
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
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
} else if (AUTH_MODE === "sign-up") {
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

  document.getElementById("verify-resend").addEventListener("click", async () => {
    const btn = document.getElementById("verify-resend");
    const errorEl = document.getElementById("verify-error");
    errorEl.textContent = "";
    btn.disabled = true;
    try {
      // 1단계 폼은 숨겨져 있을 뿐 값이 남아 있어 그대로 다시 보냅니다.
      await api.post("/api/auth/signup/send-code", {
        email: pendingEmail,
        password: document.getElementById("signup-password").value,
        name: document.getElementById("signup-name").value.trim(),
      });
      showSnackbar("인증 코드를 다시 보냈습니다.", "success");
      startResendCooldown(btn, 30);
    } catch (err) {
      errorEl.textContent = err.message || "코드를 다시 보내지 못했습니다.";
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 비밀번호 재설정 (/reset-password)                                     */
/* ------------------------------------------------------------------ */
if (AUTH_MODE === "reset") {
  const emailForm = document.getElementById("reset-form");
  const verifyForm = document.getElementById("reset-verify-form");
  const steps = document.getElementById("reset-steps");
  let resetEmail = null;

  function showResetStep(n) {
    emailForm.style.display = n === 1 ? "" : "none";
    verifyForm.style.display = n === 2 ? "" : "none";
    steps.querySelectorAll("li").forEach((li) => {
      li.classList.toggle("active", Number(li.dataset.step) === n);
      li.classList.toggle("done", Number(li.dataset.step) < n);
    });
  }

  async function sendResetCode() {
    resetEmail = document.getElementById("reset-email").value.trim();
    await api.post("/api/auth/password-reset/send-code", { email: resetEmail });
  }

  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("reset-error");
    const submitBtn = document.getElementById("reset-submit");
    errorEl.textContent = "";
    submitBtn.disabled = true;
    try {
      await sendResetCode();
      document.getElementById("reset-verify-email").textContent = resetEmail;
      document.getElementById("reset-code").value = "";
      document.getElementById("reset-verify-error").textContent = "";
      showResetStep(2);
      document.getElementById("reset-code").focus();
      showSnackbar("재설정 코드를 메일로 보냈습니다.", "success");
    } catch (err) {
      errorEl.textContent = err.message || "코드를 보내지 못했습니다.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  verifyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("reset-verify-error");
    const submitBtn = document.getElementById("reset-verify-submit");
    errorEl.textContent = "";
    submitBtn.disabled = true;
    try {
      // 성공하면 서버가 세션 쿠키까지 심어 줍니다 - 방금 이메일 소유를
      // 증명한 사람을 로그인 화면으로 되돌릴 이유가 없습니다.
      await api.post("/api/auth/password-reset/verify", {
        email: resetEmail,
        code: document.getElementById("reset-code").value.trim(),
        newPassword: document.getElementById("reset-new-password").value,
      });
      queueSnackbar("비밀번호를 바꿨습니다.", "success");
      window.location.href = nextUrl();
    } catch (err) {
      errorEl.textContent = err.message || "재설정에 실패했습니다.";
      submitBtn.disabled = false;
    }
  });

  document.getElementById("reset-back").addEventListener("click", () => showResetStep(1));

  document.getElementById("reset-resend").addEventListener("click", async () => {
    const btn = document.getElementById("reset-resend");
    const errorEl = document.getElementById("reset-verify-error");
    errorEl.textContent = "";
    btn.disabled = true;
    try {
      await sendResetCode();
      showSnackbar("재설정 코드를 다시 보냈습니다.", "success");
      startResendCooldown(btn, 30);
    } catch (err) {
      errorEl.textContent = err.message || "코드를 다시 보내지 못했습니다.";
      btn.disabled = false;
    }
  });
}
