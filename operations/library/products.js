// Products Library — sibling of parts.js for Lighting + Hardware.
// Single-page app over products-library.json.

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let DATA = null;
let BY_HANDLE = {};
let CURRENT = null;
let activeBucket = 'lighting';    // 'lighting' | 'hardware'
let activeType = 'all';
let activeResultIdx = -1;

// ---------------------------------------------------------------- bootstrap

async function bootstrap() {
  try {
    const resp = await fetch('products-library.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    DATA = await resp.json();
  } catch (e) {
    $('grid-slot').innerHTML = `<div class="empty-grid">Failed to load library: ${escapeHtml(e.message)}</div>`;
    return;
  }

  DATA.products.forEach(p => { BY_HANDLE[p.handle] = p; });

  // Sidebar counts — also fetch the parts library so all 4 tabs show counts
  $('lighting-count').textContent = (DATA.counts.lighting || 0).toLocaleString();
  $('hardware-count').textContent = (DATA.counts.hardware || 0).toLocaleString();
  fetch('parts-library.json', { cache: 'no-store' })
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
  CURRENT = null;
  syncTabActive();
  renderTypeFilters();
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
      renderGrid();
    };
  });
}

// ---------------------------------------------------------------- grid

function filtered() {
  let list = DATA.products.filter(p => p.bucket === activeBucket);
  if (activeType !== 'all') list = list.filter(p => p.type === activeType);
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
    const hay = `${title} ${handle} ${tags} ${type} ${skus}`;
    if (title === q || skus.split(' ').includes(q)) exact.push(p);
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

  // ---- QC quality strip — the things a builder needs at a glance
  const quality = qualityCells(p);
  const qualityHtml = `<div class="product-quality">${quality.map(q => `
    <div class="quality-cell">
      <div class="quality-label">${escapeHtml(q.label)}</div>
      <div class="quality-val ${q.empty ? 'empty' : ''} ${q.cls || ''}">${q.empty ? '—' : escapeHtml(q.val)}</div>
      ${q.sub ? `<div class="quality-sub">${escapeHtml(q.sub)}</div>` : ''}
    </div>`).join('')}</div>`;

  // ---- CTAs (open BOM in Notion + live product page)
  const ctaRow = `
    <div class="product-cta-row">
      ${p.bom_page_url ? `<a class="product-cta" href="${escapeHtml(p.bom_page_url)}" target="_blank" rel="noopener">Open BOM in Notion <span class="product-cta-icon">↗</span></a>` : ''}
      <a class="product-cta secondary" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Customer-facing page <span class="product-cta-icon">↗</span></a>
    </div>
  `;

  // ---- Sales section — 2024 vs 2025 totals, units + revenue
  const salesSection = renderSales(p);

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
          ${qualityHtml}
        </div>
      </div>

      ${salesSection}
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
        <ul class="qc-list">${c.parts.map(prt => `
          <li class="qc-list-row">
            <span class="bom-qty">${escapeHtml(String(prt.qty || ''))}</span>
            <span class="qc-list-detail">
              <a class="bom-part-num" href="parts.html#${encodeURIComponent(prt.part_number || '')}">${escapeHtml(prt.part_number || '—')}</a>
              <span class="bom-desc">${escapeHtml(prt.desc || '')}</span>
            </span>
          </li>`).join('')}</ul>
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
  const blocks = sections.map(([name, parts]) => {
    const isCanopy = name.toLowerCase().startsWith('canopy');
    const headCls = isCanopy ? 'bom-section-head canopy' : 'bom-section-head';
    const rows = parts.map(prt => {
      const roleCls = (prt.role === 'Color') ? 'color'
        : (prt.role === 'Finish') ? 'finish'
        : (prt.role === 'Finish+Color') ? 'finishcolor' : '';
      const roleTag = prt.role && prt.role !== 'Standard'
        ? `<span class="bom-role ${roleCls}">${escapeHtml(prt.role)}</span>` : '';
      return `<li class="bom-row">
        <span class="bom-qty">${escapeHtml(String(prt.qty || ''))}</span>
        <span class="bom-detail">
          <a class="bom-part-num" href="parts.html#${encodeURIComponent(prt.part_number || '')}">${escapeHtml(prt.part_number || '—')}</a>
          <span class="bom-desc" title="${escapeHtml(prt.desc || '')}">${escapeHtml(prt.desc || '')}</span>
        </span>
        ${roleTag}
      </li>`;
    }).join('');
    return `<div class="bom-section">
      <div class="${headCls}">
        <span class="bom-section-name">${escapeHtml(name)}${isCanopy ? ' 🪤' : ''}</span>
        <span class="bom-section-count">${parts.length} part${parts.length === 1 ? '' : 's'}</span>
      </div>
      <ul class="bom-list">${rows}</ul>
    </div>`;
  }).join('');
  return `<section class="spec-section">
    <header class="spec-section-head">
      <h3>Bill of Materials <span class="spec-section-count">${p.parts_total}</span></h3>
      <span class="spec-section-aside">Click any part number to open it in the Parts library</span>
    </header>
    ${blocks}
  </section>`;
}

bootstrap();
