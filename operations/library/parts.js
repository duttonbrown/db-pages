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
  // Pull lighting/hardware counts so the sidebar shows them on parts.html too
  fetch('products-library.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(pl => {
      if (!pl) return;
      const navL = $('nav-lighting-count'); if (navL) navL.textContent = (pl.counts.lighting || 0).toLocaleString();
      const navH = $('nav-hardware-count'); if (navH) navH.textContent = (pl.counts.hardware || 0).toLocaleString();
    })
    .catch(() => {});

  renderGlossary();
  renderRecents();
  wireSearch();
  routeFromHash();

  window.addEventListener('hashchange', routeFromHash);
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

  // ---------- Header chips. Lives in the spec-num-row alongside the part #
  // so the reader gets finish, status, category and material on the same
  // line as the name. Saves a whole row vs. a separate tags strip below.
  const finishPill = p.finish
    ? `<span class="spec-finish-pill">${escapeHtml(p.finish)} finish</span>`
    : '';
  const glossaryChip = gloss.name
    ? `<span class="spec-glossary-chip" title="Glossary category">${escapeHtml(gloss.name)}${gloss.abbr ? ` <span class="abbr">(${gloss.abbr})</span>` : ''}</span>`
    : '';
  const materialChips = (fam.materials || []).filter(Boolean).map(m =>
    `<span class="spec-material-chip" title="Material">${escapeHtml(m)}</span>`
  ).join('');

  // ---------- Vendor takes the wide row above the keyfacts. (Was In-House.)
  // Vendor is the single-fact answer most people are after — render it big
  // and label-left, value-right like the old In-House strip.
  const vendorName = fam.vendor || '';
  const vendorHtml = vendorName
    ? `<div class="spec-ihp"><span class="spec-ihp-label">Vendor</span><div class="spec-ihp-pills"><span class="vendor-name">${escapeHtml(vendorName)}</span></div></div>`
    : `<div class="spec-ihp spec-ihp-none"><span class="spec-ihp-label">Vendor</span><span class="spec-ihp-empty">— not set</span></div>`;

  // ---------- In-house processes — moved into the keyfacts grid as a cell.
  // Pull from the part, falling back to the family. Render as bold pills
  // inside the cell. Empty state is "Vendor-finished" — meaningful info, not
  // absence of data.
  const inHouse = (p.in_house_processes || fam.in_house_processes || []).filter(Boolean);
  const inHousePills = inHouse.length
    ? inHouse.map(proc => `<span class="ihp-pill" data-proc="${escapeHtml(proc)}">${escapeHtml(proc)}</span>`).join('')
    : `<span class="keyfact-val empty">Vendor-finished</span>`;

  // ---------- Key facts. Lead Time / In-House / MOQ / Reorder Qty / Last Ordered.
  // The In-House cell renders pills via the `html` field; the other cells are
  // plain values via `val`.
  const keyFacts = [
    { label: 'Lead time',    val: p.lead_time },
    { label: 'In-House',     html: `<div class="keyfact-pills">${inHousePills}</div>` },
    { label: 'MOQ',          val: p.moq },
    { label: 'Reorder qty',  val: p.reorder_qty },
    { label: 'Last ordered', val: fmtDate(p.last_ordered), sub: p.last_ordered ? relTime(p.last_ordered) : null },
  ];
  const keyFactsHtml = keyFacts.map(q => {
    if (q.html) {
      return `<div class="keyfact">
        <div class="keyfact-label">${escapeHtml(q.label)}</div>
        ${q.html}
      </div>`;
    }
    const empty = q.val == null || q.val === '';
    const val = empty ? '—' : escapeHtml(String(q.val));
    const sub = (!empty && q.sub) ? `<div class="keyfact-sub">${escapeHtml(q.sub)}</div>` : '';
    return `<div class="keyfact">
      <div class="keyfact-label">${escapeHtml(q.label)}</div>
      <div class="keyfact-val ${empty ? 'empty' : ''}">${val}</div>
      ${sub}
    </div>`;
  }).join('');

  // ---------- Demand block — one tight horizontal line: 2024 → 2025 + YoY pill.
  const u24 = p.use_2024 || 0;
  const u25 = p.use_2025 || 0;
  const demandHasData = u24 > 0 || u25 > 0;

  let yoyPill = '';
  if (u24 > 0) {
    const pct = ((u25 - u24) / u24) * 100;
    const cls = pct > 5 ? 'up' : (pct < -5 ? 'down' : 'flat');
    const arrow = pct > 5 ? '↑' : (pct < -5 ? '↓' : '→');
    yoyPill = `<span class="demand-yoy ${cls}" title="Year over year">${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
  } else if (u25 > 0) {
    yoyPill = `<span class="demand-yoy up" title="No 2024 baseline">NEW</span>`;
  }

  const demandBody = demandHasData
    ? `<div class="demand-line">
         <span class="demand-pair">
           <span class="demand-year">2024</span>
           <span class="demand-num">${u24.toLocaleString()}</span>
         </span>
         <span class="demand-arrow" aria-hidden="true">→</span>
         <span class="demand-pair">
           <span class="demand-year">2025</span>
           <span class="demand-num is-current">${u25.toLocaleString()}</span>
         </span>
         ${yoyPill}
       </div>`
    : `<p class="demand-empty">No usage recorded for 2024 or 2025.</p>`;

  const demandHtml = `
    <section class="spec-section spec-demand">
      <header class="spec-section-head">
        <h3>Demand</h3>
        ${p.last_ordered ? `<span class="spec-section-aside">Last ordered ${escapeHtml(fmtDate(p.last_ordered))} · ${escapeHtml(relTime(p.last_ordered))}</span>` : ''}
      </header>
      ${demandBody}
    </section>
  `;

  // (Material moved into the header chip row above — saves a row of vertical
  // space that previously held a single tag.)

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

  // ---------- Used In. Compact two-line list (SKU on top, name beneath),
  // arranged in a multi-column flow — no boxes, no big gaps. Stays inside
  // a <details> so the section collapses if the user wants quiet.
  const products = fam.products || [];
  const usedInHtml = products.length
    ? `<details class="spec-section spec-usedin">
        <summary class="spec-section-head">
          <h3>Used in <span class="spec-section-count">${products.length}</span></h3>
        </summary>
        <ul class="product-list">${products.map(prod => `
          <li><a class="product-line" href="${escapeHtml(prod.url || '#')}" target="_blank" rel="noopener" title="${escapeHtml(prod.title || '')}">
            <span class="product-sku">${escapeHtml(prod.sku)}</span>
            <span class="product-title">${escapeHtml(prod.title || '—')}</span>
          </a></li>`).join('')}</ul>
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
      <button class="spec-back" type="button">Back to all parts</button>

      <div class="spec-head">
        ${imgHtml}
        <div class="spec-summary">
          <div class="spec-num-row">
            <span class="spec-num">${escapeHtml(p.part_number)}</span>
            <span class="spec-status ${statusClass(p.status)}">${escapeHtml(p.status || 'Status unknown')}</span>
            ${finishPill}
            ${materialChips}
            ${glossaryChip}
          </div>
          <h2 class="spec-title">${escapeHtml(title)}</h2>
          ${definition ? `<p class="spec-definition">${escapeHtml(definition)}</p>` : ''}
          ${vendorHtml}
          <div class="spec-keyfacts">${keyFactsHtml}</div>
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
