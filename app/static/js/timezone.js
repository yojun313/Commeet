/* 시간대 보기(view timezone).
 *
 * 모든 시각은 서버에 UTC로 저장되고, 화면은 지금까지 브라우저(기기)
 * 시간대로 그렸습니다. 이 모듈은 그 "그리는 시간대"를 고를 수 있게 합니다
 * - 해외 참가자가 자기 시간대로 확인하거나, 주최자가 상대방 시간대로
 * 미리 보는 용도입니다.
 *
 * 선택은 **표시에만** 영향을 줍니다. 격자 칸과 응답은 절대 시각(UTC)으로
 * 저장되므로, 서로 다른 시간대로 보는 참가자들의 선택도 정확히 같은
 * 순간을 가리킵니다.
 *
 * 쓰는 쪽 규칙: 시각을 화면에 보여줄 때는 date.getHours() 같은 로컬 메서드
 * 대신 TZView.parts(date)를 거칩니다.
 */
const TZView = (() => {
  const STORAGE_KEY = "pcts_timezone";

  function deviceZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
    } catch (e) {
      return "Asia/Seoul";
    }
  }

  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  let selected = stored(); // null = 자동(기기 시간대)

  function zone() {
    return selected || deviceZone();
  }

  // Intl.DateTimeFormat 생성은 싸지 않아서 시간대별로 재사용합니다 -
  // 격자 하나에 셀이 수백 개라 매 셀 새로 만들면 눈에 띄게 느립니다.
  const fmtCache = new Map();
  function formatter(tz) {
    if (!fmtCache.has(tz)) {
      fmtCache.set(
        tz,
        new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          weekday: "short",
        })
      );
    }
    return fmtCache.get(tz);
  }

  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /** 선택된 시간대 기준의 벽시계 성분. {year, month(1~12), day, hour, minute, dow(0=일)} */
  function parts(dateLike) {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    const out = {};
    formatter(zone())
      .formatToParts(d)
      .forEach((p) => {
        if (p.type === "year") out.year = Number(p.value);
        else if (p.type === "month") out.month = Number(p.value);
        else if (p.type === "day") out.day = Number(p.value);
        else if (p.type === "hour") out.hour = Number(p.value) % 24; // "24:00" 방지
        else if (p.type === "minute") out.minute = Number(p.value);
        else if (p.type === "weekday") out.dow = DOW[p.value] ?? 0;
      });
    return out;
  }

  function hourFrac(dateLike) {
    const p = parts(dateLike);
    return p.hour + p.minute / 60;
  }

  function isAuto() {
    return selected === null;
  }

  function set(tzOrNull) {
    selected = tzOrNull || null;
    try {
      if (selected) localStorage.setItem(STORAGE_KEY, selected);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* 시크릿 모드 등 - 이번 화면에서만 유지 */
    }
  }

  /** 사람이 읽는 현재 상태. 예: "자동 · Asia/Seoul (내 기기)" */
  function label() {
    return isAuto() ? `자동 · ${deviceZone()} (내 기기)` : zone();
  }

  function optionList() {
    // 자주 쓸 시간대를 앞에, 나머지는 브라우저가 아는 전체 목록.
    const common = [
      "Asia/Seoul",
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Asia/Singapore",
      "Australia/Sydney",
      "UTC",
    ];
    let all = [];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch (e) {
      all = common;
    }
    const rest = all.filter((z) => !common.includes(z));
    return { common, rest };
  }

  /** 셀렉트 UI를 컨테이너에 채웁니다. 바꾸면 저장하고 onChange를 부릅니다. */
  function buildSelector(select, onChange) {
    const { common, rest } = optionList();
    select.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = `자동 · ${deviceZone()} (내 기기)`;
    select.appendChild(auto);

    const g1 = document.createElement("optgroup");
    g1.label = "자주 쓰는 시간대";
    common.forEach((z) => {
      const o = document.createElement("option");
      o.value = z;
      o.textContent = z;
      g1.appendChild(o);
    });
    select.appendChild(g1);

    const g2 = document.createElement("optgroup");
    g2.label = "전체";
    rest.forEach((z) => {
      const o = document.createElement("option");
      o.value = z;
      o.textContent = z;
      g2.appendChild(o);
    });
    select.appendChild(g2);

    select.value = selected || "";
    select.addEventListener("change", () => {
      set(select.value || null);
      onChange();
    });
  }

  return { deviceZone, zone, parts, hourFrac, isAuto, set, label, buildSelector };
})();
