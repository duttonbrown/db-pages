// Inventory Request Form — Cloudflare Worker proxy
// Endpoints:
//   GET  /search?q=...   -> merged results from Parts + Supplies
//   GET  /requestors     -> Notion users (filtered to people)
//   POST /submit         -> creates a row in Inventory Request Log
//
// Required Worker secret: NOTION_API_KEY (set via `wrangler secret put NOTION_API_KEY`)

const NOTION_VERSION = "2022-06-28";
const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes
let CATALOG_CACHE = null; // { ts: number, data: { parts:[], supplies:[] } }

// ----- Static parts-library cache -----
//
// The Parts Library project (db-operations/projects/bom-source-of-truth/parts_fetch.py)
// downloads every Part image and commits it to db-pages at
//   operations/library/parts-images/<part_number>.<ext>
// alongside a parts-library.json index. We mirror catalog image URLs to those
// static files so we don't hand the browser Notion signed URLs that expire
// every hour. The static images are served by GitHub Pages and never expire.
//
// Fallback: when a part has no entry in the library (rare — only happens for
// brand-new parts added since the last parts_fetch run), or for supplies
// (currently not mirrored), we keep using Notion's signed URL.
const PARTS_LIBRARY_URL = "https://duttonbrown.github.io/db-pages/operations/library/parts-library.json";
const STATIC_IMAGE_BASE = "https://duttonbrown.github.io/db-pages/operations/library";
const PARTS_LIBRARY_TTL_MS = 30 * 60 * 1000; // 30 min
// Cache shape: { ts, byPartNumber: {KEY -> url}, bySupplyPageId: {id -> url} }.
// Parts key on part number (worker has it from titleOf). Supplies key on
// page_id because their "title" / "SKU" inconsistency makes name-matching
// fragile, but every supply row in the catalog already carries the page id.
let PARTS_LIBRARY_CACHE = null;

// Normalize a part number for cross-source lookup. Slash/underscore are
// interchangeable in our data ("CRT5/8" === "CRT5_8"), and we uppercase to
// dodge accidental case mismatches. Matches the convention used elsewhere
// (see feedback memory: slash/underscore equivalence).
function normalizePartKey(s) {
  return String(s || "").trim().toUpperCase().replace(/\//g, "_");
}

async function getPartsLibrary() {
  const now = Date.now();
  if (PARTS_LIBRARY_CACHE && (now - PARTS_LIBRARY_CACHE.ts) < PARTS_LIBRARY_TTL_MS) {
    return PARTS_LIBRARY_CACHE;
  }
  try {
    const res = await fetch(PARTS_LIBRARY_URL, { cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const byPartNumber = {};
    for (const p of data.parts || []) {
      if (!p.image || !p.part_number) continue;
      byPartNumber[normalizePartKey(p.part_number)] = `${STATIC_IMAGE_BASE}/${p.image}`;
    }
    const bySupplyPageId = {};
    for (const s of data.supplies || []) {
      if (!s.image || !s.page_id) continue;
      bySupplyPageId[s.page_id] = `${STATIC_IMAGE_BASE}/${s.image}`;
    }
    PARTS_LIBRARY_CACHE = { ts: now, byPartNumber, bySupplyPageId };
    return PARTS_LIBRARY_CACHE;
  } catch (e) {
    // If GitHub Pages or the library fetch fails, fall back to the previous
    // cache (even if stale) — better to serve possibly-stale static URLs than
    // none. If we never had a cache, return empty maps so the catalog falls
    // back to Notion signed URLs (current behavior).
    if (PARTS_LIBRARY_CACHE) return PARTS_LIBRARY_CACHE;
    return { byPartNumber: {}, bySupplyPageId: {} };
  }
}

// Static-library URL resolution. Parts key on part_number, supplies key on
// page_id (Notion page id is stable; SKU/title vary in inconsistent ways).
function resolveStaticPartImage(partNumber, fallbackUrl, lib) {
  if (!partNumber || !lib) return fallbackUrl;
  return lib.byPartNumber[normalizePartKey(partNumber)] || fallbackUrl;
}
function resolveStaticSupplyImage(pageId, fallbackUrl, lib) {
  if (!pageId || !lib) return fallbackUrl;
  return lib.bySupplyPageId[pageId] || fallbackUrl;
}

// Log DB schema cache — used to gate writes against new optional properties
// (Qty Received, Receipt Log, Receiver) so the worker degrades gracefully
// when Thomas hasn't added them in Notion yet. Refreshed every 10 min.
let LOG_SCHEMA_CACHE = null; // { ts, propNames: Set }
const LOG_SCHEMA_TTL_MS = 10 * 60 * 1000;
async function getLogSchema(env) {
  const now = Date.now();
  if (LOG_SCHEMA_CACHE && (now - LOG_SCHEMA_CACHE.ts) < LOG_SCHEMA_TTL_MS) {
    return LOG_SCHEMA_CACHE.propNames;
  }
  try {
    const data = await notion(`/databases/${DB.LOG}`, env);
    const propNames = new Set(Object.keys(data.properties || {}));
    LOG_SCHEMA_CACHE = { ts: now, propNames };
    return propNames;
  } catch (e) {
    // If schema lookup fails, return whatever we have or a permissive empty
    // set (worker will attempt writes; if a property is missing Notion 400s).
    return LOG_SCHEMA_CACHE?.propNames || new Set();
  }
}
function filterPropsBySchema(props, schemaSet) {
  if (!schemaSet || schemaSet.size === 0) return props;
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (schemaSet.has(k)) out[k] = v;
  }
  return out;
}

// Idempotency cache — when a client retries a /submit after a partial failure,
// we look up the same key here and return the prior response instead of
// creating duplicate Notion rows. 60s window is enough for human retries and
// short enough that worker memory doesn't bloat.
const IDEMPOTENCY_TTL_MS = 60 * 1000;
const IDEMPOTENCY_CACHE = new Map(); // key -> { ts, response }

function rememberIdempotent(key, response) {
  if (!key) return;
  IDEMPOTENCY_CACHE.set(key, { ts: Date.now(), response });
  // Opportunistic cleanup so the Map doesn't grow unbounded
  if (IDEMPOTENCY_CACHE.size > 200) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of IDEMPOTENCY_CACHE) {
      if (v.ts < cutoff) IDEMPOTENCY_CACHE.delete(k);
    }
  }
}

function lookupIdempotent(key) {
  if (!key) return null;
  const hit = IDEMPOTENCY_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > IDEMPOTENCY_TTL_MS) {
    IDEMPOTENCY_CACHE.delete(key);
    return null;
  }
  return hit.response;
}

const DB = {
  PARTS:         "c3b34a1d-ff3d-4158-9cef-18cfc765ad7f",
  PART_FAMILIES: "2ceffa52-4c5b-8001-9b86-ee820e163f41",
  PART_TYPES:    "2ccffa52-4c5b-80a0-9b0c-e61fc69193d8",
  SUPPLIES:      "2c3ffa52-4c5b-80ef-9fb5-f4470dec1d0c",
  LOG:           "34affa52-4c5b-8183-998c-d29c785e4aa6",
};

const REQUESTOR_OPTIONS = [
  "Alex", "Catherine", "Chase", "Emma", "Eric", "Hannah",
  "Janet", "Sarah", "Scott", "Thomas", "Willy", "Zach"
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function notion(path, env, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Attach the upstream status as a property so the top-level fetch handler
    // can return a tagged JSON error and pages can show a friendly message
    // instead of the raw Notion error string. 5xx = Notion outage; 429 = rate
    // limited (treat like an outage from the user's POV).
    const err = new Error(`Notion ${path} ${res.status}: ${text}`);
    err.upstreamStatus = res.status;
    err.upstream = "notion";
    throw err;
  }
  return JSON.parse(text);
}

function plainText(richTextArr) {
  if (!richTextArr || !Array.isArray(richTextArr)) return "";
  return richTextArr.map(r => r.plain_text || "").join("");
}

function titleOf(page) {
  for (const p of Object.values(page.properties || {})) {
    if (p.type === "title") return plainText(p.title);
  }
  return "";
}

function vendorIdsFromRollup(prop) {
  const arr = prop?.rollup?.array || [];
  const ids = [];
  for (const a of arr) {
    for (const rel of a?.relation || []) if (rel.id) ids.push(rel.id);
  }
  return ids;
}

function vendorIdsFromRelation(prop) {
  return (prop?.relation || []).map(r => r.id);
}

async function resolveVendorNames(vendorIds, env) {
  // Cache: id -> name
  const unique = [...new Set(vendorIds)];
  const pairs = await Promise.all(unique.map(async (id) => {
    try {
      const page = await notion(`/pages/${id}`, env);
      return [id, titleOf(page)];
    } catch {
      return [id, ""];
    }
  }));
  return Object.fromEntries(pairs);
}

function partRow(p, descriptionFallback) {
  const desc = plainText(p.properties?.Filename?.rich_text) || descriptionFallback || "";
  return {
    type: "Part",
    id: p.id,
    title: titleOf(p),
    subtitle: desc,
    description: descriptionFallback || "",
    status: p.properties?.["Part Family Status"]?.rollup?.array?.[0]?.select?.name
         || p.properties?.Status?.select?.name || "",
    image: p.properties?.Image?.files?.[0]?.file?.url
        || p.properties?.Image?.files?.[0]?.external?.url || null,
    _vendorIds: vendorIdsFromRollup(p.properties?.Vendor),
    vendor: "",
    use2025: p.properties?.["2025 Use"]?.number ?? null,
    moq: p.properties?.MOQ?.number ?? null,
    reorderQty: p.properties?.["Reorder Qty."]?.number ?? null,
  };
}

// Direct part-number / filename match
async function searchPartsDirect(query, env) {
  const data = await notion(`/databases/${DB.PARTS}/query`, env, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        or: [
          { property: "Part Number", title: { contains: query } },
          { property: "Filename",    rich_text: { contains: query } },
        ],
      },
      page_size: 6,
    }),
  });
  return data.results.map(p => partRow(p));
}

// Match a Part Family by name/description, then return all its variant Parts
async function searchPartsViaFamily(query, env) {
  const fams = await notion(`/databases/${DB.PART_FAMILIES}/query`, env, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        or: [
          { property: "Name",        title: { contains: query } },
          { property: "Description", rich_text: { contains: query } },
        ],
      },
      page_size: 4,
    }),
  });

  const out = [];
  for (const fam of fams.results) {
    const description = plainText(fam.properties?.Description?.rich_text) || "";
    const variantIds = (fam.properties?.Products?.relation || []).map(r => r.id).slice(0, 6);
    if (variantIds.length === 0) continue;

    // Fetch each variant page (parallel)
    const variants = await Promise.all(
      variantIds.map(id => notion(`/pages/${id}`, env).catch(() => null))
    );
    for (const v of variants) {
      if (v && !v.archived) out.push(partRow(v, description));
    }
  }
  return out;
}

async function searchParts(query, env) {
  const [direct, viaFamily] = await Promise.all([
    searchPartsDirect(query, env),
    searchPartsViaFamily(query, env),
  ]);
  // Dedupe by id; direct hits ranked first
  const seen = new Set();
  const merged = [];
  for (const r of [...direct, ...viaFamily]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}

async function searchSupplies(query, env) {
  const body = {
    filter: {
      or: [
        { property: "Title", title: { contains: query } },
        { property: "SKU", rich_text: { contains: query } },
        { property: "Description", rich_text: { contains: query } },
      ],
    },
    page_size: 8,
  };
  const data = await notion(`/databases/${DB.SUPPLIES}/query`, env, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.results.map(s => ({
    type: "Supply",
    id: s.id,
    title: titleOf(s),
    subtitle: plainText(s.properties?.Description?.rich_text)
           || plainText(s.properties?.SKU?.rich_text) || "",
    description: plainText(s.properties?.Description?.rich_text) || "",
    status: s.properties?.Status?.select?.name || "",
    image: s.properties?.image?.files?.[0]?.file?.url
        || s.properties?.image?.files?.[0]?.external?.url || null,
    _vendorIds: vendorIdsFromRelation(s.properties?.Vendor),
    vendor: "",
    use2025: null,
    reorderQty: plainText(s.properties?.["Reorder QTY"]?.rich_text) || null,
    leadTime: null,
  }));
}

async function attachVendorNames(rows, env) {
  const allIds = [];
  for (const r of rows) for (const id of r._vendorIds || []) allIds.push(id);
  if (allIds.length === 0) return rows;
  const map = await resolveVendorNames(allIds, env);
  for (const r of rows) {
    r.vendor = (r._vendorIds || []).map(id => map[id]).filter(Boolean).join(", ");
    delete r._vendorIds;
  }
  return rows;
}

// ---------- Full catalog (cached) ----------

async function paginatedQuery(dbId, body, env, cap = 1000) {
  const results = [];
  let cursor = undefined;
  while (results.length < cap) {
    const data = await notion(`/databases/${dbId}/query`, env, {
      method: "POST",
      body: JSON.stringify({ ...body, start_cursor: cursor, page_size: 100 }),
    });
    results.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return results;
}

async function buildCatalog(env) {
  // Pull active Parts, Supplies, Families, Part Types, AND the parts-library
  // image index in parallel. The library lookup is cheap (one fetch of a
  // static JSON file from GitHub Pages, cached 30 min on the worker side
  // and 5 min at Cloudflare's edge).
  const [parts, supplies, families, partTypes, lib] = await Promise.all([
    paginatedQuery(DB.PARTS,         {}, env),
    paginatedQuery(DB.SUPPLIES,      {}, env),
    paginatedQuery(DB.PART_FAMILIES, {}, env),
    paginatedQuery(DB.PART_TYPES,    {}, env),
    getPartsLibrary(),
  ]);

  // Map type id -> name (Box, Wire Nut, Shade, etc.)
  const typeNameById = {};
  for (const t of partTypes) typeNameById[t.id] = titleOf(t);

  // Map family id -> { name, description, status, type names }
  const famById = {};
  for (const f of families) {
    const typeIds = (f.properties?.Type?.relation || []).map(r => r.id);
    famById[f.id] = {
      name:        titleOf(f),
      description: plainText(f.properties?.Description?.rich_text) || "",
      status:      f.properties?.Status?.select?.name || "",
      typeNames:   typeIds.map(id => typeNameById[id]).filter(Boolean),
    };
  }

  // Build Parts rows (description + type from parent family)
  const partRows = parts.map(p => {
    const famRel = p.properties?.["Part Family"]?.relation?.[0]?.id;
    const fam = famRel ? famById[famRel] : null;
    const partNumber = titleOf(p);
    const notionImage = p.properties?.Image?.files?.[0]?.file?.url
                     || p.properties?.Image?.files?.[0]?.external?.url || null;
    return {
      type: "Part",
      id: p.id,
      title: partNumber,
      description: fam?.description || "",
      subtitle: plainText(p.properties?.Filename?.rich_text) || "",
      familyName: fam?.name || "",
      category: fam?.typeNames?.join(", ") || "",
      status: fam?.status
           || p.properties?.["Part Family Status"]?.rollup?.array?.[0]?.select?.name
           || p.properties?.Status?.select?.name || "",
      // Prefer the static-library URL (never expires) over the Notion signed
      // URL (expires after 1 hour). Falls back to the Notion URL when the
      // part hasn't been mirrored yet — first request after a new part is
      // added will still get a working image until the next parts_fetch run.
      image: resolveStaticPartImage(partNumber, notionImage, lib),
      _vendorIds: vendorIdsFromRollup(p.properties?.Vendor),
      vendor: "",
      use2025:    p.properties?.["2025 Use"]?.number ?? null,
      moq:        p.properties?.MOQ?.number ?? null,
      reorderQty: p.properties?.["Reorder Qty."]?.number ?? null,
      leadTime:   plainText(p.properties?.["Lead Time"]?.rich_text) || null,
    };
  });

  // Build Supplies rows
  // Display ordering: SKU shows as the title (left/bold), supply name shows as description (right).
  // This matches Parts (which show Part Number first, family/description after) for visual consistency,
  // even though the underlying Notion DB stores the descriptive name as the title.
  const supplyRows = supplies.map(s => {
    const sku  = plainText(s.properties?.SKU?.rich_text) || "";
    const name = titleOf(s); // descriptive name in Notion
    const desc = plainText(s.properties?.Description?.rich_text) || "";
    const notionImage = s.properties?.image?.files?.[0]?.file?.url
                     || s.properties?.image?.files?.[0]?.external?.url || null;
    // If there's no SKU, fall back to the descriptive name as the title.
    return {
    type: "Supply",
    id: s.id,
    title: sku || name,
    description: sku ? (name + (desc ? ` — ${desc}` : "")) : desc,
    subtitle:    desc || name,
    familyName: "",
    category: s.properties?.Type?.select?.name || "",
    status: s.properties?.Status?.select?.name || "",
    // Prefer the static-library mirror over Notion signed URL (expires 1h).
    image: resolveStaticSupplyImage(s.id, notionImage, lib),
    _vendorIds: vendorIdsFromRelation(s.properties?.Vendor),
    vendor: "",
    use2025: null,
    reorderQty: plainText(s.properties?.["Reorder QTY"]?.rich_text) || null,
    leadTime: null,
    };
  });

  // Resolve all vendor names in one batch
  const all = [...partRows, ...supplyRows];
  await attachVendorNames(all, env);

  // Filter out non-active items (drop discontinued/inactive)
  const isActive = (r) => !r.status || r.status === "Active" || r.status === "Introducing";
  return {
    parts:    partRows.filter(isActive),
    supplies: supplyRows.filter(isActive),
  };
}

async function getCatalog(env, force = false) {
  const now = Date.now();
  if (!force && CATALOG_CACHE && (now - CATALOG_CACHE.ts) < CATALOG_TTL_MS) {
    return CATALOG_CACHE.data;
  }
  const data = await buildCatalog(env);
  CATALOG_CACHE = { ts: now, data };
  return data;
}

// ---------- /search keeps live API search as a fallback ----------

function currentYearPrefix() {
  // Two-digit year, e.g. 2026 -> "26"
  return String(new Date().getFullYear()).slice(-2);
}

async function maxOrderNumber(env) {
  const yy = currentYearPrefix();
  const prefix = `REQ-${yy}-`;
  // Title property is now called "Request #" (was "Order #" before the schema
  // split; "Order #" is now a separate rich_text field for customer orders).
  const data = await notion(`/databases/${DB.LOG}/query`, env, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "Request #", title: { starts_with: prefix } },
      sorts:  [{ property: "Request #", direction: "descending" }],
      page_size: 50,
    }),
  });
  let max = 0;
  const rx = new RegExp(`^REQ-${yy}-(\\d+)`);
  for (const row of data.results) {
    const m = titleOf(row).match(rx);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

function formatOrderNum(n) {
  return `REQ-${currentYearPrefix()}-${String(n).padStart(4, "0")}`;
}

const VALID_TYPES = ["Part", "Supply", "Other"];

// Status values the purchaser can land a row at directly when self-adding from
// the Purchase page. Default is "Submitted" (the requester flow). The Purchase
// page's "+ Add to queue" sends "Waiting to Order" — the purchaser already
// knows we need it, so skip the triage step.
const VALID_INITIAL_STATUSES = ["Submitted", "Waiting to Order"];

function validateItem(item) {
  if (!item.type || !VALID_TYPES.includes(item.type)) {
    return `type must be one of: ${VALID_TYPES.join(", ")}`;
  }
  if (item.notInDb || item.type === "Other") {
    if (!item.customName || !item.customName.trim()) {
      return "customName is required when notInDb is true or type is Other";
    }
  } else if (!item.relationId) {
    return "relationId is required when selecting an item from the database";
  }
  return null;
}

function validatePayload(payload) {
  if (!payload.requestor || !REQUESTOR_OPTIONS.includes(payload.requestor)) {
    return `requestor must be one of: ${REQUESTOR_OPTIONS.join(", ")}`;
  }
  if (payload.initialStatus && !VALID_INITIAL_STATUSES.includes(payload.initialStatus)) {
    return `initialStatus must be one of: ${VALID_INITIAL_STATUSES.join(", ")}`;
  }
  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0) {
    return "items must be a non-empty array";
  }
  for (let i = 0; i < items.length; i++) {
    const err = validateItem(items[i]);
    if (err) return `item ${i}: ${err}`;
  }
  return null;
}

function buildProps(item, orderNum, sharedNotes, requestor, today, initialStatus) {
  // The title property is "Request #" (REQ-26-NNNN). "Order #" is now a
  // separate rich_text field for the customer/Shopify order number, filled
  // by the purchaser at Mark Ordered time — not at submit.
  const props = {
    "Request #":      { title: [{ text: { content: orderNum } }] },
    "Status":         { status: { name: initialStatus || "Submitted" } },
    "Date Requested": { date: { start: today } },
    "Type":           { select: { name: item.type } },
    "Requestor":      { select: { name: requestor } },
    "Priority":       { select: { name: item.outOfStock ? "Urgent" : "Normal" } },
  };

  // Vendor Name (cached) — text column. Notion's formula chain through
  // Part → Part Family → Vendors hits a "rollup-of-rollup" wall, so we
  // bake the resolved vendor name in here at submit time. This drives
  // the Vendor column in Notion table/board views.
  if (item.vendor && item.vendor.trim()) {
    props["Vendor Name"] = {
      rich_text: [{ text: { content: item.vendor.slice(0, 200) } }],
    };
  }

  // MOQ: pull from source DB if known. Parts: number; Supplies: rich_text (often empty).
  if (typeof item.moq === "number") {
    props["MOQ"] = { number: item.moq };
  } else if (typeof item.moq === "string" && item.moq.trim()) {
    const parsed = parseFloat(item.moq);
    if (!Number.isNaN(parsed)) props["MOQ"] = { number: parsed };
  }

  if (item.outOfStock) props["Out of Stock"] = { checkbox: true };

  // Qty Ordered — set at submit ONLY for one-time purchases (where the
  // requester knows the qty themselves). Regular catalog requests leave
  // this blank so the purchaser sets it at Mark Ordered time based on
  // MOQ and usage.
  if (item.oneTime && typeof item.qtyOrdered === "number" && item.qtyOrdered > 0) {
    props["Qty Ordered"] = { number: item.qtyOrdered };
  }

  const noteParts = [];
  if (item.notes && item.notes.trim()) noteParts.push(item.notes.trim());
  if (sharedNotes && sharedNotes.trim()) noteParts.push(sharedNotes.trim());
  if (noteParts.length) {
    props["Notes"] = {
      rich_text: [{ text: { content: noteParts.join(" — ").slice(0, 2000) } }],
    };
  }

  if (item.notInDb || item.type === "Other") {
    props["Not in DB"] = { checkbox: true };
    if (item.customName && item.customName.trim()) {
      // Prefix marker depends on intent: one-time purchases don't need
      // "New Item Request:" (they aren't candidates for the catalog).
      // The Notes field already carries SKU/link/etc, so the title can
      // be the bare item name.
      const prefix = item.oneTime ? "One-time: " : "New Item Request: ";
      const prefixed = `${prefix}${item.customName.trim()}`.slice(0, 200);
      props["Custom Item Name"] = {
        rich_text: [{ text: { content: prefixed } }],
      };
    }
  } else if (item.relationId) {
    if (item.type === "Part") {
      props["Part"] = { relation: [{ id: item.relationId }] };
    } else if (item.type === "Supply") {
      props["Supply"] = { relation: [{ id: item.relationId }] };
    }
  }

  return props;
}

async function createRequests(items, requestor, sharedNotes, env, initialStatus) {
  const today = new Date().toISOString().slice(0, 10);
  const startMax = await maxOrderNumber(env);

  // Enrich each item with vendor (and other catalog facts) so we can write
  // a real text value into the Vendor Name column at create time.
  const catalog = await getCatalog(env).catch(() => ({ parts: [], supplies: [] }));
  const byId = {};
  for (const p of catalog.parts || []) byId[p.id] = p;
  for (const s of catalog.supplies || []) byId[s.id] = s;
  for (const it of items) {
    if (it.relationId && byId[it.relationId]) {
      const src = byId[it.relationId];
      if (!it.vendor) it.vendor = src.vendor || "";
      // MOQ resolution preference: explicit MOQ from the Parts DB, then
      // Reorder Qty as a fallback. Reorder Qty was the historical proxy
      // before MOQ existed as its own column.
      if (it.moq === undefined || it.moq === null || it.moq === "") {
        it.moq = (typeof src.moq === "number" ? src.moq : null) ?? src.reorderQty ?? null;
      }
    }
  }

  // Per-item try/catch so one failure doesn't strand the rest of the batch.
  // We return both lists; the caller turns this into a partial-success
  // response the client can act on (retry just the failed items).
  const created = [];
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const orderNum = formatOrderNum(startMax + 1 + i);
    try {
      const props = buildProps(items[i], orderNum, sharedNotes, requestor, today, initialStatus);
      const page = await notion(`/pages`, env, {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: DB.LOG },
          properties: props,
        }),
      });
      created.push({ orderNum, pageId: page.id, url: page.url, index: i });
    } catch (e) {
      const label = items[i].customName
        || (items[i].relationId && byId[items[i].relationId]?.title)
        || `Item ${i + 1}`;
      failed.push({
        index: i,
        label,
        error: String(e.message || e).slice(0, 500),
      });
    }
  }
  return { created, failed };
}

// ---------- Purchaser Console support ----------

let PEOPLE_CACHE = null; // { ts, byFirstName: { Catherine: "uuid", ... } }
const PEOPLE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getPeopleByFirstName(env, force = false) {
  const now = Date.now();
  if (!force && PEOPLE_CACHE && (now - PEOPLE_CACHE.ts) < PEOPLE_TTL_MS) {
    return PEOPLE_CACHE.byFirstName;
  }
  const data = await notion(`/users?page_size=100`, env);
  const byFirstName = {};
  for (const u of data.results || []) {
    if (u.type !== "person") continue;
    const raw = (u.name || "").trim().split(/\s+/)[0];
    if (!raw) continue;
    // Normalize to title-case key so "catherine" and "Catherine" both resolve
    const titleCase = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (!byFirstName[titleCase]) byFirstName[titleCase] = u.id;
  }
  PEOPLE_CACHE = { ts: now, byFirstName };
  return byFirstName;
}

function normalizeFirstName(name) {
  if (!name) return "";
  const trimmed = name.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

// Map a Notion request page to the row shape used by the console + status page.
// Vendor / category / lead time / image are joined from the cached catalog
// because the Notion `Vendor` formula returns null for parts (rollup-of-rollup
// limitations). Pure data transform — no filtering by status here.
function mapRequestRow(r, enrichById) {
  const props = r.properties || {};
  const status = props.Status?.status?.name || "";

  const partRel   = props.Part?.relation?.[0]?.id;
  const supplyRel = props.Supply?.relation?.[0]?.id;
  const linkedId  = partRel || supplyRel;
  const enrich    = (linkedId && enrichById[linkedId]) || {};

  const vendor = enrich.vendor || props.Vendor?.formula?.string || "";

  return {
    pageId: r.id,
    url: r.url,
    createdTime: r.created_time || null,
    lastEditedTime: r.last_edited_time || null,
    orderNum: titleOf(r),
    _linkedId: linkedId || null,
    status,
    type: props.Type?.select?.name || "",
    itemName: props["Item Name"]?.formula?.string || "",
    customItemName: plainText(props["Custom Item Name"]?.rich_text),
    vendor,
    category: enrich.category || "",
    leadTime: enrich.leadTime || "",
    description: enrich.description || "",
    image: enrich.image || null,
    use2025: enrich.use2025 ?? null,
    requestor: props.Requestor?.select?.name || "",
    moqQty: props["MOQ"]?.number ?? null,
    qtyOrdered: props["Qty Ordered"]?.number ?? null,
    outOfStock: !!props["Out of Stock"]?.checkbox,
    priority: props.Priority?.select?.name || "",
    notes: plainText(props.Notes?.rich_text),
    purchaserNotes: plainText(props["Purchaser Notes"]?.rich_text),
    dateRequested: props["Date Requested"]?.date?.start || null,
    orderedDate:   props["Ordered Date"]?.date?.start || null,
    receivedDate:  props["Received Date"]?.date?.start || null,
    eta:           props.ETA?.date?.start || null,
    poNumber:      plainText(props["PO #"]?.rich_text),
    orderNumber:   plainText(props["Order #"]?.rich_text),
    tracking:      plainText(props["Tracking #"]?.rich_text),
    reason:        plainText(props.Reason?.rich_text),
    reasonCode:    props["Reason Code"]?.select?.name || "",
    cancellationReason: plainText(props["Cancellation Reason"]?.rich_text),
    notInDb:       !!props["Not in DB"]?.checkbox,
    // One-time purchase detection. We don't have a dedicated Notion
    // property — instead, the submit path stamps the Custom Item Name
    // with a "One-time: " prefix (vs "New Item Request: " for catalog
    // candidates). UI uses this to filter/tag without a schema change.
    oneTime:       /^One-time:/i.test(plainText(props["Custom Item Name"]?.rich_text) || ""),
    // Receiver — name of the person who confirmed THIS row's shipment.
    // Per-row, not last-touched-wins, because split shipments live in
    // sibling rows (each row = one physical box from the vendor).
    receiver:      plainText(props.Receiver?.rich_text),
    // Qty Received — the actual qty that landed on THIS row. Diverges
    // from Qty Ordered on short shipments (the gap is the shortfall).
    // Set by the receive worker; null until the row closes.
    qtyReceived:   props["Qty Received"]?.number ?? null,
    // Parent Request — self-relation pointing to the row this one was split
    // off from. Null means "this is the original (or only) row for the
    // request." Populated when a partial receipt spawned this row to track
    // the remainder. See applyReceiveBatch for the split logic.
    parentRequestId: props["Parent Request"]?.relation?.[0]?.id || null,
    // Carrier-status fields populated by the inbound-tracking poller (UPS /
    // FedEx / USPS). Empty until the poller has touched the row; the status
    // page hides the carrier-status line when these are blank so untracked
    // rows look identical to before the feature shipped.
    carrierStatus: props["Carrier Status"]?.select?.name || "",
    lastScan:      plainText(props["Last Scan"]?.rich_text),
    deliveredAt:   props["Delivered At"]?.date?.start || null,
  };
}

function buildEnrichmentMap(catalog) {
  const enrichById = {};
  const fields = (r) => ({
    vendor: r.vendor || "",
    category: r.category || "",
    leadTime: r.leadTime || "",
    description: r.description || "",
    use2025: r.use2025,
    reorderQty: r.reorderQty,
    image: r.image || null,
  });
  for (const p of catalog.parts || []) enrichById[p.id] = fields(p);
  for (const s of catalog.supplies || []) enrichById[s.id] = fields(s);
  return enrichById;
}

// Per-row "this item's other recent activity" — used by the Purchaser console
// chip. Returns lastRequested / lastOrdered / lastReceived from the activity
// map but EXCLUDING the row's own occurrence (otherwise every Submitted row
// would show "Requested today" which is just self-reference noise).
function priorActivityFor(row, activity) {
  const linkedId = row._linkedId;
  if (!linkedId) return null;
  const a = activity[linkedId];
  if (!a) return null;
  const out = {};
  if (a.lastRequested && a.pageIds.requested !== row.pageId) out.lastRequested = a.lastRequested;
  if (a.lastOrdered   && a.pageIds.ordered   !== row.pageId) out.lastOrdered   = a.lastOrdered;
  if (a.lastReceived  && a.pageIds.received  !== row.pageId) out.lastReceived  = a.lastReceived;
  return Object.keys(out).length ? out : null;
}

// Active rows only (used by the Purchaser Console).
async function fetchPendingRequests(env) {
  const [data, catalog, activity] = await Promise.all([
    notion(`/databases/${DB.LOG}/query`, env, {
      method: "POST",
      body: JSON.stringify({
        sorts: [{ property: "Date Requested", direction: "descending" }],
        page_size: 100,
      }),
    }),
    getCatalog(env).catch(() => ({ parts: [], supplies: [] })),
    getActivityMap(env).catch(() => ({})),
  ]);

  const enrichById = buildEnrichmentMap(catalog);
  const rows = [];
  for (const r of data.results || []) {
    const row = mapRequestRow(r, enrichById);
    if (row.status === "Received" || row.status === "Cancelled" || !row.status) continue;
    const prior = priorActivityFor(row, activity);
    if (prior) row.priorActivity = prior;
    rows.push(row);
  }
  return rows;
}

// All rows (used by the shared Status dashboard — visible to requesters,
// purchasers, and managers). Optionally filter to a single requestor server-side
// to keep payloads small when someone narrows the lens.
async function fetchAllRequests(env, requestor) {
  const filter = requestor
    ? { filter: { property: "Requestor", select: { equals: requestor } } }
    : {};
  const [data, catalog] = await Promise.all([
    paginatedQuery(DB.LOG, {
      ...filter,
      sorts: [{ property: "Date Requested", direction: "descending" }],
    }, env, 500),
    getCatalog(env).catch(() => ({ parts: [], supplies: [] })),
  ]);
  const enrichById = buildEnrichmentMap(catalog);
  return data.map(r => mapRequestRow(r, enrichById));
}

// ----- Recent activity map -----
//
// "Has this item been requested/ordered/received recently?" lookups for the
// Submit page (don't request again too soon) and Purchaser console (don't
// re-order something we just ordered). Scanned from the same log we already
// read for /pending, so the cost is just a second pagination pass and a
// per-relation rollup. Cached for 5 minutes like the catalog.
let ACTIVITY_CACHE = null; // { ts, data: { [partId|supplyId]: { lastRequested, lastOrdered, lastReceived, pageIds: { requested, ordered, received } } } }
const ACTIVITY_TTL_MS = 5 * 60 * 1000;

async function buildActivityMap(env) {
  // Pull the full log (capped at 500 rows — well above any realistic recent
  // history). Skip Cancelled so a cancelled re-request doesn't suppress the
  // chip on a future legitimate request.
  const rows = await paginatedQuery(DB.LOG, {
    sorts: [{ property: "Date Requested", direction: "descending" }],
  }, env, 500);

  const map = {};
  const set = (id, field, dateISO, pageId) => {
    if (!id || !dateISO) return;
    if (!map[id]) map[id] = { lastRequested: null, lastOrdered: null, lastReceived: null, pageIds: {} };
    const cur = map[id][field];
    if (!cur || dateISO > cur) {
      map[id][field] = dateISO;
      map[id].pageIds[field === "lastRequested" ? "requested"
                    : field === "lastOrdered"   ? "ordered"
                    : "received"] = pageId;
    }
  };

  for (const r of rows) {
    const props  = r.properties || {};
    const status = props.Status?.status?.name || "";
    if (status === "Cancelled") continue;
    const partId   = props.Part?.relation?.[0]?.id;
    const supplyId = props.Supply?.relation?.[0]?.id;
    const id = partId || supplyId;
    if (!id) continue;
    set(id, "lastRequested", props["Date Requested"]?.date?.start, r.id);
    set(id, "lastOrdered",   props["Ordered Date"]?.date?.start, r.id);
    set(id, "lastReceived",  props["Received Date"]?.date?.start, r.id);
  }
  return map;
}

async function getActivityMap(env, force = false) {
  const now = Date.now();
  if (!force && ACTIVITY_CACHE && (now - ACTIVITY_CACHE.ts) < ACTIVITY_TTL_MS) {
    return ACTIVITY_CACHE.data;
  }
  const data = await buildActivityMap(env);
  ACTIVITY_CACHE = { ts: now, data };
  return data;
}

// Required-field map per action. Each value is a list of field keys the
// payload must include (truthy) before we'll PATCH Notion.
const ACTION_REQUIRED = {
  // orderNumber and poNumber are intentionally NOT required — most vendors
  // don't issue either at purchase time. The order-confirmation-parser
  // fills both in later from supplier email (Order # is the canonical
  // record). Purchaser can still type them if they have them.
  ordered:        ["qtyOrdered", "orderedDate", "eta"],
  backordered:    ["eta", "reason"],
  waitingToOrder: ["reason"],
  received:       ["receivedDate"],
  cancelled:      ["reasonCode"],
  // Edit is sparse — no fields are required individually but at least one
  // must be present. Validated separately below.
  edit:           [],
};

const ACTION_STATUS = {
  ordered:        "Ordered",
  backordered:    "Backordered",
  waitingToOrder: "Waiting to Order",
  received:       "Received",
  cancelled:      "Cancelled",
  // edit deliberately not in this map — it never changes Status
};

// Which fields the "edit" action accepts. Anything else in payload.fields is
// ignored to keep the surface area small and predictable.
const EDIT_ALLOWED_FIELDS = new Set([
  "orderNumber", "noOrderNumber",
  "poNumber",    "noPO",
  "qtyOrdered",
  "eta",
  "tracking",
]);

function validateUpdate(payload) {
  if (!payload || typeof payload !== "object") return "payload must be an object";
  const action = payload.action;
  if (!action || !ACTION_REQUIRED[action]) {
    return `action must be one of: ${Object.keys(ACTION_REQUIRED).join(", ")}`;
  }
  const fields = payload.fields || {};
  // For "ordered": noPO, noOrderNumber, and noEta checkboxes satisfy the
  // respective required-field check. Some vendors don't issue PO #s; some
  // internal stock requests aren't tied to a customer order #; supplier
  // hasn't given an ETA yet. The purchaser opts out per row.
  const skip = new Set();
  const truthyFlag = v => v === true || v === "1" || v === "on";
  if (action === "ordered") {
    if (truthyFlag(fields.noPO))           skip.add("poNumber");
    if (truthyFlag(fields.noOrderNumber))  skip.add("orderNumber");
    if (truthyFlag(fields.noEta))          skip.add("eta");
  }
  const missing = ACTION_REQUIRED[action].filter(k => {
    if (skip.has(k)) return false;
    const v = fields[k];
    if (typeof v === "number") return Number.isNaN(v);
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
  if (missing.length) return `missing required fields for "${action}": ${missing.join(", ")}`;
  // Cancellation reason is only required when the reason code is "Other"
  if (action === "cancelled" && fields.reasonCode === "Other") {
    const v = fields.cancellationReason;
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
      return `cancellationReason is required when reasonCode is "Other"`;
    }
  }
  // Edit: must include at least one editable field so we don't write a no-op
  // purchaser-only PATCH and clobber Purchaser Notes with the audit append.
  if (action === "edit") {
    const present = Object.keys(fields).filter(k => EDIT_ALLOWED_FIELDS.has(k));
    if (present.length === 0) {
      return "edit requires at least one field to change";
    }
  }
  // Purchaser is required for all actions except cancellation
  if (action !== "cancelled" && !payload.purchaserName) {
    return "purchaserName is required";
  }
  return null;
}

async function applyUpdate(pageId, payload, env) {
  const { action, fields = {}, purchaserName, purchaserNotes } = payload;
  const props = {};
  // Status only changes on the action transitions; "edit" leaves Status alone.
  if (ACTION_STATUS[action]) {
    props["Status"] = { status: { name: ACTION_STATUS[action] } };
  }

  // Purchaser people field — resolve first name to a Notion user id
  if (purchaserName) {
    const byFirst = await getPeopleByFirstName(env);
    const userId = byFirst[normalizeFirstName(purchaserName)];
    if (userId) {
      props["Purchaser"] = { people: [{ object: "user", id: userId }] };
    }
  }

  if (purchaserNotes && purchaserNotes.trim()) {
    props["Purchaser Notes"] = {
      rich_text: [{ text: { content: purchaserNotes.slice(0, 2000) } }],
    };
  }

  // Per-action field mapping
  if (action === "ordered") {
    const truthy = v => v === true || v === "1" || v === "on";
    const noEta         = truthy(fields.noEta);
    // PO # and Order # are no longer required. Write whatever the purchaser
    // typed (may be blank — that's fine, the order-confirmation parser will
    // fill the Order # in from the supplier's email when it arrives).
    const poText          = String(fields.poNumber || "").trim().slice(0, 200);
    const orderNumberText = String(fields.orderNumber || "").trim().slice(0, 200);
    props["Order #"]     = { rich_text: orderNumberText ? [{ text: { content: orderNumberText } }] : [] };
    props["PO #"]        = { rich_text: poText          ? [{ text: { content: poText } }] : [] };
    props["Qty Ordered"] = { number: Number(fields.qtyOrdered) };
    props["Ordered Date"] = { date: { start: fields.orderedDate } };
    // ETA: blank out if "ETA not available" was checked (worker writes null
    // to clear the Notion date property). Otherwise write the picked date.
    props["ETA"]          = noEta ? { date: null } : { date: { start: fields.eta } };
    if (fields.tracking) props["Tracking #"] = { rich_text: [{ text: { content: String(fields.tracking).slice(0, 200) } }] };
  } else if (action === "backordered") {
    props["ETA"]    = { date: { start: fields.eta } };
    props["Reason"] = { rich_text: [{ text: { content: String(fields.reason).slice(0, 2000) } }] };
  } else if (action === "waitingToOrder") {
    props["Reason"] = { rich_text: [{ text: { content: String(fields.reason).slice(0, 2000) } }] };
  } else if (action === "received") {
    props["Received Date"] = { date: { start: fields.receivedDate } };
    // Don't overwrite Qty Ordered on receive — that column is what was ordered.
    // If the single-action UI ever needs to record received qty here, write to
    // Qty Received (see /receive batch path).
  } else if (action === "cancelled") {
    props["Reason Code"] = { select: { name: fields.reasonCode } };
    if (fields.cancellationReason && String(fields.cancellationReason).trim()) {
      props["Cancellation Reason"] = { rich_text: [{ text: { content: String(fields.cancellationReason).slice(0, 2000) } }] };
    }
  } else if (action === "edit") {
    // Sparse PATCH: only fields the client actually sent get written. We fetch
    // the current row so we can (a) skip no-op writes that would mask the
    // diff, and (b) build a "Before -> After" audit line appended to
    // Purchaser Notes. Anything outside EDIT_ALLOWED_FIELDS is ignored.
    const current = await notion(`/pages/${pageId}`, env);
    const cur = current.properties || {};
    const curOrder = plainText(cur["Order #"]?.rich_text);
    const curPO    = plainText(cur["PO #"]?.rich_text);
    const curQty   = cur["Qty Ordered"]?.number ?? null;
    const curETA   = cur.ETA?.date?.start || "";
    const curTrack = plainText(cur["Tracking #"]?.rich_text);

    const truthy = v => v === true || v === "1" || v === "on";
    const changes = [];

    // Order # — string text + noOrderNumber sentinel "—"
    if ("orderNumber" in fields || "noOrderNumber" in fields) {
      const next = truthy(fields.noOrderNumber)
        ? "—"
        : String(fields.orderNumber || "").slice(0, 200);
      if (next !== curOrder) {
        props["Order #"] = { rich_text: [{ text: { content: next } }] };
        changes.push(`Order # "${curOrder}" → "${next}"`);
      }
    }
    if ("poNumber" in fields || "noPO" in fields) {
      const next = truthy(fields.noPO)
        ? "—"
        : String(fields.poNumber || "").slice(0, 200);
      if (next !== curPO) {
        props["PO #"] = { rich_text: [{ text: { content: next } }] };
        changes.push(`PO "${curPO}" → "${next}"`);
      }
    }
    if ("qtyOrdered" in fields && fields.qtyOrdered !== "" && fields.qtyOrdered != null) {
      const next = Number(fields.qtyOrdered);
      if (!Number.isNaN(next) && next !== curQty) {
        props["Qty Ordered"] = { number: next };
        changes.push(`Qty ${curQty ?? "—"} → ${next}`);
      }
    }
    if ("eta" in fields) {
      const next = String(fields.eta || "").slice(0, 10);
      if (next && next !== curETA) {
        props["ETA"] = { date: { start: next } };
        changes.push(`ETA ${curETA || "—"} → ${next}`);
      }
    }
    if ("tracking" in fields) {
      const next = String(fields.tracking || "").slice(0, 200);
      if (next !== curTrack) {
        props["Tracking #"] = { rich_text: [{ text: { content: next } }] };
        changes.push(`Tracking "${curTrack}" → "${next}"`);
      }
    }

    if (changes.length === 0 && !(purchaserNotes && purchaserNotes.trim())) {
      // Nothing to write. Return early so we don't make an empty PATCH.
      return { pageId, url: current.url, status: cur.Status?.status?.name || null, noChange: true };
    }

    // Audit line: prepend to Purchaser Notes so the most recent edit is on
    // top and the prior context is preserved. Cap at 2000 chars; truncate the
    // oldest content if we'd overflow.
    if (changes.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const auditLine = `[${today} edit by ${purchaserName}] ${changes.join("; ")}`;
      const prior = plainText(cur["Purchaser Notes"]?.rich_text);
      // The client-supplied purchaserNotes was already added to props above.
      // If they didn't add a note, use prior. Either way, prepend the audit.
      const base = (purchaserNotes && purchaserNotes.trim())
        ? `${purchaserNotes.trim()}\n${prior}`
        : prior;
      const combined = `${auditLine}\n${base}`.slice(0, 2000);
      props["Purchaser Notes"] = { rich_text: [{ text: { content: combined } }] };
    }
  }

  const updated = await notion(`/pages/${pageId}`, env, {
    method: "PATCH",
    body: JSON.stringify({ properties: props }),
  });
  return { pageId: updated.id, url: updated.url, status: ACTION_STATUS[action] || null };
}

// ----- Self-cancel (requestor removes their own pending request) -----
//
// Hard rule: only allowed when the row is still in "Submitted" status. Once a
// purchaser has touched it (Ordered / Backordered / Waiting / Received), the
// requestor can no longer self-cancel — they have to talk to the purchaser.
// No auth: the requestor types their name in the modal; we trust the team and
// stamp the name into the Cancellation Reason so misuse is visible.
const SELF_CANCEL_REASON_CODES = new Set([
  "No longer needed",
  "Duplicate request",
  "Wrong item",
  "Already in stock",
  "Other",
]);

async function applySelfCancel(pageId, payload, env) {
  const { requestor, reasonCode, reasonText } = payload || {};

  if (!requestor || typeof requestor !== "string" || !requestor.trim()) {
    return { status: 400, body: { error: "requestor is required" } };
  }
  if (!reasonCode || !SELF_CANCEL_REASON_CODES.has(reasonCode)) {
    return {
      status: 400,
      body: { error: `reasonCode must be one of: ${[...SELF_CANCEL_REASON_CODES].join(", ")}` },
    };
  }
  if (reasonCode === "Other" && (!reasonText || !String(reasonText).trim())) {
    return { status: 400, body: { error: 'reasonText is required when reasonCode is "Other"' } };
  }

  // Fetch the current row so we can verify it's still in Submitted.
  let page;
  try {
    page = await notion(`/pages/${pageId}`, env);
  } catch (e) {
    return { status: 404, body: { error: "Request not found" } };
  }
  const currentStatus = page?.properties?.Status?.status?.name || "";
  if (currentStatus !== "Submitted") {
    return {
      status: 409,
      body: {
        error: `This request can't be removed because it's already in "${currentStatus}". Contact the purchaser if you need to cancel.`,
        currentStatus,
      },
    };
  }

  // Build the visible reason — always includes who removed it.
  const reasonLabel = reasonCode === "Other"
    ? String(reasonText).trim()
    : reasonCode;
  const cancellationReason = `Removed by ${requestor.trim()} — ${reasonLabel}`.slice(0, 2000);

  const props = {
    "Status": { status: { name: "Cancelled" } },
    "Reason Code": { select: { name: reasonCode } },
    "Cancellation Reason": {
      rich_text: [{ text: { content: cancellationReason } }],
    },
  };

  const updated = await notion(`/pages/${pageId}`, env, {
    method: "PATCH",
    body: JSON.stringify({ properties: props }),
  });
  return {
    status: 200,
    body: {
      pageId: updated.id,
      url: updated.url,
      status: "Cancelled",
      cancellationReason,
    },
  };
}

// ----- Batched receive (Receive Shipments console) -----
//
// Receives a list of items the user just confirmed off a shipment. Three modes
// per item, controlled by `complete`:
//
//   Full shipment (qty == ordered)
//     → Status = Received, Qty Received = arrived qty (matches Qty Ordered).
//       Row leaves the receive queue.
//
//   Short shipment, "no more coming" (complete=true, qty < ordered)
//     → Status = Received, Qty Received = arrived qty. Qty Ordered stays as
//       the original ask, so the gap between Ordered and Received is visible
//       as the shortfall. Remainder is written off — no sibling spawn.
//
//   Short shipment, "more expected" (complete=false, qty < ordered) — THE SPLIT
//     → The original row closes: Status = Received, Qty Received = arrived qty
//       (Qty Ordered stays at the original ask).
//     → A NEW sibling row is created: Qty Ordered = remainder, Status = Ordered,
//       Parent Request = root, with all metadata copied (item relation,
//       requestor, vendor, PO #, ETA, notes) and a "Split shipment — remainder
//       of <orig>" line prepended to Notes.
//     → Receiver continues to log subsequent partials against the new sibling.
//       If THAT row splits again, the new sibling's Parent Request still points
//       to the ROOT — never to an intermediate sibling. Keeps Notion rollups
//       trivial: one query against the root pulls every shipment in the chain.
//
// Receiver attribution: written to the Receiver text property on whichever
// row closed in this transaction (each sibling has its own Receiver).
//
// Tracking #: stays on the row level. Each sibling has its own Tracking #
// because each represents a distinct physical shipment.
//
// Schema gate: `Parent Request` (relation) and `Receiver` (text) are
// optional in the DB; the worker skips them if missing so older deployments
// keep working. `Receipt Log` and `Qty Received` are no longer written —
// sibling rows ARE the log.
async function applyReceiveBatch(payload, env) {
  const { receiverName, receivedDate, items } = payload;
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "items array is required" };
  }
  const date = receivedDate || new Date().toISOString().slice(0, 10);
  const schema = await getLogSchema(env);
  const results = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || !it.pageId) {
      results.push({ ok: false, error: "missing pageId", item: it });
      continue;
    }
    if (!/^[a-f0-9-]{32,}$/i.test(it.pageId)) {
      results.push({ ok: false, error: "invalid pageId", pageId: it.pageId });
      continue;
    }

    let currentPage;
    try {
      currentPage = await notion(`/pages/${it.pageId}`, env);
    } catch (e) {
      results.push({ ok: false, pageId: it.pageId, error: `lookup failed: ${e.message || e}` });
      continue;
    }
    const curProps = currentPage.properties || {};
    const curQtyOrdered = curProps["Qty Ordered"]?.number ?? null;

    const qtyThisShipment = (it.qtyReceived != null && !Number.isNaN(Number(it.qtyReceived)))
      ? Number(it.qtyReceived)
      : null;
    const complete = !!it.complete; // receiver said nothing more is coming
    const isShort = qtyThisShipment != null && curQtyOrdered != null && qtyThisShipment < curQtyOrdered;
    const shouldSplit = isShort && !complete; // receiver said more is expected

    // ----- Close THIS row -----
    const closeProps = {
      "Status": { status: { name: "Received" } },
      "Received Date": { date: { start: date } },
    };
    // Record the actual arrived qty in Qty Received. Qty Ordered is left
    // alone — it preserves the original ask so anyone reading the row can
    // see "we ordered 10, received 8." On a clean full shipment the two
    // numbers match; on a short shipment they diverge and the gap is the
    // shortfall. (The sibling row, if spawned, tracks the remainder under
    // its own Qty Ordered.)
    if (qtyThisShipment != null) {
      closeProps["Qty Received"] = { number: qtyThisShipment };
    }
    if (receiverName) {
      closeProps["Receiver"] = {
        rich_text: [{ text: { content: receiverName.slice(0, 200) } }],
      };
    }
    // Issue note goes into Purchaser Notes prefixed "ISSUE:" so it's
    // attached to the specific shipment that had it.
    if (it.issue) {
      const issueText = `ISSUE: ${(it.issueNote || "no detail provided").slice(0, 1500)}`;
      closeProps["Purchaser Notes"] = {
        rich_text: [{ text: { content: issueText.slice(0, 2000) } }],
      };
    }

    let closedRow, siblingRow = null;
    try {
      const safeProps = filterPropsBySchema(closeProps, schema);
      closedRow = await notion(`/pages/${it.pageId}`, env, {
        method: "PATCH",
        body: JSON.stringify({ properties: safeProps }),
      });
    } catch (err) {
      results.push({ ok: false, pageId: it.pageId, error: String(err.message || err) });
      continue;
    }

    // ----- Spawn the sibling for the remainder -----
    if (shouldSplit) {
      const remainder = curQtyOrdered - qtyThisShipment;
      try {
        siblingRow = await createSplitSibling(currentPage, remainder, env, schema);
      } catch (err) {
        // Closing succeeded but split failed — surface as a partial so the
        // client can show a recoverable warning. The receiver still got
        // credit for what arrived; the missing remainder needs manual
        // follow-up in Notion.
        results.push({
          ok: true,
          pageId: closedRow.id,
          url: closedRow.url,
          complete: true,
          warning: `Closed at ${qtyThisShipment} but failed to spawn remainder row: ${err.message || err}`,
        });
        continue;
      }
    }

    results.push({
      ok: true,
      pageId: closedRow.id,
      url: closedRow.url,
      complete: !shouldSplit, // shouldSplit means we created a sibling — there's "more"
      qtyClosed: qtyThisShipment ?? curQtyOrdered,
      issue: !!it.issue,
      sibling: siblingRow ? { pageId: siblingRow.id, url: siblingRow.url } : null,
    });
  }

  const succeeded = results.filter(r => r.ok).length;
  return {
    received: succeeded,
    failed: results.length - succeeded,
    results,
  };
}

// Spawn a new sibling row for the remainder of a split shipment. Copies the
// original row's metadata so the new row stands on its own (item relation,
// requestor, vendor name, PO #, Order #, ETA, type, MOQ, urgency flag,
// notes). Resets receiving-specific fields (Status → Ordered, no Received
// Date, no Receiver, no Tracking #) since the remainder is a fresh shipment
// to track.
//
// Title (Request #): we keep a clean numbering scheme by appending "-N" to
// the parent's Request #. First split becomes <orig>-2 (the original is
// implicitly 1/N once it's been split). Subsequent splits increment.
//
// Parent Request relation always points to the ROOT of the chain. If the
// row we're splitting already has a Parent Request, we copy that root —
// no second-level branching. Keeps rollups simple: one query against the
// root pulls every sibling in the chain.
async function createSplitSibling(parentPage, remainderQty, env, schema) {
  const props = parentPage.properties || {};
  const parentTitle = titleOf(parentPage);
  const rootParentId = props["Parent Request"]?.relation?.[0]?.id || parentPage.id;

  // Generate the next sibling number. Count existing siblings (rows with
  // Parent Request = rootParentId) and use count+2 as the suffix (the
  // root is implicitly "1", first split is "2", etc.). Falls back to a
  // timestamp-based suffix on query error so we never block the receive.
  let siblingSuffix = 2;
  try {
    const siblings = await notion(`/databases/${DB.LOG}/query`, env, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          property: "Parent Request",
          relation: { contains: rootParentId },
        },
        page_size: 100,
      }),
    });
    siblingSuffix = (siblings.results?.length || 0) + 2;
  } catch {
    siblingSuffix = Math.floor(Date.now() / 1000) % 1000;
  }
  // Strip any prior -N suffix off the parent's title before re-appending.
  const baseTitle = parentTitle.replace(/-\d+$/, "");
  const newTitle = `${baseTitle}-${siblingSuffix}`;

  // Build the new row's props. Copy everything that's row-specific metadata
  // (item, vendor, requestor, PO/Order #, ETA, urgency, notes) and reset
  // anything that's per-physical-shipment (Status, Received Date, Tracking,
  // Receiver, Purchaser Notes).
  const newProps = {
    "Request #": { title: [{ text: { content: newTitle } }] },
    "Status": { status: { name: "Ordered" } },
    "Qty Ordered": { number: remainderQty },
    "Date Requested": props["Date Requested"]?.date
      ? { date: { start: props["Date Requested"].date.start } }
      : undefined,
    "Type": props.Type?.select?.name ? { select: { name: props.Type.select.name } } : undefined,
    "Requestor": props.Requestor?.select?.name ? { select: { name: props.Requestor.select.name } } : undefined,
    "Priority": props.Priority?.select?.name ? { select: { name: props.Priority.select.name } } : undefined,
    "Out of Stock": { checkbox: !!props["Out of Stock"]?.checkbox },
    "Not in DB": { checkbox: !!props["Not in DB"]?.checkbox },
  };

  // Carry forward the relation to the actual Part or Supply.
  const partRel = props.Part?.relation?.[0]?.id;
  if (partRel) newProps["Part"] = { relation: [{ id: partRel }] };
  const supplyRel = props.Supply?.relation?.[0]?.id;
  if (supplyRel) newProps["Supply"] = { relation: [{ id: supplyRel }] };

  // Custom item name for Not-in-DB requests
  const customName = plainText(props["Custom Item Name"]?.rich_text);
  if (customName) {
    newProps["Custom Item Name"] = { rich_text: [{ text: { content: customName.slice(0, 200) } }] };
  }

  // Vendor name (cached at submit time, kept on the row to dodge Notion's
  // rollup-of-rollup limitation)
  const vendorName = plainText(props["Vendor Name"]?.rich_text);
  if (vendorName) {
    newProps["Vendor Name"] = { rich_text: [{ text: { content: vendorName.slice(0, 200) } }] };
  }

  // PO and Order # — carry forward; usually the remainder ships under the
  // same PO/vendor order #. Purchaser can edit on the new row if not.
  const poNumber = plainText(props["PO #"]?.rich_text);
  if (poNumber) {
    newProps["PO #"] = { rich_text: [{ text: { content: poNumber.slice(0, 200) } }] };
  }
  const orderNumber = plainText(props["Order #"]?.rich_text);
  if (orderNumber) {
    newProps["Order #"] = { rich_text: [{ text: { content: orderNumber.slice(0, 200) } }] };
  }

  // Ordered Date carries forward (it's the original order date), ETA stays
  // since the remainder still has the same expected arrival from the vendor
  // until Chase updates it.
  if (props["Ordered Date"]?.date) {
    newProps["Ordered Date"] = { date: { start: props["Ordered Date"].date.start } };
  }
  if (props.ETA?.date) {
    newProps["ETA"] = { date: { start: props.ETA.date.start } };
  }

  // MOQ
  if (typeof props["MOQ"]?.number === "number") {
    newProps["MOQ"] = { number: props["MOQ"].number };
  }

  // Notes: prepend a split marker so anyone opening the row in Notion
  // immediately sees this is a remainder, with a link back to the parent
  // by title (and the relation handles the click-through).
  const priorNotes = plainText(props.Notes?.rich_text);
  const splitMarker = `Split shipment — remainder of ${parentTitle}.`;
  const combinedNotes = priorNotes
    ? `${splitMarker} ${priorNotes}`.slice(0, 2000)
    : splitMarker;
  newProps["Notes"] = { rich_text: [{ text: { content: combinedNotes } }] };

  // Parent Request relation — only set if the schema has it (graceful
  // degrade if Thomas hasn't added the property).
  newProps["Parent Request"] = { relation: [{ id: rootParentId }] };

  // Strip undefined values that Notion will reject, then filter to schema.
  const cleaned = {};
  for (const [k, v] of Object.entries(newProps)) {
    if (v !== undefined) cleaned[k] = v;
  }
  const safeProps = filterPropsBySchema(cleaned, schema);

  return await notion(`/pages`, env, {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: DB.LOG },
      properties: safeProps,
    }),
  });
}

// ----- Bulk update (Phase 1: ordered only) -----
//
// Apply the same "Mark Ordered" fields to many rows in a single round trip.
// Per-item Qty Ordered comes from the items[] array (each item carries its
// own qtyOrdered, since MOQs differ). All other fields (Order #, PO #,
// Ordered Date, ETA, Tracking, noPO, noOrderNumber, purchaser notes) apply
// to every row. Reuses applyUpdate per item so behavior matches the
// single-row Mark Ordered path exactly — validation, people resolution,
// purchaser notes formatting, etc.
async function applyBulkUpdate(payload, env) {
  const { action, sharedFields = {}, items, purchaserName, purchaserNotes } = payload;

  if (action !== "ordered") {
    return { status: 400, body: { error: "bulk update only supports action=ordered in this phase" } };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { error: "items array is required" } };
  }
  if (!purchaserName) {
    return { status: 400, body: { error: "purchaserName is required" } };
  }

  const results = [];
  for (const it of items) {
    if (!it || !it.pageId) {
      results.push({ ok: false, error: "missing pageId", item: it });
      continue;
    }
    if (!/^[a-f0-9-]{32,}$/i.test(it.pageId)) {
      results.push({ ok: false, error: "invalid pageId", pageId: it.pageId });
      continue;
    }
    // Build the per-item payload by merging shared fields with this item's
    // qtyOrdered. Per-item override of any other field is supported by the
    // optional `fieldOverrides` blob (unused in the v1 client but cheap to
    // honor for forward-compat).
    const fields = {
      ...sharedFields,
      ...(it.fieldOverrides || {}),
      qtyOrdered: it.qtyOrdered,
    };
    const itemPayload = { action: "ordered", fields, purchaserName, purchaserNotes };
    const err = validateUpdate(itemPayload);
    if (err) {
      results.push({ ok: false, pageId: it.pageId, error: err });
      continue;
    }
    try {
      const out = await applyUpdate(it.pageId, itemPayload, env);
      results.push({ ok: true, pageId: it.pageId, url: out.url });
    } catch (e) {
      results.push({ ok: false, pageId: it.pageId, error: String(e.message || e).slice(0, 500) });
    }
  }

  const succeeded = results.filter(r => r.ok).length;
  return {
    status: succeeded === 0 ? 502 : (succeeded === results.length ? 200 : 207),
    body: {
      updated: succeeded,
      failed: results.length - succeeded,
      results,
    },
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      if (request.method === "GET" && path === "/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return json({ results: [] });
        const [parts, supplies, activity, lib] = await Promise.all([
          searchParts(q, env),
          searchSupplies(q, env),
          getActivityMap(env).catch(() => ({})),
          getPartsLibrary(),
        ]);
        const results = [...parts, ...supplies].slice(0, 12);
        await attachVendorNames(results, env);
        // Attach last-activity stamps + swap images to the static library URL
        // when available (so URLs don't expire after 1h).
        for (const r of results) {
          const a = activity[r.id];
          if (a) {
            r.lastRequested = a.lastRequested || null;
            r.lastOrdered   = a.lastOrdered   || null;
            r.lastReceived  = a.lastReceived  || null;
          }
          if (r.type === "Part") {
            r.image = resolveStaticPartImage(r.title, r.image, lib);
          } else if (r.type === "Supply") {
            r.image = resolveStaticSupplyImage(r.id, r.image, lib);
          }
        }
        return json({ results });
      }

      if (request.method === "GET" && path === "/requestors") {
        return json({ requestors: REQUESTOR_OPTIONS });
      }

      if (request.method === "GET" && path === "/catalog") {
        const force = url.searchParams.get("refresh") === "1";
        const [data, activity] = await Promise.all([
          getCatalog(env, force),
          getActivityMap(env, force).catch(() => ({})),
        ]);
        // Mutate a clone so we don't pollute the cached catalog. (Catalog is
        // cached for 5min; we don't want stale activity baked into it.)
        const attach = (arr) => arr.map(r => {
          const a = activity[r.id];
          return a ? { ...r, lastRequested: a.lastRequested || null, lastOrdered: a.lastOrdered || null, lastReceived: a.lastReceived || null } : r;
        });
        const cachedAt = CATALOG_CACHE ? new Date(CATALOG_CACHE.ts).toISOString() : null;
        return json({
          parts: attach(data.parts),
          supplies: attach(data.supplies),
          cachedAt,
          ttlMs: CATALOG_TTL_MS,
        });
      }

      if (request.method === "GET" && path === "/activity") {
        const force = url.searchParams.get("refresh") === "1";
        const data = await getActivityMap(env, force);
        const cachedAt = ACTIVITY_CACHE ? new Date(ACTIVITY_CACHE.ts).toISOString() : null;
        return json({ activity: data, cachedAt, ttlMs: ACTIVITY_TTL_MS });
      }

      if (request.method === "POST" && path === "/submit") {
        const payload = await request.json();
        const err = validatePayload(payload);
        if (err) return json({ error: err }, 400);

        // Idempotency: if the client sent this same key within the last 60s,
        // return the prior response unchanged. Stops a retry-after-error from
        // creating duplicate rows in Notion.
        const idemKey = payload.idempotencyKey;
        const cached = lookupIdempotent(idemKey);
        if (cached) return json(cached);

        const { created, failed } = await createRequests(
          payload.items,
          payload.requestor,
          payload.sharedNotes || "",
          env,
          payload.initialStatus || "Submitted",
        );
        const response = {
          created,
          failed,
          count: created.length,
          failedCount: failed.length,
        };
        rememberIdempotent(idemKey, response);
        // HTTP status: 200 if everything succeeded, 207 if mixed, 502 if all failed.
        // Client always inspects the body to know exactly what landed.
        const status = failed.length === 0 ? 200
          : created.length === 0 ? 502
          : 207;
        return json(response, status);
      }

      if (request.method === "GET" && path === "/pending") {
        const rows = await fetchPendingRequests(env);
        return json({ rows, count: rows.length });
      }

      if (request.method === "GET" && path === "/requests") {
        const requestor = (url.searchParams.get("requestor") || "").trim();
        const rows = await fetchAllRequests(env, requestor || null);
        return json({ rows, count: rows.length, requestor: requestor || null });
      }

      if (request.method === "GET" && path === "/people") {
        const byFirst = await getPeopleByFirstName(env, url.searchParams.get("refresh") === "1");
        const allowed = ["Catherine", "Chase", "Thomas", "Zach"];
        const people = allowed.filter(n => byFirst[n]).sort();
        return json({ people });
      }

      if (request.method === "POST" && path.startsWith("/update/")) {
        const pageId = path.slice("/update/".length);
        if (!/^[a-f0-9-]{32,}$/i.test(pageId)) {
          return json({ error: "Invalid pageId" }, 400);
        }
        const payload = await request.json();
        const err = validateUpdate(payload);
        if (err) return json({ error: err }, 400);
        const out = await applyUpdate(pageId, payload, env);
        return json(out);
      }

      if (request.method === "POST" && path === "/receive") {
        const payload = await request.json();
        const out = await applyReceiveBatch(payload, env);
        if (out.error) return json(out, 400);
        return json(out);
      }

      if (request.method === "POST" && path === "/bulk-update") {
        const payload = await request.json();
        const out = await applyBulkUpdate(payload, env);
        return json(out.body, out.status);
      }

      if (request.method === "POST" && path.startsWith("/self-cancel/")) {
        const pageId = path.slice("/self-cancel/".length);
        if (!/^[a-f0-9-]{32,}$/i.test(pageId)) {
          return json({ error: "Invalid pageId" }, 400);
        }
        const payload = await request.json();
        const out = await applySelfCancel(pageId, payload, env);
        return json(out.body, out.status);
      }

      if (path === "" || path === "/") {
        return json({
          ok: true,
          name: "inventory-request-form-worker",
          endpoints: [
            "/search?q=", "/catalog", "/requestors",
            "POST /submit",
            "/pending", "/requests?requestor=", "/people",
            "POST /update/:pageId",
            "POST /receive",
            "POST /bulk-update",
            "POST /self-cancel/:pageId",
            "/activity",
          ],
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      // Tag Notion outage errors so the client can show a friendly message
      // ("Notion is having trouble — try again in a minute") instead of the
      // raw Notion error JSON which looks like our system is broken. Status
      // 503 communicates "service unavailable upstream" — keeps the page's
      // retry/refresh affordances simple.
      const upstream = e?.upstreamStatus;
      const isNotionDown =
        e?.upstream === "notion" &&
        (upstream >= 500 || upstream === 429);
      if (isNotionDown) {
        return json(
          {
            error: "Notion is having trouble responding right now. This usually clears up within a few minutes — try Refresh shortly.",
            errorCode: "upstream_unavailable",
            upstream: "notion",
            upstreamStatus: upstream,
            detail: String(e.message || e),
          },
          503,
        );
      }
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
