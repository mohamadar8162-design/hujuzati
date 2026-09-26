// Small DOM + formatting helpers shared by all pages.

export const TZ = 'Asia/Jerusalem';

export const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export const STATUS_LABELS = {
  confirmed: 'مؤكد',
  cancelled: 'ملغى',
  completed: 'مكتمل',
  no_show: 'لم يحضر',
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape user-provided text before putting it in innerHTML. */
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function toast(message, type = 'ok') {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.className = `show ${type}`;
  clearTimeout(box._t);
  box._t = setTimeout(() => (box.className = ''), 3200);
}

export function fmtTime(iso) {
  return new Intl.DateTimeFormat('ar', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

export function fmtDate(iso) {
  return new Intl.DateTimeFormat('ar', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(iso));
}

/** YYYY-MM-DD for "today + offset days" in Israel time. */
export function isoDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

export function price(n) {
  return `₪${Number(n).toLocaleString('ar')}`;
}

/** Normalise an Israeli phone number to E.164 (+9725XXXXXXXX). Returns null if invalid. */
export function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '972' + p.slice(1);
  if (!/^972\d{8,9}$/.test(p)) return null;
  return '+' + p;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function setLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label || '...جارٍ';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}
