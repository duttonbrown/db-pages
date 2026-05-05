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

// Vendor filter state. When set, only rows whose primary vendor matches are
// shown in the queue. Click an active digest bubble again (or the same one)
// to clear.
let vendorFilter = null;
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

function filteredRows() {
  if (!vendorFilter) return allRows;
  return allRows.filter(r => primaryVendor(r) === vendorFilter);
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
  // Re-render bubbles to update the active state and re-render the queue
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

function renderQueue(rows) {
  queueEl.innerHTML = "";
  if (rows.length === 0) {
    if (vendorFilter) {
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

  li.innerHTML = `
    <div class="pending-meta">
      <div class="order-num"></div>
      <div class="row-tags"></div>
      <div class="title-row">
        <strong class="title-text"></strong>
        <span class="title-desc"></span>
      </div>
      <div class="vendor-line"></div>
      <div class="stats-line"></div>
      <div class="row-extra"></div>
      <div class="notes"></div>
      <div class="submitted-at"></div>
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

  // Vendor line (matches requester form)
  const vendorEl = li.querySelector(".vendor-line");
  vendorEl.textContent = r.vendor ? `Vendor: ${r.vendor}` : "";
  vendorEl.hidden = !r.vendor;

  // Stats line (matches requester form): 2025 Use | Reorder Qty | Lead Time
  const statsEl = li.querySelector(".stats-line");
  const statsParts = [
    r.use2025 != null && `2025 Use: ${r.use2025}`,
    (r.moqQty != null) ? `MOQ: ${r.moqQty}` :
      ((r.reorderQty != null && r.reorderQty !== "") ? `Reorder Qty: ${r.reorderQty}` : null),
    r.leadTime && `Lead Time: ${r.leadTime}`,
  ].filter(Boolean);
  statsEl.textContent = statsParts.join("   |   ");
  statsEl.hidden = statsParts.length === 0;

  // Extra: requester / age / Qty Ordered / PO / ETA
  const extra = li.querySelector(".row-extra");
  const extraParts = [];
  extraParts.push(`<span><strong>Requested by:</strong> ${escapeHtml(r.requestor || "—")}</span>`);
  if (age != null) extraParts.push(`<span><strong>Age:</strong> ${age}d</span>`);
  if (r.qtyOrdered != null) extraParts.push(`<span><strong>Qty Ordered:</strong> ${r.qtyOrdered}</span>`);
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

  // Submission timestamp
  const submittedEl = li.querySelector(".submitted-at");
  submittedEl.textContent = submittedAt ? `Submitted ${submittedAt}` : "";
  submittedEl.hidden = !submittedAt;

  // Action buttons depend on current status
  const actions = li.querySelector(".row-actions");
  const buttons = actionsFor(r.status);
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `action-btn ${b.cls || ""}`;
    btn.textContent = b.label;
    btn.addEventListener("click", () => openModal(b.action, r));
    actions.appendChild(btn);
  }
  const link = document.createElement("a");
  link.className = "open-notion";
  link.href = r.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open in Notion ↗";
  actions.appendChild(link);

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
  // Allowed transitions per current status
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
        { action: "cancelled", label: "Cancel", cls: "action-cancel" },
      ];
    case "Ordered":
      return [
        { action: "received",    label: "Mark Received" },
        { action: "backordered", label: "Mark Backordered" },
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
    (row.vendor ? ` · Vendor: ${escapeHtml(row.vendor)}` : "");
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
    return `
      <div class="field">
        <label for="f-poNumber">PO #<span class="req">*</span></label>
        <input id="f-poNumber" name="poNumber" type="text" placeholder="e.g. PO-2026-0042">
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
        <label for="f-eta">ETA<span class="req">*</span></label>
        <input id="f-eta" name="eta" type="date">
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
  return "";
}

modalSubmit.addEventListener("click", async () => {
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

// Boot
loadPeople().then(loadPending);
