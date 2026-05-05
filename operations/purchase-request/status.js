// Status page — shared dashboard for the inventory request log.
// Audience: requestors, purchasers, managers, owner. Anyone can see anyone's
// request and where it sits in the purchase + delivery process.

const WORKER_URL = (window.WORKER_URL_OVERRIDE) || "https://inventory-request-form.purchasing-906.workers.dev";

const $ = (id) => document.getElementById(id);

// ----- DOM refs -----
const refreshBtn   = $("refresh-btn");
const pillsEl      = $("status-pills");
const heroSubEl    = $("hero-sub");
const loadingEl    = $("loading");
const errorEl      = $("error");
const emptyEl      = $("empty");
const activeEl     = $("active");
const activeListEl = $("active-list");
const archiveEl    = $("archive-section");
const archiveListEl= $("archive-list");
const lastRefEl    = $("last-refreshed");

// ----- State -----
let allRows = [];          // every request returned from /requests
let activeFilter = "all";  // one of: all | Submitted | Waiting to Order | Backordered | Ordered | archive

const STAGE_DEF = [
  { key: "Submitted",         label: "Submitted" },
  { key: "Waiting to Order",  label: "Waiting" },
  { key: "Backordered",       label: "Backordered" },
  { key: "Ordered",           label: "Ordered" },
  { key: "Received",          label: "Received" },
];
const STAGE_INDEX = {
  "Submitted": 0,
  "Waiting to Order": 1,
  "Backordered": 1,
  "Ordered": 2,
  "Received": 4,
};

// ----- Utilities -----
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtRelative(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const days = Math.floor(ms / 86400000);
  if (days <= 0)  return "today";
  if (days === 1) return "yesterday";
  if (days < 7)   return `${days} days ago`;
  if (days < 30)  return `${Math.floor(days / 7)} week${days < 14 ? "" : "s"} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? "" : "s"} ago`;
  return `${Math.floor(days / 365)} year${days < 730 ? "" : "s"} ago`;
}

function fmtTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function statusKindClass(status) {
  // Used to pick the left accent on the card.
  if (status === "Received")  return "kind-success";
  if (status === "Cancelled") return "kind-cancelled";
  if (status === "Backordered") return "kind-warn";
  if (status === "Ordered")   return "kind-active";
  return "kind-neutral";
}

// ----- Boot -----
refreshBtn.addEventListener("click", () => loadAndRender());

pillsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  for (const p of pillsEl.querySelectorAll(".pill")) {
    p.classList.remove("active");
    p.setAttribute("aria-selected", "false");
  }
  btn.classList.add("active");
  btn.setAttribute("aria-selected", "true");
  activeFilter = btn.dataset.status;
  renderRows();
});

async function loadAndRender() {
  loadingEl.hidden = false;
  errorEl.hidden = true;
  emptyEl.hidden = true;
  activeEl.hidden = true;
  archiveEl.hidden = true;

  try {
    const res = await fetch(`${WORKER_URL}/requests`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    allRows = data.rows || [];
    lastRefEl.textContent = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    renderRows();
  } catch (e) {
    errorEl.textContent = e.message || "Couldn't load the request log.";
    errorEl.hidden = false;
  } finally {
    loadingEl.hidden = true;
  }
}

// ----- Counts + rendering -----
function updateCounts(rows) {
  const counts = {
    all: 0,
    Submitted: 0,
    "Waiting to Order": 0,
    Backordered: 0,
    Ordered: 0,
    archive: 0,
  };
  for (const r of rows) {
    if (r.status === "Received" || r.status === "Cancelled") {
      counts.archive++;
    } else if (counts[r.status] !== undefined) {
      counts[r.status]++;
      counts.all++;
    } else {
      counts.all++;
    }
  }
  $("count-all").textContent = counts.all;
  $("count-Submitted").textContent = counts.Submitted;
  $("count-Waiting-to-Order").textContent = counts["Waiting to Order"];
  $("count-Backordered").textContent = counts.Backordered;
  $("count-Ordered").textContent = counts.Ordered;
  $("count-archive").textContent = counts.archive;
  return counts;
}

function updateHeroSub(counts) {
  if (counts.all === 0 && counts.archive === 0) {
    heroSubEl.textContent = `No requests yet.`;
    return;
  }
  if (counts.all === 0) {
    heroSubEl.textContent = `Nothing in motion. ${counts.archive} closed.`;
    return;
  }
  const word = counts.all === 1 ? "request" : "requests";
  const waiting = counts.Backordered + counts["Waiting to Order"];
  heroSubEl.innerHTML = `<strong>${counts.all}</strong> ${word} in motion — ${counts.Submitted} submitted, ${counts.Ordered} on a PO, ${waiting} waiting.`;
}

function renderRows() {
  const counts = updateCounts(allRows);
  updateHeroSub(counts);

  // Partition by archive vs active
  const active = allRows.filter(r => r.status !== "Received" && r.status !== "Cancelled");
  const archive = allRows.filter(r => r.status === "Received" || r.status === "Cancelled");

  let visibleActive = active;
  let visibleArchive = [];

  if (activeFilter === "archive") {
    visibleActive = [];
    visibleArchive = archive;
  } else if (activeFilter !== "all") {
    visibleActive = active.filter(r => r.status === activeFilter);
  }

  // Active list
  activeListEl.innerHTML = "";
  if (visibleActive.length > 0) {
    visibleActive.forEach((r, i) => {
      const card = renderCard(r, i);
      activeListEl.appendChild(card);
    });
    activeEl.hidden = false;
  } else {
    activeEl.hidden = true;
  }

  // Archive list
  archiveListEl.innerHTML = "";
  if (visibleArchive.length > 0) {
    visibleArchive.forEach((r, i) => {
      archiveListEl.appendChild(renderArchiveCard(r, i));
    });
    archiveEl.hidden = false;
  } else {
    archiveEl.hidden = true;
  }

  // Empty state — only when truly no rows match the filter
  if (visibleActive.length === 0 && visibleArchive.length === 0) {
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
  }
}

function renderCard(r, idx) {
  const li = document.createElement("li");
  li.className = "request-card";
  if (r.outOfStock) li.classList.add("urgent");
  li.style.animationDelay = `${Math.min(idx, 8) * 60}ms`;

  const itemTitle = r.itemName || r.customItemName || "(unnamed item)";
  const description = r.description || "";

  // Stages
  const stages = renderStages(r);
  const progressPct = stagePctFor(r);

  // Status-specific spotlight detail
  const spotlight = renderSpotlight(r);

  // Notes
  const notesHtml = renderNotes(r);

  li.innerHTML = `
    <div class="card-row">
      ${r.image
        ? `<img class="card-thumb" src="${escapeHtml(r.image)}" alt="">`
        : `<div class="card-thumb-fallback">${r.type === "Supply" ? "📦" : r.type === "Other" ? "🛠️" : "🔩"}</div>`}
      <div class="card-info">
        <div class="card-eyebrow">
          <span class="order-num">${escapeHtml(r.orderNum || "—")}</span>
          <span class="eyebrow-divider"></span>
          <span>Requested by <span class="requestor-name">${escapeHtml(r.requestor || "—")}</span></span>
          ${r.dateRequested ? `<span class="eyebrow-divider"></span><span title="${fmtDate(r.dateRequested)}">${fmtRelative(r.dateRequested)}</span>` : ""}
        </div>
        <div class="card-title-row">
          <strong class="card-title">${escapeHtml(itemTitle)}</strong>
          ${description ? `<span class="card-title-desc">— ${escapeHtml(description)}</span>` : ""}
        </div>
        <div class="card-tags">
          ${r.type ? `<span class="badge">${escapeHtml(r.type.toUpperCase())}</span>` : ""}
          ${r.category ? `<span class="badge badge-category">${escapeHtml(r.category.toUpperCase())}</span>` : ""}
          ${r.notInDb ? `<span class="badge badge-category">NEW ITEM</span>` : ""}
          ${r.vendor ? `<span class="badge badge-category">${escapeHtml(r.vendor.toUpperCase())}</span>` : ""}
        </div>
      </div>
      <span class="card-status-badge" data-status="${escapeHtml(r.status)}">${escapeHtml(r.status || "—")}</span>
    </div>

    <div class="process-rail ${r.status === "Cancelled" ? "is-cancelled" : ""}" style="--rail-progress: ${progressPct}%;">
      <div class="rail-stages">${stages}</div>
    </div>

    ${spotlight}
    ${notesHtml}

    <div class="card-footer-row">
      <span>${r.createdTime ? `Submitted ${fmtTimestamp(r.createdTime)}` : ""}</span>
      <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Open in Notion ↗</a>
    </div>
  `;
  return li;
}

function renderArchiveCard(r, idx) {
  const li = document.createElement("li");
  li.className = "request-card";
  li.style.animationDelay = `${Math.min(idx, 8) * 40}ms`;

  const itemTitle = r.itemName || r.customItemName || "(unnamed item)";
  const isReceived  = r.status === "Received";
  const isCancelled = r.status === "Cancelled";

  const closedLine = isReceived
    ? `<strong>Received</strong> ${r.receivedDate ? fmtDate(r.receivedDate) : ""}`
    : `<strong>Cancelled</strong>${r.reasonCode ? ` — ${escapeHtml(r.reasonCode)}` : ""}`;

  const dotColor = isReceived ? "var(--success)" : "var(--ink-faint)";

  li.innerHTML = `
    <div class="card-row">
      ${r.image
        ? `<img class="card-thumb" src="${escapeHtml(r.image)}" alt="">`
        : `<div class="card-thumb-fallback">${r.type === "Supply" ? "📦" : "🔩"}</div>`}
      <div class="card-info">
        <div class="card-eyebrow">
          <span class="order-num">${escapeHtml(r.orderNum || "—")}</span>
          <span class="eyebrow-divider"></span>
          <span>${escapeHtml(r.requestor || "—")}</span>
        </div>
        <div class="card-title-row">
          <strong class="card-title">${escapeHtml(itemTitle)}</strong>
        </div>
        <div class="archive-meta">
          <span>${closedLine}</span>
          ${r.qtyOrdered != null ? `<span>Qty: <strong>${r.qtyOrdered}</strong></span>` : ""}
          ${r.poNumber ? `<span>PO: <strong>${escapeHtml(r.poNumber)}</strong></span>` : ""}
          ${r.cancellationReason ? `<span>Reason: ${escapeHtml(r.cancellationReason)}</span>` : ""}
        </div>
      </div>
      <span class="card-status-badge" data-status="${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
    </div>
  `;
  return li;
}

// ----- Process rail rendering -----
function stagePctFor(row) {
  if (row.status === "Cancelled") return 100;
  const idx = STAGE_INDEX[row.status];
  if (idx === undefined || idx === null) return 0;
  return (idx / (STAGE_DEF.length - 1)) * 100;
}

function renderStages(r) {
  const currentIdx = STAGE_INDEX[r.status] ?? -1;
  const isCancelled = r.status === "Cancelled";
  const isBackordered = r.status === "Backordered";
  const isWaiting = r.status === "Waiting to Order";

  return STAGE_DEF.map((stage, i) => {
    let cls = "stage";
    let detail = "";

    if (isCancelled) {
      // Cancelled: mark all stages up to where it died as done, the rest as cancelled
      cls += " cancelled";
    } else if (i < currentIdx) {
      cls += " done";
    } else if (i === currentIdx) {
      cls += " active";
    }

    // Stage-specific detail under each marker (so the "story" is visible at a glance)
    if (i === 0 && r.dateRequested)              detail = fmtDate(r.dateRequested);
    else if (i === 1 && (isWaiting || isBackordered) && r.eta) detail = `ETA ${fmtDate(r.eta)}`;
    else if (i === 2 && r.orderedDate)           detail = fmtDate(r.orderedDate);
    else if (i === 2 && r.eta && r.status === "Ordered") detail = `ETA ${fmtDate(r.eta)}`;
    else if (i === 3 && r.tracking)              detail = "In transit";
    else if (i === 4 && r.receivedDate)          detail = fmtDate(r.receivedDate);

    let labelText = stage.label;
    if (i === 1) {
      if (isBackordered) labelText = "Backordered";
      else if (isWaiting) labelText = "Waiting";
      else labelText = "Waiting";
    }
    if (i === 3) labelText = "In Transit";

    const checkSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3.5 3.5L13 5"/></svg>`;
    return `
      <div class="${cls}">
        <div class="stage-marker">
          ${checkSvg}
          <span class="num">${i + 1}</span>
        </div>
        <div class="stage-label">${escapeHtml(labelText)}</div>
        ${detail ? `<div class="stage-detail">${escapeHtml(detail)}</div>` : ""}
      </div>
    `;
  }).join("");
}

// Status-specific detail spotlight grid — shows the most relevant fields
// for the current stage prominently, plus secondary fields below.
function renderSpotlight(r) {
  const cells = [];

  // Highlighted (status-relevant) cells
  if (r.status === "Submitted") {
    if (r.dateRequested) cells.push({ label: "Submitted", value: fmtDate(r.dateRequested), highlight: true });
    if (r.priority)      cells.push({ label: "Priority",  value: r.priority, highlight: r.priority === "Urgent" });
  } else if (r.status === "Waiting to Order") {
    if (r.reason) cells.push({ label: "Why waiting", value: r.reason, highlight: true });
  } else if (r.status === "Backordered") {
    if (r.eta)    cells.push({ label: "Expected",    value: fmtDate(r.eta), highlight: true });
    if (r.reason) cells.push({ label: "Why backordered", value: r.reason });
  } else if (r.status === "Ordered") {
    if (r.poNumber)    cells.push({ label: "PO #",         value: r.poNumber,            highlight: true });
    if (r.qtyOrdered != null) cells.push({ label: "Qty ordered", value: r.qtyOrdered, numeric: true, highlight: true });
    if (r.eta)         cells.push({ label: "Expected",     value: fmtDate(r.eta) });
    if (r.orderedDate) cells.push({ label: "Ordered",      value: fmtDate(r.orderedDate) });
    if (r.tracking)    cells.push({ label: "Tracking #",   value: r.tracking });
  }

  // Always-on secondary cells
  if (r.vendor)        cells.push({ label: "Vendor", value: r.vendor });
  if (r.moqQty != null) cells.push({ label: "MOQ", value: r.moqQty, numeric: true });
  if (r.leadTime)      cells.push({ label: "Lead time", value: r.leadTime });

  if (cells.length === 0) return "";

  return `<div class="detail-grid">${cells.map(c => `
    <div class="detail ${c.highlight ? "highlight" : ""}">
      <span class="detail-label">${escapeHtml(c.label)}</span>
      <span class="detail-value ${c.numeric ? "numeric" : ""}">${escapeHtml(c.value)}</span>
    </div>
  `).join("")}</div>`;
}

function renderNotes(r) {
  const blocks = [];
  if (r.notes) {
    blocks.push(`<div class="notes-block"><span class="note-label">Requester:</span><span class="note-body">${escapeHtml(r.notes)}</span></div>`);
  }
  if (r.purchaserNotes) {
    blocks.push(`<div class="notes-block kind-purchaser"><span class="note-label">Purchaser:</span><span class="note-body">${escapeHtml(r.purchaserNotes)}</span></div>`);
  }
  return blocks.join("");
}

// ----- Init -----
loadAndRender();
