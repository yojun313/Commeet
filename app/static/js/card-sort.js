/* Shared card sorting + drag-to-reorder, used by the dashboard (일정 카드)
 * and the 연락처 page. Both keep their choice in localStorage:
 *
 *   <key>_sort   - the active sort option, or "manual"
 *   <key>_order  - the hand-arranged id order (only meaningful for "manual")
 *
 * A sort option always wins over the hand-arranged order; dragging a card
 * flips the list to "manual" so the arrangement sticks from then on. */

function loadSortState(storageKey, defaultSort) {
  let sort = defaultSort;
  let order = [];
  try {
    sort = localStorage.getItem(`${storageKey}_sort`) || defaultSort;
    order = JSON.parse(localStorage.getItem(`${storageKey}_order`) || "[]");
    if (!Array.isArray(order)) order = [];
  } catch (e) {
    /* localStorage unavailable (private mode) - fall back to defaults */
  }
  return { sort, order };
}

function saveSortState(storageKey, sort, order) {
  try {
    localStorage.setItem(`${storageKey}_sort`, sort);
    if (order) localStorage.setItem(`${storageKey}_order`, JSON.stringify(order));
  } catch (e) {
    /* not persisting is acceptable; the in-memory order still applies */
  }
}

// Orders `items` by the saved id list. Ids no longer present are skipped and
// anything new (added since the arrangement was saved) goes to the front, so
// a freshly created item is never hidden away at the bottom.
function applyManualOrder(items, order, getId) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.has(getId(a)) ? rank.get(getId(a)) : -1;
    const rb = rank.has(getId(b)) ? rank.get(getId(b)) : -1;
    return ra - rb;
  });
}

// `comparators` maps a sort key to a compare function. "manual" is handled
// here rather than by the caller so every list behaves the same way.
function sortItems(items, sortKey, comparators, order, getId) {
  if (sortKey === "manual") return applyManualOrder(items, order, getId);
  const cmp = comparators[sortKey];
  return cmp ? [...items].sort(cmp) : [...items];
}

function buildSortSelect(select, options, current) {
  select.innerHTML = "";
  options.forEach(([value, label]) => {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    select.appendChild(el);
  });
  // "사용자 정렬" only exists once the user has actually dragged something,
  // so it isn't offered as a choice - it just shows up as the current value.
  if (current === "manual") {
    const el = document.createElement("option");
    el.value = "manual";
    el.textContent = "사용자 정렬 (직접 배치)";
    select.appendChild(el);
  }
  select.value = current;
}

/* ------------------------------------------------------------------ */
/* Drag to reorder                                                     */
/* ------------------------------------------------------------------ */

// Which sibling the dragged card should be inserted before, or null to
// append. Grid and single-column layouts need different hit tests, so the
// column count is derived from where the items actually sit.
function insertionTarget(container, itemSelector, draggedEl, x, y) {
  const els = [...container.querySelectorAll(itemSelector)].filter((el) => el !== draggedEl);
  if (!els.length) return null;

  const lefts = new Set(els.map((el) => Math.round(el.getBoundingClientRect().left)));
  const singleColumn = lefts.size <= 1;

  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (singleColumn) {
      if (y < r.top + r.height / 2) return el;
    } else {
      if (y < r.top) return el;
      if (y <= r.bottom && x < r.left + r.width / 2) return el;
    }
  }
  return null;
}

// Wires pointer-based reordering onto one card. `opts`:
//   handle       - the element that starts the drag
//   card         - the card being moved
//   container    - the list the card lives in
//   itemSelector - selector matching sibling cards
//   ghostLabel   - text for the floating drag ghost
//   onMove(x, y) - optional; called during the drag (dashboard uses it to
//                  light up folder drop targets)
//   onDrop(x, y, movedWithin) - called once on release. `movedWithin` is
//                  true when the card ended up reordered inside its own
//                  container, so the caller can persist the new order.
function startReorderDrag(e, opts) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();

  const { card, container, itemSelector } = opts;
  const ghost = document.createElement("div");
  ghost.className = "folder-drag-ghost";
  ghost.textContent = opts.ghostLabel || "";
  document.body.appendChild(ghost);
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;
  document.body.classList.add("dragging-active");
  card.classList.add("card-dragging");

  let reordered = false;

  const onMove = (ev) => {
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    if (opts.onMove) opts.onMove(ev.clientX, ev.clientY);

    // Only reorder while the pointer is over the card's own list - dragging
    // out of it means the caller's own drop handling (e.g. moving to another
    // folder) should take over instead.
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!over || !container.contains(over)) return;

    const before = insertionTarget(container, itemSelector, card, ev.clientX, ev.clientY);
    if (before) {
      if (before !== card.nextElementSibling) {
        container.insertBefore(card, before);
        reordered = true;
      }
    } else if (card !== container.lastElementChild) {
      container.appendChild(card);
      reordered = true;
    }
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    ghost.remove();
    document.body.classList.remove("dragging-active");
    card.classList.remove("card-dragging");
  };

  const onUp = (ev) => {
    cleanup();
    if (opts.onDrop) opts.onDrop(ev.clientX, ev.clientY, reordered);
  };

  const onCancel = () => cleanup();

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

// Reads the current DOM order back out as a list of ids.
function readOrderFromDom(container, itemSelector, idAttr) {
  return [...container.querySelectorAll(itemSelector)].map((el) => el.dataset[idAttr]);
}
