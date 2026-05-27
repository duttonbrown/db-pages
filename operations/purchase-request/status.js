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
const partBubblesEl = $("part-bubbles");
const vendorPillsEl = $("vendor-pills");

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
let activeFilter = "Ordered";  // default: Ordered (most-visited view — "where are my orders"). Pills: all | Submitted | Waiting to Order | Backordered | Ordered | In Transit | Received | archive
let activeVendor = "";     // "" = all vendors. Otherwise the primary vendor name (case-preserved) that the user pinned.
let searchQuery = "";      // free-text filter — matches across item/order/requestor/vendor/PO/notes
let sortMode = "lastUpdated";  // "lastUpdated" (default) | "requestNumber" (newest REQ-NN-#### first)

// The rail is built per-row, not from a fixed pipeline. Slot 2 ("Middle")
// reflects what actually happened — Ordered, Backordered, Waiting, or
// (for terminal cancellations) Cancelled. See buildStages() below.

// ----- Utilities -----
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
}

// The vendor field arrives as a comma-separated list when a part has multiple
// linked vendors (e.g. "Grand Brass, Ami"). Treat the first as primary — that's
// where the purchase will most likely land. The Purchaser Console uses the same
// rule for the consolidation digest.
function primaryVendor(row) {
  if (!row || !row.vendor) return "";
  const first = String(row.vendor).split(",")[0];
  return (first || "").trim();
}

function fmtDate(iso) {
  if (!iso) return "";
  // Notion date-only properties come back as "YYYY-MM-DD" (no time, no zone).
  // `new Date("YYYY-MM-DD")` parses as UTC midnight, which shifts back a day in
  // any timezone west of UTC — Mountain Time turns "2026-06-01" into May 31.
  // Build the date in local time when we recognize the date-only shape.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = dateOnly
    ? new Date(parseInt(dateOnly[1], 10), parseInt(dateOnly[2], 10) - 1, parseInt(dateOnly[3], 10))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtRelative(iso) {
  if (!iso) return "";
  // Same date-only handling as fmtDate — "YYYY-MM-DD" without a time/zone is a
  // local calendar day, not a UTC instant. Parsing it as UTC drops one day in
  // any timezone west of UTC, which then bumps "today" to "yesterday" etc.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const t = dateOnly
    ? new Date(parseInt(dateOnly[1], 10), parseInt(dateOnly[2], 10) - 1, parseInt(dateOnly[3], 10)).getTime()
    : new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
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

// A stable key for grouping cards by their underlying part/supply. Catalog
// items use itemName (e.g. "NL1"); not-in-DB items fall back to customItemName.
// Two requests for the same part share a key so they aggregate into one bubble.
function partKey(r) {
  const name = r.itemName || r.customItemName || "";
  return name.trim().toLowerCase();
}
function partLabel(r) {
  return r.itemName || r.customItemName || "(unnamed)";
}

function statusKindClass(status) {
  // Used to pick the left accent on the card.
  if (status === "Received")  return "kind-success";
  if (status === "Cancelled") return "kind-cancelled";
  if (status === "Backordered") return "kind-warn";
  if (status === "Ordered")   return "kind-active";
  return "kind-neutral";
}

// Display label + style key for the top-right status badge. Notion's internal
// status "Ordered" splits into THREE requester-facing reads now that the
// carrier-tracking poller is writing back:
//   - Ordered + carrierStatus=Delivered → "Delivered" (carrier at the dock,
//     human hasn't opened the box yet — Receive page shows it with a green
//     chip, this page makes it look the same)
//   - Ordered + tracking present        → "In Transit" (package is moving)
//   - Ordered + no tracking yet         → "Ordered" (purchase placed, waiting)
// Returns { label, key } — `key` becomes data-status on the badge so the CSS
// rules below pick the color without inventing a new Notion enum value.
function statusBadge(status, row) {
  if (status === "Ordered") {
    if (row && row.carrierStatus === "Delivered") {
      return { label: "Delivered", key: "Delivered" };
    }
    const tracking = row && typeof row.tracking === "string" ? row.tracking.trim() : "";
    return tracking
      ? { label: "In Transit", key: "Ordered" }
      : { label: "Ordered",    key: "Ordered" };
  }
  return { label: status || "—", key: status || "" };
}

// Back-compat shim — older call sites still want a plain label string. We
// could fold these into statusBadge() callers but keeping the thin wrapper
// avoids churn in surrounding code.
function statusLabel(status, row) {
  return statusBadge(status, row).label;
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

// Search input — re-renders on each keystroke. Matches across the fields a
// user is most likely to remember: item, order #, requestor, vendor, PO, notes.
const searchInput = $("status-search");
const searchClear = $("status-search-clear");
if (searchInput) {
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    searchClear.hidden = searchQuery.length === 0;
    renderRows();
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    searchClear.hidden = true;
    searchInput.focus();
    renderRows();
  });
}

// Sort dropdown — re-renders on change. Default "lastUpdated" puts the most
// recently touched rows on top; "requestNumber" sorts by REQ-NN-#### descending
// (newest request first).
const sortSelect = $("sort-select");
if (sortSelect) {
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value || "lastUpdated";
    renderRows();
  });
}

// Parse the numeric tail of a Request # title (REQ-26-0042 → 20260042) so we
// can compare across year prefixes. Falls back to a string compare if the
// title doesn't match the expected shape.
function requestNumberKey(r) {
  const m = String(r.orderNum || "").match(/^REQ-(\d{2})-(\d+)/);
  if (m) return parseInt(m[1], 10) * 1000000 + parseInt(m[2], 10);
  return -1;
}

function timeKey(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Apply the current sortMode to a row list, newest first in both modes.
// Returns a new array; never mutates input.
function applySort(rows) {
  if (sortMode === "requestNumber") {
    return [...rows].sort((a, b) => requestNumberKey(b) - requestNumberKey(a));
  }
  return [...rows].sort((a, b) =>
    timeKey(b.lastEditedTime || b.createdTime) -
    timeKey(a.lastEditedTime || a.createdTime)
  );
}

// Returns true if the row matches the current search query. An empty query
// matches everything — keep the row in the list.
function matchesSearch(r) {
  if (!searchQuery) return true;
  const q = searchQuery;
  const haystack = [
    r.itemName, r.customItemName, r.description,
    r.orderNum, r.requestor, r.vendor, r.poNumber,
    r.tracking, r.notes, r.purchaserNotes,
    r.reason, r.reasonCode, r.cancellationReason,
    r.category, r.type,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(q);
}

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
    if (!res.ok) {
      const err = new Error(data.error || "Failed to load");
      err.errorCode = data.errorCode;
      err.upstream  = data.upstream;
      throw err;
    }
    allRows = data.rows || [];
    lastRefEl.textContent = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (loadingFill) loadingFill.style.width = "100%";
    renderRows();
  } catch (e) {
    // Friendly message when Notion's API is the upstream culprit, not our app
    if (e.errorCode === "upstream_unavailable") {
      errorEl.innerHTML = `<strong>Notion is having trouble responding right now.</strong> This usually clears up within a few minutes. <button type="button" class="link-btn" id="notion-down-retry">Try refresh</button>`;
      const r = document.getElementById("notion-down-retry");
      if (r) r.addEventListener("click", () => { errorEl.hidden = true; loadAll(); });
    } else {
      errorEl.textContent = e.message || "Couldn't load the request log.";
    }
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
// "In Transit" is Ordered + a non-empty tracking string. Mirrors the badge
// label split in statusBadge() so the pill counts match what the cards read.
// "Delivered" siphons rows where the carrier-tracking poller has confirmed
// arrival but no one has marked the row Received yet — that's the bucket the
// warehouse cares about: "open these boxes next."
function hasTracking(r) {
  return typeof r.tracking === "string" && r.tracking.trim() !== "";
}
function isDelivered(r) {
  return r.status === "Ordered" && r.carrierStatus === "Delivered";
}
function isInTransit(r) {
  // Carrier-confirmed Delivered rows promote out of In Transit into Delivered.
  return r.status === "Ordered" && hasTracking(r) && !isDelivered(r);
}

function updateCounts(rows) {
  const counts = {
    all: 0,
    Submitted: 0,
    "Waiting to Order": 0,
    Backordered: 0,
    Ordered: 0,
    "In Transit": 0,
    Delivered: 0,
    Received: 0,
    archive: 0,
  };
  for (const r of rows) {
    if (r.status === "Cancelled") {
      counts.archive++;
    } else if (r.status === "Received") {
      counts.Received++;
    } else if (r.status === "Ordered") {
      // Three-way split: Delivered (carrier confirmed, awaiting human
      // Receive) → In Transit (tracking on file, not yet delivered) →
      // Ordered (no tracking yet).
      if (isDelivered(r))      counts.Delivered++;
      else if (hasTracking(r)) counts["In Transit"]++;
      else                     counts.Ordered++;
      counts.all++;
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
  $("count-In-Transit").textContent = counts["In Transit"];
  $("count-Delivered").textContent = counts.Delivered;
  $("count-Received").textContent = counts.Received;
  $("count-archive").textContent = counts.archive;
  return counts;
}

// Counts already live on each filter pill — no need to restate them in the
// page lead. Left as a no-op so the call sites don't change.
function updateHeroSub(/* counts */) {}

// Rolling horizon for Received + Cancelled rows. Rows closed more than this
// many days ago drop out of the default view to keep the page tight; pill
// counts still show the full underlying total, and a footer link points
// users at Notion when they need older state. Bump up if leadership starts
// asking for "last quarter" patterns; older than 90 days is reference, not
// active dashboard material.
const CLOSED_HORIZON_DAYS = 30;

function closedWithinHorizon(r) {
  const isReceived  = r.status === "Received";
  const isCancelled = r.status === "Cancelled";
  if (!isReceived && !isCancelled) return true;

  // Received: dedicated Received Date field. Cancelled: no dedicated date,
  // so fall back to last-edited (the cancel action is the last edit).
  const closedAt = isReceived ? r.receivedDate : (r.lastEditedTime || r.createdTime);
  if (!closedAt) return true; // missing data → keep visible, don't accidentally hide

  // Parse YYYY-MM-DD as local (see fmtDate) and full ISO normally.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(closedAt);
  const t = dateOnly
    ? new Date(parseInt(dateOnly[1], 10), parseInt(dateOnly[2], 10) - 1, parseInt(dateOnly[3], 10)).getTime()
    : new Date(closedAt).getTime();
  if (Number.isNaN(t)) return true;
  const days = Math.floor((Date.now() - t) / 86400000);
  return days <= CLOSED_HORIZON_DAYS;
}

function renderRows() {
  const counts = updateCounts(allRows);
  updateHeroSub(counts);

  // Partition: active = in motion (excludes Received + Cancelled).
  //            Received and Cancelled each get their own dedicated view,
  //            both with a rolling 30-day horizon (see closedWithinHorizon).
  const active        = allRows.filter(r => r.status !== "Received" && r.status !== "Cancelled");
  const receivedAll   = allRows.filter(r => r.status === "Received");
  const archiveAll    = allRows.filter(r => r.status === "Cancelled");
  const received      = receivedAll.filter(closedWithinHorizon);
  const archive       = archiveAll.filter(closedWithinHorizon);
  const receivedHidden = receivedAll.length - received.length;
  const archiveHidden  = archiveAll.length - archive.length;

  let visibleActive = active;
  let visibleArchive = [];
  let hiddenOlder = 0;  // for the "+ N older in Notion" footer

  if (activeFilter === "archive") {
    visibleActive = [];
    visibleArchive = archive;
    hiddenOlder = archiveHidden;
  } else if (activeFilter === "Received") {
    visibleActive = [];
    visibleArchive = received;
    hiddenOlder = receivedHidden;
  } else if (activeFilter === "Delivered") {
    // Delivered = carrier confirmed arrival, awaiting human Receive.
    // Highest-priority bucket for the warehouse — these boxes are at the
    // dock right now and have not been opened.
    visibleActive = active.filter(isDelivered);
  } else if (activeFilter === "In Transit") {
    // In Transit = Ordered + tracking + NOT yet delivered. Once the carrier
    // confirms delivery the row promotes to the Delivered pill.
    visibleActive = active.filter(isInTransit);
  } else if (activeFilter === "Ordered") {
    // Ordered = purchase placed, no tracking yet.
    visibleActive = active.filter(r => r.status === "Ordered" && !hasTracking(r));
  } else if (activeFilter !== "all") {
    visibleActive = active.filter(r => r.status === activeFilter);
  }

  // Search applies before the vendor pills are rendered so the per-vendor
  // counts reflect what's actually on screen — not a phantom number that
  // dwarfs the filtered card list.
  if (searchQuery) {
    visibleActive  = visibleActive.filter(matchesSearch);
    visibleArchive = visibleArchive.filter(matchesSearch);
  }

  // Vendor filter applies on top of status + search. Compute the per-vendor
  // counts now (before the vendor filter narrows the rows) so each pill reads
  // "how many rows would I see if I clicked this vendor." renderVendorPills
  // also auto-drops the pin if the previously-active vendor no longer appears.
  renderVendorPills([...visibleActive, ...visibleArchive]);
  if (activeVendor) {
    const vendorMatch = r => primaryVendor(r) === activeVendor;
    visibleActive  = visibleActive.filter(vendorMatch);
    visibleArchive = visibleArchive.filter(vendorMatch);
  }

  // For the All view, group by status so Delivered floats to the top (these
  // boxes are at the dock right now), then Submitted, Waiting → Backordered
  // → In Transit → Ordered. Within each bucket apply the chosen sort
  // (last-updated newest first, or request-number newest first) — JS sort is
  // stable so applying the within-bucket sort first then the bucket sort
  // yields the desired ordering.
  if (activeFilter === "all") {
    const bucket = (r) => {
      if (isDelivered(r))            return 0;
      if (r.status === "Submitted")  return 1;
      if (r.status === "Waiting to Order") return 2;
      if (r.status === "Backordered") return 3;
      if (isInTransit(r))             return 4;
      if (r.status === "Ordered")     return 5;
      return 99;
    };
    visibleActive = applySort(visibleActive).sort((a, b) => bucket(a) - bucket(b));
  } else {
    visibleActive = applySort(visibleActive);
  }
  visibleArchive = applySort(visibleArchive);

  // Part-bubble row reflects whatever's about to be rendered, regardless of
  // which section (active or archive) the rows landed in.
  renderPartBubbles([...visibleActive, ...visibleArchive]);

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
    // Rolling horizon footer — shown only on Received / Cancelled views when
    // there are older rows we deliberately suppressed. Links to Notion for
    // anyone who needs the full history.
    if (hiddenOlder > 0 && (activeFilter === "Received" || activeFilter === "archive")) {
      const li = document.createElement("li");
      li.className = "archive-horizon-footer";
      const noun = activeFilter === "Received" ? "received" : "cancelled";
      li.innerHTML = `+ ${hiddenOlder} older ${escapeHtml(noun)} hidden after ${CLOSED_HORIZON_DAYS} days · <a href="https://www.notion.so/34affa524c5b8183998cd29c785e4aa6?v=34affa524c5b814c9807000c5b591c5f&source=copy_link" target="_blank" rel="noopener">view in Notion ↗</a>`;
      archiveListEl.appendChild(li);
    }
    archiveEl.hidden = false;
  } else {
    archiveEl.hidden = true;
  }

  // Empty state — only when truly no rows match the filter. But "no recent
  // closed rows" on Received / Cancelled shouldn't read as "nothing exists"
  // — surface the horizon explanation if older rows are hiding.
  if (visibleActive.length === 0 && visibleArchive.length === 0) {
    if (hiddenOlder > 0 && (activeFilter === "Received" || activeFilter === "archive")) {
      const noun = activeFilter === "Received" ? "received" : "cancelled";
      emptyEl.innerHTML = `<p>No items ${escapeHtml(noun)} in the last ${CLOSED_HORIZON_DAYS} days.</p><p>${hiddenOlder} older ${escapeHtml(noun)} item${hiddenOlder === 1 ? "" : "s"} in Notion · <a href="https://www.notion.so/34affa524c5b8183998cd29c785e4aa6?v=34affa524c5b814c9807000c5b591c5f&source=copy_link" target="_blank" rel="noopener">view ↗</a></p>`;
    } else {
      emptyEl.innerHTML = '<h2>Nothing here.</h2><p>No requests match this filter.</p><a href="index.html">Submit a new request →</a>';
    }
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
  }
}

// Vendor pill row — one pill per primary vendor present in the rows the
// status filter just selected (i.e. counts reflect "under this status, how
// many of each vendor"). Click a vendor to narrow further; click the pinned
// vendor again or "All vendors" to clear. Hidden when no vendors are present.
function renderVendorPills(rows) {
  if (!vendorPillsEl) return;

  // Tally rows by primary vendor. Rows with no vendor fall into "(no vendor)"
  // so the user can isolate not-in-DB / unclassified rows when they need to.
  const NO_VENDOR_KEY = "(no vendor)";
  const counts = new Map();
  for (const r of rows) {
    const v = primaryVendor(r) || NO_VENDOR_KEY;
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  if (counts.size === 0) {
    vendorPillsEl.hidden = true;
    vendorPillsEl.innerHTML = "";
    return;
  }

  // Sort: highest count first, then alphabetical. "(no vendor)" sinks to the
  // end regardless of count — it's noise, not signal.
  const sorted = [...counts.entries()].sort((a, b) => {
    if (a[0] === NO_VENDOR_KEY) return 1;
    if (b[0] === NO_VENDOR_KEY) return -1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  // If the user had a vendor pinned but it's no longer in the current view
  // (e.g. they switched status filters), drop the pin so they don't end up
  // staring at an empty list. renderRows will re-run on the next interaction.
  if (activeVendor && !counts.has(activeVendor)) {
    activeVendor = "";
  }

  const total = rows.length;
  const allActive = activeVendor === "" ? " active" : "";
  const allSelected = activeVendor === "" ? "true" : "false";
  const parts = [
    `<button type="button" class="pill vendor-pill${allActive}" data-vendor="" role="tab" aria-selected="${allSelected}">
      <span>All vendors</span>
      <span class="pill-count">${total}</span>
    </button>`,
  ];
  for (const [vendor, count] of sorted) {
    const isActive = vendor === activeVendor;
    const cls = isActive ? " active" : "";
    const sel = isActive ? "true" : "false";
    parts.push(`<button type="button" class="pill vendor-pill${cls}" data-vendor="${escapeHtml(vendor)}" role="tab" aria-selected="${sel}">
      <span>${escapeHtml(vendor)}</span>
      <span class="pill-count">${count}</span>
    </button>`);
  }
  vendorPillsEl.innerHTML = parts.join("");
  vendorPillsEl.hidden = false;
}

vendorPillsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".vendor-pill");
  if (!btn) return;
  const next = btn.dataset.vendor || "";
  // Click the already-pinned vendor → unpin (act like "All vendors"). Saves
  // a trip to the All vendors pill when there are many vendors in the row.
  activeVendor = (next === activeVendor) ? "" : next;
  renderRows();
});

// Compact bubble row that mirrors what's currently rendered. One bubble per
// distinct part; qty sums when known (Ordered/Received), otherwise we show
// "×N" — the request count for that part. Click → scroll to first matching
// card. Hidden when there's nothing to show.
function renderPartBubbles(rows) {
  if (!partBubblesEl) return;
  if (!rows.length) {
    partBubblesEl.hidden = true;
    partBubblesEl.innerHTML = "";
    return;
  }

  // Aggregate by part key. Keep first-seen order so the bubble row mirrors
  // the visual order of the cards underneath.
  const order = [];
  const agg = new Map();
  for (const r of rows) {
    const key = partKey(r);
    if (!key) continue;
    if (!agg.has(key)) {
      order.push(key);
      agg.set(key, { key, label: partLabel(r), qty: 0, count: 0, hasQty: false });
    }
    const a = agg.get(key);
    a.count += 1;
    if (typeof r.qtyOrdered === "number" && r.qtyOrdered > 0) {
      a.qty += r.qtyOrdered;
      a.hasQty = true;
    }
  }

  partBubblesEl.innerHTML = order.map(k => {
    const a = agg.get(k);
    const tail = a.hasQty
      ? `<span class="part-bubble-qty">${a.qty.toLocaleString()}</span>`
      : `<span class="part-bubble-qty part-bubble-count">×${a.count}</span>`;
    return `<button type="button" class="part-bubble" data-part-key="${escapeHtml(a.key)}" title="Jump to first ${escapeHtml(a.label)}">
      <span class="part-bubble-name">${escapeHtml(a.label)}</span>
      ${tail}
    </button>`;
  }).join("");
  partBubblesEl.hidden = false;
}

// Click on a bubble → scroll to the first card with that part key and
// briefly highlight it so the eye can land on it.
partBubblesEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".part-bubble");
  if (!btn) return;
  const key = btn.dataset.partKey;
  const target = document.querySelector(`.request-card[data-part-key="${CSS.escape(key)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
});

function renderCard(r, idx) {
  const li = document.createElement("li");
  li.className = "request-card";
  li.dataset.partKey = partKey(r);
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
    ? renderTrackingRow(r)
    : "";

  // Notes
  const notesHtml = renderNotes(r);

  // Inline meta replaces the standalone Vendor/MOQ/Lead-time spotlight cells.
  // These never change with status, so they belong in the eyebrow as quiet
  // context — not eating a whole spotlight row of their own.
  const eyebrowMetaParts = [];
  if (primaryVendor(r)) eyebrowMetaParts.push(escapeHtml(primaryVendor(r)));
  if (r.moqQty != null) eyebrowMetaParts.push(`MOQ ${r.moqQty}`);
  if (r.leadTime)       eyebrowMetaParts.push(`Lead ${escapeHtml(r.leadTime)}`);
  const eyebrowMeta = eyebrowMetaParts.length
    ? `<span class="eyebrow-divider"></span><span class="eyebrow-meta">${eyebrowMetaParts.join(" · ")}</span>`
    : "";

  // Submitted-at lives on the relative-time chip's title= so the full timestamp
  // is still discoverable on hover. The footer row goes away entirely.
  const submittedTip = r.createdTime ? `Submitted ${fmtTimestamp(r.createdTime)}` : "";

  // Eyebrow-side actions (Remove request, Open in Notion). Replace the
  // bottom footer row so the card collapses by ~32px on every card.
  const removeLink = (r.status === "Submitted" && r.pageId)
    ? `<a href="#" class="remove-request-link eyebrow-link"
          data-page-id="${escapeHtml(r.pageId)}"
          data-order-num="${escapeHtml(r.orderNum || "")}"
          data-item-name="${escapeHtml(itemTitle)}">Remove</a>`
    : "";
  const notionLink = `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="eyebrow-link" title="Open in Notion">↗</a>`;

  li.innerHTML = `
    <div class="card-row">
      ${r.image
        ? `<img class="card-thumb" src="${escapeHtml(r.image)}" alt="">`
        : `<div class="card-thumb-fallback">${r.type === "Supply" ? "📦" : r.type === "Other" ? "🛠️" : "🔩"}</div>`}
      <div class="card-info">
        <div class="card-eyebrow">
          <span class="order-num">${escapeHtml(r.orderNum || "—")}</span>
          ${notionLink}
          <span class="eyebrow-divider"></span>
          <span>Requested by <span class="requestor-name">${escapeHtml(r.requestor || "—")}</span></span>
          ${r.dateRequested
            ? `<span class="eyebrow-divider"></span><span class="eyebrow-age"${submittedTip ? ` title="${escapeHtml(submittedTip)}"` : ""}>${fmtRelative(r.dateRequested)}</span>`
            : ""}
          ${eyebrowMeta}
          ${removeLink ? `<span class="eyebrow-divider"></span>${removeLink}` : ""}
        </div>
        <div class="card-title-row">
          <strong class="card-title">${escapeHtml(itemTitle)}</strong>
          ${description ? `<span class="card-title-desc">— ${escapeHtml(description)}</span>` : ""}
        </div>
        <div class="card-tags">
          ${r.type ? `<span class="badge">${escapeHtml(r.type.toUpperCase())}</span>` : ""}
          ${r.oneTime ? `<span class="badge badge-onetime">ONE-TIME</span>` : (r.notInDb ? `<span class="badge badge-category">NEW ITEM</span>` : "")}
          ${r.outOfStock ? `<span class="badge urgent-tag">URGENT</span>` : ""}
        </div>
      </div>
      <span class="card-status-badge" data-status="${escapeHtml(statusBadge(r.status, r).key)}">${escapeHtml(statusBadge(r.status, r).label)}</span>
    </div>

    <div class="process-rail ${r.status === "Cancelled" ? "is-cancelled" : ""}" style="--rail-progress: ${progressPct}%;">
      <div class="rail-stages" data-stage-count="${stageCount}" style="grid-template-columns: repeat(${stageCount}, 1fr);">${stages}</div>
    </div>

    ${spotlight}
    ${trackingRow}
    ${notesHtml}
  `;
  return li;
}

function renderArchiveCard(r, idx) {
  const li = document.createElement("li");
  li.className = "request-card";
  li.dataset.partKey = partKey(r);
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
          ${isReceived && r.receiver ? `<span>by <strong>${escapeHtml(r.receiver)}</strong></span>` : ""}
          ${renderArchiveQty(r, isReceived)}
          ${primaryVendor(r) ? `<span>Vendor: <strong>${escapeHtml(primaryVendor(r))}</strong></span>` : ""}
          ${r.orderNumber ? `<span>Order #: <strong>${escapeHtml(r.orderNumber)}</strong></span>` : ""}
          ${r.poNumber ? `<span>PO: <strong>${escapeHtml(r.poNumber)}</strong></span>` : ""}
          ${isReceived && r.tracking ? `<span>Tracking: ${renderArchiveTracking(r.tracking)}</span>` : ""}
          ${r.oneTime ? `<span class="archive-onetime-tag" title="One-time purchase, not catalog inventory">one-time</span>` : ""}
          ${r.parentRequestId ? `<span class="archive-split-tag" title="Part of a split shipment chain">split shipment</span>` : ""}
          ${r.cancellationReason ? `<span>Reason: ${escapeHtml(r.cancellationReason)}</span>` : ""}
        </div>
      </div>
      <span class="card-status-badge" data-status="${escapeHtml(statusBadge(r.status, r).key)}">${escapeHtml(statusBadge(r.status, r).label)}</span>
    </div>
  `;
  return li;
}

// Qty cell on archive cards. On Received rows we show Received vs Ordered
// and flag the gap when the row came in short. On Cancelled rows we just
// show the original Ordered qty since nothing arrived.
function renderArchiveQty(r, isReceived) {
  if (!isReceived) {
    return r.qtyOrdered != null
      ? `<span>Qty: <strong>${r.qtyOrdered}</strong></span>`
      : "";
  }
  const haveReceived = r.qtyReceived != null;
  const haveOrdered  = r.qtyOrdered != null;
  if (haveReceived && haveOrdered) {
    const short = r.qtyReceived < r.qtyOrdered;
    const overReceipt = r.qtyReceived > r.qtyOrdered;
    const tag = short ? ` <span class="archive-short-tag" title="Received less than ordered">short ${r.qtyOrdered - r.qtyReceived}</span>`
              : overReceipt ? ` <span class="archive-over-tag" title="Received more than ordered">+${r.qtyReceived - r.qtyOrdered}</span>`
              : "";
    return `<span>Qty: <strong>${r.qtyReceived}</strong> of ${r.qtyOrdered}${tag}</span>`;
  }
  if (haveReceived) return `<span>Qty received: <strong>${r.qtyReceived}</strong></span>`;
  if (haveOrdered)  return `<span>Qty ordered: <strong>${r.qtyOrdered}</strong></span>`;
  return "";
}

// Tracking cell on archive cards — shorter than the active-view tracking row.
// Renders a carrier-aware deep link when we can detect the carrier, otherwise
// just shows the number. Matches the active card's behavior (see
// renderTrackingRow + detectCarrier).
function renderArchiveTracking(tracking) {
  const carrier = detectCarrier(tracking);
  if (carrier) {
    return `<a href="${escapeHtml(carrier.url)}" target="_blank" rel="noopener" class="archive-tracking-link"><strong>${escapeHtml(carrier.clean)}</strong> <span class="archive-tracking-carrier">${escapeHtml(carrier.name)}</span> ↗</a>`;
  }
  return `<strong>${escapeHtml(tracking)}</strong>`;
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

  // Third slot — In Transit (or Delivered, once the carrier confirms).
  // Auto-checked when a carrier-detected tracking number is on file. Only
  // meaningful once the order has actually been placed.
  //
  // Carrier-tracking poller writes back r.carrierStatus + r.lastScan +
  // r.deliveredAt. We use those three to:
  //   - relabel the slot "Delivered" when the carrier confirms it
  //   - put the latest scan location/time in pretext (above the marker)
  //   - put the carrier name in detail (below the marker)
  const carrier = (isOrderedOrBeyond && r.tracking) ? detectCarrier(r.tracking) : null;
  const carrierDelivered = r.carrierStatus === "Delivered";
  let inTransit;
  if (isReceived) {
    inTransit = { state: "done", label: "In Transit", detail: carrier ? carrier.name : "", pretext: "" };
  } else if (status === "Ordered" && carrierDelivered) {
    // Box at the dock per the carrier — relabel + green check. r.deliveredAt
    // is a full ISO instant; lastScan is the city/time text. Prefer the
    // delivery timestamp since it's the more authoritative source.
    const when = r.deliveredAt
      ? fmtTimestamp(r.deliveredAt)
      : (r.lastScan || "");
    inTransit = {
      state: "done",
      label: "Delivered",
      detail: carrier ? carrier.name : "",
      pretext: when,
      kind: "delivered",
    };
  } else if (status === "Ordered" && carrier) {
    // In transit — show the latest scan line above the check when we have it.
    inTransit = {
      state: "done",
      label: r.carrierStatus || "In Transit",
      detail: carrier.name,
      pretext: r.lastScan || "",
      kind: r.carrierStatus === "Out for Delivery" ? "active-carrier" : "",
    };
  } else if (status === "Ordered") {
    // Ordered but no tracking yet — this is the active "what comes next" slot
    inTransit = { state: "active", label: "In Transit", detail: "Awaiting tracking", pretext: "" };
  } else {
    inTransit = { state: "upcoming", label: "In Transit", detail: "", pretext: "" };
  }

  // Fourth slot — Received.
  const received = {
    state: isReceived ? "done" : "upcoming",
    label: "Received",
    detail: isReceived && r.receivedDate ? fmtDate(r.receivedDate) : "",
    pretext: "",
  };

  // Progress fill: 0%, 33%, 66%, 87%, 100% across the four slots.
  // "Delivered" sits between In Transit and Received — past the third
  // checkpoint, just shy of the fourth.
  let progressPct;
  if (status === "Submitted")                 progressPct = 0;
  else if (isReceived)                        progressPct = 100;
  else if (status === "Ordered" && carrierDelivered) progressPct = 87;
  else if (status === "Ordered" && carrier)   progressPct = 75; // past the In-Transit check
  else if (status === "Ordered")              progressPct = 50; // through Ordered
  else                                        progressPct = 33; // Waiting / Backordered

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
    if (s.kind === "delivered")       cls += " kind-delivered";
    else if (s.kind === "active-carrier") cls += " kind-active-carrier";
    // Pretext slot always renders (even empty) so every stage reserves the
    // same vertical space — that keeps the rail's connecting line aligned
    // across stages whether or not a given stage has carrier-scan info.
    return `
      <div class="${cls}">
        <div class="stage-pretext">${s.pretext ? escapeHtml(s.pretext) : ""}</div>
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

  // Vendor / MOQ / Lead time intentionally NOT here — they've moved to the
  // eyebrow meta line at the top of the card so they don't eat a spotlight
  // row. Only status-relevant highlight cells live here now.

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
function renderTrackingRow(r) {
  const tracking = r && r.tracking;
  if (!tracking) return "";
  const carrier = detectCarrier(tracking);
  const numberHtml = carrier
    ? `<a href="${escapeHtml(carrier.url)}" target="_blank" rel="noopener" class="tracking-link">`
      + `${escapeHtml(carrier.clean)} <span class="tracking-carrier">${escapeHtml(carrier.name)}</span>`
      + ` <span class="tracking-cta">Track ↗</span></a>`
    : escapeHtml(tracking);
  // Carrier scan info no longer renders here — it's anchored above the
  // matching timeline stage now so the data sits next to what it describes.
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

// ----- Remove Request modal -----
//
// Requestor self-cancel. Opens on click of any "Remove request →" link in the
// footer of a Submitted card. The link's data-* attributes carry the row's
// pageId, orderNum, and itemName so the modal can target the right row and
// show a confirmation summary. The dropdown is populated from /requestors so
// it stays in sync with the Submit page's "Your name" list.
const removeModal      = $("remove-modal");
const removeModalCtx   = $("remove-modal-context");
const removeReqSel     = $("remove-requestor");
const removeReasonSel  = $("remove-reason-code");
const removeReasonText = $("remove-reason-text");
const removeReasonTextField = $("remove-reason-text-field");
const removeModalErr   = $("remove-modal-error");
const removeModalSubmit = $("remove-modal-submit");

let removeTargetPageId  = null;
let removeTargetSummary = null;

async function loadRemoveRequestors() {
  try {
    const res = await fetch(`${WORKER_URL}/requestors`);
    const data = await res.json();
    for (const name of data.requestors || []) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      removeReqSel.appendChild(opt);
    }
  } catch (e) {
    // Non-fatal — modal still works, user can type… actually no, it's a select.
    // If this fails the user just can't open Remove. Log silently; very unlikely.
  }
}

function openRemoveModal(pageId, orderNum, itemName) {
  removeTargetPageId = pageId;
  removeTargetSummary = `${orderNum} — ${itemName}`;
  removeModalCtx.innerHTML =
    `Remove <strong>${escapeHtml(orderNum)}</strong> — ${escapeHtml(itemName)}?<br>` +
    `<span style="color: var(--muted)">This sets the request to Cancelled. It stays visible under the Cancelled filter for the team.</span>`;
  removeReqSel.value = "";
  removeReasonSel.value = "";
  removeReasonText.value = "";
  removeReasonTextField.hidden = true;
  removeModalErr.hidden = true;
  removeModalSubmit.disabled = false;
  removeModalSubmit.textContent = "Remove request";
  removeModal.hidden = false;
  removeReqSel.focus();
}

function closeRemoveModal() {
  removeModal.hidden = true;
  removeTargetPageId = null;
  removeTargetSummary = null;
}

$("remove-modal-close").addEventListener("click", closeRemoveModal);
$("remove-modal-cancel").addEventListener("click", closeRemoveModal);
removeModal.addEventListener("click", (e) => { if (e.target === removeModal) closeRemoveModal(); });

removeReasonSel.addEventListener("change", () => {
  const isOther = removeReasonSel.value === "Other";
  removeReasonTextField.hidden = !isOther;
  if (!isOther) removeReasonText.value = "";
  if (isOther) removeReasonText.focus();
});

removeModalSubmit.addEventListener("click", async () => {
  if (!removeTargetPageId) return;
  const requestor  = removeReqSel.value;
  const reasonCode = removeReasonSel.value;
  const reasonText = removeReasonText.value.trim();

  if (!requestor) {
    removeModalErr.textContent = "Please pick your name.";
    removeModalErr.hidden = false;
    return;
  }
  if (!reasonCode) {
    removeModalErr.textContent = "Please pick a reason.";
    removeModalErr.hidden = false;
    return;
  }
  if (reasonCode === "Other" && !reasonText) {
    removeModalErr.textContent = "Please describe the reason.";
    removeModalErr.hidden = false;
    return;
  }
  removeModalErr.hidden = true;
  removeModalSubmit.disabled = true;
  removeModalSubmit.textContent = "Removing…";

  try {
    const res = await fetch(`${WORKER_URL}/self-cancel/${removeTargetPageId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestor, reasonCode, reasonText }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Remove failed");
    closeRemoveModal();
    loadAndRender();
  } catch (e) {
    removeModalErr.textContent = e.message || "Remove failed";
    removeModalErr.hidden = false;
    removeModalSubmit.disabled = false;
    removeModalSubmit.textContent = "Remove request";
  }
});

// Event delegation: catch clicks on any "Remove request →" link anywhere
// in the active list. Cards are re-rendered, so we can't bind to elements
// at render time and expect the handlers to survive a refresh.
document.addEventListener("click", (e) => {
  const link = e.target.closest(".remove-request-link");
  if (!link) return;
  e.preventDefault();
  openRemoveModal(
    link.dataset.pageId,
    link.dataset.orderNum || "",
    link.dataset.itemName || ""
  );
});

// ----- Init -----
loadAndRender();
loadRemoveRequestors();
