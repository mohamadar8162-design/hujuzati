import { supabase } from '../lib/supabase.js';
import {
  $, esc, toast, fmtTime, fmtDate, isoDay, price, normalizePhone, setLoading, TZ, AR,
  icon, backChevron, tile, hourOf, downloadIcs,
} from '../lib/ui.js';

// Slug from /b/<slug> (host rewrite) or ?b=<slug> (local dev).
const params = new URLSearchParams(location.search);
const slug = (location.pathname.match(/^\/b\/([^/]+)/)?.[1] || params.get('b') || '').toLowerCase();
const cancelId = params.get('cancel');

const DRAFT_KEY = 'hujuzati:customer';
const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } };
const saveDraft = (d) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode */ } };

const app = $('#app');
const bar = $('#action-bar');
const btn = $('#primary');

const s = {
  biz: null,
  view: 'home',           // home → book → done
  service: null,
  staffId: null,          // null = first available
  date: isoDay(0),
  slots: [],
  slot: null,             // { starts_at, staff_id }
  result: null,
};

init();

async function init() {
  if (!slug) return notFound();
  const { data, error } = await supabase.rpc('get_public_business', { p_slug: slug });
  if (error || !data) return notFound();
  s.biz = data;
  document.title = `احجز موعد — ${data.name}`;
  if (cancelId) return renderCancel();
  render();
}

function notFound() {
  app.innerHTML = `<div class="empty" style="padding-top:28vh">
    <p class="title">ما لقينا هاي الصفحة</p>
    <p>تأكد من الرابط اللي وصلك من المصلحة.</p>
  </div>`;
}

const hasStaffChoice = () => s.biz.staff.length > 1;
const staffName = (id) => s.biz.staff.find((x) => x.id === id)?.name;

function go(view) {
  s.view = view;
  render();
  window.scrollTo({ top: 0 });
  app.querySelector('h1, h2')?.focus({ preventScroll: true });
}

function render() {
  bar.hidden = s.view !== 'book';
  ({ home: renderHome, book: renderBook, done: renderDone })[s.view]();
}

// ---------------------------------------------------------------- Cover
function cover() {
  const b = s.biz;
  const waze = b.address ? `https://waze.com/ul?q=${encodeURIComponent(b.address)}&navigate=yes` : null;
  const wa = b.phone ? `https://wa.me/${b.phone.slice(1)}` : null;
  return `
    <header class="cover${b.cover_url ? ' has-photo' : ''}">
      ${b.cover_url ? `<img class="bg" src="${esc(b.cover_url)}" alt="" />` : ''}
      <div class="top">
        <button class="glass-btn" id="share" aria-label="شارك الصفحة">${icon('share')}</button>
      </div>
      <div>
        <h1 tabindex="-1">${esc(b.name)}</h1>
        <p class="meta">
          ${typeof b.open_now === 'boolean' ? `<span><span class="dot${b.open_now ? ' on' : ''}"></span> ${b.open_now ? 'مفتوح هلأ' : 'مسكّر هلأ'}</span>` : ''}
          ${b.category ? `<span>${typeof b.open_now === 'boolean' ? '· ' : ''}${esc(b.category)}</span>` : ''}
        </p>
        ${waze || wa ? `<div class="actions">
          ${waze ? `<a class="pill-glass" href="${waze}" target="_blank" rel="noopener">${icon('pin')}<span>الاتجاهات</span></a>` : ''}
          ${wa ? `<a class="pill-glass teal" href="${wa}" target="_blank" rel="noopener">${icon('chat')}<span>واتساب</span></a>` : ''}
        </div>` : ''}
      </div>
    </header>`;
}

function bindShare() {
  $('#share')?.addEventListener('click', async () => {
    const data = { title: s.biz.name, url: location.origin + '/b/' + s.biz.slug };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.url); toast('انتسخ الرابط'); }
    } catch { /* user closed the share sheet */ }
  });
}

// ---------------------------------------------------------------- Home: pick a service
function renderHome() {
  const b = s.biz;
  app.innerHTML = `
    ${cover()}
    <div class="sheet-up"><div class="book-body">
      ${b.description ? `<p class="muted" style="margin:14px 2px 0">${esc(b.description)}</p>` : ''}
      <p class="section-label">اختر الخدمة</p>
      ${b.services.length ? b.services.map((x) => `
        <button class="svc" data-svc="${x.id}">
          <span class="dur"><b>${x.duration_min}</b><small>دقيقة</small></span>
          <span class="grow">
            <span class="name">${esc(x.name)}</span>
            ${x.description ? `<span class="desc" style="display:block">${esc(x.description)}</span>` : ''}
          </span>
          <span class="price">${price(x.price)}</span>
        </button>`).join('')
        : `<div class="card empty">المصلحة لسا ما أضافت خدمات.</div>`}
      ${b.address ? `<p class="section-foot" style="display:flex;gap:6px;align-items:center;margin-top:16px">
        <span style="width:16px;height:16px;display:inline-flex">${icon('pin')}</span>${esc(b.address)}</p>` : ''}
    </div></div>`;
  bindShare();
  app.onclick = (e) => {
    const el = e.target.closest('[data-svc]');
    if (!el) return;
    s.service = b.services.find((x) => x.id === el.dataset.svc);
    s.slot = null;
    s.staffId = hasStaffChoice() ? null : (b.staff[0]?.id || null);
    go('book');
  };
}

// ---------------------------------------------------------------- Book: date, staff, time, details — one page
function renderBook() {
  const b = s.biz;
  const draft = loadDraft();
  const days = [];
  const max = Math.min(b.max_days_ahead, 30);
  for (let i = 0; i <= max; i++) days.push(isoDay(i));

  const dayBtn = (d, i) => {
    const date = new Date(`${d}T12:00:00Z`);
    const wd = i === 0 ? 'اليوم' : i === 1 ? 'بكرا'
      : new Intl.DateTimeFormat(AR, { weekday: 'short', timeZone: TZ }).format(date);
    return `<button class="day" data-day="${d}" aria-pressed="${d === s.date}" aria-label="${fmtDate(date.toISOString())}">
      <span class="wd">${wd}</span><span class="dn">${Number(d.slice(8))}</span></button>`;
  };

  app.innerHTML = `
    <div class="book-body">
      <div class="topbar">
        <button class="icon-btn" data-back aria-label="رجوع">${backChevron()}</button>
        <h2 tabindex="-1">احجز موعد</h2><span></span>
      </div>

      <div class="night-card">
        <h3>${esc(b.name)}</h3>
        <p class="line">${esc(s.service.name)} · <span class="num">${s.service.duration_min}</span> دقيقة · <span class="num">${price(s.service.price)}</span></p>
        ${b.address ? `<p class="line">${icon('pin')}${esc(b.address)}</p>` : ''}
      </div>

      <section class="card" style="margin-top:12px">
        <div class="card-head">${icon('calendar')}
          <div class="stack"><label>التاريخ</label><b id="date-label">${fmtDate(`${s.date}T12:00:00Z`)}</b></div>
        </div>
        <div class="days" role="group" aria-label="اختر اليوم">${days.map(dayBtn).join('')}</div>
      </section>

      ${hasStaffChoice() ? `
      <section class="card">
        <div class="card-head">${icon('user')}<div class="stack"><label>عند مين</label><b id="staff-label">${s.staffId ? esc(staffName(s.staffId)) : 'أول موظف متاح'}</b></div></div>
        <div class="chips" role="group" aria-label="اختر الموظف">
          <button class="chip" data-staff="" aria-pressed="${!s.staffId}">أول موظف متاح</button>
          ${b.staff.map((x) => `<button class="chip" data-staff="${x.id}" aria-pressed="${s.staffId === x.id}">${esc(x.name)}</button>`).join('')}
        </div>
      </section>` : ''}

      <section class="card">
        <div class="card-head">${icon('clock')}<div class="stack"><label>الوقت</label><b id="time-label">اختر وقت</b></div></div>
        <div id="slots"></div>
      </section>

      <form id="details" novalidate>
        <p class="section-label">بياناتك</p>
        <div class="field">${icon('user')}<div class="stack"><label for="c-name">الاسم</label>
          <input id="c-name" autocomplete="name" maxlength="60" placeholder="الاسم الكامل" value="${esc(draft.name || '')}" required /></div></div>
        <div class="field">${icon('phone')}<div class="stack"><label for="c-phone">رقم الجوال (واتساب)</label>
          <input id="c-phone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" placeholder="050-000-0000" value="${esc(draft.phone || '')}" required /></div></div>
        <div class="field">${icon('note')}<div class="stack"><label for="c-notes">ملاحظة (اختياري)</label>
          <textarea id="c-notes" rows="2" maxlength="300" placeholder="أي إشي بدك المصلحة تعرفه"></textarea></div></div>
        <p class="section-foot">رح يوصلك تأكيد وتذكير على واتساب لهذا الرقم.</p>
        <p class="error" id="c-error" role="alert"></p>
      </form>
    </div>`;

  app.onclick = (e) => {
    if (e.target.closest('[data-back]')) return go('home');
    const d = e.target.closest('[data-day]');
    const st = e.target.closest('[data-staff]');
    const t = e.target.closest('[data-slot]');
    if (d) {
      s.date = d.dataset.day; s.slot = null;
      app.querySelectorAll('.day').forEach((x) => x.setAttribute('aria-pressed', x === d));
      $('#date-label').textContent = fmtDate(`${s.date}T12:00:00Z`);
      loadSlots();
    }
    if (st) {
      s.staffId = st.dataset.staff || null; s.slot = null;
      app.querySelectorAll('[data-staff]').forEach((x) => x.setAttribute('aria-pressed', x === st));
      $('#staff-label').textContent = s.staffId ? staffName(s.staffId) : 'أول موظف متاح';
      loadSlots();
    }
    if (t) {
      s.slot = s.slots[Number(t.dataset.slot)];
      app.querySelectorAll('.slot').forEach((x) => x.setAttribute('aria-pressed', x === t));
      $('#time-label').innerHTML = `<span class="num">${fmtTime(s.slot.starts_at)}</span>${
        hasStaffChoice() && !s.staffId ? ` · عند ${esc(staffName(s.slot.staff_id))}` : ''}`;
      sync();
    }
  };
  app.querySelector('.day[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const phoneEl = $('#c-phone');
  $('#c-name').addEventListener('input', sync);
  phoneEl.addEventListener('input', sync);
  phoneEl.addEventListener('blur', () => {
    $('#c-error').textContent = phoneEl.value && !normalizePhone(phoneEl.value)
      ? 'الرقم لازم يكون رقم جوال، مثل 0501234567.' : '';
  });
  $('#details').addEventListener('submit', submit);

  btn.textContent = 'احجز';
  sync();
  loadSlots();
}

function valid() {
  return Boolean(s.slot && $('#c-name').value.trim().length >= 2 && normalizePhone($('#c-phone').value));
}

function sync() {
  btn.disabled = !valid();
  $('#sum').innerHTML = s.slot
    ? `<b><span class="num">${fmtTime(s.slot.starts_at)}</span></b><span>${fmtDate(s.slot.starts_at)} · <span class="num">${price(s.service.price)}</span></span>`
    : `<b>${esc(s.service.name)}</b><span>اختر اليوم والوقت</span>`;
}

async function loadSlots() {
  const box = $('#slots');
  box.innerHTML = `<p class="empty">بندوّر على أوقات فاضية…</p>`;
  $('#time-label').textContent = 'اختر وقت';
  sync();
  const key = `${s.date}|${s.staffId}`;
  const { data, error } = await supabase.rpc('get_available_slots', {
    p_slug: slug, p_service_id: s.service.id, p_staff_id: s.staffId, p_date: s.date,
  });
  if (key !== `${s.date}|${s.staffId}`) return;           // selection changed meanwhile
  if (error) { box.innerHTML = `<p class="empty">ما قدرنا نجيب الأوقات. جرّب كمان مرة.</p>`; return; }

  const seen = new Set();
  s.slots = (data || []).filter((r) => !seen.has(r.starts_at) && seen.add(r.starts_at));
  if (!s.slots.length) {
    box.innerHTML = `<div class="empty"><p class="title">ما في أوقات فاضية بهذا اليوم</p><p>جرّب يوم ثاني.</p></div>`;
    return;
  }
  const parts = [['صباحاً', (h) => h < 12], ['بعد الظهر', (h) => h >= 12 && h < 17], ['مساءً', (h) => h >= 17]];
  box.innerHTML = parts.map(([label, test]) => {
    const items = s.slots.map((r, i) => [r, i]).filter(([r]) => test(hourOf(r.starts_at)));
    if (!items.length) return '';
    return `<div class="slot-group"><h3>${label}</h3><div class="slots" role="group" aria-label="${label}">
      ${items.map(([r, i]) => `<button class="slot" data-slot="${i}" aria-pressed="false">${fmtTime(r.starts_at)}</button>`).join('')}
    </div></div>`;
  }).join('');
}

async function submit(e) {
  e.preventDefault();
  if (!valid()) return;
  const name = $('#c-name').value.trim();
  const rawPhone = $('#c-phone').value.trim();
  setLoading(btn, true, 'جارٍ الحجز…');
  const { data, error } = await supabase.rpc('create_booking', {
    p_slug: slug,
    p_service_id: s.service.id,
    p_staff_id: s.slot.staff_id,
    p_starts_at: s.slot.starts_at,
    p_name: name,
    p_phone: normalizePhone(rawPhone),
    p_notes: $('#c-notes').value.trim() || null,
  });
  setLoading(btn, false);

  if (error) {
    if (error.message.includes('SLOT_TAKEN')) {
      toast('هذا الوقت انحجز قبل شوي. اختر وقت ثاني.', 'err');
      s.slot = null;
      return loadSlots();
    }
    $('#c-error').textContent = error.message.includes('TOO_MANY_BOOKINGS')
      ? 'عندك 3 مواعيد قادمة عند هاي المصلحة، وهذا الحد.'
      : 'ما زبط الحجز. جرّب كمان مرة.';
    return;
  }
  saveDraft({ name, phone: rawPhone });
  s.result = data;
  go('done');
}

// ---------------------------------------------------------------- Done
function renderDone() {
  const r = s.result;
  const end = new Date(new Date(r.starts_at).getTime() + s.service.duration_min * 60000).toISOString();
  const who = r.staff_name && hasStaffChoice() ? ` · عند ${esc(r.staff_name)}` : '';
  app.innerHTML = `
    <div class="confirm">
      <div class="check">${icon('check')}</div>
      <h1 class="large-title" tabindex="-1">تم الحجز</h1>
      <p class="muted">وصلك تأكيد على واتساب، وبنذكّرك قبل الموعد بيوم.</p>
      <div class="card">
        ${tile(r.starts_at)}
        <div class="grow">
          <div style="font:700 24px/1.1 var(--font-display)"><span class="num">${fmtTime(r.starts_at)}</span></div>
          <div class="headline" style="margin-top:4px">${esc(s.service.name)}</div>
          <div class="muted" style="font-size:13px">${esc(s.biz.name)}${who}</div>
        </div>
      </div>
      <div style="display:grid;gap:8px;margin-top:20px">
        <button class="btn large block" id="ics">أضف للتقويم</button>
        <button class="btn large gray block" id="again">احجز موعد ثاني</button>
      </div>
      <p class="section-foot" style="margin-top:16px">لو بدك تلغي، في رابط إلغاء برسالة الواتساب.</p>
    </div>`;
  app.onclick = null;
  $('#ics').addEventListener('click', () => downloadIcs({
    title: `${s.service.name} — ${s.biz.name}`, start: r.starts_at, end,
    location: s.biz.address || s.biz.name,
  }));
  $('#again').addEventListener('click', () => { s.service = null; s.slot = null; go('home'); });
}

// ---------------------------------------------------------------- Cancel (link from WhatsApp)
function renderCancel() {
  bar.hidden = true;
  app.innerHTML = `
    ${cover()}
    <div class="sheet-up"><div class="book-body">
      <p class="section-label">إلغاء موعد</p>
      <form id="cancel-form" novalidate>
        <div class="field">${icon('phone')}<div class="stack"><label for="x-phone">للتأكيد، رقم الجوال اللي حجزت فيه</label>
          <input id="x-phone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" placeholder="050-000-0000" value="${esc(loadDraft().phone || '')}" /></div></div>
        <p class="error" id="x-error" role="alert"></p>
        <div style="display:grid;gap:8px;margin-top:16px">
          <button class="btn large destructive block" type="submit">إلغاء الموعد</button>
          <a class="btn large gray block" href="/b/${esc(slug)}">لا، خلّيه</a>
        </div>
      </form>
    </div></div>`;
  bindShare();
  $('#cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = normalizePhone($('#x-phone').value);
    if (!phone) return ($('#x-error').textContent = 'الرقم لازم يكون رقم جوال، مثل 0501234567.');
    setLoading(e.submitter, true, 'جارٍ الإلغاء…');
    const { data, error } = await supabase.rpc('cancel_booking', { p_id: cancelId, p_phone: phone });
    setLoading(e.submitter, false);
    if (error || !data) return ($('#x-error').textContent = 'ما لقينا موعد قادم بهذا الرقم. يمكن انلغى من قبل أو الموعد مرّ.');
    app.innerHTML = `<div class="confirm">
      <div class="check">${icon('check')}</div>
      <h1 class="large-title" tabindex="-1">انلغى الموعد</h1>
      <p class="muted">ما رح نذكّرك فيه.</p>
      <div style="margin-top:24px"><a class="btn large block" href="/b/${esc(slug)}">احجز موعد جديد</a></div></div>`;
  });
}
