/* 영문 보기 (헤더의 EN 버튼).
 *
 * 화면 글자는 템플릿·JS·서버 메시지 곳곳에 한국어로 직접 적혀 있어서, 그것을
 * 모두 키로 바꾸는 대신 **화면에 그려진 한국어를 사전으로 바꿔 보여 주는**
 * 방식을 씁니다. 사전은 i18n-en.js(window.I18N_EN)에 있고, 영문을 고른
 * 사람에게만 내려갑니다 (base.html).
 *
 *  - 정확히 같은 문장 → 사전 값
 *  - "{0}명 응답"처럼 값이 끼어드는 문장 → 패턴으로 맞춰 끼어든 값만 다시 번역
 *  - 그래도 남은 것 → 날짜·시각·"3명" 같은 공통 규칙과 긴 구절 치환
 *
 * 나중에 생기는 글자(스낵바, JS가 그리는 목록, confirm 창)도 MutationObserver와
 * alert/confirm/prompt 감싸기로 같은 규칙을 탑니다. 사용자가 적은 내용(일정
 * 이름·설명 등)은 translate="no"가 붙은 곳에서 건드리지 않습니다. 뜻이 둘인
 * 짧은 낱말("월" = 월요일 / 월간)은 그 요소에 data-en으로 영문을 직접 적습니다.
 *
 * 사전에 빠진 문장은 `scripts/i18n_check.py`로 찾습니다. */
(function () {
  "use strict";

  const DICT = window.I18N_EN;
  if (!DICT) return;

  const HANGUL = /[가-힣]/;
  const exact = new Map();
  const patterns = [];
  const phrases = [];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  for (const [ko, en] of Object.entries(DICT)) {
    if (en === null) continue; // 공통 규칙이 처리합니다
    if (!/\{\d\}/.test(ko)) {
      exact.set(ko, en);
      // 문장 일부로 끼어 있어도 바꿀 만큼 긴 구절만 (짧은 낱말은 오역 위험)
      if (ko.replace(/[^가-힣]/g, "").length >= 4) phrases.push([ko, en]);
      continue;
    }
    const order = [];
    let literal = "";
    const parts = ko.split(/(\{\d\})/);
    const source = parts
      .map((part, i) => {
        const m = /^\{(\d)\}$/.exec(part);
        if (m) {
          order.push(Number(m[1]));
          return "(.*?)";
        }
        if (part.length > literal.length) literal = part;
        let re = escapeRe(part);
        // 끝에 붙는 값이 비면 그 앞 공백도 화면에서 사라집니다 ("... 없습니다. {0}").
        if (i === parts.length - 3 && parts[i + 2] === "" && re.endsWith(" ")) re = re.slice(0, -1) + " ?";
        return re;
      })
      .join("");
    // 자리표시자만 있거나 서로 붙어 있으면 무엇이든 맞아 버립니다.
    if (!HANGUL.test(literal) || /\(\.\*\?\)\(\.\*\?\)/.test(source)) continue;
    // "{0}원", "{0}명"처럼 한두 글자가 바로 붙는 자리는 이름("오채원")에도
    // 맞아 버리므로, 그 자리에는 숫자 같은 값만 받습니다.
    const short = ko.replace(/[^가-힣]/g, "").length <= 2;
    const strict = [];
    ko.replace(/\{\d\}/g, (hole, at) => {
      const before = ko[at - 1] || "";
      const after = ko[at + hole.length] || "";
      strict.push(short && (HANGUL.test(before) || HANGUL.test(after)));
      return hole;
    });
    patterns.push({ re: new RegExp("^" + source + "$"), order, en, strict, literal: literal.trim(), weight: ko.length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  phrases.sort((a, b) => b[0].length - a[0].length);

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = { 일: "Sun", 월: "Mon", 화: "Tue", 수: "Wed", 목: "Thu", 금: "Fri", 토: "Sat" };
  const ampm = (p, h, mm) => `${h}${mm ? ":" + mm : ""} ${p === "오전" ? "AM" : "PM"}`;

  // 순서가 중요합니다 - 긴 형식(연·월·일)을 먼저 바꿔야 "월"만 따로 남지 않습니다.
  const RULES = [
    [/(\d{4})년 (\d{1,2})월 (\d{1,2})일/g, (_, y, m, d) => `${MON[m - 1]} ${d}, ${y}`],
    [/(\d{4})년 (\d{1,2})월/g, (_, y, m) => `${MONTH[m - 1]} ${y}`],
    [/(\d{1,2})월 (\d{1,2})일/g, (_, m, d) => `${MON[m - 1]} ${d}`],
    [/(\d{1,2})월/g, (_, m) => MONTH[m - 1] || _],
    [/- (\d{1,2})일/g, "- $1"],
    [/(오전|오후) ?(\d{1,2}):(\d{2})/g, (_, p, h, mm) => ampm(p, h, mm)],
    [/(오전|오후) ?(\d{1,2})시/g, (_, p, h) => ampm(p, h)],
    [/(오전|오후)/g, (p) => (p === "오전" ? "AM" : "PM")],
    [/\(([일월화수목금토])\)/g, (_, d) => `(${DOW[d]})`],
    [/(\d+)시간 (\d+)분/g, "$1 hr $2 min"],
    [/(\d+)시간/g, "$1 hr"],
    [/(\d+)분/g, "$1 min"],
    [/(\d{1,2})시/g, "$1:00"],
    [/(\d+)초/g, "$1s"],
    [/(\d[\d,]*)원/g, "₩$1"],
    [/(\d[\d,]*)명/g, "$1 people"],
    [/(\d[\d,]*)(건|개|통)/g, "$1"],
    [/(\d+)일/g, "$1 days"],
    [/(\d+)회/g, "$1×"],
    [/(\S+)님/g, "$1"],
  ];
  const PLURAL = /\b1 (people|responses|records|meetings|days|emails|requests|events|items|students|attendees)\b/g;
  const SINGULAR = { people: "person", responses: "response", records: "record", meetings: "meeting", days: "day", emails: "email", requests: "request", events: "event", items: "item", students: "student", attendees: "attendee" };
  const fixPlural = (s) => s.replace(PLURAL, (_, w) => "1 " + SINGULAR[w]);

  const cache = new Map();

  function translateCore(text, depth) {
    const key = norm(text);
    if (!key || !HANGUL.test(key)) return text;
    if (exact.has(key)) return exact.get(key);
    if (depth < 3) {
      for (const p of patterns) {
        if (p.literal && !key.includes(p.literal)) continue;
        const m = p.re.exec(key);
        // 값이 " · " 구분자를 넘어가면 다른 낱말까지 삼킨 것 - 아래에서 나눠 봅니다.
        if (!m || m.slice(1).some((v, i) => (p.strict[i] && HANGUL.test(v)) || v.includes(" · "))) continue;
        const values = {};
        p.order.forEach((n, i) => {
          values[n] = translateCore(m[i + 1], depth + 1);
        });
        return p.en.replace(/\{(\d)\}/g, (_, n) => (values[n] !== undefined ? values[n] : ""));
      }
    }
    // "박사 · 컴퓨터공학과 · 재학"처럼 낱말을 이어 붙인 것은 하나씩.
    if (key.includes(" · ")) {
      return key
        .split(" · ")
        .map((part) => translateCore(part, depth + 1))
        .join(" · ");
    }
    // 정렬 표시(▼) 같은 꼬리표가 붙은 머리글
    const tail = /^(.*?[가-힣].*?)(\s*[▼▲▾▴↑↓]+)$/.exec(key);
    if (tail) return translateCore(tail[1], depth + 1) + tail[2];
    // 마지막 수단: 공통 규칙과 긴 구절. 줄바꿈은 그대로 둡니다 (confirm 창).
    let out = text;
    for (const [ko, en] of phrases) {
      if (out.includes(ko)) out = out.split(ko).join(en);
      if (!HANGUL.test(out)) break;
    }
    for (const [re, rep] of RULES) {
      if (!HANGUL.test(out)) break;
      out = out.replace(re, rep);
    }
    return out;
  }

  function translate(text) {
    if (typeof text !== "string" || !HANGUL.test(text)) return text;
    if (cache.has(text)) return cache.get(text);
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    let out = fixPlural(translateCore(text, 0));
    // 원래 공백을 되살립니다. 한국어는 조사가 앞말에 붙어 공백이 없던 조각
    // ("<b>이름</b>을 끌면")도 영어로는 띄어야 하므로, 사전 값에 적힌 앞뒤
    // 공백은 원래 공백이 없을 때 그대로 씁니다.
    if (out !== text) {
      if (lead) out = out.replace(/^\s+/, "");
      if (trail) out = out.replace(/\s+$/, "");
      out = lead + out + trail;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
    return out;
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT"]);
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function skipped(el) {
    return !el || SKIP_TAGS.has(el.tagName) || !!el.closest('[translate="no"], [contenteditable="true"]');
  }
  // 입력칸 안내문은 textarea에도 바꿉니다 (안의 글자는 사용자가 쓴 것이라 그대로).
  const attrsSkipped = (el) => !el || !!el.closest('[translate="no"], [contenteditable="true"]');

  function translateText(node) {
    const v = node.nodeValue;
    if (!v || !HANGUL.test(v) || skipped(node.parentElement)) return;
    const t = translate(v);
    if (t !== v) node.nodeValue = t;
  }

  function translateAttrs(el) {
    if (attrsSkipped(el)) return;
    // 같은 낱말이 뜻이 둘인 곳("월" = 월요일 / 월간)은 화면에 직접 영문을 적어 둡니다.
    const fixed = el.getAttribute("data-en");
    if (fixed !== null && el.textContent !== fixed) el.textContent = fixed;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && HANGUL.test(v)) {
        const t = translate(v);
        if (t !== v) el.setAttribute(a, t);
      }
    }
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && HANGUL.test(el.value)) {
      el.value = translate(el.value);
    }
  }

  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateText(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    translateAttrs(root);
    if (SKIP_TAGS.has(root.tagName)) return;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.getAttribute("translate") === "no") return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(n.tagName)) {
            translateAttrs(n);
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        return HANGUL.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n = it.nextNode();
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) translateText(n);
      else translateAttrs(n);
      n = it.nextNode();
    }
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") r.addedNodes.forEach(walk);
      else if (r.type === "characterData") translateText(r.target);
      else if (r.type === "attributes") translateAttrs(r.target);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS.concat(["value"]),
  });

  for (const fn of ["alert", "confirm", "prompt"]) {
    const original = window[fn].bind(window);
    window[fn] = (message, ...rest) => original(translate(String(message ?? "")), ...rest);
  }

  function reveal() {
    walk(document.documentElement);
    document.documentElement.classList.remove("i18n-pending");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reveal);
  else reveal();
  // 무슨 일이 있어도 화면이 숨겨진 채로 남지 않게.
  setTimeout(() => document.documentElement.classList.remove("i18n-pending"), 1500);

  window.I18N = { translate };
})();
