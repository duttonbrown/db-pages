// Parts Library — single-page app over parts-library.json.
//
// Optional config (set on window BEFORE this script runs) lets a gated copy of
// this page — e.g. the SSO-walled hub version in db-private — reuse this exact
// JS/CSS while loading data + images from the public db-pages origin and
// overlaying sensitive prices from a private file:
//   window.LIBRARY_CONFIG = {
//     base: 'https://duttonbrown.github.io/db-pages/operations/library/',
//     priceOverlay: 'parts-prices.json'   // same-origin (private) overlay
//   }
// When unset (the public page), everything resolves relative as before.
const LIBRARY_CONFIG = (typeof window !== 'undefined' && window.LIBRARY_CONFIG) || {};
const LIBRARY_BASE = LIBRARY_CONFIG.base || '';
// Prefix a relative library asset path (image or JSON) with the configured base.
const libUrl = (rel) => (rel && LIBRARY_BASE && !/^https?:|^data:/.test(rel)) ? LIBRARY_BASE + rel : rel;

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
let activeFamily = null;         // family_id filter (deep-linked via #family/<id>)
let activeProcesses = new Set(); // in-house process filters: 'Powder Coat', 'Black Batch', etc.
let attentionFilter = false;     // needs-attention lens (missing location/price, etc.)
let activeQuery = '';            // free-text term ALSO applied to the browse grid
let activeResultIdx = -1;
let currentPart = null;

// --- Shareable filter state in the URL hash ----------------------------------
// Every filter the page can be in is expressible as a link, so a prefiltered
// view can be pasted into Teams/Notion instead of described in words:
//   #proc=Black%20Batch          every Black Batch part
//   #q=globe&cat=Globe%20Cap     a search inside one category
//   #proc=Powder%20Coat,Black%20Batch   parts in BOTH (filters intersect)
// The two older routes still win when the hash carries no '=' :
//   #<PART_NUMBER>   opens that part's spec card
//   #family/<id>     one part family, all finish variants
// Nothing here re-fetches — parts-library.json is already in memory, so a
// filtered link costs exactly what the unfiltered page costs.
// `cat` is written as the category NAME (readable, hand-editable) but a raw
// glossary id is still accepted, so links minted before this read fine.
function syncHash() {
  if (!DATA) return;
  const parts = [];
  if (activeQuery) parts.push('q=' + encodeURIComponent(activeQuery));
  if (activeGlossary !== 'all') {
    const g = (DATA.glossary || []).find(x => x.id === activeGlossary);
    parts.push('cat=' + encodeURIComponent((g && g.name) || activeGlossary));
  }
  if (activeProcesses.size) {
    parts.push('proc=' + [...activeProcesses].map(encodeURIComponent).join(','));
  }
  if (attentionFilter) parts.push('attn=1');
  if (activeFamily) parts.push('family=' + encodeURIComponent(activeFamily));
  const hash = parts.length ? '#' + parts.join('&') : '';
  // replaceState never fires hashchange, so this cannot re-enter routeFromHash.
  history.replaceState(null, '', location.pathname + location.search + hash);
}

// Resolve a `cat=` value to a glossary id: exact id first, then case-insensitive
// name. Unknown values are dropped rather than left to render an empty grid a
// reader would read as "we don't stock any of those".
function glossaryIdFor(value) {
  if (!value || value === 'all') return 'all';
  const list = DATA.glossary || [];
  if (list.some(g => g.id === value)) return value;
  const want = value.trim().toLowerCase();
  const byName = list.find(g => (g.name || '').trim().toLowerCase() === want);
  return byName ? byName.id : 'all';
}

function partProcesses(p) {
  const fam = DATA.families[p.family_id];
  return (p.in_house_processes || (fam && fam.in_house_processes) || []).filter(Boolean);
}

// --- Location + Price helpers -------------------------------------------------

// A part can carry 0..N resolved location objects: {code, group, description,
// color, floor_plan}. Render each as a zone-colored pill — code is the loud
// bit, zone is the quiet context, full description sits in the tooltip. When a
// floor_plan PDF is known, the pill links to it so anyone can see where the
// code physically is. (Data is blank on every part today; this lights up the
// moment a Location is assigned in Notion.)
function locationPills(locations) {
  const locs = (locations || []).filter(l => l && l.code);
  if (!locs.length) return '';
  return locs.map(l => {
    const color = l.color || 'var(--muted)';
    const tip = [l.group, l.description].filter(Boolean).join(' — ');
    const inner = `<span class="loc-code">${escapeHtml(l.code)}</span>${l.group ? `<span class="loc-zone">${escapeHtml(l.group)}</span>` : ''}`;
    const style = `style="--loc-color:${escapeHtml(color)}"`;
    return l.floor_plan
      ? `<a class="loc-pill" ${style} href="${escapeHtml(libUrl(l.floor_plan))}" target="_blank" rel="noopener" title="${escapeHtml(tip)} · open floor plan ↗">${inner}</a>`
      : `<span class="loc-pill" ${style} title="${escapeHtml(tip)}">${inner}</span>`;
  }).join('');
}

// Money formatter for Price. Whole dollars when even, two decimals otherwise.
function fmtPrice(n) {
  if (n == null || n === '') return null;
  const num = Number(n);
  if (Number.isNaN(num)) return null;
  return num % 1 === 0
    ? `$${num.toLocaleString()}`
    : `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// One-line provenance under the Price keyfact: "as of Jun 2026 · high" plus a
// truncated source. Only rendered when the overlay carried provenance.
function priceProvenance(rec) {
  if (rec.price == null) return null;
  const bits = [];
  if (rec.price_as_of) {
    const d = new Date(rec.price_as_of + 'T00:00:00');
    if (!Number.isNaN(d.getTime())) {
      bits.push('as of ' + d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
    }
  }
  if (rec.price_confidence) bits.push(rec.price_confidence);
  const src = (rec.price_source || '').split('@')[0].trim();
  if (src) bits.push(src.length > 42 ? src.slice(0, 40) + '…' : src);
  return bits.length ? bits.join(' · ') : null;
}

// A part "needs attention" when it's an active/introducing SKU that's missing
// the operational data this library exists to surface — no storage location, or
// no price — or it's being discontinued while still showing real recent demand
// (someone should know before it disappears). Drives the data-quality lens.
function partNeedsAttention(p) {
  const status = p.status;
  if (status === 'Inactive') return false; // dead SKUs aren't worth nagging about
  const missingLocation = !(p.locations && p.locations.length);
  const missingPrice = p.price == null;
  const discontinuingButUsed = status === 'Discontinuing' && (p.use_2025 || 0) > 0;
  return missingLocation || missingPrice || discontinuingButUsed;
}

function clearFiltersIfShowingPart() {
  // The URL is rewritten by the syncHash() that follows every state change —
  // clearing it here too would briefly drop the filters out of the address bar.
  currentPart = null;
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
}

// Re-render everything that depends on filter state, then mirror it into the URL.
function applyFilters() {
  renderQuickFilters();
  renderGlossary();
  renderGrid();
  syncHash();
}

function toggleProcessFilter(proc) {
  if (activeProcesses.has(proc)) activeProcesses.delete(proc);
  else activeProcesses.add(proc);
  clearFiltersIfShowingPart();
  applyFilters();
}

function toggleAttention() {
  attentionFilter = !attentionFilter;
  clearFiltersIfShowingPart();
  applyFilters();
}

// --- Quick filters (prominent top pills) -------------------------------------
// Surfaces the two workflow-critical process filters (Powder Coat, Black Batch)
// plus the data-quality lens, all in one strip above the category chips. These
// reuse the same filter state as everything else, so toggling one here, on a
// grid card, or clearing it from the active-filter row all stay in sync.
function renderQuickFilters() {
  const row = $('quick-filter-row');
  if (!row || !DATA) return;

  // Count for a process pill = parts that would match if THIS process were the
  // only process filter added on top of the current glossary + attention state.
  const procCount = (proc) =>
    countWith({ processes: new Set([proc]) });

  const pills = [
    {
      key: 'Powder Coat', kind: 'process', label: 'Powder Coat',
      active: activeProcesses.has('Powder Coat'),
      count: procCount('Powder Coat'),
      cls: 'qf-powder',
    },
    {
      key: 'Black Batch', kind: 'process', label: 'Black Batch',
      active: activeProcesses.has('Black Batch'),
      count: procCount('Black Batch'),
      cls: 'qf-black',
    },
    // "Needs attention" lens removed 2026-06-17 (too noisy until location/price
    // data is populated). The plumbing — partNeedsAttention(), toggleAttention(),
    // attentionFilter, and the filteredParts/countWith/active-filter branches —
    // is left intact so it can be re-added here later by restoring this entry.
  ];

  row.innerHTML =
    `<span class="quick-filter-label">Quick filters</span>` +
    pills.map(p => {
      // The attention lens is a worklist: when nothing needs attention, show a
      // calm "All clear" instead of an orange button nagging at zero.
      const allClear = p.kind === 'attention' && p.count === 0 && !p.active;
      const cls = allClear ? `${p.cls} qf-clear` : p.cls;
      const label = allClear ? 'All clear' : p.label;
      const countHtml = allClear ? '<span class="qf-check">✓</span>' : `<span class="qf-count">${p.count}</span>`;
      return `
      <button type="button" class="quick-filter ${cls}${p.active ? ' is-active' : ''}"${allClear ? ' disabled' : ''}
              data-kind="${p.kind}" data-key="${escapeHtml(p.key)}"
              ${p.kind === 'attention' ? 'title="Active/Introducing parts missing a location or price, or discontinuing parts still in use"' : ''}>
        <span class="qf-label">${escapeHtml(label)}</span>
        ${countHtml}
      </button>`;
    }).join('');

  row.querySelectorAll('.quick-filter').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.kind === 'attention') toggleAttention();
      else toggleProcessFilter(btn.dataset.key);
    };
  });
}

// Merge the private price overlay onto DATA.parts/supplies when configured.
// The public JSON is REDACTED (no price fields as of 2026-07-22); the overlay
// is the ONLY price source for the gated copy. Values are either a bare number
// (legacy) or {price, as_of, confidence, source} (provenance-carrying, current
// shape) — handle both so a stale overlay never blanks the page.
async function applyPriceOverlay() {
  if (!LIBRARY_CONFIG.priceOverlay || !DATA) return;
  try {
    const resp = await fetch(LIBRARY_CONFIG.priceOverlay, { cache: 'no-store' });
    if (!resp.ok) return;
    const overlay = await resp.json();
    const pp = overlay.parts || {};
    const sp = overlay.supplies || {};
    const merge = (rec, entry) => {
      if (entry == null) return;
      if (typeof entry === 'number') { rec.price = entry; return; }
      rec.price = entry.price;
      rec.price_as_of = entry.as_of || null;
      rec.price_confidence = entry.confidence || null;
      rec.price_source = entry.source || null;
    };
    (DATA.parts || []).forEach(p => merge(p, pp[p.part_number]));
    (DATA.supplies || []).forEach(s => { if (s.sku) merge(s, sp[s.sku]); });
  } catch (e) {
    /* overlay is best-effort; the page works without prices */
  }
}

// --- Load and bootstrap ---
async function bootstrap() {
  try {
    const resp = await fetch(libUrl('parts-library.json'), { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    DATA = await resp.json();
    await applyPriceOverlay();
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

  // Sidebar counts — Parts/Supplies from this file, Lighting/Hardware from products
  $('parts-count').textContent = DATA.counts.parts.toLocaleString();
  const sideSuppliesCount = $('supplies-count');
  if (sideSuppliesCount) sideSuppliesCount.textContent = (DATA.counts.supplies || 0).toLocaleString();
  fetch(libUrl('products-library.json'), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(pl => {
      if (!pl) return;
      const lc = $('nav-lighting-count'); if (lc) lc.textContent = (pl.counts.lighting || 0).toLocaleString();
      const hc = $('nav-hardware-count'); if (hc) hc.textContent = (pl.counts.hardware || 0).toLocaleString();
    })
    .catch(() => {});
  $('lib-count').innerHTML = `<b>${DATA.counts.parts}</b> parts · <b>${DATA.counts.glossary}</b> categories`;
  renderQuickFilters();
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

// Count parts matching a hypothetical filter set — used to show accurate
// counts on each filter pill (the count reflects what'd remain if you
// removed *only* that one pill, i.e. all other active filters still apply).
function countWith(opts) {
  const glossary = opts.glossary != null ? opts.glossary : activeGlossary;
  const procs = opts.processes || activeProcesses;
  const attention = opts.attention != null ? opts.attention : attentionFilter;
  const query = (opts.query != null ? opts.query : activeQuery).toLowerCase();
  return DATA.parts.filter(p => {
    if (glossary !== 'all') {
      const fam = DATA.families[p.family_id];
      if (!fam || !fam.glossary || fam.glossary.id !== glossary) return false;
    }
    if (procs.size) {
      const pp = partProcesses(p);
      for (const wanted of procs) if (!pp.includes(wanted)) return false;
    }
    if (attention && !partNeedsAttention(p)) return false;
    if (query && !matchesQuery(p, query)) return false;
    return true;
  }).length;
}

function renderActiveFilter(entries) {
  const row = $('active-filter-row');
  if (!row) return;
  const pills = [];

  if (activeFamily) {
    const fam = DATA.families[activeFamily];
    pills.push({
      name: (fam && (fam.part_number || fam.description)) || 'Part family',
      count: filteredParts().length,
      kind: 'family',
      key: activeFamily,
    });
  }
  if (activeGlossary !== 'all') {
    const entry = entries.find(g => g.id === activeGlossary);
    if (entry) {
      pills.push({
        name: entry.name || '(unnamed)',
        count: countWith({}),
        kind: 'glossary',
        key: entry.id,
      });
    }
  }
  for (const proc of activeProcesses) {
    pills.push({
      name: proc,
      count: countWith({}),
      kind: 'process',
      key: proc,
    });
  }
  if (attentionFilter) {
    pills.push({
      name: 'Needs attention',
      count: countWith({}),
      kind: 'attention',
      key: 'attention',
    });
  }
  if (activeQuery) {
    // The search term is a real filter on the grid now, so it has to be
    // visible and clearable like every other one — otherwise arriving on a
    // #q= link looks like the library simply lost most of its parts.
    pills.push({
      name: `“${activeQuery}”`,
      count: countWith({}),
      kind: 'query',
      key: 'query',
    });
  }

  if (!pills.length) { row.classList.add('hidden'); row.innerHTML = ''; return; }
  row.classList.remove('hidden');
  row.innerHTML = `<span class="active-filter-label">Filter</span>` + pills.map(p => `
    <button type="button" class="active-filter-pill" data-kind="${escapeHtml(p.kind)}" data-key="${escapeHtml(p.key)}">
      <span class="afp-name">${escapeHtml(p.name)}</span>
      <span class="afp-count">${p.count}</span>
      <span class="afp-clear" aria-label="Clear filter">×</span>
    </button>
  `).join('');
  row.querySelectorAll('.active-filter-pill').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.kind === 'glossary') activeGlossary = 'all';
      else if (btn.dataset.kind === 'process') activeProcesses.delete(btn.dataset.key);
      else if (btn.dataset.kind === 'attention') attentionFilter = false;
      else if (btn.dataset.kind === 'family') activeFamily = null;
      else if (btn.dataset.kind === 'query') {
        activeQuery = '';
        $('search').value = '';
      }
      clearFiltersIfShowingPart();
      applyFilters();
    };
  });
}

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
  renderActiveFilter(entries);
  $('glossary').innerHTML = visible.map(g => {
    return `<button class="glossary-chip${g.id === activeGlossary ? ' is-active' : ''}" data-gid="${escapeHtml(g.id)}">${escapeHtml(g.name || '(unnamed)')} <span class="gc-count">${g.count}</span></button>`;
  }).join('');
  $('glossary').querySelectorAll('.glossary-chip').forEach(b => {
    b.onclick = () => {
      activeGlossary = b.dataset.gid;
      // The whole point of clicking a chip is "show me this category" — so
      // whatever's currently showing (grid OR spec card), switch back to the
      // grid filtered by this chip. Previously if you were viewing a part
      // the spec card stayed put and the click looked like a no-op.
      clearFiltersIfShowingPart();
      applyFilters();
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
  if (activeFamily) {
    list = list.filter(p => p.family_id === activeFamily);
  }
  if (activeGlossary !== 'all') {
    list = list.filter(p => {
      const fam = DATA.families[p.family_id];
      return fam && fam.glossary && fam.glossary.id === activeGlossary;
    });
  }
  if (activeProcesses.size) {
    list = list.filter(p => {
      const procs = partProcesses(p);
      // All active process filters must match (intersect, not union)
      for (const wanted of activeProcesses) {
        if (!procs.includes(wanted)) return false;
      }
      return true;
    });
  }
  if (attentionFilter) {
    list = list.filter(partNeedsAttention);
  }
  if (activeQuery) {
    const q = activeQuery.toLowerCase();
    list = list.filter(p => matchesQuery(p, q));
  }
  return list;
}

function renderGrid() {
  const list = filteredParts();
  if (!list.length) {
    $('grid-slot').innerHTML = `<div class="empty-grid">No parts match the current filter.${activeQuery ? ` Searching for “${escapeHtml(activeQuery)}”.` : ''}</div>`;
    return;
  }
  const html = list.map(p => previewCardHtml(p)).join('');
  $('grid-slot').innerHTML = `<div class="parts-grid">${html}</div>`;
  $('grid-slot').querySelectorAll('.preview-card').forEach(a => {
    a.onclick = (e) => {
      // Clicks on an in-house process pill toggle the filter instead of
      // opening the part — the pill is the affordance for filtering.
      const pill = e.target.closest('.ihp-pill[data-filter]');
      if (pill) {
        e.preventDefault();
        e.stopPropagation();
        toggleProcessFilter(pill.dataset.proc);
        return;
      }
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
    ? `<div class="preview-image"><img src="${escapeHtml(libUrl(p.image))}" alt="${escapeHtml(p.part_number)}" loading="lazy"></div>`
    : `<div class="preview-image no-img">No image</div>`;

  // In-house process pill stripe — drawn on top of the thumb so it's
  // instantly scannable (Powder Coat / Black Batch are workflow-critical).
  const inHouse = (p.in_house_processes || fam?.in_house_processes || []).filter(Boolean);
  const ihpStripe = inHouse.length
    ? `<div class="preview-ihp">${inHouse.map(proc => `<span class="ihp-pill${activeProcesses.has(proc) ? ' is-active' : ''}" data-proc="${escapeHtml(proc)}" data-filter="1">${escapeHtml(proc)}</span>`).join('')}</div>`
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
      <div class="preview-meta">
        ${finish}
        ${(p.locations && p.locations.length) ? `<span class="preview-loc" style="--loc-color:${escapeHtml(p.locations[0].color || 'var(--muted)')}" title="${escapeHtml([p.locations[0].group, p.locations[0].description].filter(Boolean).join(' — '))}">${escapeHtml(p.locations[0].code)}${p.locations.length > 1 ? ` +${p.locations.length - 1}` : ''}</span>` : ''}
      </div>
    </div>
  </a>`;
}

// --- Search ---
// The searchable text of a part, lowercased. ONE definition, shared by the
// typeahead dropdown and the grid filter — if they diverged, a #q= link would
// show a different set than typing the same term.
function queryFields(p) {
  const fam = DATA.families[p.family_id] || {};
  return {
    pn: p.part_number.toLowerCase(),
    desc: (fam.description || '').toLowerCase(),
    gloss: ((fam.glossary && fam.glossary.name) || '').toLowerCase(),
  };
}

function matchesQuery(p, q) {
  const f = queryFields(p);
  return f.pn.includes(q) || f.desc.includes(q) || f.gloss.includes(q);
}

function search(q) {
  q = q.toLowerCase().trim();
  if (!q) return [];
  const exact = [], prefix = [], contains = [], descMatch = [];
  for (const p of DATA.parts) {
    const { pn, desc, gloss } = queryFields(p);
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
      ? `<div class="lib-result-img"><img src="${escapeHtml(libUrl(p.image))}" alt="" loading="lazy"></div>`
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

// Typing narrows the GRID as well as opening the typeahead — the dropdown caps
// at 15 and is for jumping to a known part; the grid behind it is the browsable
// answer, and it's what a #q= link has to reproduce. Debounced because a
// keystroke can re-render up to ~470 cards.
let queryTimer = null;
function scheduleQueryFilter(value) {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    const next = value.trim();
    if (next === activeQuery) return;
    activeQuery = next;
    clearFiltersIfShowingPart();
    applyFilters();
  }, 200);
}

function wireSearch() {
  const inp = $('search');
  inp.addEventListener('input', () => {
    renderSearchResults(search(inp.value));
    scheduleQueryFilter(inp.value);
  });
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
  // showPart() empties the search box on the way in; put the term back so the
  // box agrees with the grid it's filtering (and with the URL).
  $('search').value = activeQuery;
  renderQuickFilters();
  renderGlossary();
  renderGrid();
  syncHash();
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
    ? `<div class="spec-image"><img src="${escapeHtml(libUrl(p.image))}" alt="${escapeHtml(p.part_number)}"></div>`
    : `<div class="spec-image no-img">No image</div>`;

  // ---------- Header chips. Lives in the spec-num-row alongside the part #.
  // Ordered: part type (glossary), Finish, Material — each labeled so the
  // reader doesn't have to guess what the value means.
  const glossaryChip = gloss.name
    ? `<span class="spec-glossary-chip" title="Glossary category">${escapeHtml(gloss.name)}${gloss.abbr ? ` <span class="abbr">(${gloss.abbr})</span>` : ''}</span>`
    : '';
  const finishPill = p.finish
    ? `<span class="spec-finish-pill"><span class="chip-label">Finish:</span> ${escapeHtml(p.finish)}</span>`
    : '';
  const materials = (fam.materials || []).filter(Boolean);
  const materialChips = materials.length
    ? `<span class="spec-material-chip" title="Material"><span class="chip-label">Material:</span> ${materials.map(escapeHtml).join(', ')}</span>`
    : '';

  // ---------- Vendor takes the wide row above the keyfacts. (Was In-House.)
  // Vendor is the single-fact answer most people are after — render it big
  // and label-left, value-right like the old In-House strip. Multiple
  // vendors stack on separate lines (vendor names contain commas, so a
  // single comma-joined string is unreadable).
  const vendorRaw = fam.vendor;
  const vendors = Array.isArray(vendorRaw)
    ? vendorRaw.filter(Boolean)
    : (vendorRaw ? [vendorRaw] : []);
  const vendorHtml = vendors.length
    ? `<div class="spec-ihp"><span class="spec-ihp-label">Vendor</span><div class="spec-vendor-list">${vendors.map(v => `<span class="vendor-name">${escapeHtml(v)}</span>`).join('')}</div></div>`
    : `<div class="spec-ihp spec-ihp-none"><span class="spec-ihp-label">Vendor</span><span class="spec-ihp-empty">— not set</span></div>`;

  // ---------- Location — "where to find it" on the floor. Zone-colored pills,
  // one per assigned location; empty state says "not set" honestly so the blank
  // data reads as a to-do, not a bug. Sits directly under Vendor (same wide
  // label-left row treatment) since "who makes it / where is it" pair up.
  const locPills = locationPills(p.locations);
  const locationHtml = locPills
    ? `<div class="spec-ihp"><span class="spec-ihp-label">Location</span><div class="spec-loc-list">${locPills}</div></div>`
    : `<div class="spec-ihp spec-ihp-none"><span class="spec-ihp-label">Location</span><span class="spec-ihp-empty">— not set</span></div>`;

  // ---------- In-house processes — moved into the keyfacts grid as a cell.
  // Pull from the part, falling back to the family. Render as bold pills
  // inside the cell. Empty state is "Vendor-finished" — meaningful info, not
  // absence of data.
  const inHouse = (p.in_house_processes || fam.in_house_processes || []).filter(Boolean);
  const inHousePills = inHouse.length
    ? inHouse.map(proc => `<button type="button" class="ihp-pill${activeProcesses.has(proc) ? ' is-active' : ''}" data-proc="${escapeHtml(proc)}" data-filter="1">${escapeHtml(proc)}</button>`).join('')
    : `<span class="keyfact-val empty">—</span>`;

  // ---------- Key facts. Lead Time / In-House / MOQ / Reorder Qty / Last Ordered.
  // The In-House cell renders pills via the `html` field; the other cells are
  // plain values via `val`.
  const keyFacts = [
    { label: 'Price',        val: fmtPrice(p.price), sub: priceProvenance(p) },
    { label: 'Lead time',    val: p.lead_time },
    { label: 'Last ordered', val: fmtDate(p.last_ordered), sub: p.last_ordered ? relTime(p.last_ordered) : null },
    { label: 'MOQ',          val: p.moq },
    { label: 'Reorder qty',  val: p.reorder_qty },
    { label: 'In-House',     html: `<div class="keyfact-pills">${inHousePills}</div>` },
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
        ? `<img src="${escapeHtml(libUrl(s.image))}" alt="" loading="lazy">`
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
            ${glossaryChip}
            ${finishPill}
            ${materialChips}
          </div>
          <h2 class="spec-title">${escapeHtml(title)}</h2>
          ${definition ? `<p class="spec-definition">${escapeHtml(definition)}</p>` : ''}
          ${vendorHtml}
          ${locationHtml}
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

  // wire — tabs are gone, just back button + siblings + process-filter pills
  $('spec-slot').querySelector('.spec-back').onclick = backToBrowse;
  $('spec-slot').querySelectorAll('.ihp-pill[data-filter]').forEach(btn => {
    btn.onclick = () => toggleProcessFilter(btn.dataset.proc);
  });
  $('spec-slot').querySelectorAll('.sibling').forEach(a => {
    // Sibling click stays in place — the spec card is already on screen and
    // we just swap its contents.
    a.onclick = (e) => { e.preventDefault(); showPart(a.dataset.pn, { preserveScroll: true }); };
  });
}

function routeFromHash() {
  const rawHash = location.hash.slice(1);

  // Filter-state form — anything carrying '='. Checked first because a part
  // number never contains one, so the two older routes below stay reachable.
  if (rawHash.includes('=')) {
    const params = new URLSearchParams(rawHash);
    activeQuery = (params.get('q') || '').trim();
    activeGlossary = glossaryIdFor(params.get('cat'));
    activeProcesses = new Set(
      (params.get('proc') || '').split(',').map(s => s.trim()).filter(Boolean)
    );
    attentionFilter = params.get('attn') === '1';
    const fam = params.get('family');
    activeFamily = (fam && DATA && DATA.families && DATA.families[fam]) ? fam : null;
    currentPart = null;
    $('search').value = activeQuery;
    // A reload can restore a stale value into the box and pop the typeahead
    // open before we get here; the grid is the answer for a filter link.
    $('results').hidden = true;
    $('spec-slot').hidden = true;
    $('grid-slot').hidden = false;
    renderQuickFilters();
    renderGlossary();
    renderGrid();
    // Rewrite rather than trust the incoming string: a hand-typed cat name or a
    // dropped param normalizes to the canonical link the user can copy back out.
    syncHash();
    return;
  }

  if (location.hash) {
    const raw = decodeURIComponent(rawHash);
    // #family/<family_id> — show the grid filtered to one part family (all
    // finish variants). Deep-linked from the production wash list so a part
    // code opens its whole family.
    if (raw.startsWith('family/')) {
      const fid = raw.slice('family/'.length);
      if (DATA && DATA.families && DATA.families[fid]) {
        activeFamily = fid;
        currentPart = null;
        $('spec-slot').hidden = true;
        $('grid-slot').hidden = false;
        renderActiveFilter(DATA.glossary);
        renderGrid();
        return;
      }
    }
    if (PARTS_BY_NUM[raw]) {
      activeFamily = null;
      showPart(raw); return;
    }
  }
  // No hash: the unfiltered browse grid. Every filter now lives in the URL, so
  // a bare address has to mean a bare page — leaving stale filters in memory
  // would make the link the user just pasted show something else.
  activeFamily = null;
  activeQuery = '';
  activeGlossary = 'all';
  activeProcesses = new Set();
  attentionFilter = false;
  currentPart = null;
  const inp = $('search');
  if (inp) inp.value = '';
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
  if (DATA) { renderQuickFilters(); renderGlossary(); renderGrid(); }
}

bootstrap();
