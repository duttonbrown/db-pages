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

async function loadReceivers() {
  try {
    const res = await fetch(`${WORKER_URL}/people`);
    const data = await res.json();
    for (const name of data.people || []) {
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
    // /pending returns Submitted + Waiting + Backordered + Ordered. Receiving
    // only cares about Ordered — the rest aren't physically en route.
    const ordered = (data.rows || []).filter(r => r.status === "Ordered");
    renderShipments(ordered);
  } catch (e) {
    showError("Couldn't load shipments.");
    loadingBar.hidden = true;
  } finally {
    clearInterval(tick);
  }
}

refreshBtn.addEventListener("click", loadShipments);

function renderShipments(rows) {
  poListEl.innerHTML = "";

  if (rows.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Group by normalized PO. Rows missing a PO go in their own "No PO" group
  // (rare — usually only when something was marked Ordered without filling it).
  const groups = new Map(); // normalizedPO -> { display, vendor, oldestOrdered, oldestETA, items[] }
  for (const r of rows) {
    const key = r.poNumber ? normalizePO(r.poNumber) : "__NO_PO__";
    if (!groups.has(key)) {
      groups.set(key, {
        displayPO: r.poNumber || "(no PO)",
        vendor: primaryVendor(r),
        orderedDate: r.orderedDate || null,
        eta: r.eta || null,
        tracking: r.tracking || "",
        items: [],
      });
    }
    const g = groups.get(key);
    g.items.push(r);
    // Surface the earliest orderedDate / earliest ETA for the group header.
    if (r.orderedDate && (!g.orderedDate || r.orderedDate < g.orderedDate)) {
      g.orderedDate = r.orderedDate;
    }
    if (r.eta && (!g.eta || r.eta < g.eta)) g.eta = r.eta;
    if (!g.tracking && r.tracking) g.tracking = r.tracking;
  }

  // Sort by oldest orderedDate first — older POs are more likely to have arrived
  const sorted = [...groups.entries()].sort((a, b) => {
    const ax = a[1].orderedDate || "9999-99-99";
    const bx = b[1].orderedDate || "9999-99-99";
    return ax.localeCompare(bx);
  });

  for (const [poKey, g] of sorted) {
    poListEl.appendChild(renderPOGroup(poKey, g));
  }
}

function renderPOGroup(poKey, g) {
  const section = document.createElement("section");
  section.className = "po-group";
  section.dataset.poKey = poKey;

  const age = ageDays(g.orderedDate);
  const ageLabel = age != null ? ` · ${age}d ago` : "";
  const eta = g.eta ? ` · ETA ${fmtDate(g.eta)}` : "";

  section.innerHTML = `
    <header class="po-header">
      <div class="po-meta">
        <span class="po-num">${escapeHtml(g.displayPO)}</span>
        ${g.vendor ? `<span class="po-vendor">${escapeHtml(g.vendor)}</span>` : ""}
        <span class="po-when">Ordered ${escapeHtml(fmtDate(g.orderedDate))}${ageLabel}${eta}</span>
      </div>
      <div class="po-actions">
        <button type="button" class="po-receive-all primary">Receive all in this PO</button>
      </div>
    </header>
    <ul class="po-items"></ul>
    <footer class="po-footer">
      <button type="button" class="po-receive-selected secondary" disabled>Receive selected</button>
      <span class="po-selected-count">0 selected</span>
    </footer>
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
  section.querySelector(".po-selected-count").textContent =
    checked === 1 ? "1 selected" : `${checked} selected`;
  section.querySelector(".po-receive-selected").disabled = checked === 0;
}

function renderItemRow(r) {
  const li = document.createElement("li");
  li.className = "item-row";
  li.dataset.pageId = r.pageId;

  const itemTitle = r.itemName || r.customItemName || "(unnamed)";
  const description = r.description || "";
  const qtyDefault = r.qtyOrdered != null ? r.qtyOrdered : "";

  li.innerHTML = `
    <label class="item-include-wrap">
      <input type="checkbox" class="item-include" aria-label="Include in receive batch">
    </label>
    <div class="item-body">
      <div class="item-title-row">
        <strong class="item-title">${escapeHtml(itemTitle)}</strong>
        ${description ? `<span class="item-desc">— ${escapeHtml(description)}</span>` : ""}
      </div>
      <div class="item-meta">
        <span><span class="meta-label">Order #</span> ${escapeHtml(r.orderNum || "—")}</span>
        <span><span class="meta-label">Requestor</span> ${escapeHtml(r.requestor || "—")}</span>
        ${r.notes ? `<span class="item-note">"${escapeHtml(r.notes)}"</span>` : ""}
      </div>
    </div>
    <div class="item-qty">
      <label>
        <span class="meta-label">Ordered</span>
        <span class="qty-ordered">${escapeHtml(String(qtyDefault))}</span>
      </label>
      <label>
        <span class="meta-label">Received</span>
        <input type="number" class="item-qty-received" min="0" value="${escapeHtml(String(qtyDefault))}">
      </label>
    </div>
    <div class="item-issue-wrap">
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

  // Disable buttons while in-flight
  const allBtn = section.querySelector(".po-receive-all");
  const selBtn = section.querySelector(".po-receive-selected");
  allBtn.disabled = true;
  selBtn.disabled = true;
  const allLabel = allBtn.textContent;
  allBtn.textContent = "Receiving…";

  const items = selected.map(li => {
    const issue = li.querySelector(".item-issue").checked;
    const issueText = issue ? li.querySelector(".item-issue-text").value.trim() : "";
    const qtyVal = li.querySelector(".item-qty-received").value.trim();
    return {
      pageId: li.dataset.pageId,
      qtyReceived: qtyVal === "" ? null : Number(qtyVal),
      issue,
      issueNote: issueText,
    };
  });

  try {
    const res = await fetch(`${WORKER_URL}/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receiverName: receiverSel.value,
        receivedDate: todayISO(),
        items,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Receive failed");
    // Remove the received items from the DOM. If the group is now empty,
    // remove the whole section.
    for (const li of selected) li.remove();
    if (section.querySelectorAll(".item-row").length === 0) {
      section.remove();
    } else {
      updateSelectedCount(section);
    }
    if (poListEl.querySelectorAll(".po-group").length === 0) {
      emptyEl.hidden = false;
    }
  } catch (e) {
    showError(e.message || "Receive failed");
    allBtn.disabled = false;
    allBtn.textContent = allLabel;
    updateSelectedCount(section);
  }
}

// Boot
loadReceivers().then(loadShipments);
