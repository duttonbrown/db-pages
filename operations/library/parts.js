// Parts Library — single-page app over parts-library.json.

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let DATA = null;
let PARTS_BY_NUM = {};        // part_number -> part
let FAMILY_BY_PARTNUM = {};   // part_number -> family object
let GLOSSARY_BY_ID = {};      // id -> glossary entry
let activeGlossary = 'all';
let activeResultIdx = -1;
let currentPart = null;

// --- Load and bootstrap ---
async function bootstrap() {
  try {
    const resp = await fetch('parts-library.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    DATA = await resp.json();
  } catch (e) {
    $('grid-slot').innerHTML = `<div class="empty-grid">Failed to load library data: ${escapeHtml(e.message)}</div>`;
    return;
  }

  DATA.parts.forEach((p) => { PARTS_BY_NUM[p.part_number] = p; });
  Object.values(DATA.families).forEach((f) => {
    GLOSSARY_BY_ID[f.glossary && f.glossary.id] = f.glossary;
  });
  // Map every part to its family
  DATA.parts.forEach((p) => {
    if (p.family_id && DATA.families[p.family_id]) {
      FAMILY_BY_PARTNUM[p.part_number] = DATA.families[p.family_id];
    }
  });
  // Add 'all' faux glossary
  DATA.glossary.unshift({ id: 'all', name: 'All', abbr: '', definition: '' });

  $('parts-count').textContent = DATA.counts.parts.toLocaleString();
  const sideSuppliesCount = $('supplies-count');
  if (sideSuppliesCount) sideSuppliesCount.textContent = (DATA.counts.supplies || 0).toLocaleString();
  $('lib-count').innerHTML = `<b>${DATA.counts.parts}</b> parts · <b>${DATA.counts.glossary}</b> categories`;

  renderGlossary();
  renderRecents();
  wireSearch();
  routeFromHash();
  renderSupplies(); // independent of parts navigation; always rendered at the bottom

  window.addEventListener('hashchange', routeFromHash);
}

// --- Supplies (flat list rendered below parts) ---
// Independent from the parts grid: clicking a parts category chip does NOT
// affect supplies, and supplies have their own type-filter chips. Clicking
// a supply card opens the Notion page (no internal spec card yet — supplies
// are simpler entities; can be expanded later if useful).
let activeSupplyType = 'all';

function renderSupplies() {
  const section = $('section-supplies');
  if (!section) return;
  const supplies = DATA.supplies || [];
  if (supplies.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('supplies-section-count').textContent = `${supplies.length} item${supplies.length === 1 ? '' : 's'}`;

  // Type filter chips — only Active supplies; group by Type select
  const counts = {};
  supplies.filter(s => s.status === 'Active').forEach(s => {
    const t = s.type || '(uncategorized)';
    counts[t] = (counts[t] || 0) + 1;
  });
  const types = ['all', ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])];
  $('supply-type-filters').innerHTML = types.map(t => {
    const label = t === 'all' ? 'All' : t;
    const n = t === 'all' ? supplies.filter(s => s.status === 'Active').length : counts[t];
    const cls = `glossary-chip${activeSupplyType === t ? ' is-active' : ''}`;
    return `<button class="${cls}" data-supply-type="${escapeHtml(t)}">${escapeHtml(label)} <span class="gc-count">${n}</span></button>`;
  }).join('');
  $('supply-type-filters').querySelectorAll('[data-supply-type]').forEach(b => {
    b.onclick = () => {
      activeSupplyType = b.dataset.supplyType;
      renderSupplies();
    };
  });

  // Filter + render grid
  let list = supplies.filter(s => s.status === 'Active');
  if (activeSupplyType !== 'all') {
    list = list.filter(s => (s.type || '(uncategorized)') === activeSupplyType);
  }
  if (list.length === 0) {
    $('supplies-grid-slot').innerHTML = `<div class="empty-grid">No supplies match this filter.</div>`;
    return;
  }
  $('supplies-grid-slot').innerHTML = `<div class="parts-grid">${list.map(supplyCardHtml).join('')}</div>`;
}

function supplyCardHtml(s) {
  const imgHtml = s.image
    ? `<div class="preview-image"><img src="${escapeHtml(s.image)}" alt="${escapeHtml(s.sku || s.title)}" loading="lazy"></div>`
    : `<div class="preview-image no-img">No image</div>`;
  const label = s.sku || s.title || '(unnamed)';
  const desc  = s.title && s.title !== label ? s.title : (s.description || '');
  const type  = s.type ? `<span class="preview-finish">${escapeHtml(s.type)}</span>` : '';
  return `<a class="preview-card" href="${escapeHtml(s.page_url || '#')}" target="_blank" rel="noopener">
    ${imgHtml}
    <div class="preview-body">
      <div class="preview-num">${escapeHtml(label)}</div>
      <div class="preview-desc">${escapeHtml(desc)}</div>
      ${type}
    </div>
  </a>`;
}

// --- Recent parts (localStorage) ---
function loadRecents() {
  try { return JSON.parse(localStorage.getItem('db-library-recents') || '[]'); }
  catch { return []; }
}
function pushRecent(pn) {
  let r = loadRecents().filter(x => x !== pn);
  r.unshift(pn);
  r = r.slice(0, 6);
  localStorage.setItem('db-library-recents', JSON.stringify(r));
  renderRecents();
}
function renderRecents() {
  const r = loadRecents().filter(pn => PARTS_BY_NUM[pn]);
  const row = $('recents-row');
  const chips = $('recents-chips');
  if (!r.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  chips.innerHTML = r.map(pn =>
    `<button class="recents-chip" data-pn="${escapeHtml(pn)}">${escapeHtml(pn)}</button>`
  ).join(' ');
  chips.querySelectorAll('.recents-chip').forEach(b => {
    b.onclick = () => showPart(b.dataset.pn);
  });
}

// --- Glossary chips ---
function partCountsByGlossary() {
  const counts = { all: DATA.parts.length };
  DATA.parts.forEach(p => {
    const fam = DATA.families[p.family_id];
    const gid = fam && fam.glossary && fam.glossary.id;
    if (!gid) return;
    counts[gid] = (counts[gid] || 0) + 1;
  });
  return counts;
}

// Glossary strip collapses to ~2 rows by default. The toggle expands it
// when there are more chips than fit. Once the user expands, we keep it
// open for the rest of the session — they explicitly asked for more.
let glossaryExpanded = false;

function renderGlossary() {
  const counts = partCountsByGlossary();
  const entries = DATA.glossary
    .map(g => ({ ...g, count: counts[g.id] || 0 }))
    .sort((a, b) => {
      if (a.id === 'all') return -1;
      if (b.id === 'all') return 1;
      return b.count - a.count;
    });
  const visible = entries.filter(g => g.id === 'all' || g.count);
  $('glossary').innerHTML = visible.map(g => {
    return `<button class="glossary-chip${g.id === activeGlossary ? ' is-active' : ''}" data-gid="${escapeHtml(g.id)}">${escapeHtml(g.name || '(unnamed)')} <span class="gc-count">${g.count}</span></button>`;
  }).join('');
  $('glossary').querySelectorAll('.glossary-chip').forEach(b => {
    b.onclick = () => {
      activeGlossary = b.dataset.gid;
      renderGlossary();
      // The whole point of clicking a chip is "show me this category" — so
      // whatever's currently showing (grid OR spec card), switch back to the
      // grid filtered by this chip. Previously if you were viewing a part
      // the spec card stayed put and the click looked like a no-op.
      if (currentPart) {
        currentPart = null;
        history.replaceState(null, '', location.pathname + location.search);
      }
      $('spec-slot').hidden = true;
      $('grid-slot').hidden = false;
      renderGrid();
    };
  });

  // Wire the Show all / Show fewer toggle. Show it whenever there are more
  // chips than ~14 (the rough number that fits in 2 compact rows). After
  // render we measure the strip vs its collapsed cap to decide; if the
  // strip's natural height fits within the cap we keep the toggle hidden.
  const strip = $('glossary');
  const toggle = $('glossary-toggle');
  if (!toggle) return;
  // Apply the right collapsed state first, then measure.
  strip.classList.toggle('is-collapsed', !glossaryExpanded);
  // Defer measurement so layout has settled.
  requestAnimationFrame(() => {
    const collapsedCap = 64; // keep in sync with .glossary-strip.is-collapsed max-height
    // Temporarily uncollapse to measure natural height
    const wasCollapsed = strip.classList.contains('is-collapsed');
    if (wasCollapsed) strip.classList.remove('is-collapsed');
    const natural = strip.offsetHeight;
    if (wasCollapsed) strip.classList.add('is-collapsed');
    const overflows = natural > collapsedCap + 4;
    toggle.hidden = !overflows;
    toggle.textContent = glossaryExpanded ? "Show fewer" : `Show all ${visible.length - 1} categories`;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('glossary-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    glossaryExpanded = !glossaryExpanded;
    renderGlossary();
  });
});

// --- Browse grid ---
function filteredParts() {
  let list = DATA.parts.slice();
  if (activeGlossary !== 'all') {
    list = list.filter(p => {
      const fam = DATA.families[p.family_id];
      return fam && fam.glossary && fam.glossary.id === activeGlossary;
    });
  }
  return list;
}

function renderGrid() {
  const list = filteredParts();
  if (!list.length) {
    $('grid-slot').innerHTML = `<div class="empty-grid">No parts match the current filter.</div>`;
    return;
  }
  const html = list.map(p => previewCardHtml(p)).join('');
  $('grid-slot').innerHTML = `<div class="parts-grid">${html}</div>`;
  $('grid-slot').querySelectorAll('.preview-card').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      showPart(a.dataset.pn);
    };
  });
}

function previewCardHtml(p) {
  const fam = DATA.families[p.family_id];
  const desc = (fam && fam.description) || '';
  const finish = p.finish ? `<span class="preview-finish">${escapeHtml(p.finish)}</span>` : '';
  const imgHtml = p.image
    ? `<div class="preview-image"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.part_number)}" loading="lazy"></div>`
    : `<div class="preview-image no-img">No image</div>`;

  // In-house process pill stripe — drawn on top of the thumb so it's
  // instantly scannable (Powder Coat / Black Batch are workflow-critical).
  const inHouse = (p.in_house_processes || fam?.in_house_processes || []).filter(Boolean);
  const ihpStripe = inHouse.length
    ? `<div class="preview-ihp">${inHouse.map(proc => `<span class="ihp-pill" data-proc="${escapeHtml(proc)}">${escapeHtml(proc)}</span>`).join('')}</div>`
    : '';

  // Status flag — only render when non-Active so the grid stays calm.
  // Discontinuing / Inactive get loud red/gray ribbons; Introducing is blue.
  const status = p.status;
  let statusFlag = '';
  if (status && status !== 'Active') {
    const cls = statusClass(status);
    statusFlag = `<div class="preview-status-flag ${cls}">${escapeHtml(status)}</div>`;
  }
  const cardCls = status && status !== 'Active' ? `preview-card is-${statusClass(status)}` : 'preview-card';

  return `<a class="${cardCls}" data-pn="${escapeHtml(p.part_number)}" href="#${encodeURIComponent(p.part_number)}">
    ${imgHtml}
    ${ihpStripe}
    ${statusFlag}
    <div class="preview-body">
      <div class="preview-num">${escapeHtml(p.part_number)}</div>
      <div class="preview-desc">${escapeHtml(desc)}</div>
      ${finish}
    </div>
  </a>`;
}

// --- Search ---
function search(q) {
  q = q.toLowerCase().trim();
  if (!q) return [];
  const exact = [], prefix = [], contains = [], descMatch = [];
  for (const p of DATA.parts) {
    const pn = p.part_number.toLowerCase();
    const fam = DATA.families[p.family_id] || {};
    const desc = (fam.description || '').toLowerCase();
    const gloss = (fam.glossary && fam.glossary.name || '').toLowerCase();
    if (pn === q) exact.push(p);
    else if (pn.startsWith(q)) prefix.push(p);
    else if (pn.includes(q)) contains.push(p);
    else if (desc.includes(q) || gloss.includes(q)) descMatch.push(p);
  }
  return [...exact, ...prefix, ...contains, ...descMatch].slice(0, 15);
}

function renderSearchResults(items) {
  const box = $('results');
  if (!items.length) {
    box.hidden = true; box.classList.remove('open'); return;
  }
  box.innerHTML = items.map((p, i) => {
    const fam = DATA.families[p.family_id] || {};
    const desc = (fam.description || '');
    const img = p.image
      ? `<div class="lib-result-img"><img src="${escapeHtml(p.image)}" alt="" loading="lazy"></div>`
      : `<div class="lib-result-img no-img">—</div>`;
    return `<li class="lib-result" data-pn="${escapeHtml(p.part_number)}" data-idx="${i}">
      ${img}
      <div class="lib-result-text">
        <div class="lib-result-num">${escapeHtml(p.part_number)}</div>
        <div class="lib-result-desc">${escapeHtml(desc)}</div>
      </div>
      <div class="lib-result-meta">${escapeHtml(p.finish || '')}</div>
    </li>`;
  }).join('');
  box.hidden = false; box.classList.add('open');
  activeResultIdx = -1;
  box.querySelectorAll('.lib-result').forEach(el => {
    el.onclick = () => showPart(el.dataset.pn);
  });
}

function wireSearch() {
  const inp = $('search');
  inp.addEventListener('input', () => renderSearchResults(search(inp.value)));
  inp.addEventListener('focus', () => { if (inp.value) renderSearchResults(search(inp.value)); });
  inp.addEventListener('keydown', (e) => {
    const items = $('results').querySelectorAll('.lib-result');
    if (!items.length) {
      if (e.key === 'Enter') {
        const q = inp.value.trim();
        if (PARTS_BY_NUM[q]) showPart(q);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeResultIdx = (activeResultIdx + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeResultIdx = (activeResultIdx - 1 + items.length) % items.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const tgt = activeResultIdx >= 0 ? items[activeResultIdx] : items[0];
      showPart(tgt.dataset.pn);
      return;
    } else if (e.key === 'Escape') {
      $('results').hidden = true;
      return;
    } else return;
    items.forEach(el => el.classList.remove('is-active'));
    if (activeResultIdx >= 0) items[activeResultIdx].classList.add('is-active');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lib-search')) $('results').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== inp) {
      e.preventDefault(); inp.focus(); inp.select();
    }
  });
}

// --- Spec card ---
// opts.preserveScroll: skip the scroll-to-top jump (used when switching
// between siblings within an already-visible spec card — the card is right
// there in front of the user and jumping disorients them).
function showPart(pn, opts) {
  const p = PARTS_BY_NUM[pn];
  if (!p) return;
  currentPart = p;
  pushRecent(pn);
  $('search').value = '';
  $('results').hidden = true;
  history.replaceState(null, '', '#' + encodeURIComponent(pn));
  renderSpec(p);
  if (!opts || !opts.preserveScroll) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function backToBrowse() {
  currentPart = null;
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
  history.replaceState(null, '', location.pathname + location.search);
  renderGrid();
}

function fmtDate(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

// Relative time for the "last ordered 3d ago" line in the spec card. Returns
// human-friendly short forms that match the patterns used elsewhere in the
// operations UIs (today / yesterday / Nd / NMo / Ny).
function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 0) return 'upcoming';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// Status class for the colored dot/badge next to part numbers. Was just
// "active or nothing" before; now distinguishes each lifecycle stage so
// Inactive and Discontinuing are visually loud, not just text.
function statusClass(s) {
  if (s === 'Active') return 'active';
  if (s === 'Introducing') return 'introducing';
  if (s === 'Discontinuing') return 'discontinuing';
  if (s === 'Inactive') return 'inactive';
  return '';
}

function renderSpec(p) {
  const fam = DATA.families[p.family_id] || {};
  const gloss = fam.glossary || {};
  const siblings = (DATA.siblings[p.family_id] || []).map(pn => PARTS_BY_NUM[pn]).filter(Boolean);

  // ---------- Image
  const imgHtml = p.image
    ? `<div class="spec-image"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.part_number)}"></div>`
    : `<div class="spec-image no-img">No image</div>`;

  // ---------- Header chips
  const finishPill = p.finish
    ? `<span class="spec-finish-pill">${escapeHtml(p.finish)} finish</span>`
    : '';
  const glossaryChip = gloss.name
    ? `<span class="spec-glossary-chip" title="Glossary category">${escapeHtml(gloss.name)}${gloss.abbr ? ` <span class="abbr">(${gloss.abbr})</span>` : ''}</span>`
    : '';

  // ---------- In-house processes — the operational tell (Powder Coat, Black
  // Batch, etc.). Pull from the part, falling back to the family. Most
  // important fact on the page after the title; render as bold pills.
  const inHouse = (p.in_house_processes || fam.in_house_processes || []).filter(Boolean);
  let inHouseHtml = '';
  if (inHouse.length) {
    const pills = inHouse.map(proc => `<span class="ihp-pill" data-proc="${escapeHtml(proc)}">${escapeHtml(proc)}</span>`).join('');
    inHouseHtml = `<div class="spec-ihp"><span class="spec-ihp-label">In-House</span><div class="spec-ihp-pills">${pills}</div></div>`;
  } else {
    // Explicit empty state — vendor-finished is a meaningful "no work needed"
    // signal, not absence of data.
    inHouseHtml = `<div class="spec-ihp spec-ihp-none"><span class="spec-ihp-label">In-House</span><span class="spec-ihp-empty">None — arrives ready from vendor</span></div>`;
  }

  // ---------- Key facts (4-up grid). Vendor + Lead Time + MOQ + Last Ordered
  // are the action-driving values; the rest of the legacy "Material / Reorder Qty"
  // group moves to the inline-tags strip below.
  const moqDisplay = (p.moq ?? p.reorder_qty);
  const moqLabel   = (p.moq != null) ? 'MOQ' : (p.reorder_qty != null ? 'Reorder qty' : 'MOQ');
  const keyFacts = [
    { label: 'Lead time',    val: p.lead_time },
    { label: moqLabel,       val: moqDisplay },
    { label: 'Vendor',       val: fam.vendor },
    { label: 'Last ordered', val: fmtDate(p.last_ordered), sub: p.last_ordered ? relTime(p.last_ordered) : null },
  ];
  const keyFactsHtml = keyFacts.map(q => {
    const empty = q.val == null || q.val === '';
    const val = empty ? '—' : escapeHtml(String(q.val));
    const sub = (!empty && q.sub) ? `<div class="keyfact-sub">${escapeHtml(q.sub)}</div>` : '';
    return `<div class="keyfact">
      <div class="keyfact-label">${escapeHtml(q.label)}</div>
      <div class="keyfact-val ${empty ? 'empty' : ''}">${val}</div>
      ${sub}
    </div>`;
  }).join('');

  // ---------- Demand block — always open, prominent. 2024 / 2025 / YoY.
  const u24 = p.use_2024 || 0;
  const u25 = p.use_2025 || 0;
  let deltaHtml = '';
  if (u24 > 0) {
    const pct = ((u25 - u24) / u24) * 100;
    const cls = pct > 5 ? 'up' : (pct < -5 ? 'down' : 'flat');
    const arrow = pct > 5 ? '↑' : (pct < -5 ? '↓' : '→');
    deltaHtml = `<div class="demand-cell">
      <div class="demand-label">Year over year</div>
      <div class="demand-yoy ${cls}">${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</div>
    </div>`;
  } else if (u25 > 0) {
    deltaHtml = `<div class="demand-cell">
      <div class="demand-label">Year over year</div>
      <div class="demand-yoy up">NEW</div>
    </div>`;
  }
  const demandHasData = u24 > 0 || u25 > 0;
  const demandHtml = `
    <section class="spec-section spec-demand">
      <header class="spec-section-head">
        <h3>Demand</h3>
        ${p.last_ordered ? `<span class="spec-section-aside">Last ordered ${escapeHtml(fmtDate(p.last_ordered))} · ${escapeHtml(relTime(p.last_ordered))}</span>` : ''}
      </header>
      <div class="demand-grid ${demandHasData ? '' : 'is-empty'}">
        <div class="demand-cell">
          <div class="demand-label">2024 usage</div>
          <div class="demand-val ${u24 ? '' : 'empty'}">${u24 ? u24.toLocaleString() : '0'}</div>
        </div>
        <div class="demand-cell">
          <div class="demand-label">2025 usage</div>
          <div class="demand-val ${u25 ? '' : 'empty'}">${u25 ? u25.toLocaleString() : '0'}</div>
        </div>
        ${deltaHtml}
      </div>
    </section>
  `;

  // ---------- Material / Raw-or-Pre-finished as small inline tag strip
  const tags = [];
  for (const m of (fam.materials || [])) tags.push({ kind: 'material', val: m });
  if (fam.raw_or_prefinished) tags.push({ kind: 'finish-state', val: fam.raw_or_prefinished });
  const tagsHtml = tags.length
    ? `<div class="spec-tags">${tags.map(t => `<span class="spec-tag" data-kind="${t.kind}">${escapeHtml(t.val)}</span>`).join('')}</div>`
    : '';

  // ---------- Siblings (same family)
  let siblingsHtml = '';
  if (siblings.length > 1) {
    const sibs = siblings.map(s => {
      const isCurrent = s.part_number === p.part_number;
      const img = s.image
        ? `<img src="${escapeHtml(s.image)}" alt="" loading="lazy">`
        : '<span style="font-size:9px;color:var(--muted)">—</span>';
      return `<a class="sibling${isCurrent ? ' is-current' : ''}" data-pn="${escapeHtml(s.part_number)}" href="#${encodeURIComponent(s.part_number)}">
        <div class="sibling-img">${img}</div>
        <div class="sibling-num">${escapeHtml(s.part_number)}</div>
        <div class="sibling-fin">${escapeHtml(s.finish || '—')}</div>
      </a>`;
    }).join('');
    siblingsHtml = `<section class="spec-section siblings">
      <header class="spec-section-head">
        <h3>Same family — ${siblings.length} variants</h3>
        <span class="spec-section-aside">Base <b>${escapeHtml(fam.part_number || '')}</b>${fam.description ? ' · ' + escapeHtml(fam.description) : ''}</span>
      </header>
      <div class="siblings-row">${sibs}</div>
    </section>`;
  }

  // ---------- Used In (collapsed by default — often dozens of products)
  const products = fam.products || [];
  const usedInHtml = products.length
    ? `<details class="spec-section spec-usedin">
        <summary class="spec-section-head">
          <h3>Used in <span class="spec-section-count">${products.length}</span></h3>
          <span class="spec-section-aside">Products that include this part family</span>
        </summary>
        <div class="product-grid">${products.map(prod => `
          <a class="product-card-mini" href="${escapeHtml(prod.url || '#')}" target="_blank" rel="noopener" title="${escapeHtml(prod.title || '')}">
            <span class="sku">${escapeHtml(prod.sku)}</span>
            <span class="title">${escapeHtml(prod.title || '—')}</span>
          </a>`).join('')}</div>
      </details>`
    : '';

  // ---------- Admin footer (faded). Last edited + Notion deep links.
  const adminBits = [];
  if (p.last_edited_at) adminBits.push(`Last edited ${escapeHtml(p.last_edited_at.split('T')[0])}`);
  if (p.page_url)   adminBits.push(`<a href="${escapeHtml(p.page_url)}" target="_blank" rel="noopener">Open part in Notion ↗</a>`);
  if (fam.page_url) adminBits.push(`<a href="${escapeHtml(fam.page_url)}" target="_blank" rel="noopener">Open family ↗</a>`);
  const adminHtml = adminBits.length
    ? `<footer class="spec-admin">${adminBits.join(' · ')}</footer>`
    : '';

  // ---------- Title + definition. Note: definition shows ONCE here, not in
  // a separate Notes panel. Glossary chip provides category context.
  const title = fam.description || 'Part';
  const definition = gloss.definition || fam.definition || '';

  const html = `
    <article class="spec-card">
      <button class="spec-back" type="button">← Back to all parts</button>

      <div class="spec-head">
        ${imgHtml}
        <div class="spec-summary">
          <div class="spec-num-row">
            <span class="spec-num">${escapeHtml(p.part_number)}</span>
            <span class="spec-status ${statusClass(p.status)}">${escapeHtml(p.status || 'Status unknown')}</span>
            ${finishPill}
            ${glossaryChip}
          </div>
          <h2 class="spec-title">${escapeHtml(title)}</h2>
          ${definition ? `<p class="spec-definition">${escapeHtml(definition)}</p>` : ''}
          ${inHouseHtml}
          <div class="spec-keyfacts">${keyFactsHtml}</div>
          ${tagsHtml}
        </div>
      </div>

      ${demandHtml}
      ${siblingsHtml}
      ${usedInHtml}
      ${adminHtml}
    </article>
  `;

  $('spec-slot').innerHTML = html;
  $('spec-slot').hidden = false;
  $('grid-slot').hidden = true;

  // wire — tabs are gone, just back button + siblings
  $('spec-slot').querySelector('.spec-back').onclick = backToBrowse;
  $('spec-slot').querySelectorAll('.sibling').forEach(a => {
    // Sibling click stays in place — the spec card is already on screen and
    // we just swap its contents.
    a.onclick = (e) => { e.preventDefault(); showPart(a.dataset.pn, { preserveScroll: true }); };
  });
}

function routeFromHash() {
  if (location.hash) {
    const pn = decodeURIComponent(location.hash.slice(1));
    if (PARTS_BY_NUM[pn]) {
      showPart(pn); return;
    }
  }
  // No hash: show browse grid
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
  if (DATA) renderGrid();
}

bootstrap();
