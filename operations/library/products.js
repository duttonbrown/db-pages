// Products Library — sibling of parts.js for Lighting + Hardware.
// Single-page app over products-library.json.

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Body HTML from Shopify is trusted-enough internal content. Sanitize lightly:
// strip <script>/<style>/event handlers and keep the rest. We never accept
// user input here — Shopify CSV is operator-controlled.
function safeBodyHtml(html) {
  if (!html) return '';
  return html
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
}

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
    sub.textContent  = 'Pulls, knobs, hooks — finish options, materials, BOM, downloads, and certifications.';
  } else {
    lead.textContent = 'Lighting Library';
    sub.textContent  = 'Sconces, pendants, chandeliers, flush mounts — UL/cUL, sockets, BOM, canopy kits, and downloads.';
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

  const flags = [];
  if (p.has_canopy_kit)               flags.push(`<span class="preview-flag canopy" title="Canopy kit included">Canopy</span>`);
  if (/UL\s*listed/i.test(p.certification || '')) flags.push(`<span class="preview-flag ul" title="${escapeHtml(p.certification)}">UL</span>`);
  if ((p.color_options || []).length) flags.push(`<span class="preview-flag colors" title="${p.color_options.length} color options">${p.color_options.length} colors</span>`);
  const flagsHtml = flags.length ? `<div class="preview-flags">${flags.join('')}</div>` : '';

  let statusFlag = '';
  if (p.status && p.status !== 'active') {
    statusFlag = `<div class="preview-status-flag inactive">${escapeHtml(p.status)}</div>`;
  }
  const cardCls = p.status && p.status !== 'active' ? 'preview-card is-inactive' : 'preview-card';

  const price = p.price ? `$${escapeHtml(p.price)}` : '';

  return `<a class="${cardCls}" data-h="${escapeHtml(p.handle)}" href="#${encodeURIComponent(p.handle)}">
    ${imgHtml}
    ${flagsHtml}
    ${statusFlag}
    <div class="preview-body">
      <div class="preview-num" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
      <div class="preview-meta-row">
        <span class="preview-type">${escapeHtml(p.type)}</span>
        ${price ? `<span class="preview-price">${price}</span>` : ''}
      </div>
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

// Map shopify color slug -> approximate hex for swatches. Best effort; if
// we miss a color it just shows as a grey dot — still labeled.
const COLOR_HEX = {
  'white': '#FFFFFF', 'bone': '#EFE7D6', 'chalk': '#E9E4D6',
  'barely': '#E8DACE', 'orange-1': '#E26A2C', 'orange': '#E26A2C',
  'riding-hood-red': '#A52A2A', 'cobalt': '#1F45B4', 'spa': '#9FBFB8',
  'python-green': '#5C7B3B', 'lagoon-1': '#3F8C9A', 'slate-blue': '#5D6C8B',
  'ochre': '#C9952C', 'black': '#1A1A1A', 'brass': '#B08D57', 'nickel': '#C9CCCD',
  'pink': '#E7AAB0', 'sage': '#A3B18A', 'navy': '#22335E'
};

function colorHex(slug) {
  if (!slug) return '#DDD';
  const s = slug.toLowerCase().replace(/\s+/g, '-');
  return COLOR_HEX[s] || '#DDD';
}

function renderSpec(p) {
  // ---- Hero + gallery
  const hero = (p.gallery && p.gallery[0]) || { src: p.image, alt: p.image_alt || p.title };
  const heroHtml = hero.src
    ? `<div class="spec-image"><img id="hero-img" src="${escapeHtml(hero.src)}" alt="${escapeHtml(hero.alt || p.title)}"></div>`
    : `<div class="spec-image no-img">No image</div>`;
  const galleryThumbs = (p.gallery || []).slice(0, 12);
  const galleryHtml = galleryThumbs.length > 1
    ? `<div class="spec-gallery">${galleryThumbs.map((g, i) =>
        `<button type="button" class="spec-thumb${i === 0 ? ' is-current' : ''}" data-src="${escapeHtml(g.src)}" data-alt="${escapeHtml(g.alt)}">
           <img src="${escapeHtml(g.src)}" alt="" loading="lazy">
         </button>`).join('')}</div>`
    : '';

  // ---- Title row
  const skuLabel = p.bom_parent_sku || (p.variants[0] && p.variants[0].sku) || p.handle;
  const statusCls = p.status === 'active' ? 'active' : 'inactive';
  const statusLabel = p.status === 'active' ? 'Active' : (p.status || 'Unknown');

  const certShort = /UL\s*listed/i.test(p.certification || '') ? 'UL Listed' : '';

  const ctaRow = `
    <div class="product-cta-row">
      <a class="product-cta" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
        View on duttonbrown.com <span class="product-cta-icon">↗</span>
      </a>
      ${p.bom_page_url ? `<a class="product-cta secondary" href="${escapeHtml(p.bom_page_url)}" target="_blank" rel="noopener">Open BOM in Notion <span class="product-cta-icon">↗</span></a>` : ''}
      ${p.downloads.collection ? `<a class="product-cta secondary" href="${escapeHtml(p.downloads.collection)}" target="_blank" rel="noopener">${escapeHtml(p.downloads.collection_title || 'See collection')} <span class="product-cta-icon">↗</span></a>` : ''}
    </div>
  `;

  // ---- Price line
  const priceRow = p.price ? `
    <div class="product-price-row">
      <div class="product-price">$${escapeHtml(p.price)}</div>
      <div class="product-price-meta">starting · ${p.variant_count} variant${p.variant_count === 1 ? '' : 's'}${p.rating_count ? ` · ${escapeHtml(p.rating_count)} review${p.rating_count === '1' ? '' : 's'}` : ''}</div>
    </div>` : '';

  // ---- Tag strip (mounting / style / bulb)
  const tagPills = [];
  if (p.mounting_type)  tagPills.push(`<span class="spec-tag mounting">${escapeHtml(prettySlug(p.mounting_type))} mount</span>`);
  if (p.knob_handle_design) tagPills.push(`<span class="spec-tag style">${escapeHtml(prettySlug(p.knob_handle_design))}</span>`);
  if (p.bulb_cap_type)  tagPills.push(`<span class="spec-tag bulb">Cap ${escapeHtml(prettySlug(p.bulb_cap_type))}</span>`);
  if (p.bulb_shape)     tagPills.push(`<span class="spec-tag bulb">${escapeHtml(prettySlug(p.bulb_shape))}</span>`);
  if (p.style)          (p.style.split(';').slice(0, 3)).forEach(s => tagPills.push(`<span class="spec-tag style">${escapeHtml(prettySlug(s.trim()))}</span>`));
  const tagStrip = tagPills.length ? `<div class="spec-tags">${tagPills.join('')}</div>` : '';

  // ---- Quality strip — the operationally-loud facts
  const quality = qualityCells(p);
  const qualityHtml = `<div class="product-quality">${quality.map(q => `
    <div class="quality-cell">
      <div class="quality-label">${escapeHtml(q.label)}</div>
      <div class="quality-val ${q.empty ? 'empty' : ''} ${q.cls || ''}">${q.empty ? '—' : escapeHtml(q.val)}</div>
      ${q.sub ? `<div class="quality-sub">${escapeHtml(q.sub)}</div>` : ''}
    </div>`).join('')}</div>`;

  // ---- Downloads grid (always show all 5 slots so missing ones are visible)
  const downloads = [
    { key: 'tearsheet',          title: 'Tearsheet',          sub: 'PDF spec sheet',   icon: 'pdf' },
    { key: 'installation_guide', title: 'Installation Guide', sub: 'PDF',              icon: 'pdf' },
    { key: 'revit',              title: 'Revit / CAD',        sub: 'Architects',       icon: 'cad' },
    { key: 'warehouse_3d',       title: '3D Warehouse',       sub: 'Sketchup',         icon: 'url' },
  ];
  if (p.care_guide) downloads.push({ key: 'care_guide_inline', title: 'Care Guide', sub: 'Text', icon: 'care' });
  const downloadsHtml = `<div class="downloads-grid">${downloads.map(d => {
    const url = d.key === 'care_guide_inline' ? '#care-guide' : p.downloads[d.key];
    const cls = url ? '' : 'disabled';
    const attrs = url && d.key !== 'care_guide_inline'
      ? `href="${escapeHtml(url)}" target="_blank" rel="noopener"`
      : (url ? `href="${escapeHtml(url)}"` : 'aria-disabled="true"');
    return `<a class="download-btn ${cls}" ${attrs}>
      <div class="download-icon ${d.icon}">${d.icon === 'pdf' ? 'PDF' : (d.icon === 'cad' ? 'CAD' : (d.icon === 'care' ? '♡' : '↗'))}</div>
      <div class="download-meta">
        <div class="download-title">${escapeHtml(d.title)}</div>
        <div class="download-sub">${url ? escapeHtml(d.sub) : 'Not available'}</div>
      </div>
    </a>`;
  }).join('')}</div>`;
  const downloadsSection = `
    <section class="spec-section">
      <header class="spec-section-head"><h3>Downloads</h3></header>
      ${downloadsHtml}
    </section>`;

  // ---- Color swatches (if any)
  const colorsSection = (p.color_options && p.color_options.length) ? `
    <section class="spec-section">
      <header class="spec-section-head">
        <h3>Color options <span class="spec-section-count">${p.color_options.length}</span></h3>
      </header>
      <div class="swatch-row">
        ${p.color_options.map(c => `<span class="swatch">
          <span class="swatch-dot" style="background:${colorHex(c)}"></span>${escapeHtml(prettySlug(c))}
        </span>`).join('')}
      </div>
    </section>` : '';

  // ---- Variants table
  const variantsSection = renderVariants(p);

  // ---- BOM tree (grouped by section, canopy highlighted)
  const bomSection = renderBomTree(p);

  // ---- Configuration / Certification / Specs / Care prose
  const proseSection = renderProse(p);

  // ---- Body HTML (collapsible — the marketing copy)
  const bodySection = p.body_html ? `
    <section class="spec-section product-body">
      <details ${p.body_html.length < 600 ? 'open' : ''}>
        <summary><h3>Product page copy</h3></summary>
        <div class="product-body-html">${safeBodyHtml(p.body_html)}</div>
      </details>
    </section>` : '';

  // ---- Related / variation / complementary chips
  const relatedSection = renderRelated(p);

  // ---- Admin footer
  const adminBits = [];
  if (p.bom_last_edited_at) adminBits.push(`BOM edited ${escapeHtml(p.bom_last_edited_at.split('T')[0])}`);
  if (DATA.generated_at) adminBits.push(`Library updated ${escapeHtml(DATA.generated_at.split('T')[0])}`);
  adminBits.push(`<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Live product page ↗</a>`);
  if (p.bom_page_url) adminBits.push(`<a href="${escapeHtml(p.bom_page_url)}" target="_blank" rel="noopener">BOM page ↗</a>`);
  const adminHtml = `<footer class="spec-admin">${adminBits.join(' · ')}</footer>`;

  // ---- Compose
  const html = `
    <article class="spec-card product-spec">
      <button class="spec-back" type="button">← Back to ${escapeHtml(activeBucket === 'hardware' ? 'hardware' : 'lighting')}</button>

      <div class="spec-head">
        <div>
          ${heroHtml}
          ${galleryHtml}
        </div>
        <div class="spec-summary">
          <div class="spec-num-row">
            <span class="spec-num">${escapeHtml(skuLabel)}</span>
            <span class="spec-status ${statusCls}">${escapeHtml(statusLabel)}</span>
            ${certShort ? `<span class="spec-finish-pill">${escapeHtml(certShort)}</span>` : ''}
            <span class="spec-finish-pill">${escapeHtml(p.type)}</span>
          </div>
          <h2 class="spec-title">${escapeHtml(p.title)}</h2>
          ${p.tagline ? `<p class="spec-tagline">${escapeHtml(p.tagline)}</p>` : ''}
          ${priceRow}
          ${ctaRow}
          ${tagStrip}
          ${qualityHtml}
        </div>
      </div>

      ${downloadsSection}
      ${colorsSection}
      ${variantsSection}
      ${bomSection}
      ${proseSection}
      ${relatedSection}
      ${bodySection}
      ${adminHtml}
    </article>
  `;

  $('spec-slot').innerHTML = html;
  $('spec-slot').hidden = false;
  $('grid-slot').hidden = true;

  // wire
  $('spec-slot').querySelector('.spec-back').onclick = () => {
    history.replaceState(null, '', '#' + activeBucket);
    routeFromHash();
  };
  $('spec-slot').querySelectorAll('.spec-thumb').forEach(b => {
    b.onclick = () => {
      $('spec-slot').querySelectorAll('.spec-thumb').forEach(x => x.classList.remove('is-current'));
      b.classList.add('is-current');
      const img = document.getElementById('hero-img');
      if (img) {
        img.src = b.dataset.src;
        img.alt = b.dataset.alt || '';
      }
    };
  });
  // Variants show-all toggle
  const moreBtn = $('spec-slot').querySelector('.variants-show-more');
  if (moreBtn) {
    moreBtn.onclick = () => {
      $('spec-slot').querySelectorAll('.variants-table tr.is-hidden').forEach(tr => tr.classList.remove('is-hidden'));
      moreBtn.style.display = 'none';
    };
  }
}

function qualityCells(p) {
  const cells = [];
  cells.push({ label: 'Lead time',  val: p.lead_time, empty: !p.lead_time });
  cells.push({
    label: 'Certification',
    val: shortCert(p.certification),
    empty: !p.certification,
    cls: /UL\s*listed/i.test(p.certification || '') ? 'cert-yes' : '',
    sub: (p.certification && p.certification.length > 32) ? p.certification.slice(0, 80) + '…' : '',
  });
  if (p.bucket === 'lighting') {
    cells.push({ label: 'Mounting',     val: prettySlug(p.mounting_type),     empty: !p.mounting_type });
    cells.push({ label: 'Socket',       val: p.socket_type,                    empty: !p.socket_type });
    cells.push({ label: 'Hanging height', val: p.hanging_height,               empty: !p.hanging_height });
    cells.push({ label: 'Bulb',         val: bulbCombo(p),                     empty: !bulbCombo(p) });
  } else {
    cells.push({ label: 'Finish',       val: prettySlug(p.hardware_finish),    empty: !p.hardware_finish });
    cells.push({ label: 'Material',     val: prettySlug(p.handle_material),    empty: !p.handle_material });
    cells.push({ label: 'Design',       val: prettySlug(p.knob_handle_design), empty: !p.knob_handle_design });
    cells.push({ label: 'Weight',       val: p.weight,                         empty: !p.weight });
  }
  cells.push({ label: 'Variants',     val: String(p.variant_count),          empty: !p.variant_count });
  cells.push({ label: 'BOM parts',    val: p.parts_total ? String(p.parts_total) : '', empty: !p.parts_total, sub: p.has_canopy_kit ? 'Incl. canopy kit' : '' });
  return cells.slice(0, 8);
}

function bulbCombo(p) {
  const bits = [p.bulb_cap_type, p.bulb_shape, p.bulb_size].map(prettySlug).filter(Boolean);
  return bits.join(' · ');
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

function renderVariants(p) {
  const variants = p.variants || [];
  if (!variants.length) return '';
  const hasOpt2 = variants.some(v => v.option2);
  const hasOpt3 = variants.some(v => v.option3);
  const PREVIEW_LIMIT = 10;
  const overflow = variants.length > PREVIEW_LIMIT;

  const rows = variants.map((v, i) => {
    const cls = (i >= PREVIEW_LIMIT) ? 'is-hidden' : '';
    const thumb = v.image
      ? `<div class="v-thumb"><img src="${escapeHtml(v.image)}" alt="" loading="lazy"></div>`
      : `<div class="v-thumb"></div>`;
    const qty = Number(v.qty || 0);
    const qtyCls = qty < 0 ? 'neg' : '';
    return `<tr class="${cls}" style="${cls === 'is-hidden' ? 'display:none' : ''}">
      <td>${thumb}</td>
      <td class="v-sku">${escapeHtml(v.sku)}</td>
      <td>${escapeHtml(v.option1 || '—')}</td>
      ${hasOpt2 ? `<td>${escapeHtml(v.option2 || '')}</td>` : ''}
      ${hasOpt3 ? `<td>${escapeHtml(v.option3 || '')}</td>` : ''}
      <td class="v-price">${v.price ? '$' + escapeHtml(v.price) : '—'}</td>
      <td class="v-qty ${qtyCls}">${qty}</td>
    </tr>`;
  }).join('');

  return `<section class="spec-section">
    <header class="spec-section-head">
      <h3>Variants <span class="spec-section-count">${variants.length}</span></h3>
      <span class="spec-section-aside">SKU · finish · color · price · on-hand</span>
    </header>
    <table class="variants-table">
      <thead><tr>
        <th></th>
        <th>SKU</th>
        <th>${escapeHtml(variants[0].option1_name || 'Option 1')}</th>
        ${hasOpt2 ? `<th>${escapeHtml(variants[0].option2_name || 'Option 2')}</th>` : ''}
        ${hasOpt3 ? `<th>${escapeHtml(variants[0].option3_name || 'Option 3')}</th>` : ''}
        <th>Price</th>
        <th style="text-align:right">Qty</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${overflow ? `<button type="button" class="variants-show-more">Show all ${variants.length} variants</button>` : ''}
  </section>`;
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

function renderProse(p) {
  const blocks = [];
  if (p.configuration) blocks.push({ title: 'Configuration', text: p.configuration });
  if (p.certification && (p.certification.length > 40)) blocks.push({ title: 'Certification', text: p.certification });
  if (p.product_specs) blocks.push({ title: 'Specs', text: p.product_specs });
  if (p.materials)     blocks.push({ title: 'Materials', text: p.materials });
  if (p.care_guide)    blocks.push({ title: 'Care guide', text: p.care_guide, id: 'care-guide' });
  if (p.product_note)  blocks.push({ title: 'Product note', text: p.product_note });
  if (!blocks.length) return '';
  return blocks.map(b => `<section class="spec-section" ${b.id ? `id="${b.id}"` : ''}>
    <header class="spec-section-head"><h3>${escapeHtml(b.title)}</h3></header>
    <div class="prose-block">${escapeHtml(b.text)}</div>
  </section>`).join('');
}

function renderRelated(p) {
  const groups = [];
  const variation = (p.variation_handles || []).filter(h => h !== p.handle);
  const compl = p.complementary_handles || [];
  const related = (p.related_handles || []).filter(h => !variation.includes(h) && !compl.includes(h));
  if (variation.length) groups.push({ title: 'Variations', handles: variation });
  if (compl.length)     groups.push({ title: 'Complementary', handles: compl });
  if (related.length)   groups.push({ title: 'Related', handles: related });
  if (!groups.length) return '';
  const chip = (h) => {
    const target = BY_HANDLE[h];
    if (target) {
      const img = target.image ? `<span class="related-chip-img"><img src="${escapeHtml(target.image)}" alt="" loading="lazy"></span>` : '';
      return `<a class="related-chip" href="#${encodeURIComponent(h)}">${img}${escapeHtml(target.title)}</a>`;
    }
    // External handle (not in library) — link out to storefront
    return `<a class="related-chip" href="https://www.duttonbrown.com/products/${escapeHtml(h)}" target="_blank" rel="noopener">${escapeHtml(h)} ↗</a>`;
  };
  return groups.map(g => `<section class="spec-section">
    <header class="spec-section-head">
      <h3>${escapeHtml(g.title)} <span class="spec-section-count">${g.handles.length}</span></h3>
    </header>
    <div class="related-row">${g.handles.map(chip).join('')}</div>
  </section>`).join('');
}

bootstrap();
