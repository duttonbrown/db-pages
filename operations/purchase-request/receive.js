// Receive Shipments console
// Audience: receivers (Catherine, Chase, Thomas, Zach) confirming what arrived.
// Surface: rows currently in Ordered status, grouped by PO so a whole box can
// be confirmed in one click. Issues are flagged via a per-row checkbox + note;
// they still mark the row Received but are visible separately for follow-up.

const WORKER_URL = (window.WORKER_URL_OVERRIDE) || "https://inventory-request-form.purchasing-906.workers.dev";

const $ = (id) => document.getElementById(id);

const receiverSel  = $("receiver-name");
const refreshBtn   = $("refresh-btn");
const poListEl     = $("po-list");
const errorEl      = $("error");
const emptyEl      = $("empty");
const loadingBar   = $("loading-bar");
const loadingFill  = loadingBar.querySelector(".loading-fill");
const loadingMsgEl = loadingBar.querySelector(".loading-message");
const searchInput  = $("receive-search");
const searchCount  = $("receive-search-count");
const supplierBubbles = $("supplier-bubbles");

// Cache of the most recent Ordered rows so the search box can re-render
// without round-tripping the worker.
let allOrdered = [];
let searchQuery = "";
// Active supplier-bubble filter. Empty string = "All". Matches primaryVendor(r)
// (the first comma-separated vendor on a row) case-insensitively.
let vendorFilter = "";

// Keep this list in sync with app.js LOADING_MESSAGES.
const LOADING_MESSAGES = [
  "Don't forget to eat your veggies and remember to say something nice to someone you love.",
  "Drink some water. Stretch your shoulders. We'll be ready in a sec.",
  "Take a deep breath in… and out. Catalog incoming.",
  "Do the macarena. By the time you finish, the list should be loaded.",
  "Wiggle your toes for 10 seconds while this loads. Surprisingly underrated.",
];

function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }
function clearError() { errorEl.hidden = true; }
function showUpstreamUnavailable(retryFn) {
  errorEl.innerHTML = `<strong>Notion is having trouble responding right now.</strong> This usually clears up within a few minutes. <button type="button" class="link-btn" id="upstream-retry-btn">Try refresh</button>`;
  errorEl.hidden = false;
  const btn = document.getElementById("upstream-retry-btn");
  if (btn) btn.addEventListener("click", () => { clearError(); retryFn(); });
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function ageDays(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function primaryVendor(row) {
  if (!row || !row.vendor) return "";
  const first = String(row.vendor).split(",")[0];
  return (first || "").trim();
}

// Normalize PO numbers for grouping: trim + uppercase. Avoids treating
// "po-2026-0042" and "PO-2026-0042 " as separate POs.
function normalizePO(po) {
  return String(po || "").trim().toUpperCase();
}

function normalizeOrderNumber(n) {
  return String(n || "").trim().toUpperCase();
}

async function loadReceivers() {
  // Mirrors the Submit form's requestor list — anyone who can submit a request
  // can also receive a shipment. (Was previously the narrower /people pool.)
  try {
    const res = await fetch(`${WORKER_URL}/requestors`);
    const data = await res.json();
    for (const name of data.requestors || []) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      receiverSel.appendChild(opt);
    }
    const saved = localStorage.getItem("receiver-name");
    if (saved && [...receiverSel.options].some(o => o.value === saved)) {
      receiverSel.value = saved;
    }
  } catch (e) {
    showError("Couldn't load receiver names.");
  }
}

receiverSel.addEventListener("change", () => {
  if (receiverSel.value) localStorage.setItem("receiver-name", receiverSel.value);
});

async function loadShipments() {
  clearError();
  if (loadingMsgEl) {
    loadingMsgEl.textContent = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
  }
  loadingBar.hidden = false;
  loadingFill.style.width = "0%";
  let pct = 0;
  const tick = setInterval(() => {
    pct = Math.min(95, pct + Math.max(2, (95 - pct) * 0.12));
    loadingFill.style.width = pct + "%";
  }, 120);

  try {
    const res = await fetch(`${WORKER_URL}/pending`);
    const data = await res.json();
    loadingFill.style.width = "100%";
    setTimeout(() => { loadingBar.hidden = true; }, 250);
    if (!res.ok) {
      if (data.errorCode === "upstream_unavailable") {
        showUpstreamUnavailable(loadShipments);
        return;
      }
      throw new Error(data.error || "Failed to load");
    }
    // /pending returns Submitted + Waiting + Backordered + Ordered. Receiving
    // only cares about Ordered — the rest aren't physically en route.
    allOrdered = (data.rows || []).filter(r => r.status === "Ordered");
    // If the active vendor filter no longer matches any cached row (vendor
    // dropped out after a receive), reset it so the page doesn't render empty.
    if (vendorFilter && !allOrdered.some(r => primaryVendor(r).toLowerCase() === vendorFilter.toLowerCase())) {
      vendorFilter = "";
    }
    renderSupplierBubbles();
    renderShipments(filteredOrdered());
    updateSearchCount();
  } catch (e) {
    showError("Couldn't load shipments.");
    loadingBar.hidden = true;
  } finally {
    clearInterval(tick);
  }
}

refreshBtn.addEventListener("click", loadShipments);

function matchesSearch(r, q) {
  if (!q) return true;
  const haystack = [
    r.orderNum, r.itemName, r.customItemName, r.description,
    r.poNumber, r.tracking, r.requestor, r.vendor, r.notes,
  ].filter(Boolean).join(" ").toLowerCase();
  // Every space-separated term must appear so "grand brass" narrows correctly.
  return q.split(/\s+/).every(term => haystack.includes(term));
}

function filteredOrdered() {
  const q = searchQuery.trim().toLowerCase();
  const v = vendorFilter.trim().toLowerCase();
  return allOrdered.filter(r => {
    if (q && !matchesSearch(r, q)) return false;
    if (v && primaryVendor(r).toLowerCase() !== v) return false;
    return true;
  });
}

// Build the supplier bubble row at the top of the page. One bubble per
// distinct primary vendor in the current Ordered cache, plus an "All"
// bubble. Counts reflect the unfiltered cache so receivers can see how
// many items each supplier owes before clicking. Hidden when there are
// fewer than 2 vendors (no value in a 1-bubble row).
function renderSupplierBubbles() {
  if (!supplierBubbles) return;
  const counts = new Map();
  for (const r of allOrdered) {
    const v = primaryVendor(r);
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (counts.size < 2) {
    supplierBubbles.hidden = true;
    supplierBubbles.innerHTML = "";
    return;
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const allActive = vendorFilter === "" ? "is-active" : "";
  const allBubble = `<button type="button" class="supplier-bubble ${allActive}" data-vendor="" role="tab" aria-selected="${vendorFilter === ""}">All <span class="supplier-bubble-count">${allOrdered.length}</span></button>`;
  const bubbles = entries.map(([v, n]) => {
    const active = vendorFilter.toLowerCase() === v.toLowerCase() ? "is-active" : "";
    return `<button type="button" class="supplier-bubble ${active}" data-vendor="${escapeHtml(v)}" role="tab" aria-selected="${vendorFilter.toLowerCase() === v.toLowerCase()}">${escapeHtml(v)} <span class="supplier-bubble-count">${n}</span></button>`;
  }).join("");
  supplierBubbles.innerHTML = allBubble + bubbles;
  supplierBubbles.hidden = false;
}

if (supplierBubbles) {
  supplierBubbles.addEventListener("click", (e) => {
    const btn = e.target.closest(".supplier-bubble");
    if (!btn) return;
    const target = btn.dataset.vendor || "";
    // Tapping the active bubble clears the filter (back to All).
    vendorFilter = (target.toLowerCase() === vendorFilter.toLowerCase()) ? "" : target;
    renderSupplierBubbles();
    renderShipments(filteredOrdered());
    updateSearchCount();
  });
}

function updateSearchCount() {
  const total = allOrdered.length;
  if (!searchQuery.trim() && !vendorFilter) {
    searchCount.hidden = true;
    return;
  }
  const shown = filteredOrdered().length;
  searchCount.hidden = false;
  searchCount.textContent = `${shown} of ${total}`;
}

if (searchInput) {
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderShipments(filteredOrdered());
    updateSearchCount();
  });
}

function renderShipments(rows) {
  poListEl.innerHTML = "";

  if (rows.length === 0) {
    if (vendorFilter && allOrdered.length > 0) {
      emptyEl.innerHTML = `<p>No open shipments from <strong>${escapeHtml(vendorFilter)}</strong>${searchQuery.trim() ? ` matching "<strong>${escapeHtml(searchQuery)}</strong>"` : ""}. <button type="button" class="link-btn" id="clear-receive-vendor">Show all suppliers</button></p>`;
      const clr = $("clear-receive-vendor");
      if (clr) clr.addEventListener("click", () => {
        vendorFilter = "";
        renderSupplierBubbles();
        renderShipments(filteredOrdered());
        updateSearchCount();
      });
    } else if (searchQuery.trim() && allOrdered.length > 0) {
      emptyEl.innerHTML = `<p>No shipments match "<strong>${escapeHtml(searchQuery)}</strong>". <button type="button" class="link-btn" id="clear-receive-search">Clear search</button></p>`;
      const clr = $("clear-receive-search");
      if (clr) clr.addEventListener("click", () => {
        searchInput.value = "";
        searchQuery = "";
        renderShipments(filteredOrdered());
        updateSearchCount();
        searchInput.focus();
      });
    } else {
      emptyEl.innerHTML = `<p>📦 Nothing waiting to be received. The dock is clear.</p>`;
    }
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Group by vendor's Order # (the number on the actual order confirmation),
  // not PO #. Multiple vendors often share one internal PO (e.g. a "dummy" PO
  // when the purchaser submitted one batch that fanned out to several vendors),
  // and the Order # is what receivers can match against the physical box's
  // packing slip. PO # is still shown in the header for context.
  // Rows missing an Order # group together by PO # so they still cluster
  // sensibly; rows missing both fall into "(no order #)".
  //
  // VENDOR is part of the key. Two suppliers can independently assign the
  // same order number (or share a blank), and previously a Bolt Depot row
  // landing in the same group as a Grand Brass row would adopt the first
  // row's vendor in the header — making SCF screws show up under "Grand
  // Brass Lamp Parts". Splitting by vendor up front guarantees each group
  // matches exactly one packing slip.
  const groups = new Map();
  for (const r of rows) {
    const vendorKey = (primaryVendor(r) || "__no-vendor__").toLowerCase();
    let key;
    if (r.orderNumber) key = `ORD:${normalizeOrderNumber(r.orderNumber)}|${vendorKey}`;
    else if (r.poNumber) key = `PO:${normalizePO(r.poNumber)}|${vendorKey}`;
    else key = `__NONE__|${vendorKey}`;

    if (!groups.has(key)) {
      groups.set(key, {
        displayOrder: r.orderNumber || "",
        displayPO: r.poNumber || "",
        vendor: primaryVendor(r),
        orderedDate: r.orderedDate || null,
        eta: r.eta || null,
        tracking: r.tracking || "",
        items: [],
      });
    }
    const g = groups.get(key);
    g.items.push(r);
    // Backfill metadata from any row in the group: receivers can have
    // entered the order # on one row but left it blank on another in the
    // same shipment.
    if (!g.displayOrder && r.orderNumber) g.displayOrder = r.orderNumber;
    if (!g.displayPO && r.poNumber) g.displayPO = r.poNumber;
    if (!g.vendor && primaryVendor(r)) g.vendor = primaryVendor(r);
    if (r.orderedDate && (!g.orderedDate || r.orderedDate < g.orderedDate)) {
      g.orderedDate = r.orderedDate;
    }
    if (r.eta && (!g.eta || r.eta < g.eta)) g.eta = r.eta;
    if (!g.tracking && r.tracking) g.tracking = r.tracking;
  }

  // Within each group, sort urgent (out-of-stock) rows to the top so
  // receivers see what they need to unbox first.
  for (const g of groups.values()) {
    g.items.sort((a, b) => {
      if (!!a.outOfStock !== !!b.outOfStock) return a.outOfStock ? -1 : 1;
      return 0;
    });
  }

  // Sort groups: any group containing an urgent item floats up, then by
  // oldest orderedDate first (older orders are more likely to have arrived).
  const groupHasUrgent = (g) => g.items.some(r => r.outOfStock);
  const sorted = [...groups.entries()].sort((a, b) => {
    const au = groupHasUrgent(a[1]);
    const bu = groupHasUrgent(b[1]);
    if (au !== bu) return au ? -1 : 1;
    const ax = a[1].orderedDate || "9999-99-99";
    const bx = b[1].orderedDate || "9999-99-99";
    return ax.localeCompare(bx);
  });

  for (const [key, g] of sorted) {
    poListEl.appendChild(renderPOGroup(key, g));
  }
}

function renderPOGroup(groupKey, g) {
  const section = document.createElement("section");
  section.className = "po-group";
  section.dataset.groupKey = groupKey;

  const age = ageDays(g.orderedDate);
  const ageLabel = age != null ? ` · ${age}d ago` : "";
  const eta = g.eta ? ` · ETA ${fmtDate(g.eta)}` : "";

  // Header shows the vendor's Order # primary (matches what's on the packing
  // slip), then the internal PO # alongside. Either can be blank.
  const orderChip = g.displayOrder
    ? `<span class="po-num"><span class="po-prefix">Order #</span> ${escapeHtml(g.displayOrder)}</span>`
    : `<span class="po-num po-num-missing">(no order #)</span>`;
  const poChip = g.displayPO
    ? `<span class="po-num po-num-secondary"><span class="po-prefix">PO</span> ${escapeHtml(g.displayPO)}</span>`
    : "";

  section.innerHTML = `
    <header class="po-header">
      <div class="po-meta">
        ${orderChip}
        ${poChip}
        ${g.vendor ? `<span class="po-vendor">${escapeHtml(g.vendor)}</span>` : ""}
        <span class="po-when">Ordered ${escapeHtml(fmtDate(g.orderedDate))}${ageLabel}${eta}</span>
      </div>
      <div class="po-actions">
        <button type="button" class="po-receive-selected secondary" disabled>Receive selected</button>
        <button type="button" class="po-receive-all primary">Receive all</button>
      </div>
    </header>
    <ul class="po-items"></ul>
  `;

  const itemsEl = section.querySelector(".po-items");
  for (const r of g.items) itemsEl.appendChild(renderItemRow(r));

  // Wire bulk actions
  section.querySelector(".po-receive-all").addEventListener("click", () => {
    // Check every box, then submit
    section.querySelectorAll(".item-include").forEach(cb => cb.checked = true);
    updateSelectedCount(section);
    submitGroup(section, g);
  });

  section.querySelector(".po-receive-selected").addEventListener("click", () => {
    submitGroup(section, g, /* selectedOnly */ true);
  });

  // Per-row include checkboxes update the "selected" footer count
  section.addEventListener("change", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("item-include")) {
      updateSelectedCount(section);
    }
    if (e.target && e.target.classList && e.target.classList.contains("item-issue")) {
      const row = e.target.closest(".item-row");
      const noteWrap = row.querySelector(".item-issue-note");
      if (noteWrap) noteWrap.hidden = !e.target.checked;
    }
  });

  return section;
}

function updateSelectedCount(section) {
  const checked = section.querySelectorAll(".item-include:checked").length;
  const btn = section.querySelector(".po-receive-selected");
  btn.disabled = checked === 0;
  btn.textContent = checked > 0 ? `Receive selected (${checked})` : "Receive selected";
}

function renderItemRow(r) {
  const li = document.createElement("li");
  li.className = "item-row";
  if (r.outOfStock) li.classList.add("urgent");
  li.dataset.pageId = r.pageId;

  const itemTitle = r.itemName || r.customItemName || "(unnamed)";
  const description = r.description || "";
  // Received qty starts blank — receiver must explicitly enter what arrived,
  // so we don't accidentally close out a row when only part of it is in the
  // box. The Ordered count is shown next to it as a reference.
  const qtyOrdered = r.qtyOrdered != null ? r.qtyOrdered : "";
  const thumbHtml = r.image
    ? `<img class="item-thumb" src="${escapeHtml(r.image)}" alt="">`
    : `<div class="item-thumb-fallback">${r.type === "Supply" ? "📦" : r.type === "Other" ? "🛠️" : "🔩"}</div>`;
  const urgentChip = r.outOfStock
    ? `<span class="badge urgent-tag">URGENT</span>`
    : "";
  const onetimeChip = r.oneTime
    ? `<span class="badge badge-onetime">ONE-TIME</span>`
    : "";

  li.innerHTML = `
    <label class="item-include-wrap">
      <input type="checkbox" class="item-include" aria-label="Include in receive batch">
    </label>
    ${thumbHtml}
    <div class="item-body">
      <div class="item-title-row">
        <strong class="item-title">${escapeHtml(itemTitle)}</strong>
        ${description ? `<span class="item-desc">— ${escapeHtml(description)}</span>` : ""}
        ${onetimeChip}
        ${urgentChip}
      </div>
      <div class="item-meta">
        <span><span class="meta-label">Request #</span> ${escapeHtml(r.orderNum || "—")}</span>
        <span><span class="meta-label">Requestor</span> ${escapeHtml(r.requestor || "—")}</span>
        ${r.notes ? `<span class="item-note">"${escapeHtml(r.notes)}"</span>` : ""}
      </div>
    </div>
    <div class="item-qty">
      <label>
        <span class="meta-label">Ordered</span>
        <span class="qty-ordered">${escapeHtml(String(qtyOrdered))}</span>
      </label>
      <label>
        <span class="meta-label">Received</span>
        <input type="number" class="item-qty-received" min="0" value="" placeholder="${escapeHtml(String(qtyOrdered))}" data-qty-ordered="${escapeHtml(String(qtyOrdered))}">
      </label>
    </div>
    <div class="item-issue-wrap">
      <span class="item-issue-spacer" aria-hidden="true"></span>
      <label class="item-issue-label">
        <input type="checkbox" class="item-issue">
        <span>Issue</span>
      </label>
      <div class="item-issue-note" hidden>
        <input type="text" class="item-issue-text" placeholder="What's the issue? (visible to purchaser)">
      </div>
    </div>
  `;

  return li;
}

// Short-shipment modal — appears whenever an item's arrived qty is less than
// what was ordered. Receiver decides per item:
//   "More expected" (default) → close this row at the arrived qty, AND spawn
//     a new sibling row for the remainder. Receiver continues to log future
//     boxes against the sibling.
//   "Nothing more coming"     → close this row at the arrived qty and drop
//     the remainder. The shortfall is accepted as the final outcome.
// Resolves to a map of pageId -> "split" | "close", or null if cancelled.
function promptShortShipments(shortItems) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "receive-modal-overlay";
    const rows = shortItems.map(it => {
      const ordered = it.qtyOrdered ?? "?";
      const got = it.qtyReceived ?? 0;
      const remainder = (typeof it.qtyOrdered === "number" && typeof it.qtyReceived === "number")
        ? Math.max(0, it.qtyOrdered - it.qtyReceived)
        : "?";
      return `
        <li class="receive-modal-item" data-page-id="${escapeHtml(it.pageId)}">
          <div class="receive-modal-item-head">
            <strong>${escapeHtml(it.itemLabel)}</strong>
            <span class="receive-modal-counts">${got} of ${ordered} arrived · ${remainder} short</span>
          </div>
          <div class="receive-modal-choices" role="radiogroup" aria-label="Status for this item">
            <label><input type="radio" name="decide-${escapeHtml(it.pageId)}" value="split" checked> More expected — track the remaining ${remainder} on a new row</label>
            <label><input type="radio" name="decide-${escapeHtml(it.pageId)}" value="close"> Nothing more coming — close and drop the remainder</label>
          </div>
        </li>`;
    }).join("");
    overlay.innerHTML = `
      <div class="receive-modal" role="dialog" aria-modal="true" aria-labelledby="receive-modal-title">
        <header>
          <h2 id="receive-modal-title">Short shipment</h2>
          <p class="receive-modal-sub">Less arrived than was ordered. For each item, tell us whether more is expected.</p>
        </header>
        <ul class="receive-modal-list">${rows}</ul>
        <footer class="receive-modal-actions">
          <button type="button" class="link-btn" data-action="cancel">Cancel</button>
          <button type="button" class="primary" data-action="confirm">Log shipment</button>
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
      const action = e.target.dataset?.action;
      if (action === "cancel") close(null);
      if (action === "confirm") {
        const decisions = {};
        for (const it of shortItems) {
          const picked = overlay.querySelector(`input[name="decide-${CSS.escape(it.pageId)}"]:checked`);
          // "split" → more expected (worker keeps row open via spawn).
          // "close" → no more coming (worker closes and skips spawn).
          decisions[it.pageId] = picked?.value === "close" ? "close" : "split";
        }
        close(decisions);
      }
    });
  });
}

async function submitGroup(section, g, selectedOnly = false) {
  if (!receiverSel.value) {
    alert("Please select your name in the top bar before receiving.");
    receiverSel.focus();
    return;
  }
  clearError();

  const rows = [...section.querySelectorAll(".item-row")];
  const selected = rows.filter(li => {
    if (!selectedOnly) return li.querySelector(".item-include").checked;
    return li.querySelector(".item-include").checked;
  });
  if (selected.length === 0) return;

  // Build the per-item payload up front so we can detect short shipments
  // and ask the receiver how to handle them BEFORE locking the buttons.
  // Each item carries qtyReceived + a `complete` flag:
  //   complete=true  -> Status flips to Received. Worker writes the actual
  //                     qty that arrived to Qty Ordered (truth-up) and does
  //                     NOT spawn a sibling for any short remainder.
  //   complete=false -> Status flips to Received on THIS row at the arrived
  //                     qty, AND the worker spawns a sibling row tracking
  //                     the remainder (this is the split-shipment path).
  const items = selected.map(li => {
    const issue = li.querySelector(".item-issue").checked;
    const issueText = issue ? li.querySelector(".item-issue-text").value.trim() : "";
    const qtyInput = li.querySelector(".item-qty-received");
    const qtyVal = qtyInput.value.trim();
    const qtyReceived = qtyVal === "" ? null : Number(qtyVal);
    const qtyOrdered = Number(qtyInput.dataset.qtyOrdered) || null;
    const isShort = qtyOrdered != null && qtyReceived != null && qtyReceived < qtyOrdered;
    return {
      pageId: li.dataset.pageId,
      qtyReceived,
      qtyOrdered,
      isShort,
      issue,
      issueNote: issueText,
      itemLabel: li.querySelector(".item-title")?.textContent || "(item)",
      // Full shipments are auto-complete. Short shipments default to
      // splitting (more expected) — the prompt below lets the receiver
      // flip individual items to "no more coming" which sets complete=true.
      complete: !isShort,
    };
  });

  // If any item is short, ask the receiver whether more is coming.
  const shortItems = items.filter(it => it.isShort);
  if (shortItems.length > 0) {
    const decisions = await promptShortShipments(shortItems);
    if (decisions === null) {
      return; // Receiver cancelled — write nothing.
    }
    for (const it of items) {
      if (it.isShort) it.complete = decisions[it.pageId] === "close";
    }
  }

  // Disable buttons while in-flight (after the prompt so we don't strand the
  // section disabled if the receiver cancels the modal).
  const allBtn = section.querySelector(".po-receive-all");
  const selBtn = section.querySelector(".po-receive-selected");
  allBtn.disabled = true;
  selBtn.disabled = true;
  const allLabel = allBtn.textContent;
  allBtn.textContent = "Receiving…";

  // Strip helper-only fields before sending to the worker — it only needs
  // pageId, qtyReceived, complete, issue, issueNote.
  const itemsPayload = items.map(it => ({
    pageId: it.pageId,
    qtyReceived: it.qtyReceived,
    complete: it.complete,
    issue: it.issue,
    issueNote: it.issueNote,
  }));

  try {
    const res = await fetch(`${WORKER_URL}/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receiverName: receiverSel.value,
        receivedDate: todayISO(),
        items: itemsPayload,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Receive failed");

    // Every row in the batch closes on this transaction (Status → Received).
    // Short shipments with "more expected" spawn a sibling row server-side;
    // the sibling appears on the next /pending poll, not in this response —
    // we kick a refresh so receivers see remainder rows right away.
    const receivedIds = new Set(selected.map(li => li.dataset.pageId));
    allOrdered = allOrdered.filter(r => !receivedIds.has(r.pageId));
    for (const li of selected) li.remove();

    if (section.querySelectorAll(".item-row").length === 0) {
      section.remove();
    } else {
      updateSelectedCount(section);
    }

    // If the worker spawned any sibling rows, refresh to pull them in so
    // they're immediately visible on this page. Otherwise skip the network
    // round-trip — the DOM is already correct.
    const spawnedSiblings = (data.results || []).some(r => r.sibling);
    if (spawnedSiblings) {
      // Brief debounce — let the user see the row disappear before the
      // refresh repopulates with the sibling.
      setTimeout(() => loadShipments(), 600);
    }
    if (poListEl.querySelectorAll(".po-group").length === 0) {
      emptyEl.innerHTML = `<p>📦 Nothing waiting to be received. The dock is clear.</p>`;
      emptyEl.hidden = false;
    }
    // Re-run bubble render so counts reflect the new cache. If the active
    // vendor filter just lost all its rows, drop back to All.
    if (vendorFilter && !allOrdered.some(r => primaryVendor(r).toLowerCase() === vendorFilter.toLowerCase())) {
      vendorFilter = "";
      renderShipments(filteredOrdered());
    }
    renderSupplierBubbles();
    updateSearchCount();
  } catch (e) {
    showError(e.message || "Receive failed");
    allBtn.disabled = false;
    allBtn.textContent = allLabel;
    updateSelectedCount(section);
  }
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
loadReceivers().then(loadShipments);
