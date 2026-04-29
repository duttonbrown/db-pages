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

async function loadPending() {
  clearError();
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
    renderQueue(data.rows || []);
  } catch (e) {
    showError("Couldn't load pending requests.");
    loadingBar.hidden = true;
  } finally {
    clearInterval(tick);
  }
}

refreshBtn.addEventListener("click", loadPending);

function renderQueue(rows) {
  queueEl.innerHTML = "";
  if (rows.length === 0) {
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
  const age = ageDays(r.dateRequested);

  li.innerHTML = `
    <div class="pending-meta">
      <div class="order-num"></div>
      <div class="item-line"></div>
      <div class="row-tags"></div>
      <div class="row-meta"></div>
      <div class="notes"></div>
    </div>
    <div class="row-actions"></div>
  `;
  li.querySelector(".order-num").textContent = r.orderNum;
  const itemLine = li.querySelector(".item-line");
  itemLine.innerHTML = `<strong></strong><span class="item-desc"></span>`;
  itemLine.querySelector("strong").textContent = itemTitle;
  // For database items, the "item-desc" stays empty since itemName is the resolved name; we surface vendor in row-meta below.

  // Tags
  const tags = li.querySelector(".row-tags");
  tags.appendChild(makeBadge(r.type.toUpperCase(), "badge"));
  if (r.outOfStock) tags.appendChild(makeBadge("URGENT — OUT OF STOCK", "urgent-tag"));
  if (r.notInDb) tags.appendChild(makeBadge("NEW ITEM REQUEST", "badge-category"));

  // Meta line: vendor, requestor, age, MOQ
  const meta = li.querySelector(".row-meta");
  const metaParts = [];
  metaParts.push(`<span><strong>Vendor:</strong> ${escapeHtml(r.vendor || "—")}</span>`);
  metaParts.push(`<span><strong>Requested by:</strong> ${escapeHtml(r.requestor || "—")}</span>`);
  if (age != null) metaParts.push(`<span><strong>Age:</strong> ${age}d</span>`);
  if (r.moqQty != null) metaParts.push(`<span><strong>MOQ:</strong> ${r.moqQty}</span>`);
  if (r.qtyOrdered != null) metaParts.push(`<span><strong>Ordered:</strong> ${r.qtyOrdered}</span>`);
  if (r.poNumber) metaParts.push(`<span><strong>PO:</strong> ${escapeHtml(r.poNumber)}</span>`);
  if (r.eta) metaParts.push(`<span><strong>ETA:</strong> ${r.eta}</span>`);
  meta.innerHTML = metaParts.join("");

  // Notes block (combined requestor and purchaser context)
  const notesEl = li.querySelector(".notes");
  const noteParts = [];
  if (r.notes) noteParts.push(`Requester note: ${r.notes}`);
  if (r.purchaserNotes) noteParts.push(`Your note: ${r.purchaserNotes}`);
  if (r.reason) noteParts.push(`Reason: ${r.reason}`);
  notesEl.textContent = noteParts.join(" · ");
  notesEl.hidden = noteParts.length === 0;

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
        <label for="f-eta">ETA <span class="muted">(optional)</span></label>
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
      <div class="field">
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
