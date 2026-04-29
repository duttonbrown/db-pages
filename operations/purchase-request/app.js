// Inventory Request Form — cart-style client logic

const WORKER_URL = (window.WORKER_URL_OVERRIDE) || "https://inventory-request-form.purchasing-906.workers.dev";

const $ = (id) => document.getElementById(id);

const search        = $("search");
const resultsList   = $("results");
const picked        = $("picked");
const pickedImage   = $("picked-image");
const pickedTitle   = $("picked-title");
const pickedSub     = $("picked-subtitle");
const pickedType    = $("picked-type");
const pickedNoteCheckbox = $("picked-note-checkbox");
const pickedNoteInput    = $("picked-note");
const addBtn        = $("add-btn");
const cancelPick    = $("cancel-pick");
const notInDb       = $("not-in-db");
const customFields  = $("custom-fields");
const customName    = $("custom-name");
const customNotes   = $("custom-notes");
const addCustomBtn  = $("add-custom-btn");
const cartSection   = $("cart-section");
const cartList      = $("cart");
const cartCount     = $("cart-count");
const sharedSection = $("shared-section");
const requestor     = $("requestor");
const sharedNotes   = $("shared-notes");
const submitBtn     = $("submit-btn");
const successBox    = $("success");
const successHeading= $("success-heading");
const successList   = $("success-list");
const newReqBtn     = $("new-request");
const errorBox      = $("error");
const picker        = $("picker");

let pickedItem = null;
let cart = [];
let activeIndex = -1;
let currentResults = [];
let catalog = { parts: [], supplies: [] };
let catalogReady = false;

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
function clearError() { errorBox.hidden = true; }

function fmtUse(n)   { return (n === null || n === undefined) ? "" : `${n}/yr`; }
function fmtReorder(v) {
  if (v === null || v === undefined || v === "") return "";
  return `Reorder ${v}`;
}

function vendorLine(item) {
  return item.vendor ? `Vendor: ${item.vendor}` : "";
}

function statsLine(item) {
  return [
    item.use2025 != null && `2025 Use: ${item.use2025}`,
    fmtReorder(item.reorderQty),
    item.leadTime && `Lead Time: ${item.leadTime}`,
  ].filter(Boolean).join("   |   ");
}

async function loadRequestors() {
  try {
    const res = await fetch(`${WORKER_URL}/requestors`);
    const data = await res.json();
    for (const name of data.requestors || []) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      requestor.appendChild(opt);
    }
  } catch (e) {
    showError("Couldn't load requestors. Check Worker URL.");
  }
}

async function loadCatalog() {
  search.placeholder = "Loading catalog (10–20 seconds for instant search after)…";
  search.disabled = true;
  try {
    const res = await fetch(`${WORKER_URL}/catalog`);
    const data = await res.json();
    catalog.parts = data.parts || [];
    catalog.supplies = data.supplies || [];
    catalogReady = true;
    search.placeholder = `Search ${catalog.parts.length} parts + ${catalog.supplies.length} supplies…`;
  } catch (e) {
    search.placeholder = "Search part number, name, or description";
    showError("Couldn't load catalog. Search may be slower.");
  } finally {
    search.disabled = false;
  }
}

function localSearch(q) {
  const needle = q.toLowerCase();
  const score = (r) => {
    const t = (r.title || "").toLowerCase();
    const d = (r.description || "").toLowerCase();
    const s = (r.subtitle || "").toLowerCase();
    const f = (r.familyName || "").toLowerCase();
    const c = (r.category || "").toLowerCase();
    if (t.startsWith(needle)) return 4;
    if (t.includes(needle))   return 3;
    if (f.includes(needle) || c.includes(needle)) return 2;
    if (d.includes(needle) || s.includes(needle)) return 1;
    return 0;
  };
  const all = [...catalog.parts, ...catalog.supplies];
  return all
    .map(r => ({ r, s: score(r) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 20)
    .map(x => x.r);
}

function runSearch(q) {
  if (q.length < 2) { resultsList.hidden = true; return; }
  if (!catalogReady) {
    resultsList.innerHTML = '<li class="empty">Loading catalog…</li>';
    resultsList.hidden = false;
    return;
  }
  renderResults(localSearch(q));
}

function renderResults(items) {
  currentResults = items;
  activeIndex = -1;
  resultsList.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No matches. Check the box below if it isn't in the database.";
    resultsList.appendChild(empty);
  } else {
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.dataset.index = i;
      const icon = item.type === "Part" ? "🔩" : "📦";
      const thumb = item.image
        ? `<img class="thumb" src="${item.image}" alt="">`
        : `<span class="icon">${icon}</span>`;
      li.innerHTML = `
        ${thumb}
        <span class="meta">
          <span class="title-row">
            <strong class="title-text"></strong>
            <span class="title-desc"></span>
          </span>
          <small class="vendor-line"></small>
          <small class="stats-line"></small>
        </span>
      `;
      li.querySelector(".title-text").textContent = item.title || "(untitled)";
      const desc = item.description || item.subtitle || "";
      li.querySelector(".title-desc").textContent = desc ? `— ${desc}` : "";
      const vLine = vendorLine(item);
      const sLine = statsLine(item);
      li.querySelector(".vendor-line").textContent = vLine;
      li.querySelector(".vendor-line").hidden = !vLine;
      li.querySelector(".stats-line").textContent = sLine;
      li.querySelector(".stats-line").hidden = !sLine;
      li.addEventListener("click", () => pickItem(item));
      resultsList.appendChild(li);
    });
  }
  resultsList.hidden = false;
}

function pickItem(item) {
  pickedItem = item;
  pickedImage.src = item.image || "";
  pickedImage.hidden = !item.image;
  const desc = item.description || item.subtitle || "";
  pickedTitle.textContent = desc ? `${item.title} — ${desc}` : item.title;
  pickedSub.innerHTML = "";
  const v = vendorLine(item);
  const s = statsLine(item);
  if (v) {
    const vEl = document.createElement("span");
    vEl.textContent = v;
    pickedSub.appendChild(vEl);
  }
  if (s) {
    const sEl = document.createElement("span");
    sEl.textContent = s;
    sEl.style.display = "block";
    pickedSub.appendChild(sEl);
  }
  pickedType.textContent = item.type;
  pickedNoteCheckbox.checked = false;
  pickedNoteInput.value = "";
  pickedNoteInput.hidden = true;
  picked.hidden = false;
  search.hidden = true;
  resultsList.hidden = true;
}

function cancelPicked() {
  pickedItem = null;
  picked.hidden = true;
  search.hidden = false;
  search.value = "";
  search.focus();
}

function addPickedToCart() {
  if (!pickedItem) return;
  const note = pickedNoteCheckbox.checked ? pickedNoteInput.value.trim() : "";
  cart.push({
    type: pickedItem.type,
    relationId: pickedItem.id,
    notInDb: false,
    qty: 1,
    notes: note,
    title: pickedItem.title,
    description: pickedItem.description,
    subtitle: pickedItem.subtitle,
    vendor: pickedItem.vendor,
    reorderQty: pickedItem.reorderQty,
    use2025: pickedItem.use2025,
    leadTime: pickedItem.leadTime,
    image: pickedItem.image,
  });
  cancelPicked();
  renderCart();
}

function addCustomToCart() {
  const name = customName.value.trim();
  if (!name) return;
  const t = document.querySelector('input[name="custom-type"]:checked').value;
  cart.push({
    type: t,
    notInDb: true,
    customName: name,
    qty: 1,
    notes: customNotes.value.trim(),
    title: name,
    subtitle: "(not in database)",
    vendor: "",
  });
  customName.value = "";
  customNotes.value = "";
  document.querySelector('input[name="custom-type"][value="Part"]').checked = true;
  notInDb.checked = false;
  toggleNotInDb();
  renderCart();
}

function removeFromCart(i) {
  cart.splice(i, 1);
  renderCart();
}

function renderCart() {
  cartList.innerHTML = "";
  if (cart.length === 0) {
    cartSection.hidden = true;
    sharedSection.hidden = true;
    return;
  }
  cartSection.hidden = false;
  sharedSection.hidden = false;
  cartCount.textContent = `(${cart.length} item${cart.length === 1 ? "" : "s"})`;

  cart.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = "cart-item";
    const icon = it.notInDb ? (it.type === "Other" ? "🛠️" : (it.type === "Part" ? "🔩" : "📦"))
                            : (it.type === "Part" ? "🔩" : "📦");
    const cartThumb = it.image
      ? `<img class="thumb" src="${it.image}" alt="">`
      : `<span class="icon">${icon}</span>`;
    li.innerHTML = `
      ${cartThumb}
      <div class="cart-meta">
        <span class="title-row">
          <strong class="title-text"></strong>
          <span class="title-desc"></span>
        </span>
        <small class="vendor-line"></small>
        <small class="stats-line"></small>
        <div class="cart-note-row">
          <button type="button" class="link-btn cart-note-toggle"></button>
          <input type="text" class="cart-note-input" placeholder="Note for purchaser" hidden>
        </div>
      </div>
      <button type="button" class="link-btn cart-remove" aria-label="Remove">✕</button>
    `;
    li.querySelector(".title-text").textContent = it.title;
    const desc = it.description || it.subtitle || "";
    li.querySelector(".title-desc").textContent = desc ? `— ${desc}` : "";
    const vLine = vendorLine(it);
    const sLine = statsLine(it);
    li.querySelector(".vendor-line").textContent = vLine;
    li.querySelector(".vendor-line").hidden = !vLine;
    li.querySelector(".stats-line").textContent = sLine;
    li.querySelector(".stats-line").hidden = !sLine;

    const noteToggle = li.querySelector(".cart-note-toggle");
    const noteInput  = li.querySelector(".cart-note-input");
    const setNoteUI = () => {
      const has = !!(it.notes && it.notes.trim());
      if (has) {
        noteToggle.textContent = `Note: ${it.notes}  (edit)`;
        noteInput.hidden = true;
      } else {
        noteToggle.textContent = "+ Add note";
        noteInput.hidden = true;
      }
    };
    setNoteUI();
    noteToggle.addEventListener("click", () => {
      noteInput.hidden = false;
      noteInput.value = it.notes || "";
      noteToggle.hidden = true;
      noteInput.focus();
    });
    noteInput.addEventListener("blur", () => {
      cart[i].notes = noteInput.value.trim();
      noteToggle.hidden = false;
      setNoteUI();
    });
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); noteInput.blur(); }
      if (e.key === "Escape") { noteInput.value = it.notes || ""; noteInput.blur(); }
    });

    li.querySelector(".cart-remove").addEventListener("click", () => removeFromCart(i));
    cartList.appendChild(li);
  });

  updateSubmitState();
}

function updateSubmitState() {
  submitBtn.disabled = !(cart.length > 0 && requestor.value !== "");
}

function toggleNotInDb() {
  if (notInDb.checked) {
    customFields.hidden = false;
    search.hidden = true;
    resultsList.hidden = true;
    cancelPicked();
    customName.focus();
  } else {
    customFields.hidden = true;
    search.hidden = false;
    customName.value = "";
    search.focus();
  }
}

function updateAddCustomState() {
  addCustomBtn.disabled = customName.value.trim().length === 0;
}

async function handleSubmit() {
  if (cart.length === 0 || !requestor.value) return;
  clearError();
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  const payload = {
    requestor: requestor.value,
    sharedNotes: sharedNotes.value.trim(),
    items: cart.map(it => ({
      type: it.type,
      relationId: it.relationId,
      notInDb: it.notInDb,
      customName: it.customName,
      qty: it.qty,
      notes: it.notes,
    })),
  };

  try {
    const res = await fetch(`${WORKER_URL}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Submit failed");
    showSuccess(data);
  } catch (e) {
    showError(e.message || "Submit failed");
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit purchase request";
  }
}

function showSuccess(data) {
  picker.hidden = true;
  cartSection.hidden = true;
  sharedSection.hidden = true;
  successBox.hidden = false;
  const n = data.count;
  successHeading.textContent = `Purchase request submitted (${n} item${n === 1 ? "" : "s"})`;
  successList.innerHTML = "";
  for (const c of data.created) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${c.orderNum}</strong> <a href="${c.url}" target="_blank" rel="noopener">View in Notion ↗</a>`;
    successList.appendChild(li);
  }
}

function resetForm() {
  cart = [];
  cancelPicked();
  notInDb.checked = false;
  toggleNotInDb();
  picker.hidden = false;
  cartSection.hidden = true;
  sharedSection.hidden = true;
  successBox.hidden = true;
  requestor.value = "";
  sharedNotes.value = "";
  submitBtn.textContent = "Submit purchase request";
  search.focus();
  clearError();
}

// Keyboard navigation in results
search.addEventListener("keydown", (e) => {
  if (resultsList.hidden) return;
  const items = resultsList.querySelectorAll("li[data-index]");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
  } else if (e.key === "Enter" && activeIndex >= 0) {
    e.preventDefault();
    pickItem(currentResults[activeIndex]);
    return;
  } else if (e.key === "Escape") {
    resultsList.hidden = true;
    return;
  } else { return; }
  items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
});

search.addEventListener("input", () => {
  runSearch(search.value.trim());
});

addBtn.addEventListener("click", addPickedToCart);
cancelPick.addEventListener("click", cancelPicked);
pickedNoteCheckbox.addEventListener("change", () => {
  pickedNoteInput.hidden = !pickedNoteCheckbox.checked;
  if (pickedNoteCheckbox.checked) pickedNoteInput.focus();
  else pickedNoteInput.value = "";
});
notInDb.addEventListener("change", toggleNotInDb);
customName.addEventListener("input", updateAddCustomState);
addCustomBtn.addEventListener("click", addCustomToCart);
requestor.addEventListener("change", updateSubmitState);
submitBtn.addEventListener("click", handleSubmit);
newReqBtn.addEventListener("click", resetForm);

// Boot: fetch catalog + requestors in parallel
Promise.all([loadCatalog(), loadRequestors()]).then(updateSubmitState);
