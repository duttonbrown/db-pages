// Status page — shared dashboard for the inventory request log.
// Audience: requestors, purchasers, managers, owner. Anyone can see anyone's
// request and where it sits in the purchase + delivery process.

const WORKER_URL = (window.WORKER_URL_OVERRIDE) || "https://inventory-request-form.purchasing-906.workers.dev";

const $ = (id) => document.getElementById(id);

// ----- DOM refs -----
const refreshBtn    = $("refresh-btn");
const pillsEl       = $("status-pills");
const heroSubEl     = $("hero-sub");
const loadingBar    = $("loading-bar");
const loadingFill   = loadingBar?.querySelector(".loading-fill");
const loadingMsgEl  = $("loading-message");
const errorEl       = $("error");
const emptyEl       = $("empty");
const activeEl      = $("active");
const activeListEl  = $("active-list");
const archiveEl     = $("archive-section");
const archiveListEl = $("archive-list");
const lastRefEl     = $("last-refreshed");

// Keep this list in sync with app.js LOADING_MESSAGES.
const LOADING_MESSAGES = [
  "Don't forget to eat your veggies and remember to say something nice to someone you love.",
  "Drink some water. Stretch your shoulders. We'll be ready in a sec.",
  "Take a deep breath in… and out. Catalog incoming.",
  "Do the macarena. By the time you finish, the list should be loaded.",
  "Wiggle your toes for 10 seconds while this loads. Surprisingly underrated.",
];

// ----- State -----
let allRows = [];          // every request returned from /requests
let activeFilter = "all";  // one of: all | Submitted | Waiting to Order | Backordered | Ordered | archive

// The rail is built per-row, not from a fixed pipeline. Slot 2 ("Middle")
// reflects what actually happened — Ordered, Backordered, Waiting, or
// (for terminal cancellations) Cancelled. See buildStages() below.

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
  errorEl.hidden = true;
  emptyEl.hidden = true;
  activeEl.hidden = true;
  archiveEl.hidden = true;

  if (loadingMsgEl) {
    loadingMsgEl.textContent = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
  }
  if (loadingFill) loadingFill.style.width = "0%";
  loadingBar.hidden = false;
  let pct = 0;
  const tick = setInterval(() => {
    if (!loadingFill) return;
    pct = Math.min(95, pct + Math.max(2, (95 - pct) * 0.10));
    loadingFill.style.width = pct + "%";
  }, 150);

  try {
    const res = await fetch(`${WORKER_URL}/requests`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    allRows = data.rows || [];
    lastRefEl.textContent = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (loadingFill) loadingFill.style.width = "100%";
    renderRows();
  } catch (e) {
    errorEl.textContent = e.message || "Couldn't load the request log.";
    errorEl.hidden = false;
  } finally {
    clearInterval(tick);
    setTimeout(() => { loadingBar.hidden = true; }, 250);
  }
}

// ----- Counts + rendering -----
//
// Buckets:
//   - "In motion" (all): everything that's not Received or Cancelled
//   - Received:  its own filter (the "I got my stuff" view)
//   - Archive:   Cancelled only — the dead end
function updateCounts(rows) {
  const counts = {
    all: 0,
    Submitted: 0,
    "Waiting to Order": 0,
    Backordered: 0,
    Ordered: 0,
    Received: 0,
    archive: 0,
  };
  for (const r of rows) {
    if (r.status === "Cancelled") {
      counts.archive++;
    } else if (r.status === "Received") {
      counts.Received++;
    } else if (counts[r.status] !== undefined) {
      counts[r.status]++;
      counts.all++;
    } else {
      counts.all++;
    }
  }
  $("count-all").textContent = counts.all;
  $("count-Submitted").textContent = counts.Submitted;
  $("count-Ordered").textContent = counts.Ordered;
  $("count-Backordered").textContent = counts.Backordered;
  $("count-Waiting-to-Order").textContent = counts["Waiting to Order"];
  $("count-Received").textContent = counts.Received;
  $("count-archive").textContent = counts.archive;
  return counts;
}

function updateHeroSub(counts) {
  if (counts.all === 0 && counts.Received === 0 && counts.archive === 0) {
    heroSubEl.textContent = `No requests yet.`;
    return;
  }
  if (counts.all === 0) {
    const tail = [];
    if (counts.Received) tail.push(`${counts.Received} received`);
    if (counts.archive)  tail.push(`${counts.archive} cancelled`);
    heroSubEl.textContent = `Nothing in motion${tail.length ? " — " + tail.join(", ") : "."}`;
    return;
  }
  const word = counts.all === 1 ? "request" : "requests";
  const waiting = counts.Backordered + counts["Waiting to Order"];
  heroSubEl.innerHTML = `<strong>${counts.all}</strong> ${word} in motion — ${counts.Submitted} submitted, ${counts.Ordered} on a PO, ${waiting} waiting.`;
}

function renderRows() {
  const counts = updateCounts(allRows);
  updateHeroSub(counts);

  // Partition: active = in motion (excludes Received + Cancelled).
  //            Received and Cancelled each get their own dedicated view.
  const active   = allRows.filter(r => r.status !== "Received" && r.status !== "Cancelled");
  const received = allRows.filter(r => r.status === "Received");
  const archive  = allRows.filter(r => r.status === "Cancelled");

  let visibleActive = active;
  let visibleArchive = [];

  if (activeFilter === "archive") {
    visibleActive = [];
    visibleArchive = archive;
  } else if (activeFilter === "Received") {
    visibleActive = [];
    visibleArchive = received;
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

  // Archive list (also hosts Received view)
  archiveListEl.innerHTML = "";
  if (visibleArchive.length > 0) {
    const titleEl = $("archive-title");
    const subEl   = $("archive-sub");
    if (activeFilter === "Received") {
      titleEl.textContent = "Received";
      subEl.textContent = "Items that have arrived";
    } else if (activeFilter === "archive") {
      titleEl.textContent = "Cancelled";
      subEl.textContent = "Requests that won't be filled";
    } else {
      titleEl.textContent = "Closed";
      subEl.textContent = "Already received or cancelled";
    }
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

  // Stages — built per-row; rail length and middle-slot label are dynamic.
  const built = buildStages(r);
  const stages = renderStages(r);
  const progressPct = built.progressPct;
  const stageCount = built.stages.length;

  // Status-specific spotlight detail
  const spotlight = renderSpotlight(r);

  // Tracking row — dedicated panel below the spotlight when a tracking
  // number is on file. Shows on Ordered and Received cards.
  const trackingRow = (r.status === "Ordered" || r.status === "Received")
    ? renderTrackingRow(r.tracking)
    : "";

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
      <div class="rail-stages" data-stage-count="${stageCount}" style="grid-template-columns: repeat(${stageCount}, 1fr);">${stages}</div>
    </div>

    ${spotlight}
    ${trackingRow}
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
//
// The rail's middle slot is dynamic — it reflects what actually happened to
// THIS request, not a fixed pipeline. Active rows always show 3 slots:
//
//   Submitted → (Waiting | Backordered | Ordered) → Received
//
// Cancelled rows are terminal and only show 2 slots:
//
//   Submitted → Cancelled (with reason underneath)

// Each slot has one of these states:
//   done     — confirmed, shows a check
//   active   — currently in progress (no check, accent ring)
//   upcoming — future step (faded, visible so the path is clear)
//   cancelled — terminal X marker, only for Cancelled rows
//
// A check appears on every "done" slot, so as a request advances you see the
// timeline fill in: Submitted ✓ → Ordered ✓ → In Transit ✓ → Received ✓.
function buildStages(r) {
  const status = r.status;
  const isCancelled = status === "Cancelled";

  if (isCancelled) {
    // Terminal 2-stage rail: Submitted ✓ → Cancelled
    const reason = r.reasonCode || r.cancellationReason || "Cancelled";
    return {
      stages: [
        { state: "done",      label: "Submitted", detail: r.dateRequested ? fmtDate(r.dateRequested) : "" },
        { state: "cancelled", label: "Cancelled", detail: reason },
      ],
      progressPct: 100,
      cancelled: true,
    };
  }

  // 4-stage rail: Submitted → (middle) → In Transit → Received
  // Middle slot relabels per row: Waiting / Backordered / Ordered.
  const middle = stageForMiddle(r);
  const isReceived = status === "Received";
  const isOrderedOrBeyond = status === "Ordered" || isReceived;

  // First slot — always done because the row exists.
  const submitted = {
    state: "done",
    label: "Submitted",
    detail: r.dateRequested ? fmtDate(r.dateRequested) : "",
  };

  // Third slot — In Transit. Auto-checked when a carrier-detected tracking
  // number is on file (presence of a real tracking number = "this is moving").
  // Only meaningful once the order has actually been placed.
  const carrier = (isOrderedOrBeyond && r.tracking) ? detectCarrier(r.tracking) : null;
  let inTransit;
  if (isReceived) {
    inTransit = { state: "done", label: "In Transit", detail: carrier ? carrier.name : "" };
  } else if (status === "Ordered" && carrier) {
    inTransit = { state: "done", label: "In Transit", detail: carrier.name };
  } else if (status === "Ordered") {
    // Ordered but no tracking yet — this is the active "what comes next" slot
    inTransit = { state: "active", label: "In Transit", detail: "Awaiting tracking" };
  } else {
    inTransit = { state: "upcoming", label: "In Transit", detail: "" };
  }

  // Fourth slot — Received.
  const received = {
    state: isReceived ? "done" : "upcoming",
    label: "Received",
    detail: isReceived && r.receivedDate ? fmtDate(r.receivedDate) : "",
  };

  // Progress fill: 0%, 33%, 66%, 100% across the four slots.
  let progressPct;
  if (status === "Submitted")        progressPct = 0;
  else if (isReceived)               progressPct = 100;
  else if (status === "Ordered" && carrier) progressPct = 75; // past the In-Transit check
  else if (status === "Ordered")     progressPct = 50;        // through Ordered
  else                                progressPct = 33;        // Waiting / Backordered

  return {
    stages: [submitted, middle, inTransit, received],
    progressPct,
    cancelled: false,
  };
}

// Builds the dynamic middle slot. Label and state reflect the row's status.
//   - Submitted: middle is upcoming "Ordered" (faded preview of next step)
//   - Waiting / Backordered: middle is active (in progress, no check)
//   - Ordered: middle is done (the order is confirmed → check)
//   - Received: middle is done (Ordered is in the past)
function stageForMiddle(r) {
  const status = r.status;

  if (status === "Submitted") {
    return { state: "upcoming", label: "Ordered", detail: "" };
  }

  if (status === "Waiting to Order") {
    return {
      state: "active",
      label: "Waiting",
      detail: r.reason || (r.eta ? `ETA ${fmtDate(r.eta)}` : ""),
    };
  }

  if (status === "Backordered") {
    return {
      state: "active",
      label: "Backordered",
      detail: r.eta ? `ETA ${fmtDate(r.eta)}` : (r.reason || ""),
    };
  }

  if (status === "Ordered") {
    // The order is confirmed → done check. Date underneath tells the story.
    return {
      state: "done",
      label: "Ordered",
      detail: r.orderedDate ? fmtDate(r.orderedDate) : "",
    };
  }

  if (status === "Received") {
    return {
      state: "done",
      label: "Ordered",
      detail: r.orderedDate ? fmtDate(r.orderedDate) : "",
    };
  }

  return { state: "upcoming", label: status || "—", detail: "" };
}

function renderStages(r) {
  const { stages } = buildStages(r);
  const checkSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3.5 3.5L13 5"/></svg>`;
  const cancelSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

  return stages.map((s, i) => {
    let cls = "stage";
    if (s.state === "done")      cls += " done";
    else if (s.state === "active") cls += " active";
    else if (s.state === "cancelled") cls += " cancelled";
    else if (s.state === "upcoming")  cls += " upcoming";

    const icon = s.state === "cancelled" ? cancelSvg : checkSvg;
    return `
      <div class="${cls}">
        <div class="stage-marker">
          ${icon}
          <span class="num">${i + 1}</span>
        </div>
        <div class="stage-label">${escapeHtml(s.label)}</div>
        ${s.detail ? `<div class="stage-detail">${escapeHtml(s.detail)}</div>` : ""}
      </div>
    `;
  }).join("");
}

// ----- Carrier detection from tracking number -----
//
// Heuristic match against known carrier formats. Returns null if the
// pattern is ambiguous or unknown — caller falls back to plain text.
const CARRIERS = [
  { name: "UPS",        re: /^1Z[0-9A-Z]{16}$/i,                                      url: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}` },
  { name: "USPS",       re: /^(94|93|92|95)\d{20}$/,                                  url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}` },
  { name: "USPS",       re: /^E[A-Z]\d{9}US$/i,                                       url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}` },
  { name: "USPS Intl",  re: /^[A-Z]{2}\d{9}[A-Z]{2}$/,                                url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}` },
  { name: "Amazon",     re: /^TBA\d{12}$/i,                                           url: (n) => `https://track.amazon.com/tracking/${encodeURIComponent(n)}` },
  { name: "FedEx",      re: /^\d{12}$/,                                               url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  { name: "FedEx",      re: /^\d{15}$/,                                               url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  { name: "FedEx",      re: /^\d{20}$/,                                               url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  { name: "OnTrac",     re: /^[CD]\d{14}$/,                                           url: (n) => `https://www.ontrac.com/tracking?number=${encodeURIComponent(n)}` },
  { name: "DHL",        re: /^\d{10,11}$/,                                            url: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(n)}` },
];

function detectCarrier(tracking) {
  if (!tracking) return null;
  const clean = String(tracking).replace(/[\s-]/g, "");
  for (const c of CARRIERS) {
    if (c.re.test(clean)) return { name: c.name, url: c.url(clean), clean };
  }
  return null;
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
    if (r.orderedDate) cells.push({ label: "Ordered",      value: fmtDate(r.orderedDate) });
    if (r.eta)         cells.push({ label: "Expected",     value: fmtDate(r.eta) });
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

// Tracking row — dedicated panel below the spotlight when a tracking number
// is on file. Auto-detects carrier from the number's syntax; if detected,
// surfaces the carrier name and a deep link to that carrier's tracking page.
// Falls back to plain text when the pattern is ambiguous.
function renderTrackingRow(tracking) {
  if (!tracking) return "";
  const carrier = detectCarrier(tracking);
  const numberHtml = carrier
    ? `<a href="${escapeHtml(carrier.url)}" target="_blank" rel="noopener" class="tracking-link">`
      + `${escapeHtml(carrier.clean)} <span class="tracking-carrier">${escapeHtml(carrier.name)}</span>`
      + ` <span class="tracking-cta">Track ↗</span></a>`
    : escapeHtml(tracking);
  return `
    <div class="tracking-row">
      <div class="tracking-label">Tracking</div>
      <div class="tracking-value">${numberHtml}</div>
    </div>
  `;
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
