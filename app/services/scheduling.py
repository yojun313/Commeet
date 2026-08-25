"""Optimal appointment assignment for finalizing an event.

The host attends every meeting, so no two meetings may overlap. We therefore
carve each polled day into consecutive, non-overlapping blocks of the meeting
length - any subset of those blocks is conflict-free for the host by
construction. Assigning respondents to blocks then reduces exactly to a
degree-constrained bipartite matching ("b-matching"), which we solve to
optimality with min-cost max-flow:

  * max flow -> schedules the largest possible number of people
  * min cost -> among all such optima, prefers firm "available" slots over
    "if needed" ones, and earlier blocks over later ones

Complexity is O(F * E log V) with F = number of respondents; for realistic
sizes (tens of people, hundreds of blocks) this runs in milliseconds.
"""

import heapq
from datetime import datetime, timedelta

# Cost weights. "available" is free; an "if needed" assignment is heavily
# penalised so it is only chosen when it lets one more person be scheduled.
# The per-slot tiebreak (prefer earlier blocks) is tiny enough that the total
# tiebreak across every slot can never outweigh a single "if needed".
COST_AVAILABLE = 0
COST_IF_NEEDED = 1_000_000
COST_SLOT_TIEBREAK = 1


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
                cost = COST_IF_NEEDED
            else:
                continue
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

    unassigned = [k for k in participant_keys if k not in assigned]
    return meetings, unassigned
