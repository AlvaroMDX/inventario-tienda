'use strict';

const DB_NAME = 'inventario-tienda';
const STORE = 'kv';
const KEY = 'state';
const LS_KEY = 'inventario-tienda-state';
const BACKUP_WARN_DAYS = 7;
const MERGE_WINDOW_MS = 2 * 60 * 1000;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const moneyFmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('es-ES');
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

const MOVE_LABEL = {
  alta: 'Alta', entrada: 'Entrada', salida: 'Salida', ajuste: 'Recuento',
  venta: 'Venta', anulacion: 'Venta anulada', baja: 'Baja',
};

function defaultState() {
  return {
    version: 1,
    settings: { title: 'Inventario de la tienda', storeName: '', lowStock: 2, logo: null, logoW: 0, logoH: 0, lastBackup: null },
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

function quickStep(id, d) {
  const p = productById(id);
  if (!p) return;
  if (p.units + d < 0) { toast(`No quedan unidades de ${p.name}`); return; }
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
  if (p.units <= state.settings.lowStock) return 'low';
  return '';
}

function rowHtml(p, i) {
  const cls = stockClass(p);
  const badge = cls === 'out' ? '<span class="badge">Agotado</span>' : cls === 'low' ? '<span class="badge">Poco stock</span>' : '';
  const thumb = p.photo ? `<img src="${p.photo}" alt="" loading="lazy">` : esc(initials(p.name));
  return `<li class="row ${cls}" data-id="${p.id}" style="--i:${Math.min(i, 20)}">
    <div class="thumb">${thumb}</div>
    <div class="info">
      <span class="ref">${esc(p.ref)}</span>
      <span class="name">${esc(p.name)}</span>
      <span class="price">${fmtMoney(p.price)}<span class="value">· ${fmtMoney(p.price * p.units)} en stock</span></span>
    </div>
    <div class="step-area">
      <div class="stepper">
        <button type="button" class="dec" data-act="dec" aria-label="Restar una unidad">−</button>
        <button type="button" class="units" data-act="adjust" title="Sumar, restar o fijar varias unidades"><b>${fmtNum(p.units)}</b><small>uds.</small></button>
        <button type="button" class="inc" data-act="inc" aria-label="Sumar una unidad">+</button>
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
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
    ref: (a, b) => a.ref.localeCompare(b.ref, 'es', { numeric: true, sensitivity: 'base' }),
    units: (a, b) => a.units - b.units || a.name.localeCompare(b.name, 'es'),
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
  $('#statProducts').textContent = fmtNum(all.length);
  $('#statUnits').textContent = fmtNum(all.reduce((s, p) => s + p.units, 0));
  $('#statValue').textContent = fmtMoney(all.reduce((s, p) => s + p.units * p.price, 0));
  const from = dayStart(isoDay(new Date()));
  const today = state.sales.filter((s) => !s.voidedAt && s.date >= from && s.date <= from + 86400000 - 1).reduce((s, v) => s + v.total, 0);
  $('#statToday').textContent = fmtMoney(today);
}

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
  const hasData = state.products.length > 0;
  const days = s.lastBackup ? Math.floor((Date.now() - s.lastBackup) / 86400000) : null;
  const show = hasData && (days === null || days >= BACKUP_WARN_DAYS);
  $('#backupWarn').hidden = !show;
  if (show) {
    $('#backupWarnText').textContent = days === null
      ? 'Aún no has descargado ninguna copia de seguridad. Los datos viven solo en este dispositivo.'
      : `Hace ${days} días de la última copia de seguridad.`;
  }
}

function renderAll() {
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

function openProduct(id = null) {
  editingId = id;
  const p = id ? productById(id) : null;
  pendingPhoto = p?.photo ?? null;
  $('#productDlgTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  $('#pUnitsLabel').textContent = p ? 'Unidades' : 'Unidades iniciales';
  $('#pRef').value = p?.ref ?? '';
  $('#pName').value = p?.name ?? '';
  $('#pPrice').value = p ? p.price : '';
  $('#pUnits').value = p ? p.units : '';
  $('#pDelete').hidden = !p;
  showError('#productError');
  paintPhoto();
  openDlg('#productDlg');
  setTimeout(() => (p ? $('#pName') : $('#pRef')).focus(), 50);
}

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
  if (!Number.isFinite(units) || units < 0) return showError('#productError', 'Las unidades tienen que ser 0 o más.');
  const dup = activeProducts().find((p) => p.id !== editingId && norm(p.ref) === norm(ref));
  if (dup) return showError('#productError', `La referencia ${ref} ya la usa «${dup.name}».`);

  if (editingId) {
    const p = productById(editingId);
    const diff = units - p.units;
    Object.assign(p, { ref, name, price, photo: pendingPhoto });
    if (diff !== 0) { p.units = units; addMovement(p.id, diff, 'ajuste', { note: 'Editado a mano' }); }
    toast('Producto actualizado');
  } else {
    const now = Date.now();
    const p = { id: uid(), ref, name, price, units, photo: pendingPhoto, createdAt: now, deletedAt: null };
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
  $('#aUnits').textContent = fmtNum(p.units);
  $('#aQty').value = '';
  $('#aNote').value = '';
  showError('#adjustError');
  openDlg('#adjustDlg');
  setTimeout(() => $('#aQty').focus(), 50);
}

$('#adjustForm').addEventListener('submit', (e) => e.preventDefault());
$$('[data-adjust]').forEach((b) => b.addEventListener('click', () => {
  const p = productById(adjustingId);
  const qty = Math.trunc(Number($('#aQty').value));
  const note = $('#aNote').value.trim();
  const mode = b.dataset.adjust;
  if ($('#aQty').value === '' || !Number.isFinite(qty) || qty < 0) return showError('#adjustError', 'Escribe una cantidad.');
  let delta;
  if (mode === 'add') delta = qty;
  else if (mode === 'sub') delta = -qty;
  else delta = qty - p.units;
  if (p.units + delta < 0) return showError('#adjustError', `Solo hay ${p.units} unidades.`);
  if (delta === 0) { closeDlg(b); return; }
  p.units += delta;
  addMovement(p.id, delta, mode === 'set' ? 'ajuste' : delta > 0 ? 'entrada' : 'salida', { note });
  save();
  closeDlg(b);
  updateRow(p);
  renderStats();
  $(`.row[data-id="${p.id}"]`)?.classList.add('flash');
  toast(`${p.name}: ${delta > 0 ? '+' : ''}${delta} → ${p.units} uds.`);
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
  if (line) line.qty += 1;
  else saleLines.push({ productId: id, qty: 1, price: p.price });
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
        <span class="r-units">${fmtMoney(p.price)}<br>${fmtNum(p.units)} uds.</span>
      </button></li>`).join('')
    : '<li class="r-none">No hay productos con ese nombre o referencia.</li>';
  ul.hidden = false;
}

function renderSale() {
  const tbody = $('#sLines');
  tbody.innerHTML = saleLines.map((l, i) => {
    const p = productById(l.productId);
    const short = l.qty > p.units;
    return `<tr data-i="${i}">
      <td class="l-name">${esc(p.name)}<small>${esc(p.ref)} · quedan ${fmtNum(p.units)}</small>${short ? '<span class="warn">No hay tantas unidades</span>' : ''}</td>
      <td class="num"><input type="number" class="l-qty" min="1" step="1" inputmode="numeric" value="${l.qty}"></td>
      <td class="num"><input type="number" class="l-price" min="0" step="0.01" inputmode="decimal" value="${l.price}"></td>
      <td class="num l-sub">${fmtMoney(l.qty * l.price)}</td>
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
    if (!(l.qty >= 1) || !Number.isInteger(l.qty)) return `Revisa las unidades de «${p.name}».`;
    if (!(l.price >= 0)) return `Revisa el precio de «${p.name}».`;
    if (l.qty > p.units) return `De «${p.name}» solo quedan ${p.units}. Ajusta el stock antes si hace falta.`;
  }
  return null;
}

function updateSaleTotal() {
  const total = saleLines.reduce((s, l) => s + (l.qty || 0) * (l.price || 0), 0);
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
  tr.querySelector('.l-sub').textContent = fmtMoney((l.qty || 0) * (l.price || 0));
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
    return { productId: p.id, ref: p.ref, name: p.name, qty: l.qty, price: round2(l.price) };
  });
  const total = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
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
  if (!confirm(`¿Anular la venta nº ${s.number} (${fmtMoney(s.total)})? Las unidades vuelven al inventario.`)) return;
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
          <ul class="h-lines">${s.lines.map((l) => `<li><span>${l.qty} ×</span><span>${esc(l.name)}</span><span>${fmtMoney(l.qty * l.price)}</span></li>`).join('')}</ul>
          <div class="h-foot">${s.voidedAt ? `<span class="h-tag">Anulada el ${fmtDay(s.voidedAt)}</span>` : `<button type="button" class="btn btn-ghost btn-small" data-void="${s.id}">Anular venta</button>`}</div>
        </article>`).join('')
      : '<p class="empty">No hay ventas en estas fechas.</p>');
  } else {
    const moves = state.movements.filter((m) => m.date >= from && m.date <= to).sort((a, b) => b.date - a.date);
    body.innerHTML = moves.length
      ? `<table class="moves"><tbody>${moves.map((m) => {
          const p = productById(m.productId);
          return `<tr>
            <td class="m-date">${fmtDateTime(m.date)}</td>
            <td><span class="m-type">${MOVE_LABEL[m.type] || m.type}</span><br>${esc(p ? p.name : '—')}${m.note ? `<br><span class="muted">${esc(m.note)}</span>` : ''}</td>
            <td class="m-delta ${m.delta > 0 ? 'pos' : 'neg'}">${m.delta > 0 ? '+' : ''}${m.delta}</td>
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

function currentReport() {
  const rows = activeProducts()
    .sort((a, b) => a.ref.localeCompare(b.ref, 'es', { numeric: true, sensitivity: 'base' }))
    .map((p) => ({ ref: p.ref, name: p.name, price: p.price, units: p.units, value: round2(p.price * p.units), photo: p.photo }));
  return {
    rows,
    units: rows.reduce((s, r) => s + r.units, 0),
    value: round2(rows.reduce((s, r) => s + r.value, 0)),
  };
}

function rangeReport(from, to) {
  const byProduct = groupMoves();
  const rows = state.products
    .filter((p) => p.createdAt <= to && (!p.deletedAt || p.deletedAt >= from))
    .sort((a, b) => a.ref.localeCompare(b.ref, 'es', { numeric: true, sensitivity: 'base' }))
    .map((p) => {
      const moves = (byProduct.get(p.id) || []).filter((m) => m.date >= from && m.date <= to);
      const end = stockAt(p, to, byProduct);
      let net = 0, inUnits = 0, sold = 0, out = 0, amount = 0;
      for (const m of moves) {
        net += m.delta;
        if (m.type === 'venta' || m.type === 'anulacion') {
          sold -= m.delta;
          amount -= m.delta * (m.price ?? p.price);
        } else if (m.delta > 0) inUnits += m.delta;
        else out -= m.delta;
      }
      return { ref: p.ref, name: p.name, price: p.price, start: end - net, in: inUnits, sold, out, end, amount: round2(amount), deleted: !!p.deletedAt && p.deletedAt <= to };
    });
  const sales = state.sales.filter((s) => s.date >= from && s.date <= to).sort((a, b) => a.date - b.date);
  const moves = state.movements.filter((m) => m.date >= from && m.date <= to).sort((a, b) => a.date - b.date);
  return {
    rows, sales, moves,
    sold: rows.reduce((s, r) => s + r.sold, 0),
    amount: round2(rows.reduce((s, r) => s + r.amount, 0)),
  };
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
      ['Referencia', 'Producto', 'Precio', 'Unidades', 'Valor'],
      ...r.rows.map((x) => [x.ref, x.name, x.price, x.units, x.value]),
      [],
      ['', 'TOTAL', '', r.units, r.value],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(aoa, [2, 4], 3, [16, 40, 12, 10, 14]), 'Inventario');
  } else {
    const r = rangeReport(from, to);
    const period = `Del ${fmtDay(from)} al ${fmtDay(to)}`;
    const summary = [
      [title],
      [`Movimiento de inventario · ${period}`],
      [],
      ['Referencia', 'Producto', 'Precio', 'Stock inicial', 'Entradas', 'Vendidas', 'Otras salidas', 'Stock final', 'Importe vendido'],
      ...r.rows.map((x) => [x.ref, x.deleted ? `${x.name} (eliminado)` : x.name, x.price, x.start, x.in, x.sold, x.out, x.end, x.amount]),
      [],
      ['', 'TOTAL', '', '', '', r.sold, '', '', r.amount],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(summary, [2, 8], 3, [16, 40, 12, 13, 11, 11, 13, 12, 16]), 'Resumen');

    const salesAoa = [
      ['Nº venta', 'Fecha', 'Referencia', 'Producto', 'Unidades', 'Precio', 'Importe', 'Estado'],
      ...r.sales.flatMap((s) => s.lines.map((l) => [s.number, fmtDateTime(s.date), l.ref, l.name, l.qty, l.price, round2(l.qty * l.price), s.voidedAt ? `Anulada ${fmtDay(s.voidedAt)}` : ''])),
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(salesAoa, [5, 6], 0, [9, 17, 16, 36, 10, 11, 12, 18]), 'Ventas');

    const movesAoa = [
      ['Fecha', 'Tipo', 'Referencia', 'Producto', 'Cantidad', 'Nota'],
      ...r.moves.map((m) => {
        const p = productById(m.productId);
        return [fmtDateTime(m.date), MOVE_LABEL[m.type] || m.type, p?.ref ?? '', p?.name ?? '', m.delta, m.note || ''];
      }),
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(movesAoa, [], 0, [17, 14, 16, 36, 10, 36]), 'Movimientos');
  }
  XLSX.writeFile(wb, `${fileBase}.xlsx`);
}

/* ---------- PDF ---------- */

const pdfText = (s) => String(s).replace(/[  ]/g, ' ');
const pdfMoney = (n) => pdfText(fmtMoney(n));
const imgFormat = (dataUrl) => (/^data:image\/png/i.test(dataUrl) ? 'PNG' : 'JPEG');
const INK = [31, 28, 23];
const ACCENT = [200, 67, 27];
const SOFT = [246, 241, 232];

function pdfHeader(doc, subtitle) {
  const s = state.settings;
  const W = doc.internal.pageSize.getWidth();
  let x = 14;
  if (s.logo && s.logoW && s.logoH) {
    const maxW = 34, maxH = 20;
    const k = Math.min(maxW / s.logoW, maxH / s.logoH);
    const w = s.logoW * k, h = s.logoH * k;
    try { doc.addImage(s.logo, imgFormat(s.logo), 14, 12 + (maxH - h) / 2, w, h); x = 14 + w + 6; } catch { /* unreadable logo */ }
  }
  if (s.storeName) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...ACCENT);
    doc.text(pdfText(s.storeName.toUpperCase()), x, 17);
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...INK);
  doc.text(pdfText(s.title), x, s.storeName ? 25 : 22);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(110, 102, 88);
  doc.text(pdfText(subtitle), x, s.storeName ? 31 : 28);
  doc.setDrawColor(...INK); doc.setLineWidth(0.6);
  doc.line(14, 36, W - 14, 36);
  doc.setLineWidth(0.2);
  doc.line(14, 37.2, W - 14, 37.2);
  return 43;
}

function pdfFooter(doc) {
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 132, 118);
    doc.text(pdfText(`Generado el ${fmtDateTime(Date.now())}`), 14, H - 8);
    doc.text(`Página ${i} de ${total}`, W - 14, H - 8, { align: 'right' });
  }
}

const tableBase = {
  theme: 'plain',
  margin: { left: 14, right: 14, bottom: 16 },
  styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.2, textColor: INK, lineColor: [217, 207, 189], lineWidth: { bottom: 0.2 } },
  headStyles: { fillColor: INK, textColor: [243, 237, 226], fontStyle: 'bold', fontSize: 8 },
  alternateRowStyles: { fillColor: SOFT },
  footStyles: { fillColor: [235, 227, 212], textColor: INK, fontStyle: 'bold' },
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
      head: [['Foto', 'Ref.', 'Producto', 'Precio', 'Uds.', 'Valor']],
      body: r.rows.map((x) => ['', pdfText(x.ref), pdfText(x.name), pdfMoney(x.price), String(x.units), pdfMoney(x.value)]),
      foot: [['', '', 'TOTAL', '', String(r.units), pdfMoney(r.value)]],
      columnStyles: {
        0: { cellWidth: 16, minCellHeight: 14 },
        1: { cellWidth: 26, fontStyle: 'bold' },
        3: { halign: 'right', cellWidth: 24 },
        4: { halign: 'right', cellWidth: 16 },
        5: { halign: 'right', cellWidth: 28 },
      },
      bodyStyles: { valign: 'middle' },
      didDrawCell: (d) => {
        if (d.section !== 'body' || d.column.index !== 0) return;
        const photo = r.rows[d.row.index]?.photo;
        if (!photo) return;
        const size = Math.min(d.cell.width, d.cell.height) - 2;
        try { doc.addImage(photo, 'JPEG', d.cell.x + (d.cell.width - size) / 2, d.cell.y + (d.cell.height - size) / 2, size, size); } catch { /* broken photo */ }
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
    head: [['Ref.', 'Producto', 'Precio', 'Stock inicial', 'Entradas', 'Vendidas', 'Otras salidas', 'Stock final', 'Importe vendido']],
    body: r.rows.map((x) => [pdfText(x.ref), pdfText(x.deleted ? `${x.name} (eliminado)` : x.name), pdfMoney(x.price), x.start, x.in, x.sold, x.out, x.end, pdfMoney(x.amount)].map(String)),
    foot: [['', 'TOTAL', '', '', '', String(r.sold), '', '', pdfMoney(r.amount)]],
    columnStyles: {
      0: { cellWidth: 28, fontStyle: 'bold' },
      2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      6: { halign: 'right' }, 7: { halign: 'right', fontStyle: 'bold' }, 8: { halign: 'right' },
    },
  });

  let y = doc.lastAutoTable.finalY + 12;
  if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 20; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...INK);
  doc.text('Ventas del periodo', 14, y);
  const saleRows = r.sales.flatMap((s) => s.lines.map((l) => [
    String(s.number), pdfText(fmtDateTime(s.date)), pdfText(l.ref), pdfText(l.name), String(l.qty), pdfMoney(l.price), pdfMoney(l.qty * l.price), s.voidedAt ? 'Anulada' : '',
  ]));
  const validTotal = round2(r.sales.filter((s) => !s.voidedAt).reduce((s, v) => s + v.total, 0));
  doc.autoTable({
    ...tableBase,
    startY: y + 4,
    head: [['Nº', 'Fecha', 'Ref.', 'Producto', 'Uds.', 'Precio', 'Importe', '']],
    body: saleRows.length ? saleRows : [['', '', '', 'No hay ventas en el periodo', '', '', '', '']],
    foot: [['', '', '', 'TOTAL (sin anuladas)', '', '', pdfMoney(validTotal), '']],
    columnStyles: {
      0: { cellWidth: 14 }, 1: { cellWidth: 34 }, 2: { cellWidth: 28 },
      4: { halign: 'right', cellWidth: 16 }, 5: { halign: 'right', cellWidth: 24 }, 6: { halign: 'right', cellWidth: 26 },
      7: { cellWidth: 20, textColor: ACCENT, fontStyle: 'bold' },
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

/* ---------- Settings, logo and backup ---------- */

function openSettings(focusBackup = false) {
  const s = state.settings;
  $('#stStore').value = s.storeName || '';
  $('#stTitle').value = s.title || '';
  $('#stLow').value = s.lowStock;
  $('#stLogoRemove').hidden = !s.logo;
  $('#stLastBackup').textContent = s.lastBackup ? `Última copia: ${fmtDateTime(s.lastBackup)}` : 'Todavía no has hecho ninguna copia.';
  openDlg('#settingsDlg');
  if (focusBackup) setTimeout(() => $('#backupSection').scrollIntoView({ behavior: 'smooth' }), 80);
}

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = state.settings;
  s.storeName = $('#stStore').value.trim();
  s.title = $('#stTitle').value.trim() || 'Inventario de la tienda';
  const low = Math.trunc(Number($('#stLow').value));
  s.lowStock = Number.isFinite(low) && low >= 0 ? low : 2;
  save();
  closeDlg(e.target);
  renderAll();
});

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
    await save();
    closeDlg($('#backupImport'));
    renderAll();
    toast('Copia restaurada');
  } catch {
    toast('Ese fichero no es una copia válida del inventario.', 4000);
  }
});

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
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
