"""Optimal appointment assignment for finalizing an event.

The host attends every meeting, so no two meetings may overlap. We therefore
carve each polled day into consecutive, non-overlapping blocks of the meeting
length - any subset of those blocks is conflict-free for the host by
construction. Assigning respondents to blocks then reduces exactly to a
degree-constrained bipartite matching ("b-matching"), which we solve to
optimality with min-cost max-flow:

  * max flow -> schedules the largest possible number of people
  * min cost -> among all such optima, applies the tie-breaks below

비용 우선순위 (위가 절대 우선):

  1. 최대한 많은 사람을 배정한다               <- max flow 자체
  2. "가능(비선호)" 시간 사용을 피한다            <- COST 가중치
  3. **정원까지 꽉 채워 한 번에 모은다**        <- 슬롯별 좌석 수 가중치
  4. 이른 시간을 고른다                        <- 슬롯 순서 tiebreak

3번이 없던 동안에는 4번(이른 시간 선호)이 사람을 흩어 놓았습니다. 정원이
3명이어도 "2명이 가능한 이른 시간 + 1명이 가능한 다른 시간"이 "3명 모두
가능한 늦은 시간"보다 싸게 나왔기 때문입니다.

한 가지 한계: "사람이 모일수록 싸진다"는 구조는 오목(concave)해서 최소비용
유량으로는 표현할 수 없습니다. 그래서 3번은 **슬롯 가격**으로 근사하고
(그 시간에 몇 명이나 앉힐 수 있는가), 남는 경우는 마지막에 실제로 합쳐 보는
_regroup()이 정리합니다.

Complexity is O(F * E log V) with F = number of respondents; for realistic
sizes (tens of people, hundreds of blocks) this runs in milliseconds.
"""

import heapq
from datetime import datetime, timedelta

COST_AVAILABLE = 0
COST_SLOT_TIEBREAK = 1


def _cost_weights(
    num_participants: int, num_slots: int, capacity: int
) -> tuple[int, int]:
    """(모으기 가중치, "가능(비선호)" 가중치).

    각 단계는 **그 아래 단계를 전부 합친 것보다 커야** 순서가 뒤집히지
    않습니다. 고정 상수로 두면 사람이나 후보 시간이 많아질 때 아래 단계의
    합이 위 단계를 넘어설 수 있어, 문제 크기에서 직접 계산합니다.
    """
    # 모든 사람이 가장 늦은 슬롯에 가더라도 이만큼을 넘지 못합니다.
    max_tiebreak = num_participants * max(num_slots, 1) * COST_SLOT_TIEBREAK
    group = max_tiebreak + 1
    # 한 사람의 모으기 벌점은 최대 capacity * group 입니다.
    max_group = num_participants * max(capacity, 1) * group
    if_needed = max_group + max_tiebreak + 1
    return group, if_needed


class _MinCostMaxFlow:
    """Successive shortest paths with Johnson potentials (Dijkstra)."""

    def __init__(self, num_nodes: int) -> None:
        self.n = num_nodes
        # edge = [to, capacity, cost, index of reverse edge]
        self.graph: list[list[list[int]]] = [[] for _ in range(num_nodes)]

    def add_edge(self, u: int, v: int, capacity: int, cost: int) -> None:
        self.graph[u].append([v, capacity, cost, len(self.graph[v])])
        self.graph[v].append([u, 0, -cost, len(self.graph[u]) - 1])

    def solve(self, source: int, sink: int) -> tuple[int, int]:
        inf = float("inf")
        potential = [0] * self.n
        total_flow = 0
        total_cost = 0

        while True:
            dist = [inf] * self.n
            prev_node = [-1] * self.n
            prev_edge = [-1] * self.n
            dist[source] = 0
            queue = [(0, source)]

            while queue:
                d, u = heapq.heappop(queue)
                if d > dist[u]:
                    continue
                for i, (v, cap, cost, _) in enumerate(self.graph[u]):
                    if cap <= 0:
                        continue
                    nd = d + cost + potential[u] - potential[v]
                    if nd < dist[v]:
                        dist[v] = nd
                        prev_node[v] = u
                        prev_edge[v] = i
                        heapq.heappush(queue, (nd, v))

            if dist[sink] == inf:
                break

            for i in range(self.n):
                if dist[i] < inf:
                    potential[i] += dist[i]

            # Bottleneck along the found path
            push = inf
            v = sink
            while v != source:
                push = min(push, self.graph[prev_node[v]][prev_edge[v]][1])
                v = prev_node[v]

            v = sink
            while v != source:
                edge = self.graph[prev_node[v]][prev_edge[v]]
                edge[1] -= push
                self.graph[v][edge[3]][1] += push
                v = prev_node[v]

            total_flow += push
            total_cost += push * potential[sink]

        return total_flow, total_cost


def build_slots(
    day_starts: list[datetime], window_hours: float, meeting_minutes: int
) -> list[tuple[datetime, datetime]]:
    """Splits each polled day into back-to-back meeting-length blocks."""
    if meeting_minutes <= 0:
        return []

    length = timedelta(minutes=meeting_minutes)
    slots: list[tuple[datetime, datetime]] = []

    for day_start in sorted(day_starts):
        window_end = day_start + timedelta(hours=window_hours)
        cursor = day_start
        while cursor + length <= window_end:
            slots.append((cursor, cursor + length))
            cursor += length

    return slots


def covers_slot(
    tick_set: set[datetime],
    slot_start: datetime,
    slot_end: datetime,
    increment_minutes: int,
) -> bool:
    """True when every grid tick inside the block is marked."""
    if increment_minutes <= 0:
        return False
    step = timedelta(minutes=increment_minutes)
    cursor = slot_start
    while cursor < slot_end:
        if cursor not in tick_set:
            return False
        cursor += step
    return True


def assign_participants(
    participant_keys: list[str],
    slots: list[tuple[datetime, datetime]],
    available: dict[str, set[int]],
    if_needed: dict[str, set[int]],
    capacity: int,
) -> tuple[dict[int, list[str]], list[str]]:
    """Assigns each respondent to at most one block, respecting capacity.

    `available` / `if_needed` map a participant key to the set of slot
    indices they can make. Returns ({slot index: [participant keys]},
    [unassignable participant keys]).
    """
    num_participants = len(participant_keys)
    num_slots = len(slots)
    if num_participants == 0 or num_slots == 0 or capacity <= 0:
        return {}, list(participant_keys)

    cost_group, cost_if_needed = _cost_weights(num_participants, num_slots, capacity)

    # 이 시간에 실제로 몇 자리를 채울 수 있는가. 정원이 3명인데 두 명만
    # 올 수 있는 시간은 한 자리가 비게 되므로, 그만큼 비싸게 매깁니다.
    # 이것이 "쪼개지 말고 모아라"를 슬롯 가격으로 표현한 것입니다.
    seats = [0] * num_slots
    for j in range(num_slots):
        fillable = sum(
            1
            for key in participant_keys
            if j in available.get(key, ()) or j in if_needed.get(key, ())
        )
        seats[j] = min(fillable, capacity)

    source = 0
    sink = num_participants + num_slots + 1

    def participant_node(i: int) -> int:
        return 1 + i

    def slot_node(j: int) -> int:
        return 1 + num_participants + j

    flow = _MinCostMaxFlow(sink + 1)

    for i in range(num_participants):
        flow.add_edge(source, participant_node(i), 1, 0)
    for j in range(num_slots):
        flow.add_edge(slot_node(j), sink, capacity, 0)

    # Remember where each participant->slot edge lives so the result can be
    # read back directly instead of inferred from leftover capacity.
    choice_edges: list[tuple[int, int, int]] = []  # (participant, slot, edge index)
    for i, key in enumerate(participant_keys):
        firm = available.get(key, set())
        soft = if_needed.get(key, set())
        node = participant_node(i)
        for j in range(num_slots):
            if j in firm:
                cost = COST_AVAILABLE
            elif j in soft:
                cost = cost_if_needed
            else:
                continue
            cost += (capacity - seats[j]) * cost_group
            choice_edges.append((i, j, len(flow.graph[node])))
            flow.add_edge(node, slot_node(j), 1, cost + j * COST_SLOT_TIEBREAK)

    flow.solve(source, sink)

    meetings: dict[int, list[str]] = {}
    assigned: set[str] = set()
    for i, j, edge_index in choice_edges:
        key = participant_keys[i]
        if key in assigned:
            continue
        # Capacity fully consumed on a unit-capacity edge means it carries flow.
        if flow.graph[participant_node(i)][edge_index][1] == 0:
            meetings.setdefault(j, []).append(key)
            assigned.add(key)

    meetings = _regroup(meetings, available, if_needed, capacity, num_slots)

    unassigned = [k for k in participant_keys if k not in assigned]
    return meetings, unassigned


def _if_needed_count(
    people: list[str], slot: int, available: dict[str, set[int]]
) -> int:
    """그 시간에 배정하면 몇 명이 "가능(비선호)" 시간을 쓰게 되는가."""
    return sum(1 for key in people if slot not in available.get(key, ()))


def _regroup(
    meetings: dict[int, list[str]],
    available: dict[str, set[int]],
    if_needed: dict[str, set[int]],
    capacity: int,
    num_slots: int,
) -> dict[int, list[str]]:
    """정원을 못 채운 모임끼리 합칠 수 있으면 합칩니다.

    최소비용 유량은 "사람이 모일수록 싸진다"를 표현할 수 없어(오목 비용),
    슬롯 가격으로 근사할 수밖에 없습니다. 근사가 놓친 조합을 여기서 실제로
    합쳐 봅니다 - 두 모임을 합쳐 정원 안에 들어가고 **전원이 참석 가능한**
    시간이 있으면 옮깁니다.

    아무도 배정에서 빼지 않으므로 배정 인원 수는 절대 줄지 않고,
    "가능(비선호)"을 쓰는 사람 수도 늘리지 않습니다.
    """
    if capacity <= 1:
        return meetings  # 1:1 면담은 합칠 것이 없습니다

    def eligible(key: str, slot: int) -> bool:
        return slot in available.get(key, ()) or slot in if_needed.get(key, ())

    changed = True
    while changed:
        changed = False
        # 작은 모임부터 - 흡수되어 사라질 후보입니다.
        order = sorted(meetings, key=lambda j: (len(meetings[j]), j))
        for a in order:
            if a not in meetings:
                continue
            for b in order:
                if b == a or a not in meetings or b not in meetings:
                    continue
                people = meetings[a] + meetings[b]
                if len(people) > capacity:
                    continue

                before = _if_needed_count(meetings[a], a, available) + _if_needed_count(
                    meetings[b], b, available
                )

                # 옮겨 갈 수 있는 시간: 두 모임이 쓰던 자리이거나, 아무도
                # 쓰지 않는 자리. 호스트가 모든 약속에 들어가므로 다른 모임이
                # 이미 쓰는 시간에는 겹쳐 넣을 수 없습니다.
                taken = set(meetings) - {a, b}
                best = None
                for target in range(num_slots):
                    if target in taken:
                        continue
                    if not all(eligible(key, target) for key in people):
                        continue
                    after = _if_needed_count(people, target, available)
                    if after > before:
                        continue  # 남의 "가능(비선호)" 시간을 새로 끌어 쓰지 않습니다
                    rank = (after, target)
                    if best is None or rank < best[0]:
                        best = (rank, target)

                if best is None:
                    continue
                target = best[1]
                del meetings[a]
                del meetings[b]
                meetings[target] = people
                changed = True
                break

    return meetings
