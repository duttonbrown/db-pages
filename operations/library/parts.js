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
  $('lib-count').innerHTML = `<b>${DATA.counts.parts}</b> parts · <b>${DATA.counts.glossary}</b> categories`;

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

function renderGlossary() {
  const counts = partCountsByGlossary();
  const entries = DATA.glossary
    .map(g => ({ ...g, count: counts[g.id] || 0 }))
    .sort((a, b) => {
      if (a.id === 'all') return -1;
      if (b.id === 'all') return 1;
      return b.count - a.count;
    });
  $('glossary').innerHTML = entries.map(g => {
    if (g.id !== 'all' && !g.count) return '';
    return `<button class="glossary-chip${g.id === activeGlossary ? ' is-active' : ''}" data-gid="${escapeHtml(g.id)}">${escapeHtml(g.name || '(unnamed)')} <span class="gc-count">${g.count}</span></button>`;
  }).join('');
  $('glossary').querySelectorAll('.glossary-chip').forEach(b => {
    b.onclick = () => {
      activeGlossary = b.dataset.gid;
      renderGlossary();
      // If we're viewing a part, leaving filter as-is doesn't hide it; only re-renders grid if visible
      if ($('spec-slot').hidden === false) {
        // grid stays hidden; just refresh on back
      } else {
        renderGrid();
      }
    };
  });
}

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
  return `<a class="preview-card" data-pn="${escapeHtml(p.part_number)}" href="#${encodeURIComponent(p.part_number)}">
    ${imgHtml}
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
function showPart(pn) {
  const p = PARTS_BY_NUM[pn];
  if (!p) return;
  currentPart = p;
  pushRecent(pn);
  $('search').value = '';
  $('results').hidden = true;
  history.replaceState(null, '', '#' + encodeURIComponent(pn));
  renderSpec(p);
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

function statusClass(s) {
  return s === 'Active' ? 'active' : '';
}

function renderSpec(p) {
  const fam = DATA.families[p.family_id] || {};
  const gloss = fam.glossary || {};
  const siblings = (DATA.siblings[p.family_id] || []).map(pn => PARTS_BY_NUM[pn]).filter(Boolean);

  const imgHtml = p.image
    ? `<div class="spec-image"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.part_number)}"></div>`
    : `<div class="spec-image no-img">No image</div>`;

  // Quick facts
  const quick = [
    { label: 'Material', val: (fam.materials || []).join(', ') },
    { label: 'Lead time', val: p.lead_time },
    { label: 'Last ordered', val: fmtDate(p.last_ordered) },
    { label: 'Vendor', val: fam.vendor },
    { label: 'MOQ', val: p.moq },
    { label: 'Reorder qty', val: p.reorder_qty },
  ];
  const quickHtml = quick.map(q => {
    const empty = q.val == null || q.val === '';
    const val = empty ? '—' : escapeHtml(String(q.val));
    return `<div>
      <div class="quick-label">${escapeHtml(q.label)}</div>
      <div class="quick-val ${empty ? 'empty' : ''}">${val}</div>
    </div>`;
  }).join('');

  const finishPill = p.finish
    ? `<span class="spec-finish-pill">${escapeHtml(p.finish)} finish</span>`
    : '';

  // Siblings
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
    siblingsHtml = `<div class="siblings">
      <div class="siblings-head">
        <span class="siblings-label">Same family · ${siblings.length} variants</span>
        <span class="siblings-base">Base: <b>${escapeHtml(fam.part_number || '')}</b>${fam.description ? ' · ' + escapeHtml(fam.description) : ''}</span>
      </div>
      <div class="siblings-row">${sibs}</div>
    </div>`;
  }

  // Demand panel
  const u24 = p.use_2024 || 0;
  const u25 = p.use_2025 || 0;
  let delta = '';
  if (u24 > 0) {
    const pct = ((u25 - u24) / u24) * 100;
    const cls = pct > 5 ? 'up' : (pct < -5 ? 'down' : 'flat');
    const arrow = pct > 5 ? '↑' : (pct < -5 ? '↓' : '→');
    delta = `<div class="year-block">
      <div class="year-label">YoY</div>
      <div class="year-delta ${cls}">${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</div>
    </div>`;
  } else if (u25 > 0) {
    delta = `<div class="year-block">
      <div class="year-label">YoY</div>
      <div class="year-delta up">↑ NEW</div>
    </div>`;
  }
  const demandHtml = `
    <div class="year-row">
      <div class="year-block">
        <div class="year-label">2024 usage</div>
        <div class="year-val ${u24 ? '' : 'empty'}">${u24 ? u24.toLocaleString() : '0'}</div>
      </div>
      <div class="year-block">
        <div class="year-label">2025 usage</div>
        <div class="year-val ${u25 ? '' : 'empty'}">${u25 ? u25.toLocaleString() : '0'}</div>
      </div>
      ${delta}
    </div>
    <p class="demand-note">Usage from Notion Parts DB.${p.last_ordered ? ` Last ordered ${escapeHtml(fmtDate(p.last_ordered))}` : ''}${p.lead_time ? ` · ${escapeHtml(p.lead_time)} lead time` : ''}.</p>
  `;

  // Used In panel (from family.products)
  const products = fam.products || [];
  const usedInHtml = products.length
    ? `<div class="product-grid">${products.map(prod => `
        <a class="product-card-mini" href="${escapeHtml(prod.url || '#')}" target="_blank" rel="noopener" title="${escapeHtml(prod.title || '')}">
          <span class="sku">${escapeHtml(prod.sku)}</span>
          <span class="title">${escapeHtml(prod.title || '—')}</span>
        </a>`).join('')}</div>`
    : `<div class="empty-panel">Not used in any product BOM yet.</div>`;

  // Notes panel
  const notesItems = [
    { label: 'Definition', val: gloss.definition || fam.definition || '' },
    { label: 'In-house process', val: (p.in_house_processes || fam.in_house_processes || []).join(', ') },
    { label: 'Raw or Pre-finished', val: fam.raw_or_prefinished || '' },
    { label: 'Glossary type', val: gloss.name ? `${gloss.name}${gloss.abbr ? ` (${gloss.abbr})` : ''}` : '' },
    { label: 'Last edited (Notion)', val: p.last_edited_at ? p.last_edited_at.split('T')[0] : '' },
  ];
  const notesHtml = `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 24px;">
    ${notesItems.map(n => `<div>
      <div class="quick-label">${escapeHtml(n.label)}</div>
      <div class="quick-val ${n.val ? '' : 'empty'}">${n.val ? escapeHtml(n.val) : '—'}</div>
    </div>`).join('')}
    <div style="grid-column: 1 / -1;">
      <div class="quick-label">Notion link</div>
      <div class="quick-val"><a href="${escapeHtml(p.page_url)}" target="_blank" rel="noopener">Open part in Notion ↗</a>${fam.page_url ? ` · <a href="${escapeHtml(fam.page_url)}" target="_blank" rel="noopener">Open family ↗</a>` : ''}</div>
    </div>
  </div>`;

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
            ${finishPill}
            <span class="spec-status ${statusClass(p.status)}">${escapeHtml(p.status || 'Status unknown')}</span>
          </div>
          <h2 class="spec-title">${escapeHtml(title)}</h2>
          <p class="spec-definition">${escapeHtml(definition)}</p>
          <div class="spec-quick">${quickHtml}</div>
        </div>
      </div>
      ${siblingsHtml}
      <div class="spec-tabs">
        <button class="spec-tab is-active" data-tab="demand">Demand</button>
        <button class="spec-tab" data-tab="used">Used In <span class="tab-count">${products.length}</span></button>
        <button class="spec-tab" data-tab="notes">Notes &amp; Refs</button>
      </div>
      <div class="spec-panel is-active" data-panel="demand">${demandHtml}</div>
      <div class="spec-panel" data-panel="used">${usedInHtml}</div>
      <div class="spec-panel" data-panel="notes">${notesHtml}</div>
    </article>
  `;

  $('spec-slot').innerHTML = html;
  $('spec-slot').hidden = false;
  $('grid-slot').hidden = true;

  // wire
  $('spec-slot').querySelector('.spec-back').onclick = backToBrowse;
  $('spec-slot').querySelectorAll('.spec-tab').forEach(t => {
    t.onclick = () => {
      $('spec-slot').querySelectorAll('.spec-tab').forEach(x => x.classList.remove('is-active'));
      $('spec-slot').querySelectorAll('.spec-panel').forEach(x => x.classList.remove('is-active'));
      t.classList.add('is-active');
      $('spec-slot').querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('is-active');
    };
  });
  $('spec-slot').querySelectorAll('.sibling').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); showPart(a.dataset.pn); };
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
