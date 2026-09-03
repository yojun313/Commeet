// Commeet API 클라이언트.
//
// 인증은 Commeet의 평범한 세션 쿠키를 씁니다. 팝업에서 로그인하면 서버가
// Set-Cookie를 내려 주고, 이후 요청은 `credentials: "include"`로 그 쿠키를
// 함께 보냅니다. **비밀번호는 저장하지 않습니다** - 로그인 요청에 한 번 실려
// 갈 뿐이고, 남는 것은 브라우저가 관리하는 세션 쿠키뿐입니다.
//
// 팝업은 확장 페이지라 host_permissions가 있으면 CORS 제약을 받지 않습니다
// (서버의 allow_credentials=False는 이 경로에 영향을 주지 않습니다). 다만
// 세션 쿠키가 SameSite=Lax라, 확장에서 보낸 요청에 쿠키가 실리는지는 크롬
// 버전에 따라 달라질 수 있습니다. 로그인은 됐는데 이후 호출이 401로 돌아온다면
// 그 경우이니, docs/povis-extension-handoff.md의 "인증" 항목을 보세요.

const COMMEET_DEFAULT_BASE = "https://commeet.postech.ac.kr";

class CommeetError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function commeetBaseUrl() {
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  return (baseUrl || COMMEET_DEFAULT_BASE).replace(/\/+$/, "");
}

async function commeetSetBaseUrl(url) {
  await chrome.storage.local.set({ baseUrl: (url || "").trim().replace(/\/+$/, "") });
}

/** 목적격 조사. "비밀번호을(를)" 같은 문장을 만들지 않으려고 받침을 봅니다. */
function objectParticle(word) {
  const last = word.charCodeAt(word.length - 1) - 0xac00;
  if (last < 0 || last > 11171) return "을(를)"; // 한글이 아니면 안전한 형태로
  return last % 28 === 0 ? "를" : "을";
}

/** 서버가 돌려준 에러를 사람이 읽을 문장으로 바꿉니다.
 *
 *  FastAPI의 검증 실패(422)는 `detail`이 문자열이 아니라 pydantic 오류
 *  **배열**입니다. 그대로 찍으면 화면에 `[{"type":"missing",...}]`가 떠서
 *  무엇을 고쳐야 하는지 알 수 없었습니다. 여기서 사람 말로 옮깁니다. */
async function errorMessage(res) {
  let data = null;
  try { data = await res.json(); } catch { /* JSON이 아니면 아래 기본 문구 */ }
  const detail = data?.detail;

  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    const FIELD_NAMES = { email: "이메일", password: "비밀번호", name: "이름", code: "인증 코드" };
    const parts = detail.map((e) => {
      const field = FIELD_NAMES[e?.loc?.[e.loc.length - 1]] || e?.loc?.[e.loc.length - 1] || "입력값";
      if (e?.type === "missing") return `${field}${objectParticle(field)} 입력해 주세요.`;
      if (String(e?.type || "").includes("email")) return "이메일 형식이 올바르지 않습니다.";
      return `${field}: ${e?.msg || "올바르지 않습니다."}`;
    });
    return [...new Set(parts)].join(" ");
  }

  if (res.status === 401) return "로그인이 필요합니다.";
  return `요청이 실패했습니다 (HTTP ${res.status})`;
}

async function commeetFetch(path, { method = "GET", body } = {}) {
  const base = await commeetBaseUrl();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      credentials: "include", // 세션 쿠키
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new CommeetError(`${base}에 연결하지 못했습니다. 주소와 서버 상태를 확인해 주세요.`, 0);
  }

  if (!res.ok) {
    throw new CommeetError(await errorMessage(res), res.status);
  }
  return res.status === 204 ? null : res.json();
}

const Commeet = {
  Error: CommeetError,
  baseUrl: commeetBaseUrl,
  setBaseUrl: commeetSetBaseUrl,

  login: (email, password) =>
    commeetFetch("/api/auth/login", { method: "POST", body: { email, password } }),
  logout: () => commeetFetch("/api/auth/logout", { method: "POST" }),
  profile: () => commeetFetch("/api/user/profile"),

  /** 대시보드에 뜨는 일정. 내가 만든 것만 추립니다 - 면담 기록은 주최자만
   *  쓸 수 있어서, 참여만 한 일정에는 가져올 기록이 없습니다. */
  async myEvents() {
    const events = await commeetFetch("/api/user/events");
    return (events || []).filter((e) => e.isOwner);
  },

  /** 일정별 면담 기록 수: `{eventId: {total, draft}}`.
   *  목록에 "기록 있음"을 표시하려고 씁니다. 서버가 복호화 없이 집계만
   *  하므로, 개수를 알자고 면담 내용을 통째로 받아오지 않습니다. */
  async recordCounts() {
    const data = await commeetFetch("/api/records/counts");
    return data?.counts || {};
  },

  /** 한 일정의 면담 기록. eventId를 반드시 넘겨, 다른 일정의 기록까지
   *  받아오지 않습니다 (면담 내용은 개인정보입니다). */
  async recordsFor(eventId) {
    const data = await commeetFetch(`/api/records?eventId=${encodeURIComponent(eventId)}`);
    return data?.records || [];
  },
};
