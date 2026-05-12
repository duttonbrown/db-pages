// Supplies Library — sibling of parts.js for consumables (powder coats,
// packaging, chemicals, shop materials). Same UX as parts: type-filter
// bubbles, recents, search, click-to-open spec card.

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let DATA = null;          // raw parts-library.json (we only use .supplies)
let SUPPLIES = [];
let BY_KEY = {};
let activeType = 'all';
let activeResultIdx = -1;
let current = null;

// Stable per-supply identifier for hash routing / recents.
// SKU is sparse-ish (131/135) — fall back to page_id.
function keyOf(s) { return s.sku || s.page_id; }

async function bootstrap() {
  try {
    const resp = await fetch('parts-library.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    DATA = await resp.json();
  } catch (e) {
    $('grid-slot').innerHTML = `<div class="empty-grid">Failed to load library: ${escapeHtml(e.message)}</div>`;
    return;
  }
  SUPPLIES = (DATA.supplies || []).filter(s => s.status !== 'Inactive');
  SUPPLIES.forEach(s => { BY_KEY[keyOf(s)] = s; });

  // Sidebar counts — Parts/Supplies from this file, Lighting/Hardware from products
  $('parts-count').textContent = (DATA.counts.parts || 0).toLocaleString();
  $('supplies-count').textContent = SUPPLIES.length.toLocaleString();
  fetch('products-library.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(pl => {
      if (!pl) return;
      $('nav-lighting-count').textContent = (pl.counts.lighting || 0).toLocaleString();
      $('nav-hardware-count').textContent = (pl.counts.hardware || 0).toLocaleString();
    })
    .catch(() => {});

  $('lib-count').innerHTML = `<b>${SUPPLIES.length}</b> supplies`;

  renderTypeFilters();
  renderRecents();
  wireSearch();
  wireKeyboard();
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
}

// ---------------------------------------------------------------- recents

function loadRecents() {
  try { return JSON.parse(localStorage.getItem('db-supplies-recents') || '[]'); }
  catch { return []; }
}
function pushRecent(k) {
  let r = loadRecents().filter(x => x !== k);
  r.unshift(k);
  r = r.slice(0, 6);
  localStorage.setItem('db-supplies-recents', JSON.stringify(r));
  renderRecents();
}
function renderRecents() {
  const r = loadRecents().filter(k => BY_KEY[k]);
  const row = $('recents-row');
  const chips = $('recents-chips');
  if (!r.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  chips.innerHTML = r.map(k => {
    const s = BY_KEY[k];
    const label = s.sku || s.title || k;
    return `<button class="recents-chip" data-k="${escapeHtml(k)}">${escapeHtml(label)}</button>`;
  }).join(' ');
  chips.querySelectorAll('.recents-chip').forEach(b => {
    b.onclick = () => { location.hash = '#' + encodeURIComponent(b.dataset.k); };
  });
}

// ---------------------------------------------------------------- type filters

function typeCounts() {
  const counts = { all: SUPPLIES.length };
  SUPPLIES.forEach(s => {
    const t = s.type || '(uncategorized)';
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

function renderTypeFilters() {
  const counts = typeCounts();
  const types = Object.keys(counts).filter(t => t !== 'all')
    .sort((a, b) => counts[b] - counts[a]);
  const entries = [{ id: 'all', name: 'All', count: counts.all }]
    .concat(types.map(t => ({ id: t, name: t, count: counts[t] })));
  $('type-filters').innerHTML = entries.map(e => {
    const cls = `glossary-chip${activeType === e.id ? ' is-active' : ''}`;
    return `<button class="${cls}" data-type="${escapeHtml(e.id)}">${escapeHtml(e.name)} <span class="gc-count">${e.count}</span></button>`;
  }).join('');
  $('type-filters').querySelectorAll('[data-type]').forEach(b => {
    b.onclick = () => {
      activeType = b.dataset.type;
      if (current) {
        current = null;
        history.replaceState(null, '', location.pathname + location.search);
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
  let list = SUPPLIES.slice();
  if (activeType !== 'all') {
    list = list.filter(s => (s.type || '(uncategorized)') === activeType);
  }
  return list;
}

function renderGrid() {
  const list = filtered();
  if (!list.length) {
    $('grid-slot').innerHTML = `<div class="empty-grid">No supplies match this filter.</div>`;
    return;
  }
  const html = list.map(cardHtml).join('');
  $('grid-slot').innerHTML = `<div class="parts-grid">${html}</div>`;
  $('grid-slot').querySelectorAll('.preview-card').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      location.hash = '#' + encodeURIComponent(a.dataset.k);
    };
  });
}

function cardHtml(s) {
  const imgHtml = s.image
    ? `<div class="preview-image"><img src="${escapeHtml(s.image)}" alt="${escapeHtml(s.sku || s.title)}" loading="lazy"></div>`
    : `<div class="preview-image no-img">No image</div>`;
  const label = s.sku || s.title || '(unnamed)';
  const desc  = s.title && s.title !== label ? s.title : (s.description || '');
  const type  = s.type ? `<span class="preview-finish">${escapeHtml(s.type)}</span>` : '';
  const k = keyOf(s);
  return `<a class="preview-card" data-k="${escapeHtml(k)}" href="#${encodeURIComponent(k)}">
    ${imgHtml}
    <div class="preview-body">
      <div class="preview-num">${escapeHtml(label)}</div>
      <div class="preview-desc">${escapeHtml(desc)}</div>
      ${type}
    </div>
  </a>`;
}

// ---------------------------------------------------------------- search

function search(q) {
  q = q.toLowerCase().trim();
  if (!q) return [];
  const exact = [], prefix = [], contains = [];
  for (const s of SUPPLIES) {
    const sku = (s.sku || '').toLowerCase();
    const title = (s.title || '').toLowerCase();
    const desc = (s.description || '').toLowerCase();
    const type = (s.type || '').toLowerCase();
    const hay = `${sku} ${title} ${desc} ${type}`;
    if (sku === q || title === q) exact.push(s);
    else if (sku.startsWith(q) || title.startsWith(q)) prefix.push(s);
    else if (hay.includes(q)) contains.push(s);
  }
  return [...exact, ...prefix, ...contains].slice(0, 15);
}

function renderSearchResults(items) {
  const box = $('results');
  if (!items.length) { box.hidden = true; box.classList.remove('open'); return; }
  box.innerHTML = items.map((s, i) => {
    const img = s.image
      ? `<div class="lib-result-img"><img src="${escapeHtml(s.image)}" alt="" loading="lazy"></div>`
      : `<div class="lib-result-img no-img">—</div>`;
    const label = s.sku || s.title || '—';
    const sub = (s.title && s.title !== label) ? s.title : (s.description || '');
    return `<li class="lib-result" data-k="${escapeHtml(keyOf(s))}" data-idx="${i}">
      ${img}
      <div class="lib-result-text">
        <div class="lib-result-num">${escapeHtml(label)}</div>
        <div class="lib-result-desc">${escapeHtml(sub)}</div>
      </div>
      <div class="lib-result-meta">${escapeHtml(s.type || '')}</div>
    </li>`;
  }).join('');
  box.hidden = false; box.classList.add('open');
  activeResultIdx = -1;
  box.querySelectorAll('.lib-result').forEach(el => {
    el.onclick = () => { location.hash = '#' + encodeURIComponent(el.dataset.k); };
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
      location.hash = '#' + encodeURIComponent(tgt.dataset.k);
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

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('search')) {
      e.preventDefault(); $('search').focus(); $('search').select();
    }
  });
}

// ---------------------------------------------------------------- spec card

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function statusClass(status) {
  if (status === 'Active') return 'active';
  if (status === 'Introducing') return 'introducing';
  if (status === 'Discontinuing') return 'discontinuing';
  if (status === 'Inactive') return 'inactive';
  return '';
}

function showSupply(k) {
  const s = BY_KEY[k];
  if (!s) return;
  current = s;
  pushRecent(k);
  $('search').value = '';
  $('results').hidden = true;
  history.replaceState(null, '', '#' + encodeURIComponent(k));
  renderSpec(s);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function backToBrowse() {
  current = null;
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
  history.replaceState(null, '', location.pathname + location.search);
  renderGrid();
}

function renderSpec(s) {
  const imgHtml = s.image
    ? `<div class="spec-image"><img src="${escapeHtml(s.image)}" alt="${escapeHtml(s.sku || s.title)}"></div>`
    : `<div class="spec-image no-img">No image</div>`;

  const skuLabel = s.sku || s.title || '—';
  const subtitle = s.title && s.title !== skuLabel ? s.title : '';
  const typeChip = s.type ? `<span class="spec-glossary-chip">${escapeHtml(s.type)}</span>` : '';

  const keyFacts = [
    { label: 'Type',         val: s.type },
    { label: 'Reorder qty',  val: s.reorder_qty },
    { label: 'Last edited',  val: fmtDate(s.last_edited_at) },
  ];
  const keyFactsHtml = keyFacts.map(q => {
    const empty = q.val == null || q.val === '';
    const val = empty ? '—' : escapeHtml(String(q.val));
    return `<div class="keyfact">
      <div class="keyfact-label">${escapeHtml(q.label)}</div>
      <div class="keyfact-val ${empty ? 'empty' : ''}">${val}</div>
    </div>`;
  }).join('');

  const descBlock = s.description
    ? `<p class="spec-definition">${escapeHtml(s.description)}</p>`
    : '';

  const adminBits = [];
  if (s.last_edited_at) adminBits.push(`Last edited ${escapeHtml(s.last_edited_at.split('T')[0])}`);
  if (s.page_url) adminBits.push(`<a href="${escapeHtml(s.page_url)}" target="_blank" rel="noopener">Open in Notion ↗</a>`);
  const adminHtml = `<footer class="spec-admin">${adminBits.join(' · ')}</footer>`;

  const html = `
    <article class="spec-card">
      <button class="spec-back" type="button">← Back to supplies</button>

      <div class="spec-head">
        ${imgHtml}
        <div class="spec-summary">
          <div class="spec-num-row">
            <span class="spec-num">${escapeHtml(skuLabel)}</span>
            <span class="spec-status ${statusClass(s.status)}">${escapeHtml(s.status || 'Status unknown')}</span>
            ${typeChip}
          </div>
          ${subtitle ? `<h2 class="spec-title">${escapeHtml(subtitle)}</h2>` : ''}
          ${descBlock}
          <div class="spec-keyfacts">${keyFactsHtml}</div>
        </div>
      </div>

      ${adminHtml}
    </article>
  `;

  $('spec-slot').innerHTML = html;
  $('spec-slot').hidden = false;
  $('grid-slot').hidden = true;
  $('spec-slot').querySelector('.spec-back').onclick = backToBrowse;
}

// ---------------------------------------------------------------- routing

function routeFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && BY_KEY[hash]) {
    showSupply(hash);
    return;
  }
  current = null;
  $('spec-slot').hidden = true;
  $('grid-slot').hidden = false;
  renderGrid();
}

bootstrap();
