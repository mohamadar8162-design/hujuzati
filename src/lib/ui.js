// Small DOM + formatting helpers shared by all pages.

export const TZ = 'Asia/Jerusalem';
/** Arabic words, Latin digits — how dates are written in Israel. */
export const AR = 'ar-u-nu-latn';

export const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export const STATUS_LABELS = {
  confirmed: 'مؤكد',
  cancelled: 'انلغى',
  completed: 'وصل',
  no_show: 'ما إجا',
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
  return new Intl.DateTimeFormat(AR, {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

export function fmtDate(iso) {
  return new Intl.DateTimeFormat(AR, {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(iso));
}

/** YYYY-MM-DD for "today + offset days" in Israel time. */
export function isoDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

export function price(n) {
  return `₪${Number(n).toLocaleString('en')}`;
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

// ---------------------------------------------------------------------------
// Icons — one stroke family, 1.8 weight, sized by CSS. Direction-aware chevrons.
// ---------------------------------------------------------------------------
const P = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  services: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16 14.6c2.3.1 4 1.6 4.5 4.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
  signout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h9"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-3.6 3.8-5.8 7.5-5.8s6.7 2.2 7.5 5.8"/>',
  phone: '<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M11 17.5h2"/>',
  note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
}
/** Disclosure chevron: points toward the trailing edge (left in RTL). */
export const chevron = () =>
  '<svg class="chev" viewBox="0 0 8 13" aria-hidden="true"><path d="M6.5 1.5 1.5 6.5l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Back chevron: points toward the leading edge (right in RTL). */
export const backChevron = () =>
  '<svg viewBox="0 0 10 17" aria-hidden="true"><path d="M1.5 1.5 8.5 8.5l-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const checkmark = () =>
  '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5 6.5 12.5 13.5 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------
// Calendar tile (the signature element)
// ---------------------------------------------------------------------------
export function tile(iso, big = false) {
  const d = new Date(iso);
  const month = new Intl.DateTimeFormat(AR, { timeZone: TZ, month: 'long' }).format(d);
  const day = new Intl.DateTimeFormat('en', { timeZone: TZ, day: 'numeric' }).format(d);
  return `<div class="tile${big ? ' big' : ''}" aria-hidden="true"><div class="m">${month}</div><div class="d">${day}</div></div>`;
}

/** Hour (0–23) of an ISO time in Israel. */
export function hourOf(iso) {
  return Number(new Intl.DateTimeFormat('en', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
}

/** Download an .ics file so the customer can add the appointment to their calendar. */
export function downloadIcs({ title, start, end, location = '', description = '' }) {
  const f = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (s) => String(s).replace(/[,;\\]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hujuzati//AR', 'BEGIN:VEVENT',
    `UID:${f(start)}-${Math.random().toString(36).slice(2)}@hujuzati`,
    `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(start)}`, `DTEND:${f(end)}`,
    `SUMMARY:${clean(title)}`, location && `LOCATION:${clean(location)}`, description && `DESCRIPTION:${clean(description)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${clean(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'موعد.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
