// Products Library — sibling of parts.js for Lighting + Hardware.
// Single-page app over products-library.json.

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Cross-origin base, mirrors parts.js. The gated hub copy of this page sets
//   window.LIBRARY_CONFIG = { base: 'https://duttonbrown.github.io/db-pages/operations/library/' }
// so the same-origin (public) page is untouched (base '' → libUrl is a no-op),
// while the gated page resolves the data JSON against the public origin. Product
// images are already absolute Shopify CDN URLs, so libUrl only rewrites the
// relative data fetches; it leaves http(s)/data URLs alone.
//
// The gated copy ALSO sets `costOverlay: 'products-costing.json'` — a same-origin
// file in db-private carrying material cost, assembly minutes, labor and margin.
// Exactly the arrangement parts.js has with `parts-prices.json`, and for the same
// reason: db-pages is public GitHub Pages, and what a fixture costs us and how
// long it takes to build are not public facts. The public page renders without
// those sections and is never told they exist.
const LIBRARY_CONFIG = (typeof window !== 'undefined' && window.LIBRARY_CONFIG) || {};
const LIBRARY_BASE = LIBRARY_CONFIG.base || '';
const libUrl = (rel) => (rel && LIBRARY_BASE && !/^https?:|^data:/.test(rel)) ? LIBRARY_BASE + rel : rel;

let DATA = null;
let COSTING = {};          // handle -> {assembly…, cost…, margin…, shipping}
let COSTING_META = null;   // {generated, labor_rate, dim_divisor}
let CONTENT = {};          // handle -> SharePoint Content folder webUrl
let BY_HANDLE = {};
let CURRENT = null;
let activeBucket = 'lighting';    // 'lighting' | 'hardware'
let activeType = 'all';
let activeConfig = null;          // a configuration_options value, or null = any
let activeResultIdx = -1;

// ---------------------------------------------------------------- bootstrap

// Merge the private costing overlay. Best-effort by design — if the file is
// missing, stale or unreadable, the page renders exactly as the public one does
// rather than breaking. Built by
// db-operations/projects/inventory-valuation/build_product_facts.py.
async function applyCostOverlay() {
  if (!LIBRARY_CONFIG.costOverlay) return;
  try {
    const resp = await fetch(LIBRARY_CONFIG.costOverlay, { cache: 'no-store' });
    if (!resp.ok) return;
    const o = await resp.json();
    COSTING = o.products || {};
    COSTING_META = {
      generated: o.generated || null,
      labor_rate: o.labor_rate || null,
      dim_divisor: o.dim_divisor || 192,
    };
  } catch (e) {
    /* overlay is optional; the page works without it */
  }
}

// Merge the private content-library overlay: handle -> the product's folder in
// SharePoint 30_assets/Content (photos, renders, video). Same best-effort shape
// as the costing overlay — the public page is never told it exists, and a
// missing file just means no link. Built by
// db-operations/projects/onedrive-reorg/content_library_sync.py.
//
// Keyed by handle, not SKU, deliberately: matching a listing to its folder
// needs the H / (C) / size-variant rules in sku_family.py, and that resolution
// happens in the generator so this page never has to know the SKU scheme.
async function applyContentOverlay() {
  if (!LIBRARY_CONFIG.contentOverlay) return;
  try {
    const resp = await fetch(LIBRARY_CONFIG.contentOverlay, { cache: 'no-store' });
    if (!resp.ok) return;
    const o = await resp.json();
    CONTENT = o.by_handle || {};
  } catch (e) {
    /* overlay is optional; the page works without it */
  }
}

async function bootstrap() {
  try {
    const resp = await fetch(libUrl('products-library.json'), { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    DATA = await resp.json();
  } catch (e) {
    $('grid-slot').innerHTML = `<div class="empty-grid">Failed to load library: ${escapeHtml(e.message)}</div>`;
    return;
  }

  DATA.products.forEach(p => { BY_HANDLE[p.handle] = p; });

  // Awaited, not fired-and-forgotten: routeFromHash() below can open a spec
  // card immediately on a deep link, and a card rendered before the overlay
  // lands would silently omit the cost sections with no way to notice.
  await applyCostOverlay();
  await applyContentOverlay();

  // Sidebar counts — also fetch the parts library so all 4 tabs show counts
  $('lighting-count').textContent = (DATA.counts.lighting || 0).toLocaleString();
  $('hardware-count').textContent = (DATA.counts.hardware || 0).toLocaleString();
  fetch(libUrl('parts-library.json'), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(pl => {
      if (!pl) return;
      $('parts-count').textContent = (pl.counts.parts || 0).toLocaleString();
      $('supplies-count').textContent = (pl.counts.supplies || 0).toLocaleString();
    })
    .catch(() => {});

  renderRecents();
  wireSearch();
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('search')) {
      e.preventDefault(); $('search').focus(); $('search').select();
    }
  });
  window.addEventListener('hashchange', routeFromHash);
  routeFromHash();
  applyQueryDeepLink();
}

// A SKU clicked elsewhere in the hub (the jobs board's Job Summary, a traveler)
// arrives here as ?q=30223. The page used to ignore it entirely: you clicked a
// number and landed on a cold library, then retyped the number you just
// clicked. Prefill the box, and when the query resolves to a single fixture,
// open it outright. A #hash wins — it names one product; ?q= is only a search.
function applyQueryDeepLink() {
  if (location.hash) return;
  let q = '';
  try { q = (new URLSearchParams(location.search).get('q') || '').trim(); }
  catch { return; }
  if (!q) return;
  const inp = $('search');
  inp.value = q;
  const hits = search(q);
  const ql = q.toLowerCase();
  const exact = hits.filter(p =>
    (p.bom_parent_sku || '').toLowerCase() === ql ||
    (p.title || '').toLowerCase() === ql ||
    (p.handle || '').toLowerCase() === ql ||
    (p.variants || []).some(v => (v.sku || '').toLowerCase() === ql));
  const only = exact.length === 1 ? exact[0] : (hits.length === 1 ? hits[0] : null);
  if (only) { location.hash = '#' + encodeURIComponent(only.handle); return; }
  renderSearchResults(hits);
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

// ---------------------------------------------------------------- routing

function routeFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  // Routes:
  //   #lighting               -> grid filtered to lighting
  //   #hardware               -> grid filtered to hardware
  //   #color-bianca-sconce-20 -> spec view for that handle
  //   #<type>/lighting        -> not used; types are chips in the strip
  if (BY_HANDLE[hash]) {
    activeBucket = BY_HANDLE[hash].bucket === 'hardware' ? 'hardware' : 'lighting';
    activeType = 'all';
    syncTabActive();
    showProduct(hash);
    return;
  }
  if (hash === 'hardware') {
    activeBucket = 'hardware';
  } else {
    // default lighting
    activeBucket = 'lighting';
  }
  activeType = 'all';
  activeConfig = null;
  CURRENT = null;
  syncTabActive();
  renderTypeFilters();
  renderConfigFilters();
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
  updateLead();
  renderGrid();
}

function syncTabActive() {
  document.querySelectorAll('.side-nav-tab').forEach(a => a.removeAttribute('aria-current'));
  const t = document.querySelector(`.side-nav-tab[data-tab="${activeBucket}"]`);
  if (t) t.setAttribute('aria-current', 'page');
}

function updateLead() {
  const lead = $('page-lead'), sub = $('page-sub');
  if (activeBucket === 'hardware') {
    lead.textContent = 'Hardware Library';
    sub.textContent  = 'Pulls, knobs, hooks — assembly, BOM, finishes, downloads, and ship metrics.';
  } else {
    lead.textContent = 'Lighting Library';
    sub.textContent  = 'Sconces, pendants, chandeliers, flush mounts — assembly diagram, wire lengths, BOM, canopy kit, and sales.';
  }
  const c = DATA.counts;
  const total = activeBucket === 'hardware' ? c.hardware : c.lighting;
  $('lib-count').innerHTML = `<b>${total}</b> ${activeBucket === 'hardware' ? 'hardware items' : 'lighting fixtures'}`;
}

// ---------------------------------------------------------------- recents

function loadRecents() {
  try { return JSON.parse(localStorage.getItem('db-products-recents') || '[]'); }
  catch { return []; }
}
function pushRecent(h) {
  let r = loadRecents().filter(x => x !== h);
  r.unshift(h);
  r = r.slice(0, 6);
  localStorage.setItem('db-products-recents', JSON.stringify(r));
  renderRecents();
}
function renderRecents() {
  const r = loadRecents().filter(h => BY_HANDLE[h]);
  const row = $('recents-row');
  const chips = $('recents-chips');
  if (!r.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  chips.innerHTML = r.map(h => {
    const p = BY_HANDLE[h];
    return `<button class="recents-chip" data-h="${escapeHtml(h)}">${escapeHtml(p.title)}</button>`;
  }).join(' ');
  chips.querySelectorAll('.recents-chip').forEach(b => {
    b.onclick = () => { location.hash = '#' + encodeURIComponent(b.dataset.h); };
  });
}

// ---------------------------------------------------------------- type filters

function renderTypeFilters() {
  // Show only the types that belong to the active bucket
  const counts = {};
  DATA.products.forEach(p => {
    if (p.bucket !== activeBucket) return;
    counts[p.type] = (counts[p.type] || 0) + 1;
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const entries = [{ id: 'all', name: 'All', count: total }]
    .concat(Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      .map(t => ({ id: t, name: t, count: counts[t] })));
  $('type-filters').innerHTML = entries.map(e => {
    const cls = `glossary-chip${activeType === e.id ? ' is-active' : ''}`;
    return `<button class="${cls}" data-type="${escapeHtml(e.id)}">${escapeHtml(e.name)} <span class="gc-count">${e.count}</span></button>`;
  }).join('');
  $('type-filters').querySelectorAll('[data-type]').forEach(b => {
    b.onclick = () => {
      activeType = b.dataset.type;
      if (CURRENT) {
        CURRENT = null;
        history.replaceState(null, '', '#' + activeBucket);
      }
      $('spec-slot').hidden = true;
      $('grid-slot').hidden = false;
      renderTypeFilters();
      renderConfigFilters();
      renderGrid();
    };
  });
}

// ------------------------------------------------------------ config filters
//
// A secondary, data-driven facet over the variant "Configuration" axis:
//   sconces -> Hardwired (no switch) / Hardwired with dimmer switch
//   hanging -> Flat ceiling / Sloped ceiling (add hang-straight)
// Chips are built from whatever configuration_options exist in the active
// bucket + type view — no hardcoded labels. The row hides itself when the
// current view has no configurable products (e.g. Hardware).
function renderConfigFilters() {
  const host = $('config-filters');
  if (!host) return;
  // Options present in the current bucket (+ type, if one is picked), so the
  // chips always reflect a non-empty result.
  const counts = {};
  DATA.products.forEach(p => {
    if (p.bucket !== activeBucket) return;
    if (activeType !== 'all' && p.type !== activeType) return;
    (p.configuration_options || []).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  });
  const values = Object.keys(counts);
  // If the active chip is no longer valid in this view, drop it.
  if (activeConfig && !counts[activeConfig]) activeConfig = null;
  if (!values.length) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  // Stable, readable order: hardwired/ceiling groupings sort naturally.
  values.sort((a, b) => a.localeCompare(b));
  const chips = [{ id: null, name: 'Any config', count: 0 }]
    .concat(values.map(v => ({ id: v, name: v, count: counts[v] })));
  host.innerHTML = chips.map(c => {
    const on = (c.id === activeConfig) || (c.id === null && !activeConfig);
    const cls = `glossary-chip config-chip${on ? ' is-active' : ''}`;
    const cnt = c.id === null ? '' : ` <span class="gc-count">${c.count}</span>`;
    return `<button class="${cls}" data-config="${escapeHtml(c.id == null ? '' : c.id)}">${escapeHtml(c.name)}${cnt}</button>`;
  }).join('');
  host.querySelectorAll('[data-config]').forEach(b => {
    b.onclick = () => {
      activeConfig = b.dataset.config || null;
      if (CURRENT) { CURRENT = null; history.replaceState(null, '', '#' + activeBucket); }
      $('spec-slot').hidden = true;
      $('grid-slot').hidden = false;
      renderConfigFilters();
      renderGrid();
    };
  });
}

// ---------------------------------------------------------------- grid

function filtered() {
  let list = DATA.products.filter(p => p.bucket === activeBucket);
  if (activeType !== 'all') list = list.filter(p => p.type === activeType);
  if (activeConfig) list = list.filter(p => (p.configuration_options || []).includes(activeConfig));
  return list;
}

function renderGrid() {
  const list = filtered();
  if (!list.length) {
    $('grid-slot').innerHTML = `<div class="empty-grid">No products match this filter.</div>`;
    return;
  }
  const html = list.map(cardHtml).join('');
  $('grid-slot').innerHTML = `<div class="parts-grid">${html}</div>`;
  $('grid-slot').querySelectorAll('.preview-card').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      location.hash = '#' + encodeURIComponent(a.dataset.h);
    };
  });
}

function cardHtml(p) {
  const imgHtml = p.image
    ? `<div class="preview-image"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.image_alt || p.title)}" loading="lazy"></div>`
    : `<div class="preview-image no-img">No image</div>`;

  // QC-relevant flags only. UL is in the spec card; not surfaced on tile.
  // Sales pill is the loudest signal for a QC person — quick read on demand.
  const flags = [];
  if (p.has_canopy_kit)               flags.push(`<span class="preview-flag canopy" title="Canopy kit included">Canopy</span>`);
  if ((p.color_options || []).length) flags.push(`<span class="preview-flag colors" title="${p.color_options.length} color options">${p.color_options.length} colors</span>`);
  const total25 = p.sales_2025_units || 0;
  if (total25 > 0)                    flags.push(`<span class="preview-flag sales" title="2025 units sold">${total25.toLocaleString()} sold '25</span>`);
  const flagsHtml = flags.length ? `<div class="preview-flags">${flags.join('')}</div>` : '';

  let statusFlag = '';
  if (p.status && p.status !== 'active') {
    statusFlag = `<div class="preview-status-flag inactive">${escapeHtml(p.status)}</div>`;
  }
  const cardCls = p.status && p.status !== 'active' ? 'preview-card is-inactive' : 'preview-card';

  return `<a class="${cardCls}" data-h="${escapeHtml(p.handle)}" href="#${encodeURIComponent(p.handle)}">
    ${imgHtml}
    ${statusFlag}
    <div class="preview-body">
      <div class="preview-num" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
      <div class="preview-meta-row">
        <span class="preview-type">${escapeHtml(p.type)}</span>
      </div>
      ${flagsHtml}
    </div>
  </a>`;
}

// ---------------------------------------------------------------- search

function search(q) {
  q = q.toLowerCase().trim();
  if (!q) return [];
  const exact = [], prefix = [], contains = [], other = [];
  const pool = DATA.products;  // search across both buckets
  for (const p of pool) {
    const title = (p.title || '').toLowerCase();
    const handle = (p.handle || '').toLowerCase();
    const tags = (p.tags || []).join(' ').toLowerCase();
    const type = (p.type || '').toLowerCase();
    const skus = (p.variants || []).map(v => v.sku.toLowerCase()).join(' ');
    // The parent SKU is what the rest of the business calls a fixture (jobs
    // board, travelers, BOM Master all say "30223"), but it isn't any variant's
    // SKU — without it, typing the number people actually use only ever scored
    // as a substring match.
    const parent = (p.bom_parent_sku || '').toLowerCase();
    const hay = `${title} ${handle} ${tags} ${type} ${skus} ${parent}`;
    if (title === q || parent === q || skus.split(' ').includes(q)) exact.push(p);
    else if (title.startsWith(q) || handle.startsWith(q)) prefix.push(p);
    else if (hay.includes(q)) contains.push(p);
    else if (type.includes(q)) other.push(p);
  }
  return [...exact, ...prefix, ...contains, ...other].slice(0, 18);
}

function renderSearchResults(items) {
  const box = $('results');
  if (!items.length) {
    box.hidden = true; box.classList.remove('open'); return;
  }
  box.innerHTML = items.map((p, i) => {
    const img = p.image
      ? `<div class="lib-result-img"><img src="${escapeHtml(p.image)}" alt="" loading="lazy"></div>`
      : `<div class="lib-result-img no-img">—</div>`;
    return `<li class="lib-result" data-h="${escapeHtml(p.handle)}" data-idx="${i}">
      ${img}
      <div class="lib-result-text">
        <div class="lib-result-num">${escapeHtml(p.title)}</div>
        <div class="lib-result-desc">${escapeHtml(p.type)} · ${p.variant_count} variants${p.price ? ` · $${escapeHtml(p.price)}` : ''}</div>
      </div>
      <div class="lib-result-meta">${escapeHtml(p.bucket)}</div>
    </li>`;
  }).join('');
  box.hidden = false; box.classList.add('open');
  activeResultIdx = -1;
  box.querySelectorAll('.lib-result').forEach(el => {
    el.onclick = () => { location.hash = '#' + encodeURIComponent(el.dataset.h); };
  });
}

function wireSearch() {
  const inp = $('search');
  inp.addEventListener('input', () => renderSearchResults(search(inp.value)));
  inp.addEventListener('focus', () => { if (inp.value) renderSearchResults(search(inp.value)); });
  inp.addEventListener('keydown', (e) => {
    const items = $('results').querySelectorAll('.lib-result');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeResultIdx = (activeResultIdx + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeResultIdx = (activeResultIdx - 1 + items.length) % items.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const tgt = activeResultIdx >= 0 ? items[activeResultIdx] : items[0];
      location.hash = '#' + encodeURIComponent(tgt.dataset.h);
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
}

// ---------------------------------------------------------------- spec card

function showProduct(handle) {
  const p = BY_HANDLE[handle];
  if (!p) return;
  CURRENT = p;
  pushRecent(handle);
  $('search').value = '';
  $('results').hidden = true;
  history.replaceState(null, '', '#' + encodeURIComponent(handle));
  renderSpec(p);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

// QC-focused spec view. The product listing on duttonbrown.com is the
// customer view — this is the SHOP view. Everything here is meant to help
// a builder/QC person know how the fixture is made: hero image, assembly
// diagram, wire lengths, parts list, extension rods, canopy configurations,
// testing notes, and 2024/2025 sales.

function renderSpec(p) {
  // ---- Hero (one main image, no gallery scroll — we want the assembly
  // diagram to be the second visual)
  const heroSrc = p.image;
  const heroHtml = heroSrc
    ? `<div class="spec-image"><img src="${escapeHtml(heroSrc)}" alt="${escapeHtml(p.image_alt || p.title)}"></div>`
    : `<div class="spec-image no-img">No image</div>`;

  const skuLabel = p.bom_parent_sku || (p.variants[0] && p.variants[0].sku) || p.handle;
  const statusCls = p.status === 'active' ? 'active' : 'inactive';
  const statusLabel = p.status === 'active' ? 'Active' : (p.status || 'Unknown');
  const certShort = shortCert(p.certification);
  const certPill = certShort
    ? `<span class="spec-finish-pill cert-yes" title="${escapeHtml(p.certification)}">${escapeHtml(certShort)}</span>`
    : '';

  // ---- Configuration options (variant axis): hardwired-switch choice on
  // sconces, ceiling choice on hanging fixtures. Rendered as its own labelled
  // pill row so the longer ceiling strings read cleanly.
  const cfg = p.configuration_options || [];
  const configHtml = cfg.length ? `
    <div class="spec-config-row">
      <span class="spec-config-label">Configuration</span>
      <span class="spec-config-pills">${cfg.map(v =>
        `<span class="spec-config-pill">${escapeHtml(v)}</span>`).join('')}</span>
    </div>` : '';

  // ---- QC quality strip — the things a builder needs at a glance
  const quality = qualityCells(p);
  const qualityHtml = `<div class="product-quality">${quality.map(q => `
    <div class="quality-cell">
      <div class="quality-label">${escapeHtml(q.label)}</div>
      <div class="quality-val ${q.empty ? 'empty' : ''} ${q.cls || ''}">${q.empty ? '—' : escapeHtml(q.val)}</div>
      ${q.sub ? `<div class="quality-sub">${escapeHtml(q.sub)}</div>` : ''}
    </div>`).join('')}</div>`;

  // ---- CTAs (open BOM in Notion + live product page + content folder)
  const contentUrl = CONTENT[p.handle];
  const ctaRow = `
    <div class="product-cta-row">
      ${p.bom_page_url ? `<a class="product-cta" href="${escapeHtml(p.bom_page_url)}" target="_blank" rel="noopener">Open BOM in Notion <span class="product-cta-icon">↗</span></a>` : ''}
      ${contentUrl ? `<a class="product-cta secondary" href="${escapeHtml(contentUrl)}" target="_blank" rel="noopener">Photos &amp; renders <span class="product-cta-icon">↗</span></a>` : ''}
      <a class="product-cta secondary" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Customer-facing page <span class="product-cta-icon">↗</span></a>
    </div>
  `;

  // ---- Sales section — 2024 vs 2025 totals, units + revenue
  const salesSection = renderSales(p);

  // ---- Build & cost, then how it ships. Both render only on the gated copy
  // (they need the private overlay) and both sit right under Sales: what it
  // sells for and what it costs to build belong in one eyeline.
  const costSection = renderCost(p);
  const shippingSection = renderShipping(p);

  // ---- Assembly diagrams / downloads — assembly diagram and tearsheet
  // are the visual references a QC person reaches for first.
  const diagramsSection = renderDiagrams(p);

  // ---- QC callouts: wire lengths, extension rods, canopy configurations
  const qcSection = renderQcCallouts(p);

  // ---- Full BOM (grouped by section, canopy highlighted, parts link to parts.html)
  const bomSection = renderBomTree(p);

  // ---- Variant SKU summary (compact — finish/color combinations only)
  const variantsSection = renderVariantsCompact(p);

  // ---- Admin footer
  const adminBits = [];
  if (p.bom_last_edited_at) adminBits.push(`BOM edited ${escapeHtml(p.bom_last_edited_at.split('T')[0])}`);
  if (DATA.generated_at) adminBits.push(`Library updated ${escapeHtml(DATA.generated_at.split('T')[0])}`);
  if (p.bom_page_url) adminBits.push(`<a href="${escapeHtml(p.bom_page_url)}" target="_blank" rel="noopener">BOM page ↗</a>`);
  if (contentUrl) adminBits.push(`<a href="${escapeHtml(contentUrl)}" target="_blank" rel="noopener">Content folder ↗</a>`);
  adminBits.push(`<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Customer page ↗</a>`);
  const adminHtml = `<footer class="spec-admin">${adminBits.join(' · ')}</footer>`;

  // ---- Compose
  const html = `
    <article class="spec-card product-spec">
      <button class="spec-back" type="button">← Back to ${escapeHtml(activeBucket === 'hardware' ? 'hardware' : 'lighting')}</button>

      <div class="spec-head">
        <div>
          ${heroHtml}
        </div>
        <div class="spec-summary">
          <div class="spec-num-row">
            <span class="spec-num">${escapeHtml(skuLabel)}</span>
            <span class="spec-status ${statusCls}">${escapeHtml(statusLabel)}</span>
            ${certPill}
            <span class="spec-finish-pill">${escapeHtml(p.type)}</span>
          </div>
          <h2 class="spec-title">${escapeHtml(p.title)}</h2>
          ${ctaRow}
          ${configHtml}
          ${qualityHtml}
        </div>
      </div>

      ${salesSection}
      ${costSection}
      ${shippingSection}
      ${diagramsSection}
      ${qcSection}
      ${bomSection}
      ${variantsSection}
      ${adminHtml}
    </article>
  `;

  $('spec-slot').innerHTML = html;
  $('spec-slot').hidden = false;
  $('grid-slot').hidden = true;

  $('spec-slot').querySelector('.spec-back').onclick = () => {
    history.replaceState(null, '', '#' + activeBucket);
    routeFromHash();
  };
}

function qualityCells(p) {
  // QC-relevant facts only. Marketing fields (style, bulb temperature,
  // hanging height for the customer) are NOT here — they're on the listing.
  const cells = [];
  cells.push({ label: 'Lead time',  val: p.lead_time, empty: !p.lead_time });
  cells.push({
    label: 'Certification',
    val: shortCert(p.certification),
    empty: !p.certification,
    cls: /UL\s*listed/i.test(p.certification || '') ? 'cert-yes' : '',
  });
  if (p.bucket === 'lighting') {
    cells.push({ label: 'Mounting', val: prettySlug(p.mounting_type), empty: !p.mounting_type });
    cells.push({ label: 'Socket',   val: p.socket_type,                empty: !p.socket_type });
  } else {
    cells.push({ label: 'Finish',   val: prettySlug(p.hardware_finish), empty: !p.hardware_finish });
    cells.push({ label: 'Material', val: prettySlug(p.handle_material), empty: !p.handle_material });
  }
  cells.push({ label: 'Variants',  val: String(p.variant_count), empty: !p.variant_count });
  cells.push({
    label: 'BOM parts',
    val: p.parts_total ? String(p.parts_total) : '',
    empty: !p.parts_total,
    sub: p.has_canopy_kit ? 'Incl. canopy kit' : '',
  });
  // Pre-test flag — fixtures with "Extension Rods Assembled Prior to Testing"
  // need to be bench-tested before ship.
  if (p.qc && p.qc.needs_pre_test) {
    cells.push({ label: 'Pre-test', val: 'Required', cls: 'cert-yes', sub: 'Extension rods + electrical' });
  }
  return cells.slice(0, 8);
}

function shortCert(s) {
  if (!s) return '';
  if (/UL\s*listed/i.test(s)) {
    if (/damp/i.test(s)) return 'UL · damp';
    if (/wet/i.test(s)) return 'UL · wet';
    if (/dry/i.test(s)) return 'UL · dry';
    return 'UL Listed';
  }
  return s.length > 28 ? s.slice(0, 26) + '…' : s;
}

function prettySlug(s) {
  if (!s) return '';
  return String(s).split(';')[0].replace(/-/g, ' ').replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- Sales --------------------------------------------------------

function renderSales(p) {
  const u24 = p.sales_2024_units || 0;
  const u25 = p.sales_2025_units || 0;
  if (!u24 && !u25) return '';
  let yoy = '';
  if (u24 > 0) {
    const pct = ((u25 - u24) / u24) * 100;
    const cls = pct > 5 ? 'up' : (pct < -5 ? 'down' : 'flat');
    const arrow = pct > 5 ? '↑' : (pct < -5 ? '↓' : '→');
    yoy = `<span class="demand-yoy ${cls}">${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
  } else if (u25 > 0) {
    yoy = `<span class="demand-yoy up">NEW</span>`;
  }
  const fmt = (n) => '$' + Math.round(n).toLocaleString();
  return `
    <section class="spec-section spec-demand">
      <header class="spec-section-head">
        <h3>Sales</h3>
        <span class="spec-section-aside">Gross units shipped (all finishes &amp; colors)</span>
      </header>
      <div class="demand-line">
        <span class="demand-pair">
          <span class="demand-year">2024</span>
          <span class="demand-num">${u24.toLocaleString()}</span>
          <span class="quality-sub" style="margin-left:4px">${fmt(p.sales_2024_revenue || 0)}</span>
        </span>
        <span class="demand-arrow" aria-hidden="true">→</span>
        <span class="demand-pair">
          <span class="demand-year">2025</span>
          <span class="demand-num is-current">${u25.toLocaleString()}</span>
          <span class="quality-sub" style="margin-left:4px">${fmt(p.sales_2025_revenue || 0)}</span>
        </span>
        ${yoy}
      </div>
    </section>`;
}

// ---------- Build & cost (private overlay only) --------------------------
//
// Everything in this section is INTERNAL and arrives only via the gated
// overlay, so on the public page these functions return '' and nothing hints
// that they exist.
//
// Two rules govern how it renders, and both come from being burnt before:
//
//   1. A cost without its coverage is a lie. `21800FH` resolves 19 of 35 BOM
//      lines; rendering that as a bare "$247.80" next to a 100%-covered product
//      invites someone to reprice off a lower bound. Coverage travels with the
//      number, always, in the same eyeline.
//   2. Margin is shown TWICE. Material-only reads ~89% because it counts no
//      labor; loaded subtracts assembly too. Showing only the first flatters
//      every product; showing only the second buries a hard number under a
//      labor estimate that, for 43% of products, is inferred from a sibling.

const ASM_BASIS = {
  MEASURED: { chip: 'MEASURED', cls: 'ok',
              tip: 'Median of this product’s own timed builds in the Assembly Log.' },
  VARIANT:  { chip: 'ESTIMATED', cls: 'warn',
              tip: 'From its hang-straight / Color twin — the same physical assembly. Not timed for this SKU.' },
  SIZE:     { chip: 'ESTIMATED', cls: 'warn',
              tip: 'From a same-family sibling at another size or height. Assembly does differ somewhat.' },
  MODEL:    { chip: 'MODELLED', cls: 'weak',
              tip: 'No builds logged. Median of comparable products by type. Weakest basis — expect to correct it.' },
};

const money = (n, dp = 2) =>
  n == null ? null : '$' + n.toLocaleString(undefined,
    { minimumFractionDigits: dp, maximumFractionDigits: dp });

const FINISH_BASIS = {
  real:    { chip: 'REAL', cls: 'ok',
             tip: 'This finish has its own priced part — not a blend.' },
  derived: { chip: 'DERIVED', cls: 'warn',
             tip: 'No price for this exact finish yet — family average across whatever IS priced.' },
  assumed: { chip: 'ASSUMED', cls: 'weak',
             tip: 'Nothing priced anywhere in this family — deepest fallback (sibling/catalog/category/global).' },
};

function renderFinishStrip(c) {
  if (!c.by_finish) return '';
  const order = [['brass', 'Brass'], ['nickel', 'Nickel'], ['black', 'Black']];
  const cellHtml = order.map(([key, label]) => {
    const f = c.by_finish[key];
    if (!f || f.material_est == null) return '';
    const basisKey = f.real_lines > 0 ? 'real' : (f.derived_lines > 0 ? 'derived' : 'assumed');
    const basis = FINISH_BASIS[basisKey];
    return `
      <div class="cost-cell">
        <div class="cost-label">${escapeHtml(label)}</div>
        <div class="cost-val">${escapeHtml(money(f.material_est))}</div>
        <span class="cost-chip ${basis.cls}" title="${escapeHtml(basis.tip)}">${basis.chip}</span>
      </div>`;
  }).filter(Boolean).join('');
  if (!cellHtml) return '';
  const method = c.finish_weighting && c.finish_weighting.method === 'sales-mix'
    ? 'Material above is weighted by actual 2025 sales mix across these three.'
    : 'Material above is a plain average of these three — no sales history yet to weight by.';
  return `
    <div class="cost-strip cost-strip-finish">${cellHtml}</div>
    <p class="cost-note cost-note-finish">${escapeHtml(method)}</p>`;
}

function renderCost(p) {
  const c = COSTING[p.handle];
  if (!c) return '';

  const basis = ASM_BASIS[c.assembly_basis] || ASM_BASIS.MODEL;
  const cells = [];

  if (c.assembly_minutes != null) {
    // Show the IQR, not the full range: the log's outliers are timers left
    // running, and a "3–373 min" range describes the data entry, not the work.
    const spread = (c.assembly_p25 != null && c.assembly_p75 != null &&
                    c.assembly_p75 > c.assembly_p25)
      ? `${+c.assembly_p25.toFixed(1)}–${+c.assembly_p75.toFixed(1)} min typical` : '';
    const n = c.assembly_builds
      ? `${c.assembly_builds} timed build${c.assembly_builds === 1 ? '' : 's'}`
      : (c.assembly_basis_sku ? `from ${c.assembly_basis_sku}` : '');
    cells.push({
      label: 'Assembly time',
      val: `${+c.assembly_minutes.toFixed(c.assembly_minutes < 2 ? 2 : 1)} min`,
      chip: basis, sub: [n, spread].filter(Boolean).join(' · '),
    });
  }
  if (c.material_cost_est != null) {
    const pct = c.cost_coverage == null ? null : Math.round(c.cost_coverage * 100);
    cells.push({
      label: 'Material', val: money(c.material_cost_est),
      sub: pct == null ? '' :
        `${pct}% of ${c.cost_lines} lines at real prices` + (pct < 100 ? ', rest assumed' : ''),
      cls: pct != null && pct < 70 ? 'thin' : '',
    });
  }
  if (c.labor_cost != null) {
    cells.push({ label: 'Labor', val: money(c.labor_cost),
                 sub: `${+c.assembly_minutes.toFixed(1)} min @ $${c.labor_rate}/hr loaded` });
  }
  if (c.unit_cost_est != null) {
    cells.push({ label: 'Unit cost', val: money(c.unit_cost_est),
                 sub: 'material + assembly labor', accent: true });
  }
  if (c.sell_price != null) {
    cells.push({ label: 'Sell price', val: money(c.sell_price, 0), sub: 'list, one unit' });
  }
  if (!cells.length) return '';

  const cellHtml = cells.map(q => `
    <div class="cost-cell">
      <div class="cost-label">${escapeHtml(q.label)}</div>
      <div class="cost-val ${q.accent ? 'accent' : ''} ${q.cls || ''}">${escapeHtml(q.val)}</div>
      ${q.chip ? `<span class="cost-chip ${q.chip.cls}" title="${escapeHtml(q.chip.tip)}">${escapeHtml(q.chip.chip)}</span>` : ''}
      ${q.sub ? `<div class="cost-sub">${escapeHtml(q.sub)}</div>` : ''}
    </div>`).join('');

  const pct = (v) => (v * 100).toFixed(1) + '%';
  const mBits = [];
  if (c.material_margin != null) {
    mBits.push(`<span class="margin-pair"><span class="margin-key">Material only</span>
      <span class="margin-num">${pct(c.material_margin)}</span></span>`);
  }
  if (c.loaded_margin != null) {
    const drop = c.material_margin != null
      ? `<span class="margin-drop">labor takes ${((c.material_margin - c.loaded_margin) * 100).toFixed(1)} pts</span>` : '';
    mBits.push(`<span class="margin-pair"><span class="margin-key">Material + labor</span>
      <span class="margin-num is-loaded">${pct(c.loaded_margin)}</span>${drop}</span>`);
  }
  const marginHtml = mBits.length
    ? `<div class="margin-line"><span class="margin-head">Margin</span>${
        mBits.join('<span class="margin-sep">·</span>')}</div>` : '';

  const skus = (c.skus || []).length > 1
    ? `<span class="spec-section-aside">covers ${c.skus.map(escapeHtml).join(', ')}</span>` : '';
  const asOf = COSTING_META && COSTING_META.generated
    ? `<span class="spec-section-aside">recalculated ${escapeHtml(COSTING_META.generated)}</span>` : '';

  return `
    <section class="spec-section spec-cost">
      <header class="spec-section-head">
        <h3>Build &amp; cost</h3>
        <span class="spec-section-aside gated">Internal</span>
        ${skus}
        ${asOf}
      </header>
      <div class="cost-strip">${cellHtml}</div>
      ${renderFinishStrip(c)}
      ${marginHtml}
      <p class="cost-note">Machine-calculated from the BOM, live part prices and the
        Assembly Log — regenerated every refresh, so it is never hand-edited.
        Assembly time is bench time for one assembler; powder coat, wash, QC,
        testing and packing are not in it.</p>
    </section>`;
}

// ---------- Shipping & packaging (private overlay only) ------------------

function renderShipping(p) {
  const c = COSTING[p.handle];
  const s = c && c.shipping;
  if (!s) return '';

  // "A blank tier ABOVE a covered tier is shallow, not a gap." Max Qty 2 means
  // tiers 3-5 SHOULD be empty — printing "—" there manufactures ~450 rows of
  // noise and buries the genuinely unpackaged fixtures. So a tier past the max
  // is simply not rendered; a blank tier BELOW the max still shows a real gap.
  const maxQty = parseInt(s.max_qty_per_box, 10);
  const labels = ['Qty 1', 'Qty 2', 'Qty 3', 'Qty 4', 'Qty 5 & up'];
  const boxes = s.boxes || [];
  const rows = [];
  if (!boxes.some(Boolean)) {
    // Nothing on file at any tier is ONE fact, not five. Repeating it per tier
    // reads as five separate problems and drowns the fixtures that have a
    // partial answer worth completing.
    rows.push(`<div class="ship-tier gap"><span class="ship-tier-b">
        No carton on file at any quantity</span></div>`);
  } else {
    boxes.forEach((b, i) => {
      if (!b && maxQty && (i + 1) > maxQty) return;
      rows.push(`<div class="ship-tier ${b ? '' : 'gap'}">
          <span class="ship-tier-q">${labels[i]}</span>
          <span class="ship-tier-b">${b ? escapeHtml(b) : 'no box on file'}</span>
        </div>`);
    });
  }
  if (!rows.length && !s.weight_lb) return '';

  const facts = [];
  if (s.max_qty_per_box) facts.push(`<b>${escapeHtml(s.max_qty_per_box)}</b> max per box`);
  if (s.bag) facts.push(`bagged in ${escapeHtml(s.bag)}`);
  if (s.dims && s.dims.some(v => v != null)) {
    facts.push('fixture ' + s.dims.map(v => v == null ? '?' : v + '"').join(' × '));
  }
  if (s.wire_length) facts.push(`wire ${escapeHtml(s.wire_length)}`);

  // FedEx bills the greater of actual and dimensional weight. A light, bulky
  // fixture ships on its carton, not its scale — surfacing that here is the
  // difference between quoting freight off 4 lb and off the 20 lb we're billed.
  let wHtml = '';
  if (s.weight_lb != null || s.dim_weight_lb != null) {
    const bits = [];
    if (s.weight_lb != null) bits.push(`<span class="ship-w"><b>${s.weight_lb}</b> lb actual</span>`);
    if (s.dim_weight_lb != null) {
      const div = (COSTING_META && COSTING_META.dim_divisor) || 192;
      bits.push(`<span class="ship-w"><b>${s.dim_weight_lb}</b> lb dim <span class="cost-sub">(qty-1 carton ÷ ${div})</span></span>`);
    }
    if (s.billable_weight_lb != null) {
      const dimWins = s.dim_weight_lb != null && s.dim_weight_lb > (s.weight_lb || 0);
      bits.push(`<span class="ship-w billable"><b>${s.billable_weight_lb}</b> lb billable${
        dimWins ? ' <span class="cost-chip warn" title="Dimensional weight exceeds actual weight, so FedEx bills the carton, not the scale.">DIM</span>' : ''}</span>`);
    }
    wHtml = `<div class="ship-weights">${bits.join('')}</div>`;
  }

  const notes = s.packing_notes
    ? `<p class="cost-note">${escapeHtml(s.packing_notes)}</p>` : '';

  return `
    <section class="spec-section spec-ship">
      <header class="spec-section-head">
        <h3>Shipping &amp; packaging</h3>
        <span class="spec-section-aside gated">Internal</span>
        <a class="spec-section-aside ship-link"
           href="https://hub.duttonbrown.com/production/packing-sheet"
           target="_blank" rel="noopener">Packing sheet ↗</a>
      </header>
      <div class="ship-tiers">${rows.join('')}</div>
      ${facts.length ? `<div class="ship-facts">${facts.join(' <span class="margin-sep">·</span> ')}</div>` : ''}
      ${wHtml}
      ${notes}
    </section>`;
}

// ---------- Diagrams / Downloads ----------------------------------------

function renderDiagrams(p) {
  // The Tearsheet typically IS the assembly diagram for our lighting (it's
  // the exploded view + dimensions). Installation Guide is the customer-
  // facing PDF. Revit/CAD is the architectural file. We surface the
  // tearsheet first and largest so the QC person can open it inline.
  const t = p.downloads.tearsheet;
  const ig = p.downloads.installation_guide;
  const rev = p.downloads.revit;
  const w3d = p.downloads.warehouse_3d;

  // If there's a tearsheet, show it embedded so QC can read it without
  // leaving the page. PDFs render via the browser's native plugin.
  const tearsheetEmbed = t
    ? `<div class="diagram-frame">
         <iframe src="${escapeHtml(t)}#view=FitH" loading="lazy" title="Tearsheet for ${escapeHtml(p.title)}"></iframe>
         <div class="diagram-actions">
           <a class="product-cta secondary" href="${escapeHtml(t)}" target="_blank" rel="noopener">Open tearsheet ↗</a>
         </div>
       </div>`
    : `<div class="empty-panel">No tearsheet uploaded for this product.</div>`;

  const extras = [];
  if (ig)  extras.push({ title: 'Installation Guide', sub: 'Customer-facing PDF', url: ig });
  if (rev) extras.push({ title: 'Revit / CAD',        sub: 'Architects file',     url: rev });
  if (w3d) extras.push({ title: '3D Warehouse',       sub: 'SketchUp model',      url: w3d });
  const extrasHtml = extras.length
    ? `<div class="downloads-grid">${extras.map(d => `
         <a class="download-btn" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">
           <div class="download-icon pdf">PDF</div>
           <div class="download-meta">
             <div class="download-title">${escapeHtml(d.title)}</div>
             <div class="download-sub">${escapeHtml(d.sub)}</div>
           </div>
         </a>`).join('')}</div>`
    : '';

  return `
    <section class="spec-section">
      <header class="spec-section-head">
        <h3>Assembly diagram</h3>
        <span class="spec-section-aside">Exploded view + dimensions from the tearsheet</span>
      </header>
      ${tearsheetEmbed}
      ${extrasHtml}
    </section>`;
}

// ---------- QC callouts: wire lengths, extension rods, canopy configs ----

function renderQcCallouts(p) {
  const qc = p.qc || {};
  const blocks = [];

  // Wire / lead lengths
  if ((qc.wire_lengths || []).length) {
    const rows = qc.wire_lengths.map(w => `
      <li class="qc-list-row">
        <span class="qc-list-num">${w.length_in}<span class="qc-list-unit">"</span></span>
        <span class="qc-list-detail">
          <a class="bom-part-num" href="parts.html#${encodeURIComponent(w.part_number)}">${escapeHtml(w.part_number)}</a>
          <span class="bom-desc">${escapeHtml(w.desc || '')}</span>
        </span>
        <span class="bom-qty">${escapeHtml(String(w.qty || ''))}</span>
      </li>`).join('');
    blocks.push(`
      <section class="spec-section">
        <header class="spec-section-head">
          <h3>Wire &amp; lead lengths <span class="spec-section-count">${qc.wire_lengths.length}</span></h3>
          <span class="spec-section-aside">Pre-wired leads ship at these lengths</span>
        </header>
        <ul class="qc-list">${rows}</ul>
      </section>`);
  }

  // Extension rods
  if ((qc.extension_rods || []).length) {
    const total = qc.extension_rods.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const rows = qc.extension_rods.map(r => `
      <li class="qc-list-row">
        <span class="bom-qty">${escapeHtml(String(r.qty || ''))}</span>
        <span class="qc-list-detail">
          <a class="bom-part-num" href="parts.html#${encodeURIComponent(r.part_number)}">${escapeHtml(r.part_number)}</a>
          <span class="bom-desc">${escapeHtml(r.desc || '')}</span>
        </span>
      </li>`).join('');
    blocks.push(`
      <section class="spec-section">
        <header class="spec-section-head">
          <h3>Extension rods <span class="spec-section-count">${total}</span></h3>
          <span class="spec-section-aside">${qc.needs_pre_test ? 'Assembled and tested before ship' : 'Customer-installed'}</span>
        </header>
        <ul class="qc-list">${rows}</ul>
      </section>`);
  }

  // Canopy kit configurations
  if ((qc.canopy_configs || []).length) {
    const cfgs = qc.canopy_configs.map(c => `
      <div class="canopy-cfg">
        <div class="canopy-cfg-head">
          <span class="canopy-cfg-name">${escapeHtml(c.name)}</span>
          <span class="bom-section-count">${c.part_count} part${c.part_count === 1 ? '' : 's'}</span>
        </div>
        ${bomTable(c.parts)}
      </div>`).join('');
    blocks.push(`
      <section class="spec-section">
        <header class="spec-section-head">
          <h3>Canopy kit <span class="spec-section-count">${qc.canopy_configs.length}</span></h3>
          <span class="spec-section-aside">${qc.canopy_configs.length === 1 ? 'Configuration' : 'Configurations — choose by mounting'}</span>
        </header>
        <div class="canopy-cfg-list">${cfgs}</div>
      </section>`);
  }

  return blocks.join('');
}

// ---------- Compact variants (just SKU + finish + color, no inventory) ----

function renderVariantsCompact(p) {
  const variants = p.variants || [];
  if (!variants.length) return '';
  const rows = variants.map(v => `
    <li class="qc-list-row">
      <span class="v-sku">${escapeHtml(v.sku)}</span>
      <span class="qc-list-detail">
        <span class="bom-desc">${escapeHtml([v.option1, v.option2, v.option3].filter(Boolean).join(' · '))}</span>
      </span>
    </li>`).join('');
  return `
    <details class="spec-section spec-usedin">
      <summary class="spec-section-head">
        <h3>Variant SKUs <span class="spec-section-count">${variants.length}</span></h3>
      </summary>
      <ul class="qc-list">${rows}</ul>
    </details>`;
}

function renderBomTree(p) {
  if (!p.parts_total) {
    return `<section class="spec-section">
      <header class="spec-section-head">
        <h3>Bill of Materials</h3>
        <span class="spec-section-aside">Not linked to a Notion BOM yet</span>
      </header>
      <div class="empty-panel">No BOM data — this product hasn't been linked to a part list in Notion.</div>
    </section>`;
  }
  const sections = Object.entries(p.parts_by_section);
  // Sort: Assembly first, Canopy second, then alpha
  sections.sort(([a], [b]) => {
    const order = (n) => n.toLowerCase().startsWith('assembly') ? 0
      : n.toLowerCase().startsWith('canopy') ? 1 : 2;
    return order(a) - order(b) || a.localeCompare(b);
  });
  const blocks = sections.map(([name, parts]) => bomSectionTable(name, parts)).join('');
  return `<section class="spec-section">
    <header class="spec-section-head">
      <h3>Bill of Materials <span class="spec-section-count">${p.parts_total}</span></h3>
      <span class="spec-section-aside">Click any part number to open it in the Parts library</span>
    </header>
    ${blocks}
  </section>`;
}

// Shared table renderer so the BOM and the canopy configs read identically —
// aligned columns (role · part # · description · qty), zebra striped, matching
// the BOM Master page. `parts` items carry {part_number|qty|desc, role?}.
function bomTable(parts) {
  const rows = parts.map(prt => {
    // Use effective_role — the collapsed 3-value vocabulary (Standard / Finish
    // / Color) that BOM Master renders. part_role carries the raw 5-value form
    // (Finish Only, Color Only, Finish+Color, ...) which is why this page used
    // to show a divergent purple "FC" pill. Keying off effective_role makes the
    // C/F/S badges identical to BOM Master. Fall back to part_role then Standard.
    const role = prt.effective_role || prt.role || 'Standard';
    const roleCls = (role === 'Color') ? 'color'
      : (role === 'Finish') ? 'finish'
      : 'standard';
    const pillChar = role.charAt(0).toUpperCase();
    const pn = prt.part_number || '';
    const partCell = pn
      ? `<a class="bom-part-num" href="parts.html#${encodeURIComponent(pn)}">${escapeHtml(pn)}</a>`
      : '—';
    return `<tr>
      <td class="bt-role"><span class="bom-pill ${roleCls}" title="${escapeHtml(role)}">${escapeHtml(pillChar)}</span></td>
      <td class="bt-part">${partCell}</td>
      <td class="bt-desc">${escapeHtml(prt.desc || '')}</td>
      <td class="bt-qty">${escapeHtml(String(prt.qty || ''))}</td>
    </tr>`;
  }).join('');
  return `<table class="bom-table">
    <thead><tr><th></th><th>Part #</th><th>Description</th><th>Qty</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function bomSectionTable(name, parts) {
  const isCanopy = name.toLowerCase().startsWith('canopy');
  const headCls = isCanopy ? 'bom-section-head canopy' : 'bom-section-head';
  return `<div class="bom-section">
    <div class="${headCls}">
      <span class="bom-section-name">${escapeHtml(name)}</span>
      <span class="bom-section-count">${parts.length} part${parts.length === 1 ? '' : 's'}</span>
    </div>
    ${bomTable(parts)}
  </div>`;
}

bootstrap();
