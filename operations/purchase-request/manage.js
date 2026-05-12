// Purchaser Console — manage.js
const WORKER_URL = (window.WORKER_URL_OVERRIDE) || "https://inventory-request-form.purchasing-906.workers.dev";

const $ = (id) => document.getElementById(id);

const purchaserSel = $("purchaser-name");
const refreshBtn   = $("refresh-btn");
const queueEl      = $("queue");
const errorEl      = $("error");
const emptyEl      = $("empty");
const loadingBar   = $("loading-bar");
const loadingFill  = loadingBar.querySelector(".loading-fill");
const digestEl     = $("vendor-digest");
const digestListEl = $("vendor-digest-list");
const triageEl     = $("triage");
const triageListEl = $("triage-list");
const bulkToggleBtn   = $("bulk-toggle-btn");
const bulkActionBar   = $("bulk-action-bar");
const bulkCountEl     = $("bulk-count");
const bulkSelectAllBtn = $("bulk-select-all");
const bulkClearBtn    = $("bulk-clear");
const bulkOrderedBtn  = $("bulk-ordered-btn");

// Bulk mode: when on, every queue row shows a left-edge checkbox and the
// sticky action bar appears at the bottom of the viewport once any row is
// selected. Only Submitted / Backordered / Waiting rows can be selected for
// the "Mark Ordered" action (matches the per-row action allow-list).
let bulkMode = false;
const bulkSelection = new Set(); // pageIds

// Vendor filter state. When set, only rows whose primary vendor matches are
// shown in the queue. Click an active digest bubble again (or the same one)
// to clear.
let vendorFilter = null;
// Triage filter state — mutually exclusive with vendorFilter. Values:
// null | "urgent" | "newItem". Lives alongside vendor so the bubble UI
// can show the active state without inventing another mode flag.
let triageFilter = null;
// Holds the most recent /pending payload so refresh-less filtering is cheap.
let allRows = [];

// Modal
const modal        = $("modal");
const modalTitle   = $("modal-title");
const modalContext = $("modal-context");
const modalForm    = $("modal-form");
const modalErr     = $("modal-error");
const modalClose   = $("modal-close");
const modalCancel  = $("modal-cancel");
const modalSubmit  = $("modal-submit");

const STATUS_GROUPS = [
  { name: "Submitted", emoji: "📥" },
  { name: "Backordered", emoji: "⏸️" },
  { name: "Waiting to Order", emoji: "⏳" },
  { name: "Ordered", emoji: "🛒" },
];

const REASON_CODES = [
  "Already in stock",
  "Duplicate request",
  "Substitute available",
  "No longer needed",
  "Wrong item",
  "Vendor unavailable",
  "Other",
];

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function clearError() { errorEl.hidden = true; }

function todayISO() { return new Date().toISOString().slice(0, 10); }

// ----- Recent activity chip -----
//
// Mirrors app.js recentChip(). Reads from row.priorActivity (the worker
// already excluded the current row's own occurrence so we don't get noise
// like "Requested today" on every fresh Submitted row).
function recentChip(activity) {
  if (!activity) return null;
  const now = Date.now();
  const ageDays = (iso) => iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null;
  const candidates = [
    { kind: "received",  label: "Received",  age: ageDays(activity.lastReceived) },
    { kind: "ordered",   label: "Ordered",   age: ageDays(activity.lastOrdered) },
    { kind: "requested", label: "Requested", age: ageDays(activity.lastRequested) },
  ].filter(c => c.age != null && c.age >= 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.age - b.age);
  const pick = candidates[0];
  if (pick.age > 180) return null;
  const tone = pick.age <= 30 ? "urgent" : "muted";
  const ageText = pick.age === 0 ? "today"
                : pick.age === 1 ? "yesterday"
                : `${pick.age}d ago`;
  const prefix = tone === "urgent" ? pick.label : `Last ${pick.label.toLowerCase()}`;
  return { text: `${prefix} ${ageText}`, tone, kind: pick.kind, ageDays: pick.age };
}

// Parse a free-text lead time ("1 week", "2 weeks", "10 days", "3-4 weeks")
// into a number of days. Returns null when nothing parseable is found so the
// caller can decide whether to fall back to today. Range strings ("2-3 weeks")
// use the upper bound so the ETA defaults conservative, not optimistic.
function leadTimeToDays(s) {
  if (!s) return null;
  const str = String(s).toLowerCase().trim();
  // Pull the last number in the string (covers "2-3 weeks" -> 3, "approx 2 weeks" -> 2)
  const nums = str.match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const n = parseFloat(nums[nums.length - 1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/month/.test(str))   return Math.round(n * 30);
  if (/week/.test(str))    return Math.round(n * 7);
  if (/day/.test(str))     return Math.round(n);
  // Bare number with no unit — assume days
  return Math.round(n);
}

// Add `days` to an ISO date (YYYY-MM-DD). Returns ISO. UTC math so we don't
// shift the date around DST transitions.
function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function ageDays(dateISO) {
  if (!dateISO) return null;
  const ms = Date.now() - new Date(dateISO).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function formatSubmittedAt(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  // e.g. "Apr 29, 2026 at 3:42 PM"
  return dt.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).replace(/, (\d)/, " at $1").replace(/, /, " at ");
}

async function loadPeople() {
  try {
    const res = await fetch(`${WORKER_URL}/people`);
    const data = await res.json();
    for (const name of data.people || []) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      purchaserSel.appendChild(opt);
    }
    // Restore last-selected
    const saved = localStorage.getItem("purchaser-name");
    if (saved && [...purchaserSel.options].some(o => o.value === saved)) {
      purchaserSel.value = saved;
    }
  } catch (e) {
    showError("Couldn't load purchaser names.");
  }
}

purchaserSel.addEventListener("change", () => {
  if (purchaserSel.value) localStorage.setItem("purchaser-name", purchaserSel.value);
});

// Keep this list in sync with app.js LOADING_MESSAGES.
const LOADING_MESSAGES = [
  "Don't forget to eat your veggies and remember to say something nice to someone you love.",
  "Drink some water. Stretch your shoulders. We'll be ready in a sec.",
  "Take a deep breath in… and out. Catalog incoming.",
  "Do the macarena. By the time you finish, the list should be loaded.",
  "Wiggle your toes for 10 seconds while this loads. Surprisingly underrated.",
];

async function loadPending() {
  clearError();
  const loadingMsgEl = loadingBar.querySelector(".loading-message");
  if (loadingMsgEl) {
    loadingMsgEl.textContent = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
  }
  loadingBar.hidden = false;
  let pct = 0;
  loadingFill.style.width = "0%";
  const tick = setInterval(() => {
    pct = Math.min(95, pct + Math.max(2, (95 - pct) * 0.12));
    loadingFill.style.width = pct + "%";
  }, 120);

  try {
    const res = await fetch(`${WORKER_URL}/pending`);
    const data = await res.json();
    loadingFill.style.width = "100%";
    setTimeout(() => { loadingBar.hidden = true; }, 300);
    allRows = data.rows || [];
    renderTriage(allRows);
    renderDigest(allRows);
    renderQueue(filteredRows());
  } catch (e) {
    showError("Couldn't load pending requests.");
    loadingBar.hidden = true;
  } finally {
    clearInterval(tick);
  }
}

// ----- Vendor digest -----
//
// Surfaces vendors with 2+ open requests (Submitted + Waiting only — these
// are the ones a purchaser can still consolidate before placing an order).
// Backordered and Ordered rows already have a vendor commitment, so they're
// excluded from the count but Ordered rows are scanned to compute "last
// ordered: <date>" so the purchaser can see if today's batch already shipped.

// Each row's vendor field is a comma-separated list (e.g. "Grand Brass, Ami").
// Treat the first non-blank entry as the primary vendor — that's where the
// row is most likely to actually be placed.
function primaryVendor(row) {
  if (!row.vendor) return "";
  const first = String(row.vendor).split(",")[0];
  return (first || "").trim();
}

// Triage bubbles only apply to rows still in Submitted status — once a
// purchaser has moved a request to Waiting / Ordered / Backordered, the
// urgency or new-item flag has been acknowledged. The bubble counts and
// the filter use this same predicate so they stay in sync.
function isTriageEligible(r) {
  return r.status === "Submitted";
}

function filteredRows() {
  let rows = allRows;
  if (triageFilter === "urgent") rows = rows.filter(r => isTriageEligible(r) && r.outOfStock);
  else if (triageFilter === "newItem") rows = rows.filter(r => isTriageEligible(r) && r.notInDb);
  if (vendorFilter) rows = rows.filter(r => primaryVendor(r) === vendorFilter);
  return rows;
}

// ----- Triage digest -----
//
// Two bubbles: "Urgent — out of stock" and "New item requests" (rows with
// Not in DB checked). Section auto-hides when both counts are zero.
function renderTriage(rows) {
  const eligible = rows.filter(isTriageEligible);
  const urgentCount = eligible.filter(r => r.outOfStock).length;
  const newItemCount = eligible.filter(r => r.notInDb).length;

  if (urgentCount === 0 && newItemCount === 0) {
    triageEl.hidden = true;
    triageListEl.innerHTML = "";
    // Clear stale filter if its bucket dried up
    if (triageFilter === "urgent" && urgentCount === 0) triageFilter = null;
    if (triageFilter === "newItem" && newItemCount === 0) triageFilter = null;
    return;
  }

  triageEl.hidden = false;
  triageListEl.innerHTML = "";

  if (urgentCount > 0) {
    triageListEl.appendChild(buildTriageBubble({
      key: "urgent",
      label: "Urgent — out of stock",
      count: urgentCount,
      modifier: "triage-bubble-urgent",
    }));
  }
  if (newItemCount > 0) {
    triageListEl.appendChild(buildTriageBubble({
      key: "newItem",
      label: "New item requests",
      count: newItemCount,
      modifier: "triage-bubble-newitem",
    }));
  }

  // If the active triage filter's bucket disappeared after a refresh, drop it
  if (triageFilter === "urgent" && urgentCount === 0) triageFilter = null;
  if (triageFilter === "newItem" && newItemCount === 0) triageFilter = null;
}

function buildTriageBubble({ key, label, count, modifier }) {
  const isActive = triageFilter === key;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `triage-bubble ${modifier}` + (isActive ? " active" : "");
  btn.setAttribute("role", "tab");
  btn.setAttribute("aria-selected", isActive ? "true" : "false");
  btn.dataset.triage = key;
  btn.innerHTML = `
    <span class="triage-bubble-label">${escapeHtml(label)}</span>
    <span class="triage-bubble-count">${count}</span>
  `;
  btn.addEventListener("click", () => toggleTriageFilter(key));
  return btn;
}

function toggleTriageFilter(key) {
  triageFilter = (triageFilter === key) ? null : key;
  // Triage and vendor are mutually exclusive — picking one clears the other.
  // Otherwise "Urgent + Grand Brass" can return zero rows for confusing reasons.
  if (triageFilter) vendorFilter = null;
  renderTriage(allRows);
  renderDigest(allRows);
  renderQueue(filteredRows());
}

function renderDigest(rows) {
  // Group consolidatable rows by primary vendor (Submitted + Waiting only)
  const buckets = new Map(); // vendor -> { submitted, waiting, oldestAge }
  // Track most recent Ordered date per vendor for the "last ordered" hint
  const lastOrdered = new Map(); // vendor -> ISO date string (latest)

  for (const r of rows) {
    const v = primaryVendor(r);
    if (!v) continue;

    if (r.status === "Ordered" && r.orderedDate) {
      const prev = lastOrdered.get(v);
      if (!prev || r.orderedDate > prev) lastOrdered.set(v, r.orderedDate);
    }

    if (r.status !== "Submitted" && r.status !== "Waiting to Order") continue;
    if (!buckets.has(v)) buckets.set(v, { submitted: 0, waiting: 0, oldestAge: null });
    const b = buckets.get(v);
    if (r.status === "Submitted") b.submitted++;
    else b.waiting++;
    const age = ageDays(r.dateRequested);
    if (age != null && (b.oldestAge == null || age > b.oldestAge)) b.oldestAge = age;
  }

  // Only show vendors with 2+ open requests
  const entries = [...buckets.entries()]
    .filter(([, b]) => (b.submitted + b.waiting) >= 2)
    .sort((a, b) => (b[1].submitted + b[1].waiting) - (a[1].submitted + a[1].waiting));

  if (entries.length === 0) {
    digestEl.hidden = true;
    digestListEl.innerHTML = "";
    // Filter may still be set on a vendor that no longer has 2+ — clear it.
    if (vendorFilter && !buckets.has(vendorFilter)) vendorFilter = null;
    return;
  }

  digestEl.hidden = false;
  digestListEl.innerHTML = "";
  for (const [vendor, b] of entries) {
    const total = b.submitted + b.waiting;
    const lastOrd = lastOrdered.get(vendor);
    const lastOrdLabel = lastOrd ? lastOrderedLabel(lastOrd) : "";
    const breakdown = [
      b.submitted > 0 ? `${b.submitted} submitted` : null,
      b.waiting   > 0 ? `${b.waiting} waiting`     : null,
    ].filter(Boolean).join(" · ");
    const isActive = vendorFilter === vendor;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vendor-bubble" + (isActive ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.dataset.vendor = vendor;
    btn.innerHTML = `
      <div class="vendor-bubble-row">
        <span class="vendor-bubble-name">${escapeHtml(vendor)}</span>
        <span class="vendor-bubble-count">${total}</span>
      </div>
      <div class="vendor-bubble-meta">
        <span>${escapeHtml(breakdown)}</span>
        ${b.oldestAge != null ? `<span class="vendor-bubble-age">oldest ${b.oldestAge}d</span>` : ""}
      </div>
      ${lastOrdLabel ? `<div class="vendor-bubble-last">Last ordered ${escapeHtml(lastOrdLabel)}</div>` : ""}
    `;
    btn.addEventListener("click", () => toggleVendorFilter(vendor));
    digestListEl.appendChild(btn);
  }

  // If the active filter's vendor disappeared, clear it
  if (vendorFilter && !buckets.has(vendorFilter)) {
    vendorFilter = null;
  }
}

function toggleVendorFilter(vendor) {
  vendorFilter = (vendorFilter === vendor) ? null : vendor;
  // Mutual exclusion with triage filter — see toggleTriageFilter.
  if (vendorFilter) triageFilter = null;
  // Re-render bubbles to update the active state and re-render the queue
  renderTriage(allRows);
  renderDigest(allRows);
  renderQueue(filteredRows());
}

// Friendly relative label for the "Last ordered" hint
function lastOrderedLabel(iso) {
  if (!iso) return "";
  const today = todayISO();
  if (iso === today) return "today";
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (diffDays === 1) return "yesterday";
  if (diffDays > 0 && diffDays < 7) return `${diffDays} days ago`;
  // Use formatted date for older
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

refreshBtn.addEventListener("click", loadPending);

// ----- Bulk mode wiring -----
//
// Only Submitted / Backordered / Waiting to Order rows can transition to
// Ordered, so the checkbox only appears on those statuses. Ordered rows in
// the queue are visible but not selectable.
function bulkEligible(r) {
  return r.status === "Submitted"
      || r.status === "Backordered"
      || r.status === "Waiting to Order";
}

function setBulkMode(on) {
  bulkMode = !!on;
  bulkToggleBtn.setAttribute("aria-pressed", bulkMode ? "true" : "false");
  bulkToggleBtn.textContent = bulkMode ? "Exit bulk update" : "Bulk update";
  bulkToggleBtn.classList.toggle("active", bulkMode);
  if (!bulkMode) bulkSelection.clear();
  document.body.classList.toggle("bulk-mode", bulkMode);
  refreshBulkBar();
  // Re-render so checkboxes appear / disappear
  renderQueue(filteredRows());
}

bulkToggleBtn.addEventListener("click", () => setBulkMode(!bulkMode));

function refreshBulkBar() {
  const n = bulkSelection.size;
  if (!bulkMode || n === 0) {
    bulkActionBar.hidden = true;
    return;
  }
  bulkActionBar.hidden = false;
  bulkCountEl.textContent = `${n} selected`;
  bulkOrderedBtn.disabled = n === 0;
}

bulkClearBtn.addEventListener("click", () => {
  bulkSelection.clear();
  // Uncheck DOM without a full re-render
  document.querySelectorAll(".bulk-checkbox:checked").forEach(cb => cb.checked = false);
  refreshBulkBar();
});

bulkSelectAllBtn.addEventListener("click", () => {
  // "Visible" = currently rendered (respects vendor/triage filter). Only the
  // bulk-eligible ones get added — Ordered rows in the queue are skipped.
  const rows = filteredRows().filter(bulkEligible);
  for (const r of rows) bulkSelection.add(r.pageId);
  document.querySelectorAll(".bulk-checkbox").forEach(cb => {
    if (bulkSelection.has(cb.dataset.pageId)) cb.checked = true;
  });
  refreshBulkBar();
});

bulkOrderedBtn.addEventListener("click", openBulkOrderedModal);

function renderQueue(rows) {
  queueEl.innerHTML = "";
  if (rows.length === 0) {
    if (triageFilter) {
      const label = triageFilter === "urgent" ? "urgent" : "new-item";
      emptyEl.innerHTML = `<p>No ${label} requests right now. <button type="button" class="link-btn" id="clear-triage-filter">Clear filter</button></p>`;
      const clearBtn = $("clear-triage-filter");
      if (clearBtn) clearBtn.addEventListener("click", () => toggleTriageFilter(triageFilter));
    } else if (vendorFilter) {
      // Filter to a vendor that has no remaining rows — show a contextual
      // empty state rather than the cheerful "queue is clear" celebration.
      emptyEl.innerHTML = `<p>No open requests for <strong>${escapeHtml(vendorFilter)}</strong>. <button type="button" class="link-btn" id="clear-vendor-filter">Clear filter</button></p>`;
      const clearBtn = $("clear-vendor-filter");
      if (clearBtn) clearBtn.addEventListener("click", () => toggleVendorFilter(vendorFilter));
    } else {
      emptyEl.innerHTML = `<p>🎉 No active requests. The queue is clear.</p>`;
    }
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Group rows by status, in the order defined above
  const grouped = {};
  for (const g of STATUS_GROUPS) grouped[g.name] = [];
  for (const r of rows) {
    if (grouped[r.status]) grouped[r.status].push(r);
  }

  for (const g of STATUS_GROUPS) {
    const items = grouped[g.name];
    if (items.length === 0) continue;
    const section = document.createElement("section");
    section.className = "status-group";
    section.innerHTML = `
      <div class="status-group-header">
        <span class="status-pill" data-status="${g.name}">${g.emoji} ${g.name}</span>
        <h3></h3>
        <span class="count">(${items.length})</span>
      </div>
      <ul class="pending-list"></ul>
    `;
    section.querySelector("h3").textContent = "";
    const list = section.querySelector(".pending-list");
    for (const r of items) list.appendChild(renderRow(r));
    queueEl.appendChild(section);
  }
}

function renderRow(r) {
  const li = document.createElement("li");
  li.className = "pending-row";
  if (r.outOfStock) li.classList.add("urgent");

  const itemTitle = r.itemName || r.customItemName || "(unnamed)";
  const description = r.description || "";
  const age = ageDays(r.dateRequested);
  const submittedAt = formatSubmittedAt(r.createdTime);

  const thumbHtml = r.image
    ? `<img class="row-thumb" src="${escapeHtml(r.image)}" alt="">`
    : `<div class="row-thumb-fallback">${r.type === "Supply" ? "📦" : r.type === "Other" ? "🛠️" : "🔩"}</div>`;

  const bulkCheckboxHtml = bulkMode
    ? (bulkEligible(r)
        ? `<label class="bulk-checkbox-wrap"><input type="checkbox" class="bulk-checkbox" data-page-id="${escapeHtml(r.pageId)}"${bulkSelection.has(r.pageId) ? " checked" : ""}></label>`
        : `<span class="bulk-checkbox-wrap bulk-checkbox-disabled" aria-hidden="true"></span>`)
    : "";

  li.innerHTML = `
    ${bulkCheckboxHtml}
    ${thumbHtml}
    <div class="pending-meta">
      <div class="title-row">
        <span class="order-num"></span>
        <span class="row-tags"></span>
        <strong class="title-text"></strong>
        <span class="title-desc"></span>
      </div>
      <div class="vendor-line"></div>
      <div class="row-extra"></div>
      <div class="notes"></div>
    </div>
    <div class="row-actions"></div>
  `;
  li.querySelector(".order-num").textContent = r.orderNum;
  li.querySelector(".title-text").textContent = itemTitle;
  li.querySelector(".title-desc").textContent = description ? `— ${description}` : "";

  // Chip row (matches requester form): TYPE + Category + URGENT + NEW ITEM
  const tags = li.querySelector(".row-tags");
  tags.appendChild(makeBadge(r.type.toUpperCase(), "badge"));
  if (r.category) tags.appendChild(makeBadge(r.category.toUpperCase(), "badge badge-category"));
  if (r.notInDb)  tags.appendChild(makeBadge("NEW ITEM REQUEST", "badge badge-category"));
  if (r.outOfStock) tags.appendChild(makeBadge("URGENT — OUT OF STOCK", "urgent-tag"));
  // Recent activity chip — warns the purchaser if this same item was just
  // ordered/received recently so they don't re-order on top of an in-flight one.
  const chip = recentChip(r.priorActivity);
  if (chip) {
    const span = document.createElement("span");
    span.className = "recent-chip";
    span.dataset.tone = chip.tone;
    span.textContent = chip.text;
    tags.appendChild(span);
  }

  // Vendor line (matches requester form)
  const vendorEl = li.querySelector(".vendor-line");
  const v = primaryVendor(r);
  vendorEl.textContent = v ? `Vendor: ${v}` : "";
  vendorEl.hidden = !v;

  // Single meta line: requester · age · 2025 use · MOQ/reorder · lead time · qty/po/eta.
  // Submitted timestamp moves to a `title` tooltip on the age chip so it stays
  // discoverable without taking a whole line.
  const extra = li.querySelector(".row-extra");
  const extraParts = [];
  extraParts.push(`<span><strong>Requested by:</strong> ${escapeHtml(r.requestor || "—")}</span>`);
  if (age != null) {
    const tip = submittedAt ? ` title="Submitted ${escapeHtml(submittedAt)}"` : "";
    extraParts.push(`<span${tip}><strong>Age:</strong> ${age}d</span>`);
  }
  if (r.use2025 != null) extraParts.push(`<span><strong>2025 Use:</strong> ${r.use2025}</span>`);
  if (r.moqQty != null) {
    extraParts.push(`<span><strong>MOQ:</strong> ${r.moqQty}</span>`);
  } else if (r.reorderQty != null && r.reorderQty !== "") {
    extraParts.push(`<span><strong>Reorder Qty:</strong> ${r.reorderQty}</span>`);
  }
  if (r.leadTime) extraParts.push(`<span><strong>Lead Time:</strong> ${escapeHtml(r.leadTime)}</span>`);
  if (r.qtyOrdered != null) extraParts.push(`<span><strong>Qty Ordered:</strong> ${r.qtyOrdered}</span>`);
  if (r.orderNumber) extraParts.push(`<span><strong>Order #:</strong> ${escapeHtml(r.orderNumber)}</span>`);
  if (r.poNumber) extraParts.push(`<span><strong>PO:</strong> ${escapeHtml(r.poNumber)}</span>`);
  if (r.eta) extraParts.push(`<span><strong>ETA:</strong> ${r.eta}</span>`);
  extra.innerHTML = extraParts.join("");

  // Notes block (combined requester and purchaser context)
  const notesEl = li.querySelector(".notes");
  const noteParts = [];
  if (r.notes) noteParts.push(`<strong>Requester note:</strong> ${escapeHtml(r.notes)}`);
  if (r.purchaserNotes) noteParts.push(`<strong>Your note:</strong> ${escapeHtml(r.purchaserNotes)}`);
  if (r.reason) noteParts.push(`<strong>Reason:</strong> ${escapeHtml(r.reason)}`);
  notesEl.innerHTML = noteParts.join(" · ");
  notesEl.hidden = noteParts.length === 0;

  // Action buttons depend on current status. In bulk mode, hide the per-row
  // actions so the queue stays clean and people use the bulk bar instead.
  const actions = li.querySelector(".row-actions");
  if (bulkMode) {
    actions.remove();
  } else {
    const buttons = actionsFor(r.status);
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `action-btn ${b.cls || ""}`;
      btn.textContent = b.label;
      btn.addEventListener("click", () => openModal(b.action, r));
      actions.appendChild(btn);
    }
  }

  // Wire bulk checkbox if present
  const bulkCb = li.querySelector(".bulk-checkbox");
  if (bulkCb) {
    bulkCb.addEventListener("change", () => {
      if (bulkCb.checked) bulkSelection.add(bulkCb.dataset.pageId);
      else bulkSelection.delete(bulkCb.dataset.pageId);
      refreshBulkBar();
    });
  }

  return li;
}

function makeBadge(text, cls) {
  const span = document.createElement("span");
  span.className = `badge ${cls}`;
  span.textContent = text;
  return span;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function actionsFor(status) {
  // Allowed transitions per current status. The "edit" action doesn't change
  // status — it lets the purchaser correct facts like Order # / PO # / Qty /
  // ETA / Tracking that get entered wrong or change after the supplier
  // responds. Only offered on rows that have already been ordered, since
  // that's where the editable fields are populated.
  switch (status) {
    case "Submitted":
      return [
        { action: "ordered",        label: "Mark Ordered" },
        { action: "backordered",    label: "Mark Backordered" },
        { action: "waitingToOrder", label: "Mark Waiting to Order" },
        { action: "cancelled",      label: "Cancel", cls: "action-cancel" },
      ];
    case "Backordered":
    case "Waiting to Order":
      return [
        { action: "ordered",   label: "Mark Ordered" },
        { action: "edit",      label: "Edit",   cls: "action-edit" },
        { action: "cancelled", label: "Cancel", cls: "action-cancel" },
      ];
    case "Ordered":
      return [
        { action: "received",    label: "Mark Received" },
        { action: "backordered", label: "Mark Backordered" },
        { action: "edit",        label: "Edit",   cls: "action-edit" },
        { action: "cancelled",   label: "Cancel", cls: "action-cancel" },
      ];
    default:
      return [];
  }
}

// ---------- Modal ----------

const ACTION_TITLES = {
  ordered: "Mark as Ordered",
  backordered: "Mark as Backordered",
  waitingToOrder: "Mark as Waiting to Order",
  received: "Mark as Received",
  cancelled: "Cancel Request",
  edit: "Edit order details",
};

let modalRow = null;
let modalAction = null;

function openModal(action, row) {
  if (!purchaserSel.value && action !== "cancelled") {
    alert("Please select your name in the top bar before taking actions.");
    purchaserSel.focus();
    return;
  }
  modalRow = row;
  modalAction = action;
  modalTitle.textContent = ACTION_TITLES[action];
  modalContext.innerHTML =
    `<strong>${escapeHtml(row.orderNum)}</strong> — ${escapeHtml(row.itemName || row.customItemName || "(unnamed)")}` +
    (primaryVendor(row) ? ` · Vendor: ${escapeHtml(primaryVendor(row))}` : "");
  modalForm.innerHTML = fieldsFor(action, row);
  modalErr.hidden = true;
  modal.hidden = false;

  // Cancellation: only show "Cancellation reason" when reason code is "Other"
  if (action === "cancelled") {
    const reasonSel = modalForm.querySelector("#f-reasonCode");
    const reasonField = modalForm.querySelector("#cancellation-reason-field");
    const reasonInput = modalForm.querySelector("#f-cancellationReason");
    reasonSel.addEventListener("change", () => {
      const isOther = reasonSel.value === "Other";
      reasonField.hidden = !isOther;
      if (!isOther) reasonInput.value = "";
      if (isOther) reasonInput.focus();
    });
  }

  // Mark Ordered + Edit share the same "No PO #" / "No Order #" toggles and
  // the same ETA auto-slide behavior. Edit reuses them; the auto-slide is a
  // no-op for Edit because the form has no Ordered Date input.
  if (action === "ordered" || action === "edit") {
    const noPOBox = modalForm.querySelector("#f-noPO");
    const poInput = modalForm.querySelector("#f-poNumber");
    if (noPOBox && poInput) {
      noPOBox.addEventListener("change", () => {
        if (noPOBox.checked) {
          poInput.value = "";
          poInput.disabled = true;
          poInput.placeholder = "Not provided";
        } else {
          poInput.disabled = false;
          poInput.placeholder = "e.g. PO-2026-0042";
          poInput.focus();
        }
      });
    }

    // Same pattern for "No Order # available" — internal stock requests that
    // aren't tied to a Shopify/customer order.
    const noOrderBox = modalForm.querySelector("#f-noOrderNumber");
    const orderInput = modalForm.querySelector("#f-orderNumber");
    if (noOrderBox && orderInput) {
      noOrderBox.addEventListener("change", () => {
        if (noOrderBox.checked) {
          orderInput.value = "";
          orderInput.disabled = true;
          orderInput.placeholder = "Not provided";
        } else {
          orderInput.disabled = false;
          orderInput.placeholder = "e.g. #12345";
          orderInput.focus();
        }
      });
    }

    // Auto-slide ETA when Ordered Date changes — but only while the user
    // hasn't manually touched the ETA. As soon as they pick a date there,
    // we respect it and stop overriding. This way a default "today + 1 week"
    // stays useful if the order date is backdated, but doesn't fight a
    // purchaser who wants a specific ETA.
    const orderedInput = modalForm.querySelector("#f-orderedDate");
    const etaInput     = modalForm.querySelector("#f-eta");
    if (orderedInput && etaInput) {
      const leadDays = Number(etaInput.dataset.leadDays);
      let etaTouched = false;
      etaInput.addEventListener("input", () => { etaTouched = true; });
      if (Number.isFinite(leadDays) && leadDays > 0) {
        orderedInput.addEventListener("input", () => {
          if (etaTouched) return;
          if (!orderedInput.value) return;
          etaInput.value = addDaysISO(orderedInput.value, leadDays);
        });
      }
    }
  }

  // Auto-focus first input
  const firstInput = modalForm.querySelector("input, select, textarea");
  if (firstInput) firstInput.focus();
}

function closeModal() {
  modal.hidden = true;
  modalRow = null;
  modalAction = null;
}
modalClose.addEventListener("click", closeModal);
modalCancel.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

function fieldsFor(action, row) {
  const today = todayISO();
  const moq = row.moqQty ?? "";
  if (action === "ordered") {
    // Default ETA = orderedDate + lead time (parsed from row.leadTime).
    // Falls back to empty when leadTime is missing/unparseable so the
    // purchaser has to pick one explicitly instead of trusting a bad guess.
    const leadDays = leadTimeToDays(row.leadTime);
    const defaultETA = leadDays != null ? addDaysISO(today, leadDays) : "";
    const etaHint = leadDays != null
      ? ` <span class="muted">(${escapeHtml(row.leadTime)} from order date)</span>`
      : "";
    return `
      <div class="field-row">
        <div class="field">
          <label for="f-orderNumber">Order #<span class="req">*</span></label>
          <input id="f-orderNumber" name="orderNumber" type="text" placeholder="e.g. #12345">
          <label class="field-checkbox">
            <input type="checkbox" id="f-noOrderNumber" name="noOrderNumber" value="1">
            <span>No Order # available</span>
          </label>
        </div>
        <div class="field">
          <label for="f-poNumber">PO #<span class="req">*</span></label>
          <input id="f-poNumber" name="poNumber" type="text" placeholder="e.g. PO-2026-0042">
          <label class="field-checkbox">
            <input type="checkbox" id="f-noPO" name="noPO" value="1">
            <span>No PO # available</span>
          </label>
        </div>
      </div>
      <div class="field">
        <label for="f-qtyOrdered">Qty Ordered<span class="req">*</span></label>
        <input id="f-qtyOrdered" name="qtyOrdered" type="number" min="1" value="${moq}">
      </div>
      <div class="field">
        <label for="f-orderedDate">Ordered Date<span class="req">*</span></label>
        <input id="f-orderedDate" name="orderedDate" type="date" value="${today}">
      </div>
      <div class="field">
        <label for="f-eta">ETA<span class="req">*</span>${etaHint}</label>
        <input id="f-eta" name="eta" type="date" value="${defaultETA}" data-lead-days="${leadDays ?? ""}">
      </div>
      <div class="field">
        <label for="f-tracking">Tracking # <span class="muted">(optional)</span></label>
        <input id="f-tracking" name="tracking" type="text">
      </div>
      <div class="field">
        <label for="f-purchaserNotes">Purchaser notes <span class="muted">(optional, visible to requester)</span></label>
        <input id="f-purchaserNotes" name="purchaserNotes" type="text">
      </div>
    `;
  }
  if (action === "backordered") {
    return `
      <div class="field">
        <label for="f-eta">Expected ETA<span class="req">*</span></label>
        <input id="f-eta" name="eta" type="date">
      </div>
      <div class="field">
        <label for="f-reason">Reason<span class="req">*</span></label>
        <input id="f-reason" name="reason" type="text" placeholder="Why is it on backorder?">
      </div>
      <div class="field">
        <label for="f-purchaserNotes">Purchaser notes <span class="muted">(optional)</span></label>
        <input id="f-purchaserNotes" name="purchaserNotes" type="text">
      </div>
    `;
  }
  if (action === "waitingToOrder") {
    return `
      <div class="field">
        <label for="f-reason">Reason<span class="req">*</span></label>
        <input id="f-reason" name="reason" type="text" placeholder="e.g. waiting on PO consolidation, vendor minimum">
      </div>
      <div class="field">
        <label for="f-purchaserNotes">Purchaser notes <span class="muted">(optional)</span></label>
        <input id="f-purchaserNotes" name="purchaserNotes" type="text">
      </div>
    `;
  }
  if (action === "received") {
    const qtyVal = row.qtyOrdered ?? row.moqQty ?? "";
    return `
      <div class="field">
        <label for="f-receivedDate">Received Date<span class="req">*</span></label>
        <input id="f-receivedDate" name="receivedDate" type="date" value="${today}">
      </div>
      <div class="field">
        <label for="f-qtyOrdered">Qty Received <span class="muted">(updates Qty Ordered)</span></label>
        <input id="f-qtyOrdered" name="qtyOrdered" type="number" min="0" value="${qtyVal}">
      </div>
      <div class="field">
        <label for="f-purchaserNotes">Purchaser notes <span class="muted">(optional)</span></label>
        <input id="f-purchaserNotes" name="purchaserNotes" type="text">
      </div>
    `;
  }
  if (action === "cancelled") {
    const opts = REASON_CODES.map(c => `<option value="${c}">${c}</option>`).join("");
    return `
      <div class="field">
        <label for="f-reasonCode">Reason Code<span class="req">*</span></label>
        <select id="f-reasonCode" name="reasonCode">
          <option value="">Select…</option>
          ${opts}
        </select>
      </div>
      <div class="field" id="cancellation-reason-field" hidden>
        <label for="f-cancellationReason">Cancellation reason<span class="req">*</span></label>
        <input id="f-cancellationReason" name="cancellationReason" type="text" placeholder="Visible to the requester">
      </div>
      <div class="field">
        <label for="f-purchaserNotes">Purchaser notes <span class="muted">(optional)</span></label>
        <input id="f-purchaserNotes" name="purchaserNotes" type="text">
      </div>
    `;
  }
  if (action === "edit") {
    // Pre-fill every field with the row's current value. No "required"
    // markers — edit is sparse: only fields the purchaser actually changes
    // get PATCHed. The worker appends an audit line to Purchaser Notes.
    const orderNumber = row.orderNumber || "";
    const poNumber    = row.poNumber    || "";
    const qty         = row.qtyOrdered ?? "";
    const eta         = row.eta         || "";
    const tracking    = row.tracking    || "";
    // "No Order #" / "No PO" sentinel is the em-dash we wrote at Mark Ordered.
    const orderIsNo = orderNumber === "—";
    const poIsNo    = poNumber    === "—";
    return `
      <div class="field-row">
        <div class="field">
          <label for="f-orderNumber">Order #</label>
          <input id="f-orderNumber" name="orderNumber" type="text" value="${escapeHtml(orderIsNo ? "" : orderNumber)}"${orderIsNo ? " disabled placeholder=\"Not provided\"" : ""}>
          <label class="field-checkbox">
            <input type="checkbox" id="f-noOrderNumber" name="noOrderNumber" value="1"${orderIsNo ? " checked" : ""}>
            <span>No Order # available</span>
          </label>
        </div>
        <div class="field">
          <label for="f-poNumber">PO #</label>
          <input id="f-poNumber" name="poNumber" type="text" value="${escapeHtml(poIsNo ? "" : poNumber)}"${poIsNo ? " disabled placeholder=\"Not provided\"" : ""}>
          <label class="field-checkbox">
            <input type="checkbox" id="f-noPO" name="noPO" value="1"${poIsNo ? " checked" : ""}>
            <span>No PO # available</span>
          </label>
        </div>
      </div>
      <div class="field">
        <label for="f-qtyOrdered">Qty Ordered</label>
        <input id="f-qtyOrdered" name="qtyOrdered" type="number" min="1" value="${qty}">
      </div>
      <div class="field">
        <label for="f-eta">ETA</label>
        <input id="f-eta" name="eta" type="date" value="${eta}">
      </div>
      <div class="field">
        <label for="f-tracking">Tracking #</label>
        <input id="f-tracking" name="tracking" type="text" value="${escapeHtml(tracking)}">
      </div>
      <div class="field">
        <label for="f-purchaserNotes">Add note about this edit <span class="muted">(optional, prepends to notes)</span></label>
        <input id="f-purchaserNotes" name="purchaserNotes" type="text" placeholder="e.g. Supplier said low stock — reduced qty">
      </div>
    `;
  }
  return "";
}

modalSubmit.addEventListener("click", async () => {
  // Bulk path uses a separate submit handler with its own per-item payload
  // shape and its own POST endpoint.
  if (modalAction === "__bulkOrdered") {
    return submitBulkOrdered();
  }
  if (!modalRow || !modalAction) return;
  const formData = new FormData(modalForm);
  const fields = {};
  for (const [k, v] of formData.entries()) {
    const trimmed = typeof v === "string" ? v.trim() : v;
    if (trimmed === "" || trimmed === null) continue;
    if (k === "qtyOrdered") fields[k] = Number(trimmed);
    else fields[k] = trimmed;
  }
  const purchaserNotes = fields.purchaserNotes;
  delete fields.purchaserNotes;

  modalErr.hidden = true;
  modalSubmit.disabled = true;
  modalSubmit.textContent = "Saving…";
  try {
    const res = await fetch(`${WORKER_URL}/update/${modalRow.pageId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: modalAction,
        fields,
        purchaserName: purchaserSel.value,
        purchaserNotes,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Update failed");
    closeModal();
    await loadPending();
  } catch (e) {
    modalErr.textContent = e.message || "Update failed";
    modalErr.hidden = false;
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Confirm";
  }
});

// ----- Bulk Mark Ordered modal -----
//
// Reuses the shared modal shell but swaps in a per-item qty table at the top
// (one row per selected request, each with its own editable Qty Ordered) and
// the same shared-field block (Order # / PO # / Ordered Date / ETA /
// Tracking / Notes) below it.

let bulkModalRows = []; // snapshot of selected rows at modal-open time

function openBulkOrderedModal() {
  if (!purchaserSel.value) {
    alert("Please select your name in the top bar before bulk-ordering.");
    purchaserSel.focus();
    return;
  }
  // Snapshot the current selection so a refresh-after-submit doesn't strand it.
  const selectedIds = [...bulkSelection];
  bulkModalRows = allRows.filter(r => selectedIds.includes(r.pageId));
  if (bulkModalRows.length === 0) return;

  // Vendor mismatch: warn (not block) when selected rows have different
  // primary vendors. Most bulk orders go to a single vendor; mixed selection
  // is occasionally intentional but worth a heads-up.
  const vendors = new Set(bulkModalRows.map(primaryVendor).filter(Boolean));
  const vendorWarning = vendors.size > 1
    ? `<div class="bulk-vendor-warning">
         <strong>Heads up:</strong> these items have ${vendors.size} different vendors
         (${[...vendors].map(escapeHtml).join(", ")}). Make sure you're putting them on
         the right PO before confirming.
       </div>`
    : "";

  // Lead time hint for ETA default — use the longest among selected items so
  // the auto-defaulted ETA is conservative. Falls back to no default if no
  // item has a parseable lead time.
  const leadDaysList = bulkModalRows.map(r => leadTimeToDays(r.leadTime)).filter(d => d != null && d > 0);
  const maxLead = leadDaysList.length ? Math.max(...leadDaysList) : null;
  const today = todayISO();
  const defaultETA = maxLead != null ? addDaysISO(today, maxLead) : "";
  const etaHint = maxLead != null
    ? ` <span class="muted">(longest lead = ${maxLead}d from order date)</span>`
    : "";

  // Per-item qty table — one editable row per selected request. Default to
  // MOQ when known, else previously-recorded qtyOrdered, else blank.
  const itemsTableRows = bulkModalRows.map(r => {
    const title = r.itemName || r.customItemName || "(unnamed)";
    const qtyDefault = r.moqQty ?? r.qtyOrdered ?? "";
    const vendor = primaryVendor(r);
    return `
      <tr data-page-id="${escapeHtml(r.pageId)}">
        <td class="bulk-items-id">${escapeHtml(r.orderNum)}</td>
        <td class="bulk-items-title">
          <div class="bulk-items-title-text">${escapeHtml(title)}</div>
          ${vendor ? `<div class="bulk-items-vendor">${escapeHtml(vendor)}</div>` : ""}
        </td>
        <td class="bulk-items-qty">
          <input type="number" class="bulk-qty-input" min="1" value="${qtyDefault}" aria-label="Qty Ordered for ${escapeHtml(r.orderNum)}">
        </td>
      </tr>
    `;
  }).join("");

  modalTitle.textContent = `Mark ${bulkModalRows.length} items as Ordered`;
  modalContext.innerHTML = vendors.size === 1
    ? `<strong>${bulkModalRows.length} items</strong> · Vendor: ${escapeHtml([...vendors][0])}`
    : `<strong>${bulkModalRows.length} items</strong> selected for bulk ordering`;
  modalForm.innerHTML = `
    ${vendorWarning}
    <div class="bulk-items-table-wrap">
      <table class="bulk-items-table">
        <thead><tr>
          <th>Request #</th>
          <th>Item</th>
          <th class="bulk-items-qty-head">Qty Ordered<span class="req">*</span></th>
        </tr></thead>
        <tbody>${itemsTableRows}</tbody>
      </table>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="bf-orderNumber">Order #<span class="req">*</span></label>
        <input id="bf-orderNumber" name="orderNumber" type="text" placeholder="e.g. #12345">
        <label class="field-checkbox">
          <input type="checkbox" id="bf-noOrderNumber" name="noOrderNumber" value="1">
          <span>No Order # available</span>
        </label>
      </div>
      <div class="field">
        <label for="bf-poNumber">PO #<span class="req">*</span></label>
        <input id="bf-poNumber" name="poNumber" type="text" placeholder="e.g. PO-2026-0042">
        <label class="field-checkbox">
          <input type="checkbox" id="bf-noPO" name="noPO" value="1">
          <span>No PO # available</span>
        </label>
      </div>
    </div>
    <div class="field">
      <label for="bf-orderedDate">Ordered Date<span class="req">*</span></label>
      <input id="bf-orderedDate" name="orderedDate" type="date" value="${today}">
    </div>
    <div class="field">
      <label for="bf-eta">ETA<span class="req">*</span>${etaHint}</label>
      <input id="bf-eta" name="eta" type="date" value="${defaultETA}" data-lead-days="${maxLead ?? ""}">
    </div>
    <div class="field">
      <label for="bf-tracking">Tracking # <span class="muted">(optional, same for all)</span></label>
      <input id="bf-tracking" name="tracking" type="text">
    </div>
    <div class="field">
      <label for="bf-purchaserNotes">Purchaser notes <span class="muted">(optional, applied to all)</span></label>
      <input id="bf-purchaserNotes" name="purchaserNotes" type="text">
    </div>
  `;
  modalErr.hidden = true;
  modal.hidden = false;

  // Wire toggles
  const wireNoToggle = (boxId, inputId, placeholderOn, placeholderOff) => {
    const box = modalForm.querySelector(`#${boxId}`);
    const input = modalForm.querySelector(`#${inputId}`);
    if (!box || !input) return;
    box.addEventListener("change", () => {
      if (box.checked) {
        input.value = "";
        input.disabled = true;
        input.placeholder = placeholderOn;
      } else {
        input.disabled = false;
        input.placeholder = placeholderOff;
        input.focus();
      }
    });
  };
  wireNoToggle("bf-noOrderNumber", "bf-orderNumber", "Not provided", "e.g. #12345");
  wireNoToggle("bf-noPO",          "bf-poNumber",   "Not provided", "e.g. PO-2026-0042");

  // ETA auto-slide on Ordered Date change (mirrors single-row modal)
  const orderedInput = modalForm.querySelector("#bf-orderedDate");
  const etaInput     = modalForm.querySelector("#bf-eta");
  if (orderedInput && etaInput && maxLead != null) {
    let etaTouched = false;
    etaInput.addEventListener("input", () => { etaTouched = true; });
    orderedInput.addEventListener("input", () => {
      if (etaTouched) return;
      if (!orderedInput.value) return;
      etaInput.value = addDaysISO(orderedInput.value, maxLead);
    });
  }

  // Flag the submit handler to take the bulk path
  modalAction = "__bulkOrdered";
  modalRow = null;

  // Auto-focus the Order # input
  const firstInput = modalForm.querySelector("#bf-orderNumber");
  if (firstInput) firstInput.focus();
}

async function submitBulkOrdered() {
  const f = (id) => modalForm.querySelector("#" + id);
  const truthyBox = (id) => { const el = f(id); return !!el && el.checked; };
  const sharedFields = {
    orderNumber:   f("bf-orderNumber")?.value.trim() || "",
    poNumber:      f("bf-poNumber")?.value.trim() || "",
    orderedDate:   f("bf-orderedDate")?.value || "",
    eta:           f("bf-eta")?.value || "",
    tracking:      f("bf-tracking")?.value.trim() || "",
    noPO:          truthyBox("bf-noPO"),
    noOrderNumber: truthyBox("bf-noOrderNumber"),
  };
  // Strip empty/false so the worker's validator doesn't get confused
  for (const k of Object.keys(sharedFields)) {
    if (sharedFields[k] === "" || sharedFields[k] === false) delete sharedFields[k];
  }

  // Per-item qty pulled from the table rows; reject if any are blank/<=0
  const qtyRows = [...modalForm.querySelectorAll(".bulk-items-table tbody tr")];
  const items = [];
  for (const tr of qtyRows) {
    const pageId = tr.dataset.pageId;
    const raw    = tr.querySelector(".bulk-qty-input").value.trim();
    if (!raw) { return failBulk(`Qty Ordered is required on every row — check the table above.`); }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { return failBulk(`Qty must be a positive number — check the table above.`); }
    items.push({ pageId, qtyOrdered: n });
  }

  const purchaserNotes = f("bf-purchaserNotes")?.value.trim() || "";

  modalErr.hidden = true;
  modalSubmit.disabled = true;
  modalSubmit.textContent = "Saving…";
  try {
    const res = await fetch(`${WORKER_URL}/bulk-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ordered",
        sharedFields,
        items,
        purchaserName: purchaserSel.value,
        purchaserNotes,
      }),
    });
    const data = await res.json();
    if (!res.ok && res.status !== 207) {
      const firstErr = (data.results || []).find(r => !r.ok)?.error || data.error || "Bulk update failed";
      throw new Error(firstErr);
    }
    // Surface per-row failures in the modal if any
    const failures = (data.results || []).filter(r => !r.ok);
    if (failures.length) {
      const lines = failures.map(fr => {
        const matched = bulkModalRows.find(r => r.pageId === fr.pageId);
        const label = matched ? matched.orderNum : (fr.pageId || "?");
        return `• ${label}: ${escapeHtml(fr.error || "unknown error")}`;
      }).join("<br>");
      modalErr.innerHTML = `${data.updated} updated, ${failures.length} failed:<br>${lines}`;
      modalErr.hidden = false;
    } else {
      closeModal();
    }
    // Clear out succeeded selections so a follow-up bulk doesn't reapply
    const succeededIds = new Set((data.results || []).filter(r => r.ok).map(r => r.pageId));
    for (const id of succeededIds) bulkSelection.delete(id);
    await loadPending();
    refreshBulkBar();
  } catch (e) {
    failBulk(e.message || "Bulk update failed");
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Confirm";
  }
}

function failBulk(msg) {
  modalErr.textContent = msg;
  modalErr.hidden = false;
}

// Stop the wheel from silently bumping focused number inputs ("5000 -> 5006"
// bug Zach hit). When a number input has focus and the user scrolls, blur it
// — the page scrolls and the value stays put.
document.addEventListener("wheel", (e) => {
  const el = document.activeElement;
  if (el && el.tagName === "INPUT" && el.type === "number") {
    el.blur();
  }
}, { passive: true });

// Boot
loadPeople().then(loadPending);
