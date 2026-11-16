'use strict';

const DB_NAME = 'inventario-tienda';
const STORE = 'kv';
const KEY = 'state';
const LS_KEY = 'inventario-tienda-state';
const BACKUP_WARN_DAYS = 7;
const MERGE_WINDOW_MS = 2 * 60 * 1000;
const BRAND = { storeName: 'Sabor Nature', logo: 'img/logo-sabor-nature.png' };

// Instagram examples with indicative prices.
const SAMPLES = [
  { ref: 'TE-ROJO-TAZA', name: 'Té rojo a la taza (cacao, calabaza y especias)', unit: 'g', price: 5.5, units: 800, photo: 'post-02.jpg' },
  { ref: 'TE-ROJO-GRAN', name: 'Té rojo Romance de Granada · Azaria', unit: 'g', price: 6.2, units: 600, photo: 'post-07.jpg' },
  { ref: 'TE-ROJO-GALL', name: 'Té rojo Galleta Festiva', unit: 'g', price: 5.5, units: 750, photo: 'post-08.jpg' },
  { ref: 'TE-NEGRO-CALA', name: 'Té negro Calabaza Spicy', unit: 'g', price: 4.9, units: 500, photo: 'post-11.jpg' },
  { ref: 'TE-VERDE-MANU', name: 'Té verde con miel de Manuka', unit: 'g', price: 6.5, units: 400, photo: 'post-06.jpg' },
  { ref: 'ROO-CANAMO', name: 'Rooibos Cáñamo', unit: 'g', price: 5.2, units: 650, photo: 'post-05.jpg' },
  { ref: 'ROO-VERDE-ESP', name: 'Rooibos verde especiado (novedad)', unit: 'g', price: 5.2, units: 150, photo: 'post-03.jpg' },
  { ref: 'FIG-GAIA', name: 'Figura Diosa Gaia (Madre Tierra)', unit: 'ud', price: 34.9, units: 2, photo: 'post-00.jpg' },
  { ref: 'COL-OJO-TIGRE', name: 'Colgante ojo de tigre facetado y plata', unit: 'ud', price: 24.9, units: 4, photo: 'post-01.jpg' },
  { ref: 'SOL-BCOMP-50', name: 'Solaray B-Complex 50', unit: 'ud', price: 18.95, units: 6, photo: 'post-04.jpg' },
  { ref: 'GRA-GARBANZO', name: 'Harina de garbanzo BIO · El Granero', unit: 'ud', price: 3.45, units: 8, photo: 'post-09.jpg' },
  { ref: 'GRA-SARRACENO', name: 'Harina de trigo sarraceno BIO · El Granero', unit: 'ud', price: 3.95, units: 0, photo: 'post-10.jpg' },
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const moneyFmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
const fmtMoney = (n) => moneyFmt.format(n || 0);
const fmtNum = (n) => numFmt.format(n || 0);
const fmtDateTime = (ts) => new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (ts) => { const d = new Date(ts); return `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayStart = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const dayEnd = (iso) => dayStart(iso) + 86400000 - 1;
const initials = (name) => (String(name).trim()[0] || '?').toUpperCase();

/* ---------- Units (g priced per 100 g) ---------- */

const unitOf = (p) => (p && p.unit === 'g' ? 'g' : 'ud');
const isWeight = (p) => unitOf(p) === 'g';
const priceFactor = (unit) => (unit === 'g' ? 0.01 : 1);
const amountOf = (qty, price, unit) => round2(qty * price * priceFactor(unit));
const priceUnitLabel = (unit) => (unit === 'g' ? '100 g' : 'ud');
const fmtPrice = (price, unit) => (unit === 'g' ? `${fmtMoney(price)} / 100 g` : fmtMoney(price));
const fmtQty = (q, unit) => {
  if (unit === 'g') return Math.abs(q) >= 1000 ? `${fmtNum(q / 1000)} kg` : `${fmtNum(q)} g`;
  return `${fmtNum(q)} ${Math.abs(q) === 1 ? 'ud.' : 'uds.'}`;
};
const MASK = '****';
const shown = (text) => (state.settings.hideFigures ? MASK : text);
const stepOf = (p) => (isWeight(p) ? state.settings.weightStep : 1);
const lowLimit = (p) => (isWeight(p) ? state.settings.lowStockG : state.settings.lowStock);

const MOVE_LABEL = {
  alta: 'Alta', entrada: 'Entrada', salida: 'Salida', ajuste: 'Recuento',
  venta: 'Venta', anulacion: 'Venta anulada', baja: 'Baja',
};

function defaultState() {
  return {
    version: 2,
    settings: {
      title: 'Inventario de la tienda', storeName: '', lowStock: 2, lowStockG: 200, weightStep: 50,
      logo: null, logoW: 0, logoH: 0, lastBackup: null, brandApplied: false, samplesSeeded: false, hideFigures: true,
      theme: 'auto',
    },
    products: [],
    movements: [],
    sales: [],
    saleSeq: 0,
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    products: Array.isArray(raw.products) ? raw.products : [],
    movements: Array.isArray(raw.movements) ? raw.movements : [],
    sales: Array.isArray(raw.sales) ? raw.sales : [],
  };
}

let state = defaultState();

/* ---------- Storage (IndexedDB, localStorage as fallback) ---------- */

const storage = (() => {
  let dbPromise = null;
  const open = () => dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const idbGet = async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  const idbSet = async (value) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  let useLs = !('indexedDB' in window);
  return {
    async load() {
      if (!useLs) {
        try { return await idbGet(); } catch { useLs = true; }
      }
      try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
    },
    async save(value) {
      if (!useLs) {
        try { return await idbSet(value); } catch { useLs = true; }
      }
      localStorage.setItem(LS_KEY, JSON.stringify(value));
    },
  };
})();

let saveChain = Promise.resolve();
function save() {
  saveChain = saveChain
    .then(() => storage.save(state))
    .catch(() => toast('No se han podido guardar los cambios. Descarga una copia de seguridad.', 6000));
  return saveChain;
}

/* ---------- Domain ---------- */

const activeProducts = () => state.products.filter((p) => !p.deletedAt);
const productById = (id) => state.products.find((p) => p.id === id);

function addMovement(productId, delta, type, extra = {}) {
  const m = {
    id: uid(), productId, delta, type,
    date: extra.date ?? Date.now(),
    note: extra.note || '',
    saleId: extra.saleId || null,
    price: extra.price ?? null,
  };
  state.movements.push(m);
  return m;
}

function quickStep(id, sign) {
  const p = productById(id);
  if (!p) return;
  if (sign < 0 && p.units <= 0) { toast(`No queda nada de ${p.name}`); return; }
  let d = sign * stepOf(p);
  if (p.units + d < 0) d = -p.units;
  p.units += d;
  const now = Date.now();
  const last = state.movements[state.movements.length - 1];
  // Consecutive +/- taps on the same product collapse into one movement.
  if (last && last.productId === id && (last.type === 'entrada' || last.type === 'salida') && !last.note && now - last.date < MERGE_WINDOW_MS) {
    last.delta += d;
    last.date = now;
    if (last.delta === 0) state.movements.pop();
    else last.type = last.delta > 0 ? 'entrada' : 'salida';
  } else {
    addMovement(id, d, d > 0 ? 'entrada' : 'salida');
  }
  save();
  updateRow(p);
  renderStats();
}

function stockAt(product, ts, movesByProduct) {
  const moves = movesByProduct.get(product.id) || [];
  let after = 0;
  for (const m of moves) if (m.date > ts) after += m.delta;
  return product.units - after;
}

function groupMoves() {
  const map = new Map();
  for (const m of state.movements) {
    if (!map.has(m.productId)) map.set(m.productId, []);
    map.get(m.productId).push(m);
  }
  return map;
}

/* ---------- Rendering ---------- */

const ICON_SELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';

function stockClass(p) {
  if (p.units <= 0) return 'out';
  if (p.units <= lowLimit(p)) return 'low';
  return '';
}

function rowHtml(p, i) {
  const cls = stockClass(p);
  const unit = unitOf(p);
  const step = stepOf(p);
  const badge = cls === 'out' ? '<span class="badge">Agotado</span>' : cls === 'low' ? '<span class="badge">Poco stock</span>' : '';
  const thumb = p.photo ? `<img src="${p.photo}" alt="" loading="lazy">` : esc(initials(p.name));
  const small = unit === 'g' ? 'g' : 'uds.';
  return `<li class="row ${cls}" data-id="${p.id}" style="--i:${Math.min(i, 20)}">
    <div class="thumb">${thumb}</div>
    <div class="info">
      <span class="ref">${esc(p.ref)}</span>
      <span class="name">${esc(p.name)}</span>
      <span class="price">${fmtPrice(p.price, unit)}<span class="value">· ${shown(fmtMoney(amountOf(p.units, p.price, unit)))} en stock</span></span>
    </div>
    <div class="step-area">
      <div class="stepper">
        <button type="button" class="dec" data-act="dec" aria-label="Restar ${esc(fmtQty(step, unit))}">−</button>
        <button type="button" class="units" data-act="adjust" title="Sumar, restar o fijar una cantidad"><b>${fmtNum(p.units)}</b><small>${small}</small></button>
        <button type="button" class="inc" data-act="inc" aria-label="Sumar ${esc(fmtQty(step, unit))}">+</button>
      </div>
      ${badge}
      <div class="row-actions">
        <button type="button" class="icon-btn sell" data-act="sell" title="Vender" aria-label="Vender">${ICON_SELL}</button>
        <button type="button" class="icon-btn" data-act="edit" title="Editar" aria-label="Editar">${ICON_EDIT}</button>
      </div>
    </div>
  </li>`;
}

function updateRow(p) {
  const li = $(`.row[data-id="${p.id}"]`);
  if (!li) return;
  const fresh = document.createElement('template');
  fresh.innerHTML = rowHtml(p, 0).trim();
  const node = fresh.content.firstElementChild;
  node.style.animation = 'none';
  li.replaceWith(node);
}

function sortedFiltered() {
  const q = norm($('#search').value);
  let list = activeProducts();
  if (q) list = list.filter((p) => norm(p.ref).includes(q) || norm(p.name).includes(q));
  const sort = $('#sort').value;
  // Relative to each product's low-stock limit.
  const ratio = (p) => (lowLimit(p) > 0 ? p.units / lowLimit(p) : p.units);
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
    ref: (a, b) => a.ref.localeCompare(b.ref, 'es', { numeric: true, sensitivity: 'base' }),
    units: (a, b) => ratio(a) - ratio(b) || a.name.localeCompare(b.name, 'es'),
    recent: (a, b) => b.createdAt - a.createdAt,
  }[sort];
  return list.sort(cmp);
}

function renderList() {
  const all = activeProducts();
  const list = sortedFiltered();
  $('#list').innerHTML = list.map(rowHtml).join('');
  $('#empty').hidden = all.length > 0;
  $('#noMatch').hidden = all.length === 0 || list.length > 0;
}

function renderStats() {
  const all = activeProducts();
  $('#statProducts').textContent = shown(fmtNum(all.length));
  $('#statLow').textContent = shown(fmtNum(all.filter((p) => stockClass(p) !== '').length));
  $('#statValue').textContent = shown(fmtMoney(all.reduce((s, p) => s + amountOf(p.units, p.price, unitOf(p)), 0)));
  const from = dayStart(isoDay(new Date()));
  const today = state.sales.filter((s) => !s.voidedAt && s.date >= from && s.date <= from + 86400000 - 1).reduce((s, v) => s + v.total, 0);
  $('#statToday').textContent = shown(fmtMoney(today));
  const hidden = state.settings.hideFigures;
  $('#figuresBtn').setAttribute('aria-pressed', String(hidden));
  $('#figuresLabel').textContent = hidden ? 'Mostrar cifras' : 'Ocultar cifras';
}

$('#figuresBtn').addEventListener('click', () => {
  state.settings.hideFigures = !state.settings.hideFigures;
  save();
  renderStats();
  renderList();
});

function renderHeader() {
  const s = state.settings;
  $('#appTitle').textContent = s.title || 'Inventario de la tienda';
  $('#storeName').textContent = s.storeName || '';
  document.title = s.storeName ? `${s.title} · ${s.storeName}` : s.title;
  $('#today').textContent = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const img = $('#logoImg');
  if (s.logo) { img.src = s.logo; img.hidden = false; $('#logoPh').hidden = true; $('#logoBtn').classList.add('has-logo'); }
  else { img.removeAttribute('src'); img.hidden = true; $('#logoPh').hidden = false; $('#logoBtn').classList.remove('has-logo'); }
}

function renderBackupWarn() {
  const s = state.settings;
  const hasData = state.products.some((p) => !p.sample);
  const days = s.lastBackup ? Math.floor((Date.now() - s.lastBackup) / 86400000) : null;
  const show = hasData && (days === null || days >= BACKUP_WARN_DAYS);
  $('#backupWarn').hidden = !show;
  if (show) {
    $('#backupWarnText').textContent = days === null
      ? 'Aún no has descargado ninguna copia de seguridad. Los datos viven solo en este dispositivo.'
      : `Hace ${days} días de la última copia de seguridad.`;
  }
}

const THEME_KEY = 'inventario-theme';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = state.settings.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#171813' : '#f5f3ea';
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
}
darkQuery.addEventListener('change', applyTheme);

function renderAll() {
  applyTheme();
  renderHeader();
  renderStats();
  renderList();
  renderBackupWarn();
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Images ---------- */

async function readImage(file, max, type, quality) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    return { data: c.toDataURL(type, quality), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/* ---------- Dialog helpers ---------- */

function openDlg(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeDlg(el) { el.closest('dialog')?.close(); }
function showError(id, msg) { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; }

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) closeDlg(close);
});
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

/* ---------- Product dialog ---------- */

let editingId = null;
let pendingPhoto;

const formUnit = () => $('input[name=pUnit]:checked').value;

function syncUnitLabels() {
  const g = formUnit() === 'g';
  $('#pPriceLabel').textContent = g ? 'Precio por 100 g (€)' : 'Precio (€)';
  $('#pUnitsLabel').textContent = editingId ? (g ? 'Gramos en stock' : 'Unidades') : (g ? 'Gramos iniciales' : 'Unidades iniciales');
  $('#pUnits').step = '1';
}

function openProduct(id = null) {
  editingId = id;
  const p = id ? productById(id) : null;
  pendingPhoto = p?.photo ?? null;
  $('#productDlgTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  const unit = p ? unitOf(p) : 'ud';
  $$('input[name=pUnit]').forEach((r) => { r.checked = r.value === unit; r.disabled = !!p; });
  $('#pRef').value = p?.ref ?? '';
  $('#pName').value = p?.name ?? '';
  $('#pPrice').value = p ? p.price : '';
  $('#pUnits').value = p ? p.units : '';
  $('#pDelete').hidden = !p;
  syncUnitLabels();
  showError('#productError');
  paintPhoto();
  openDlg('#productDlg');
  setTimeout(() => (p ? $('#pName') : $('#pRef')).focus(), 50);
}

$$('input[name=pUnit]').forEach((r) => r.addEventListener('change', syncUnitLabels));

function paintPhoto() {
  const img = $('#pPhotoPreview');
  if (pendingPhoto) { img.src = pendingPhoto; img.hidden = false; $('#pPhotoPh').hidden = true; $('#pPhotoRemove').hidden = false; }
  else { img.removeAttribute('src'); img.hidden = true; $('#pPhotoPh').hidden = false; $('#pPhotoRemove').hidden = true; }
}

$('#pPhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    pendingPhoto = (await readImage(file, 480, 'image/jpeg', 0.82)).data;
    paintPhoto();
  } catch {
    toast('No se ha podido leer esa imagen. Prueba con JPG o PNG.');
  }
});
$('#pPhotoRemove').addEventListener('click', () => { pendingPhoto = null; paintPhoto(); });

$('#productForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const ref = $('#pRef').value.trim();
  const name = $('#pName').value.trim();
  const price = round2($('#pPrice').value);
  const units = Math.trunc(Number($('#pUnits').value));
  if (!ref || !name) return showError('#productError', 'La referencia y el nombre son obligatorios.');
  if (!(price >= 0)) return showError('#productError', 'El precio no es válido.');
  if (!Number.isFinite(units) || units < 0) return showError('#productError', 'Las existencias tienen que ser 0 o más.');
  const dup = activeProducts().find((p) => p.id !== editingId && norm(p.ref) === norm(ref));
  if (dup) return showError('#productError', `La referencia ${ref} ya la usa «${dup.name}».`);

  if (editingId) {
    const p = productById(editingId);
    const diff = units - p.units;
    Object.assign(p, { ref, name, price, photo: pendingPhoto, sample: false });
    if (diff !== 0) { p.units = units; addMovement(p.id, diff, 'ajuste', { note: 'Editado a mano' }); }
    toast('Producto actualizado');
  } else {
    const now = Date.now();
    const p = { id: uid(), ref, name, unit: formUnit(), price, units, photo: pendingPhoto, createdAt: now, deletedAt: null };
    state.products.push(p);
    addMovement(p.id, units, 'alta', { date: now });
    toast('Producto añadido');
  }
  save();
  closeDlg(e.target);
  renderAll();
});

$('#pDelete').addEventListener('click', () => {
  const p = productById(editingId);
  if (!p) return;
  if (!confirm(`¿Eliminar «${p.name}»? Seguirá apareciendo en los informes de fechas anteriores.`)) return;
  if (p.units !== 0) addMovement(p.id, -p.units, 'baja');
  p.units = 0;
  p.deletedAt = Date.now();
  save();
  closeDlg($('#pDelete'));
  renderAll();
  toast('Producto eliminado');
});

/* ---------- Adjust dialog ---------- */

let adjustingId = null;

function openAdjust(id) {
  const p = productById(id);
  adjustingId = id;
  $('#aRef').textContent = p.ref;
  $('#aName').textContent = p.name;
  $('#aUnits').textContent = fmtQty(p.units, unitOf(p));
  $('#aQtyLabel').textContent = isWeight(p) ? 'Cantidad en gramos' : 'Cantidad en unidades';
  $('#aQty').value = '';
  $('#aNote').value = '';
  showError('#adjustError');
  openDlg('#adjustDlg');
  setTimeout(() => $('#aQty').focus(), 50);
}

$('#adjustForm').addEventListener('submit', (e) => e.preventDefault());
$$('[data-adjust]').forEach((b) => b.addEventListener('click', () => {
  const p = productById(adjustingId);
  const unit = unitOf(p);
  const qty = Math.trunc(Number($('#aQty').value));
  const note = $('#aNote').value.trim();
  const mode = b.dataset.adjust;
  if ($('#aQty').value === '' || !Number.isFinite(qty) || qty < 0) return showError('#adjustError', 'Escribe una cantidad.');
  let delta;
  if (mode === 'add') delta = qty;
  else if (mode === 'sub') delta = -qty;
  else delta = qty - p.units;
  if (p.units + delta < 0) return showError('#adjustError', `Solo hay ${fmtQty(p.units, unit)}.`);
  if (delta === 0) { closeDlg(b); return; }
  p.units += delta;
  addMovement(p.id, delta, mode === 'set' ? 'ajuste' : delta > 0 ? 'entrada' : 'salida', { note });
  save();
  closeDlg(b);
  updateRow(p);
  renderStats();
  $(`.row[data-id="${p.id}"]`)?.classList.add('flash');
  toast(`${p.name}: ${delta > 0 ? '+' : '−'}${fmtQty(Math.abs(delta), unit)} → ${fmtQty(p.units, unit)}`);
}));

/* ---------- List events ---------- */

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.row').dataset.id;
  const act = btn.dataset.act;
  if (act === 'inc') quickStep(id, 1);
  else if (act === 'dec') quickStep(id, -1);
  else if (act === 'adjust') openAdjust(id);
  else if (act === 'edit') openProduct(id);
  else if (act === 'sell') openSale(id);
});

$('#search').addEventListener('input', renderList);
$('#sort').addEventListener('change', renderList);

/* ---------- Sale dialog ---------- */

let saleLines = [];

function openSale(preselectId = null) {
  if (!activeProducts().length) { toast('Primero añade algún producto'); return; }
  saleLines = [];
  $('#sDate').value = toLocalInput(Date.now());
  $('#sSearch').value = '';
  $('#sResults').hidden = true;
  showError('#saleError');
  if (preselectId) addSaleLine(preselectId);
  renderSale();
  openDlg('#saleDlg');
  if (!preselectId) setTimeout(() => $('#sSearch').focus(), 50);
}

function addSaleLine(id) {
  const p = productById(id);
  const line = saleLines.find((l) => l.productId === id);
  if (line) line.qty += isWeight(p) ? stepOf(p) : 1;
  else saleLines.push({ productId: id, qty: isWeight(p) ? 100 : 1, price: p.price });
}

function renderResults() {
  const q = norm($('#sSearch').value);
  const ul = $('#sResults');
  if (!q) { ul.hidden = true; return; }
  const found = activeProducts().filter((p) => norm(p.ref).includes(q) || norm(p.name).includes(q)).slice(0, 8);
  ul.innerHTML = found.length
    ? found.map((p) => `<li><button type="button" data-pick="${p.id}">
        <span class="mini">${p.photo ? `<img src="${p.photo}" alt="">` : esc(initials(p.name))}</span>
        <span><span class="ref">${esc(p.ref)}</span><br><span class="r-name">${esc(p.name)}</span></span>
        <span class="r-units">${fmtPrice(p.price, unitOf(p))}<br>${fmtQty(p.units, unitOf(p))}</span>
      </button></li>`).join('')
    : '<li class="r-none">No hay productos con ese nombre o referencia.</li>';
  ul.hidden = false;
}

function renderSale() {
  const tbody = $('#sLines');
  tbody.innerHTML = saleLines.map((l, i) => {
    const p = productById(l.productId);
    const unit = unitOf(p);
    const short = l.qty > p.units;
    return `<tr data-i="${i}">
      <td class="l-name">${esc(p.name)}<small>${esc(p.ref)} · quedan ${fmtQty(p.units, unit)}</small>${short ? '<span class="warn">No hay tanto en stock</span>' : ''}</td>
      <td class="num"><input type="number" class="l-qty" min="1" step="1" inputmode="numeric" value="${l.qty}"><span class="unit-suffix">${unit === 'g' ? 'g' : 'uds.'}</span></td>
      <td class="num"><input type="number" class="l-price" min="0" step="0.01" inputmode="decimal" value="${l.price}">${unit === 'g' ? '<span class="l-price-unit">€/100 g</span>' : ''}</td>
      <td class="num l-sub">${fmtMoney(amountOf(l.qty || 0, l.price || 0, unit))}</td>
      <td><button type="button" class="l-del" aria-label="Quitar">×</button></td>
    </tr>`;
  }).join('');
  $('#sEmpty').hidden = saleLines.length > 0;
  updateSaleTotal();
}

function saleProblems() {
  if (!saleLines.length) return 'empty';
  for (const l of saleLines) {
    const p = productById(l.productId);
    if (!(l.qty >= 1) || !Number.isInteger(l.qty)) return `Revisa la cantidad de «${p.name}».`;
    if (!(l.price >= 0)) return `Revisa el precio de «${p.name}».`;
    if (l.qty > p.units) return `De «${p.name}» solo quedan ${fmtQty(p.units, unitOf(p))}. Ajusta el stock antes si hace falta.`;
  }
  return null;
}

function updateSaleTotal() {
  const total = saleLines.reduce((s, l) => s + amountOf(l.qty || 0, l.price || 0, unitOf(productById(l.productId))), 0);
  $('#sTotal').textContent = fmtMoney(total);
  $('#sSubmit').disabled = saleProblems() !== null;
}

$('#sSearch').addEventListener('input', renderResults);
$('#sSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = $('#sResults [data-pick]');
  if (first) first.click();
});
$('#sResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  addSaleLine(b.dataset.pick);
  $('#sSearch').value = '';
  $('#sResults').hidden = true;
  renderSale();
});
$('#sLines').addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  const l = saleLines[Number(tr.dataset.i)];
  if (e.target.classList.contains('l-qty')) l.qty = Number(e.target.value);
  if (e.target.classList.contains('l-price')) l.price = round2(e.target.value);
  tr.querySelector('.l-sub').textContent = fmtMoney(amountOf(l.qty || 0, l.price || 0, unitOf(productById(l.productId))));
  updateSaleTotal();
});
$('#sLines').addEventListener('change', (e) => {
  if (e.target.classList.contains('l-qty')) renderSale();
});
$('#sLines').addEventListener('click', (e) => {
  if (!e.target.closest('.l-del')) return;
  saleLines.splice(Number(e.target.closest('tr').dataset.i), 1);
  renderSale();
});

$('#saleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const problem = saleProblems();
  if (problem) return showError('#saleError', problem === 'empty' ? 'Añade al menos un producto.' : problem);
  const date = $('#sDate').value ? new Date($('#sDate').value).getTime() : Date.now();
  const id = uid();
  const lines = saleLines.map((l) => {
    const p = productById(l.productId);
    return { productId: p.id, ref: p.ref, name: p.name, unit: unitOf(p), qty: l.qty, price: round2(l.price) };
  });
  const total = round2(lines.reduce((s, l) => s + amountOf(l.qty, l.price, l.unit), 0));
  const number = ++state.saleSeq;
  state.sales.push({ id, number, date, lines, total, voidedAt: null });
  for (const l of lines) {
    const p = productById(l.productId);
    p.units -= l.qty;
    addMovement(p.id, -l.qty, 'venta', { date, saleId: id, price: l.price, note: `Venta nº ${number}` });
  }
  save();
  closeDlg(e.target);
  renderAll();
  toast(`Venta nº ${number} registrada · ${fmtMoney(total)}`);
});

function voidSale(id) {
  const s = state.sales.find((x) => x.id === id);
  if (!s || s.voidedAt) return;
  if (!confirm(`¿Anular la venta nº ${s.number} (${fmtMoney(s.total)})? Lo vendido vuelve al inventario.`)) return;
  s.voidedAt = Date.now();
  for (const l of s.lines) {
    const p = productById(l.productId);
    if (!p || p.deletedAt) continue;
    p.units += l.qty;
    addMovement(p.id, l.qty, 'anulacion', { saleId: s.id, price: l.price, note: `Venta nº ${s.number} anulada` });
  }
  save();
  renderAll();
  renderHistory();
  toast(`Venta nº ${s.number} anulada`);
}

/* ---------- History ---------- */

let historyTab = 'sales';

function openHistory() {
  const now = new Date();
  $('#hTo').value = isoDay(now);
  $('#hFrom').value = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
  renderHistory();
  openDlg('#historyDlg');
}

function historyRange() {
  const from = $('#hFrom').value ? dayStart($('#hFrom').value) : 0;
  const to = $('#hTo').value ? dayEnd($('#hTo').value) : Infinity;
  return [from, to];
}

function renderHistory() {
  const [from, to] = historyRange();
  const body = $('#historyBody');
  if (historyTab === 'sales') {
    const sales = state.sales.filter((s) => s.date >= from && s.date <= to).sort((a, b) => b.date - a.date);
    const valid = sales.filter((s) => !s.voidedAt);
    const sum = valid.reduce((s, v) => s + v.total, 0);
    body.innerHTML = `<p class="h-summary"><b>${valid.length}</b> ventas · <b>${fmtMoney(sum)}</b> en el periodo</p>` + (sales.length
      ? sales.map((s) => `<article class="h-sale ${s.voidedAt ? 'voided' : ''}">
          <div class="h-head"><span class="h-num">Nº ${s.number}</span><span class="h-date">${fmtDateTime(s.date)}</span><span class="h-total">${fmtMoney(s.total)}</span></div>
          <ul class="h-lines">${s.lines.map((l) => `<li><span>${fmtQty(l.qty, l.unit || 'ud')}</span><span>${esc(l.name)}</span><span>${fmtMoney(amountOf(l.qty, l.price, l.unit || 'ud'))}</span></li>`).join('')}</ul>
          <div class="h-foot">${s.voidedAt ? `<span class="h-tag">Anulada el ${fmtDay(s.voidedAt)}</span>` : `<button type="button" class="btn btn-ghost btn-small" data-void="${s.id}">Anular venta</button>`}</div>
        </article>`).join('')
      : '<p class="empty">No hay ventas en estas fechas.</p>');
  } else {
    const moves = state.movements.filter((m) => m.date >= from && m.date <= to).sort((a, b) => b.date - a.date);
    body.innerHTML = moves.length
      ? `<table class="moves"><tbody>${moves.map((m) => {
          const p = productById(m.productId);
          const unit = unitOf(p);
          return `<tr>
            <td class="m-date">${fmtDateTime(m.date)}</td>
            <td><span class="m-type">${MOVE_LABEL[m.type] || m.type}</span><br>${esc(p ? p.name : '—')}${m.note ? `<br><span class="muted">${esc(m.note)}</span>` : ''}</td>
            <td class="m-delta ${m.delta > 0 ? 'pos' : 'neg'}">${m.delta > 0 ? '+' : '−'}${fmtQty(Math.abs(m.delta), unit)}</td>
          </tr>`;
        }).join('')}</tbody></table>`
      : '<p class="empty">No hay movimientos en estas fechas.</p>';
  }
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  historyTab = t.dataset.tab;
  $$('.tab').forEach((x) => x.classList.toggle('is-on', x === t));
  renderHistory();
}));
$('#hFrom').addEventListener('change', renderHistory);
$('#hTo').addEventListener('change', renderHistory);
$('#historyBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-void]');
  if (b) voidSale(b.dataset.void);
});

/* ---------- Reports ---------- */

const byRef = (a, b) => a.ref.localeCompare(b.ref, 'es', { numeric: true, sensitivity: 'base' });

function currentReport() {
  const rows = activeProducts().sort(byRef).map((p) => {
    const unit = unitOf(p);
    return { ref: p.ref, name: p.name, unit, price: p.price, units: p.units, value: amountOf(p.units, p.price, unit), photo: p.photo };
  });
  return { rows, value: round2(rows.reduce((s, r) => s + r.value, 0)) };
}

function rangeReport(from, to) {
  const byProduct = groupMoves();
  const rows = state.products
    .filter((p) => p.createdAt <= to && (!p.deletedAt || p.deletedAt >= from))
    .sort(byRef)
    .map((p) => {
      const unit = unitOf(p);
      const moves = (byProduct.get(p.id) || []).filter((m) => m.date >= from && m.date <= to);
      const end = stockAt(p, to, byProduct);
      let net = 0, inQty = 0, sold = 0, out = 0, amount = 0;
      for (const m of moves) {
        net += m.delta;
        if (m.type === 'venta' || m.type === 'anulacion') {
          sold -= m.delta;
          amount -= m.delta * (m.price ?? p.price) * priceFactor(unit);
        } else if (m.delta > 0) inQty += m.delta;
        else out -= m.delta;
      }
      return { ref: p.ref, name: p.name, unit, price: p.price, start: end - net, in: inQty, sold, out, end, amount: round2(amount), deleted: !!p.deletedAt && p.deletedAt <= to };
    });
  const sales = state.sales.filter((s) => s.date >= from && s.date <= to).sort((a, b) => a.date - b.date);
  const moves = state.movements.filter((m) => m.date >= from && m.date <= to).sort((a, b) => a.date - b.date);
  return { rows, sales, moves, amount: round2(rows.reduce((s, r) => s + r.amount, 0)) };
}

function reportTitle() {
  const s = state.settings;
  return s.storeName ? `${s.title} · ${s.storeName}` : s.title;
}

/* ---------- Excel ---------- */

const MONEY_Z = '#,##0.00 "€"';

function sheetFrom(aoa, moneyCols, headerRow, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    for (const c of moneyCols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') cell.z = MONEY_Z;
    }
  }
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

function exportExcel(mode, from, to, fileBase) {
  const wb = XLSX.utils.book_new();
  const title = reportTitle();
  if (mode === 'current') {
    const r = currentReport();
    const aoa = [
      [title],
      [`Inventario a ${fmtDateTime(Date.now())}`],
      [],
      ['Referencia', 'Producto', 'Precio', 'Precio por', 'Existencias', 'Unidad', 'Valor'],
      ...r.rows.map((x) => [x.ref, x.name, x.price, priceUnitLabel(x.unit), x.units, x.unit, x.value]),
      [],
      ['', 'TOTAL', '', '', '', '', r.value],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(aoa, [2, 6], 3, [16, 44, 11, 10, 12, 8, 14]), 'Inventario');
  } else {
    const r = rangeReport(from, to);
    const period = `Del ${fmtDay(from)} al ${fmtDay(to)}`;
    const summary = [
      [title],
      [`Movimiento de inventario · ${period}`],
      [],
      ['Referencia', 'Producto', 'Unidad', 'Precio', 'Precio por', 'Stock inicial', 'Entradas', 'Vendido', 'Otras salidas', 'Stock final', 'Importe vendido'],
      ...r.rows.map((x) => [x.ref, x.deleted ? `${x.name} (eliminado)` : x.name, x.unit, x.price, priceUnitLabel(x.unit), x.start, x.in, x.sold, x.out, x.end, x.amount]),
      [],
      ['', 'TOTAL', '', '', '', '', '', '', '', '', r.amount],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(summary, [3, 10], 3, [16, 44, 8, 11, 10, 12, 10, 10, 12, 11, 16]), 'Resumen');

    const salesAoa = [
      ['Nº venta', 'Fecha', 'Referencia', 'Producto', 'Cantidad', 'Unidad', 'Precio', 'Precio por', 'Importe', 'Estado'],
      ...r.sales.flatMap((s) => s.lines.map((l) => {
        const unit = l.unit || 'ud';
        return [s.number, fmtDateTime(s.date), l.ref, l.name, l.qty, unit, l.price, priceUnitLabel(unit), amountOf(l.qty, l.price, unit), s.voidedAt ? `Anulada ${fmtDay(s.voidedAt)}` : ''];
      })),
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(salesAoa, [6, 8], 0, [9, 17, 16, 40, 10, 8, 10, 10, 12, 18]), 'Ventas');

    const movesAoa = [
      ['Fecha', 'Tipo', 'Referencia', 'Producto', 'Cantidad', 'Unidad', 'Nota'],
      ...r.moves.map((m) => {
        const p = productById(m.productId);
        return [fmtDateTime(m.date), MOVE_LABEL[m.type] || m.type, p?.ref ?? '', p?.name ?? '', m.delta, unitOf(p), m.note || ''];
      }),
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(movesAoa, [], 0, [17, 14, 16, 40, 10, 8, 36]), 'Movimientos');
  }
  XLSX.writeFile(wb, `${fileBase}.xlsx`);
}

/* ---------- PDF ---------- */

const pdfText = (s) => String(s).replace(/[  ]/g, ' ');
const pdfMoney = (n) => pdfText(fmtMoney(n));
const pdfPrice = (price, unit) => pdfText(fmtPrice(price, unit));
const pdfQty = (q, unit) => pdfText(unit === 'g' ? fmtQty(q, unit) : fmtNum(q));
const imgFormat = (dataUrl) => (/^data:image\/png/i.test(dataUrl) ? 'PNG' : 'JPEG');
const INK = [43, 43, 43];
const BRAND_GREEN = [91, 138, 18];
const PLUM = [142, 74, 168];
const DANGER = [181, 69, 42];
const SOFT = [245, 243, 234];

function pdfHeader(doc, subtitle) {
  const s = state.settings;
  const W = doc.internal.pageSize.getWidth();
  let x = 14;
  if (s.logo && s.logoW && s.logoH) {
    const maxW = 26, maxH = 24;
    const k = Math.min(maxW / s.logoW, maxH / s.logoH);
    const w = s.logoW * k, h = s.logoH * k;
    try { doc.addImage(s.logo, imgFormat(s.logo), 14, 10 + (maxH - h) / 2, w, h); x = 14 + w + 5; } catch { /* unreadable logo */ }
  }
  if (s.storeName) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...PLUM);
    doc.text(pdfText(s.storeName.toUpperCase()), x, 17);
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...INK);
  doc.text(pdfText(s.title), x, s.storeName ? 25 : 22);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(110, 108, 92);
  doc.text(pdfText(subtitle), x, s.storeName ? 31 : 28);
  doc.setDrawColor(...INK); doc.setLineWidth(0.6);
  doc.line(14, 37, W - 14, 37);
  doc.setDrawColor(165, 206, 50); doc.setLineWidth(0.9);
  doc.line(14, 38.4, W - 14, 38.4);
  return 45;
}

function pdfFooter(doc) {
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 138, 120);
    doc.text(pdfText(`Generado el ${fmtDateTime(Date.now())}`), 14, H - 8);
    doc.text(`Página ${i} de ${total}`, W - 14, H - 8, { align: 'right' });
  }
}

const tableBase = {
  theme: 'plain',
  margin: { left: 14, right: 14, bottom: 16 },
  styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.2, textColor: INK, lineColor: [220, 216, 196], lineWidth: { bottom: 0.2 } },
  headStyles: { fillColor: INK, textColor: [245, 243, 234], fontStyle: 'bold', fontSize: 8 },
  alternateRowStyles: { fillColor: SOFT },
  footStyles: { fillColor: [230, 240, 207], textColor: INK, fontStyle: 'bold' },
};

function exportPdf(mode, from, to, fileBase) {
  const { jsPDF } = window.jspdf;
  if (mode === 'current') {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const r = currentReport();
    const startY = pdfHeader(doc, `Inventario a ${fmtDateTime(Date.now())}`);
    doc.autoTable({
      ...tableBase,
      startY,
      head: [['Foto', 'Ref.', 'Producto', 'Precio', 'Existencias', 'Valor']],
      body: r.rows.map((x) => ['', pdfText(x.ref), pdfText(x.name), pdfPrice(x.price, x.unit), pdfQty(x.units, x.unit) + (x.unit === 'g' ? '' : ' uds.'), pdfMoney(x.value)]),
      foot: [['', '', 'TOTAL', '', '', pdfMoney(r.value)]],
      columnStyles: {
        0: { cellWidth: 16, minCellHeight: 14 },
        1: { cellWidth: 28, fontStyle: 'bold' },
        3: { halign: 'right', cellWidth: 30 },
        4: { halign: 'right', cellWidth: 22 },
        5: { halign: 'right', cellWidth: 24 },
      },
      bodyStyles: { valign: 'middle' },
      didDrawCell: (d) => {
        if (d.section !== 'body' || d.column.index !== 0) return;
        const photo = r.rows[d.row.index]?.photo;
        if (!photo) return;
        const size = Math.min(d.cell.width, d.cell.height) - 2;
        try { doc.addImage(photo, imgFormat(photo), d.cell.x + (d.cell.width - size) / 2, d.cell.y + (d.cell.height - size) / 2, size, size); } catch { /* broken photo */ }
      },
    });
    pdfFooter(doc);
    doc.save(`${fileBase}.pdf`);
    return;
  }

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const r = rangeReport(from, to);
  const startY = pdfHeader(doc, `Movimiento de inventario · del ${fmtDay(from)} al ${fmtDay(to)}`);
  doc.autoTable({
    ...tableBase,
    startY,
    head: [['Ref.', 'Producto', 'Precio', 'Stock inicial', 'Entradas', 'Vendido', 'Otras salidas', 'Stock final', 'Importe vendido']],
    body: r.rows.map((x) => [
      pdfText(x.ref), pdfText(x.deleted ? `${x.name} (eliminado)` : x.name), pdfPrice(x.price, x.unit),
      pdfQty(x.start, x.unit), pdfQty(x.in, x.unit), pdfQty(x.sold, x.unit), pdfQty(x.out, x.unit), pdfQty(x.end, x.unit), pdfMoney(x.amount),
    ]),
    foot: [['', 'TOTAL', '', '', '', '', '', '', pdfMoney(r.amount)]],
    columnStyles: {
      0: { cellWidth: 30, fontStyle: 'bold' },
      2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      6: { halign: 'right' }, 7: { halign: 'right', fontStyle: 'bold' }, 8: { halign: 'right' },
    },
  });

  let y = doc.lastAutoTable.finalY + 12;
  if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 20; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...BRAND_GREEN);
  doc.text('Ventas del periodo', 14, y);
  const saleRows = r.sales.flatMap((s) => s.lines.map((l) => {
    const unit = l.unit || 'ud';
    return [String(s.number), pdfText(fmtDateTime(s.date)), pdfText(l.ref), pdfText(l.name), pdfQty(l.qty, unit), pdfPrice(l.price, unit), pdfMoney(amountOf(l.qty, l.price, unit)), s.voidedAt ? 'Anulada' : ''];
  }));
  const validTotal = round2(r.sales.filter((s) => !s.voidedAt).reduce((s, v) => s + v.total, 0));
  doc.autoTable({
    ...tableBase,
    startY: y + 4,
    head: [['Nº', 'Fecha', 'Ref.', 'Producto', 'Cant.', 'Precio', 'Importe', '']],
    body: saleRows.length ? saleRows : [['', '', '', 'No hay ventas en el periodo', '', '', '', '']],
    foot: [['', '', '', 'TOTAL (sin anuladas)', '', '', pdfMoney(validTotal), '']],
    columnStyles: {
      0: { cellWidth: 14 }, 1: { cellWidth: 34 }, 2: { cellWidth: 30 },
      4: { halign: 'right', cellWidth: 20 }, 5: { halign: 'right', cellWidth: 30 }, 6: { halign: 'right', cellWidth: 26 },
      7: { cellWidth: 20, textColor: DANGER, fontStyle: 'bold' },
    },
  });
  pdfFooter(doc);
  doc.save(`${fileBase}.pdf`);
}

/* ---------- Export dialog ---------- */

function openExport() {
  const now = new Date();
  $('#eFrom').value = isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  $('#eTo').value = isoDay(now);
  syncExportMode();
  showError('#exportError');
  openDlg('#exportDlg');
}

function syncExportMode() {
  $('#eRange').hidden = $('input[name=eMode]:checked').value !== 'range';
}

$$('input[name=eMode]').forEach((r) => r.addEventListener('change', syncExportMode));
$('#exportForm').addEventListener('submit', (e) => e.preventDefault());
$$('[data-export]').forEach((b) => b.addEventListener('click', () => {
  const mode = $('input[name=eMode]:checked').value;
  const format = b.dataset.export;
  let from = 0, to = Date.now(), fileBase = `inventario_${isoDay(new Date())}`;
  if (mode === 'range') {
    if (!$('#eFrom').value || !$('#eTo').value) return showError('#exportError', 'Elige las dos fechas.');
    from = dayStart($('#eFrom').value);
    to = dayEnd($('#eTo').value);
    if (from > to) return showError('#exportError', 'La fecha «Desde» es posterior a «Hasta».');
    fileBase = `inventario_${$('#eFrom').value}_a_${$('#eTo').value}`;
  } else if (!activeProducts().length) {
    return showError('#exportError', 'No hay productos que exportar.');
  }
  showError('#exportError');
  try {
    if (format === 'xlsx') exportExcel(mode, from, to, fileBase);
    else exportPdf(mode, from, to, fileBase);
    toast(format === 'xlsx' ? 'Excel descargado' : 'PDF descargado');
  } catch (err) {
    console.error(err);
    showError('#exportError', 'No se ha podido generar el fichero.');
  }
}));

/* ---------- Settings, logo, samples and backup ---------- */

function openSettings(focusBackup = false) {
  const s = state.settings;
  $('#stStore').value = s.storeName || '';
  $('#stTitle').value = s.title || '';
  $('#stLow').value = s.lowStock;
  $('#stLowG').value = s.lowStockG;
  $('#stStep').value = s.weightStep;
  $(`input[name="stTheme"][value="${s.theme || 'auto'}"]`).checked = true;
  $('#stLogoRemove').hidden = !s.logo;
  $('#samplesSection').hidden = !state.products.some((p) => p.sample && !p.deletedAt);
  $('#stLastBackup').textContent = s.lastBackup ? `Última copia: ${fmtDateTime(s.lastBackup)}` : 'Todavía no has hecho ninguna copia.';
  openDlg('#settingsDlg');
  if (focusBackup) setTimeout(() => $('#backupSection').scrollIntoView({ behavior: 'smooth' }), 80);
}

const intOr = (v, fallback, min) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : fallback;
};

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = state.settings;
  s.storeName = $('#stStore').value.trim();
  s.title = $('#stTitle').value.trim() || 'Inventario de la tienda';
  s.lowStock = intOr($('#stLow').value, 2, 0);
  s.lowStockG = intOr($('#stLowG').value, 200, 0);
  s.weightStep = intOr($('#stStep').value, 50, 1);
  save();
  closeDlg(e.target);
  renderAll();
});

document.querySelectorAll('input[name="stTheme"]').forEach((r) => r.addEventListener('change', () => {
  state.settings.theme = r.value;
  save();
  applyTheme();
}));

$('#logoBtn').addEventListener('click', () => $('#logoInput').click());
$('#stLogoChange').addEventListener('click', () => $('#logoInput').click());
$('#stLogoRemove').addEventListener('click', () => {
  Object.assign(state.settings, { logo: null, logoW: 0, logoH: 0 });
  $('#stLogoRemove').hidden = true;
  save();
  renderHeader();
});
$('#logoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await readImage(file, 600, 'image/png');
    Object.assign(state.settings, { logo: img.data, logoW: img.w, logoH: img.h });
    $('#stLogoRemove').hidden = false;
    save();
    renderHeader();
    toast('Logo actualizado');
  } catch {
    toast('No se ha podido leer esa imagen. Prueba con JPG o PNG.');
  }
});
$('#appTitle').addEventListener('click', () => openSettings());

$('#samplesRemove').addEventListener('click', () => {
  const ids = new Set(state.products.filter((p) => p.sample).map((p) => p.id));
  if (!ids.size) return;
  if (!confirm(`¿Quitar los ${ids.size} productos de ejemplo? Se borran también sus movimientos.`)) return;
  state.products = state.products.filter((p) => !ids.has(p.id));
  state.movements = state.movements.filter((m) => !ids.has(m.productId));
  state.sales = state.sales
    .map((s) => {
      const lines = s.lines.filter((l) => !ids.has(l.productId));
      return { ...s, lines, total: round2(lines.reduce((t, l) => t + amountOf(l.qty, l.price, l.unit || 'ud'), 0)) };
    })
    .filter((s) => s.lines.length);
  save();
  $('#samplesSection').hidden = true;
  renderAll();
  toast('Productos de ejemplo quitados');
});

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

$('#backupExport').addEventListener('click', () => {
  state.settings.lastBackup = Date.now();
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  downloadBlob(blob, `inventario-copia_${isoDay(new Date())}.json`);
  save();
  $('#stLastBackup').textContent = `Última copia: ${fmtDateTime(state.settings.lastBackup)}`;
  renderBackupWarn();
  toast('Copia descargada. Guárdala fuera del móvil.');
});
$('#backupImport').addEventListener('click', () => $('#backupFile').click());
$('#backupFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || !Array.isArray(raw.products) || !raw.settings) throw new Error('format');
    const n = raw.products.filter((p) => !p.deletedAt).length;
    if (!confirm(`La copia tiene ${n} productos y ${(raw.sales || []).length} ventas. Se sustituirá TODO lo que hay ahora. ¿Seguir?`)) return;
    state = normalizeState(raw);
    state.settings.brandApplied = true;
    state.settings.samplesSeeded = true;
    await save();
    closeDlg($('#backupImport'));
    renderAll();
    toast('Copia restaurada');
  } catch {
    toast('Ese fichero no es una copia válida del inventario.', 4000);
  }
});

/* ---------- First run branding and samples ---------- */

async function applyBranding() {
  const s = state.settings;
  if (s.brandApplied) return false;
  if (!s.storeName) s.storeName = BRAND.storeName;
  if (!s.logo) {
    try {
      s.logo = await urlToDataUrl(BRAND.logo);
      s.logoW = 600; s.logoH = 600;
    } catch { /* uploadable later from Ajustes */ }
  }
  s.brandApplied = true;
  return true;
}

async function seedSamples() {
  const s = state.settings;
  if (s.samplesSeeded) return false;
  s.samplesSeeded = true;
  if (state.products.length) return true;
  const base = Date.now() - SAMPLES.length * 1000;
  for (const [i, x] of SAMPLES.entries()) {
    let photo = null;
    try { photo = await urlToDataUrl(`img/ejemplos/${x.photo}`); } catch { /* no photo */ }
    const createdAt = base + i * 1000;
    const p = { id: uid(), ref: x.ref, name: x.name, unit: x.unit, price: x.price, units: x.units, photo, createdAt, deletedAt: null, sample: true };
    state.products.push(p);
    addMovement(p.id, x.units, 'alta', { date: createdAt });
  }
  return true;
}

/* ---------- Toolbar ---------- */

$('#saleBtn').addEventListener('click', () => openSale());
$('#addBtn').addEventListener('click', () => openProduct());
$('#exportBtn').addEventListener('click', openExport);
$('#historyBtn').addEventListener('click', openHistory);
$('#settingsBtn').addEventListener('click', () => openSettings());
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (!o) return;
  if (o.dataset.open === 'product') openProduct();
  if (o.dataset.open === 'backup') openSettings(true);
});

/* ---------- Boot ---------- */

(async function boot() {
  try { state = normalizeState(await storage.load()); } catch { state = defaultState(); }
  renderAll();
  const branded = await applyBranding();
  const seeded = await seedSamples();
  if (branded || seeded) { save(); renderAll(); }
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
