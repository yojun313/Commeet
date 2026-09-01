/* 여러 사람이 함께 보는 화면을 새로고침 없이 최신 상태로 유지하는 공용 루프.
 *
 * 화면마다 "서버 상태가 지금 몇 번째인가"를 알려 주는 값싼 엔드포인트가
 * 하나씩 있습니다 (일정: /api/events/{id}/version, 대시보드·캘린더:
 * /api/user/events/version). 이 루프는 그것만 주기적으로 두드리다가 값이
 * 달라졌을 때에만 진짜 데이터를 다시 받습니다. 무거운 조회 자체를 몇 초마다
 * 반복하면 트래픽이 감당이 안 되기 때문입니다 - 응답 목록 하나가 응답자
 * 한 명당 ISO 문자열 수백 개입니다.
 *
 * 어느 화면에서든 공통으로 지키는 것:
 *
 *  - 탭이 안 보이면 아예 멈춥니다. 사람들은 페이지를 열어 둔 채 딴 일을
 *    하기 때문에, 실제 요청 수를 가장 크게 줄이는 것이 이 규칙입니다.
 *    다시 보이는 순간 기다리지 않고 한 번 확인합니다.
 *  - 아무 일도 없으면 간격을 5초에서 30초까지 늘립니다. 변화가 보이면
 *    다시 5초로 돌아옵니다.
 *  - 사용자가 편집 중이면(isBusy) 손대지 않습니다. 저장하지 않은 입력을
 *    다시 그리기로 날려 버리는 것이 자동 갱신에서 가장 흔한 사고입니다.
 *  - 요청이 겹치지 않습니다.
 *
 * 서버 쪽 짝은 app/services/event_service.py의 버전 카운터와 app/main.py의
 * bump_event_version_middleware입니다.
 */

const LIVE_MIN_MS = 5000;
const LIVE_MAX_MS = 30000;

// 다이얼로그가 떠 있는 동안에는 그 뒤를 다시 그리지 않습니다. 삭제 확인이나
// 폴더 만들기 도중에 목록이 통째로 바뀌면, 무엇에 대해 확인을 누르고 있었는지
// 알 수 없게 됩니다.
function liveDialogOpen() {
  return !!document.querySelector(".dialog-backdrop.open");
}

// 카드를 끌고 있는 중 (card-sort.js가 body에 붙이는 표시).
function liveDragging() {
  return document.body.classList.contains("dragging-active");
}

/* 옵션
 *   url       버전 엔드포인트. 문자열이거나, 문자열을 돌려주는 함수.
 *   onChange  버전이 달라졌을 때 부를 함수 (async 가능). 여기서 실제
 *             데이터를 다시 받아 화면을 갱신합니다.
 *   isBusy    (선택) true면 이번 차례를 건너뜁니다. 편집 중 보호용.
 *   onGone    (선택) 404/401/403 - 볼 권한이 없어졌거나 사라진 경우.
 *             호출되면 루프는 멈춘 상태입니다.
 */
function createLiveRefresh(opts) {
  const state = {
    version: null, // 마지막으로 화면에 반영한 서버 버전
    delay: LIVE_MIN_MS,
    timer: null,
    running: false,
    busy: false, // 요청이 아직 안 끝났는가
  };

  function stop() {
    state.running = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function schedule(delay) {
    if (!state.running) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(tick, delay);
  }

  function start() {
    stop();
    state.running = true;
    state.delay = LIVE_MIN_MS;
    schedule(LIVE_MIN_MS);
  }

  // 사용자가 방금 뭔가 했거나 탭으로 돌아왔을 때. 늘어나 있던 간격을
  // 되돌려서 남의 변경도 다시 빠르게 따라잡게 합니다.
  function wake(delay) {
    if (!state.running) return;
    state.delay = LIVE_MIN_MS;
    schedule(delay === undefined ? LIVE_MIN_MS : delay);
  }

  // 다른 경로로 최신 데이터를 이미 받았을 때 기준점을 맞춥니다. 이걸 해
  // 두지 않으면 첫 차례에 괜히 한 번 더 받습니다.
  function sync(version) {
    state.version = version === undefined ? null : version;
  }

  async function tick() {
    state.timer = null;
    if (!state.running) return;

    // 안 보이는 탭은 요청하지 않습니다. 다음 차례를 예약하지 않고 그냥
    // 끝내고, 아래 visibilitychange 리스너가 돌아올 때 다시 깨웁니다.
    if (document.hidden) return;

    if (state.busy || (opts.isBusy && opts.isBusy())) {
      schedule(state.delay);
      return;
    }

    state.busy = true;
    try {
      const url = typeof opts.url === "function" ? opts.url() : opts.url;
      const { v } = await api.get(url);
      if (v === state.version) {
        state.delay = Math.min(state.delay * 2, LIVE_MAX_MS);
      } else {
        const previous = state.version;
        // 먼저 옮겨 두고, 갱신이 실패하면 되돌립니다. onChange 안에서
        // sync()로 더 정확한 값을 넣을 수도 있으므로 그쪽이 이깁니다.
        state.version = v;
        state.delay = LIVE_MIN_MS;
        try {
          await opts.onChange(v);
        } catch (err) {
          state.version = previous; // 다음 차례에 다시 시도합니다
          throw err;
        }
      }
    } catch (err) {
      if (err.status === 404 || err.status === 401 || err.status === 403) {
        // 사라졌거나 볼 권한이 없어졌습니다. 계속 두드려 봐야 소용없습니다.
        stop();
        if (opts.onGone) opts.onGone(err);
        return;
      }
      // 네트워크가 끊겼거나 서버가 잠깐 죽은 경우. 조용히 물러섰다가 다시
      // 시도합니다 - 몇 초마다 오류를 띄우면 그게 더 방해됩니다.
      state.delay = Math.min(state.delay * 2, LIVE_MAX_MS);
    } finally {
      state.busy = false;
    }

    schedule(state.delay);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // 자리를 비운 사이에 밀린 변경이 있을 수 있으니 기다리지 않고 바로.
    wake(0);
  });

  return {
    start,
    stop,
    wake,
    sync,
    // 다른 경로의 갱신이 도는 동안 폴링이 같은 조회를 겹쳐 쏘지 않게 합니다.
    setBusy(flag) {
      state.busy = !!flag;
    },
    isRunning() {
      return state.running;
    },
  };
}
