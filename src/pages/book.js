import { supabase } from '../lib/supabase.js';
import {
  $, esc, toast, fmtTime, fmtDate, isoDay, price, normalizePhone, setLoading, TZ, AR,
  chevron, backChevron, tile, hourOf, downloadIcs,
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

const s = {
  biz: null,
  step: 'service',          // service → staff → time → details → done
  service: null,
  staffId: null,            // null = first available
  date: isoDay(0),
  slots: [],
  slot: null,               // { starts_at, staff_id }
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
  app.innerHTML = `<div class="empty" style="padding-top:25vh">
    <p class="title">ما لقينا هاي الصفحة</p>
    <p>تأكد من الرابط اللي وصلك من المصلحة.</p>
  </div>`;
}

const STEPS = ['service', 'staff', 'time', 'details'];
const hasStaffChoice = () => s.biz.staff.length > 1;
const visibleSteps = () => STEPS.filter((x) => x !== 'staff' || hasStaffChoice());
const staffName = (id) => s.biz.staff.find((x) => x.id === id)?.name;

function go(step) {
  s.step = step;
  render();
  window.scrollTo({ top: 0 });
  app.querySelector('h1, h2')?.focus({ preventScroll: true });
}

function render() {
  bar.hidden = s.step !== 'details';
  ({ service: stepService, staff: stepStaff, time: stepTime, details: stepDetails, done: stepDone })[s.step]();
}

function header(backTo, title) {
  const n = visibleSteps().indexOf(s.step) + 1;
  return `
    <button class="back" data-back="${backTo}">${backChevron()}<span>رجوع</span></button>
    <h2 class="step-title" tabindex="-1">${title}</h2>
    <p class="step-count">الخطوة ${n} من ${visibleSteps().length}</p>`;
}

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-back]');
  if (b) go(b.dataset.back);
});

// ---------------------------------------------------------------- 1. Service
function stepService() {
  const b = s.biz;
  const meta = [b.category, b.address].filter(Boolean).map(esc).join(' · ');
  app.innerHTML = `
    <header class="biz">
      <h1 class="large-title" tabindex="-1">${esc(b.name)}</h1>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${b.description ? `<p class="meta">${esc(b.description)}</p>` : ''}
    </header>
    <p class="section-label">اختر الخدمة</p>
    ${b.services.length ? `<ul class="group">${b.services.map((x) => `
      <li><button class="row" data-svc="${x.id}">
        <span class="grow">${esc(x.name)}<span class="sub">${x.duration_min} دقيقة${x.description ? ` · ${esc(x.description)}` : ''}</span></span>
        <span class="trail num">${price(x.price)}</span>${chevron()}
      </button></li>`).join('')}</ul>`
      : `<div class="group"><p class="empty">المصلحة لسا ما أضافت خدمات.</p></div>`}
    ${b.phone ? `<p class="section-foot">سؤال؟ <a href="https://wa.me/${b.phone.slice(1)}" target="_blank" rel="noopener">راسلنا على واتساب</a></p>` : ''}`;

  app.onclick = (e) => {
    const btn = e.target.closest('[data-svc]');
    if (!btn) return;
    s.service = b.services.find((x) => x.id === btn.dataset.svc);
    s.slot = null;
    if (hasStaffChoice()) go('staff');
    else { s.staffId = b.staff[0]?.id || null; go('time'); }
  };
}

// ---------------------------------------------------------------- 2. Staff
function stepStaff() {
  app.innerHTML = `
    ${header('service', 'عند مين؟')}
    <p class="section-label">${esc(s.service.name)}</p>
    <ul class="group">
      <li><button class="row" data-staff="">
        <span class="grow">أول موظف متاح<span class="sub">بيطلعلك أقرب وقت فاضي</span></span>${chevron()}
      </button></li>
      ${s.biz.staff.map((x) => `<li><button class="row" data-staff="${x.id}">
        <span class="grow">${esc(x.name)}</span>${chevron()}
      </button></li>`).join('')}
    </ul>`;
  app.onclick = (e) => {
    const btn = e.target.closest('[data-staff]');
    if (!btn) return;
    s.staffId = btn.dataset.staff || null;
    s.slot = null;
    go('time');
  };
}

// ---------------------------------------------------------------- 3. Time
function stepTime() {
  const days = [];
  const max = Math.min(s.biz.max_days_ahead, 30);
  for (let i = 0; i <= max; i++) days.push(isoDay(i));

  const dayBtn = (d, i) => {
    const date = new Date(`${d}T12:00:00Z`);
    const wd = i === 0 ? 'اليوم' : i === 1 ? 'بكرا'
      : new Intl.DateTimeFormat(AR, { weekday: 'short', timeZone: TZ }).format(date);
    const full = new Intl.DateTimeFormat(AR, { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(date);
    return `<button class="day" data-day="${d}" aria-pressed="${d === s.date}" aria-label="${full}">
      <span class="wd">${wd}</span><span class="dn">${Number(d.slice(8))}</span></button>`;
  };

  const who = s.staffId ? ` · ${esc(staffName(s.staffId))}` : '';
  app.innerHTML = `
    ${header(hasStaffChoice() ? 'staff' : 'service', 'اختر الوقت')}
    <p class="section-label">${esc(s.service.name)} · ${s.service.duration_min} دقيقة${who}</p>
    <div class="days" role="group" aria-label="اليوم">${days.map(dayBtn).join('')}</div>
    <div id="slots"></div>`;

  app.onclick = (e) => {
    const d = e.target.closest('[data-day]');
    const t = e.target.closest('[data-slot]');
    if (d) {
      s.date = d.dataset.day;
      app.querySelectorAll('.day').forEach((x) => x.setAttribute('aria-pressed', x === d));
      loadSlots();
    }
    if (t) { s.slot = s.slots[Number(t.dataset.slot)]; go('details'); }
  };
  app.querySelector('.day[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  loadSlots();
}

async function loadSlots() {
  const box = $('#slots');
  box.innerHTML = `<p class="empty">بندوّر على أوقات فاضية…</p>`;
  const reqDate = s.date;
  const { data, error } = await supabase.rpc('get_available_slots', {
    p_slug: slug, p_service_id: s.service.id, p_staff_id: s.staffId, p_date: reqDate,
  });
  if (reqDate !== s.date) return;                    // another day was tapped meanwhile
  if (error) { box.innerHTML = `<p class="empty">ما قدرنا نجيب الأوقات. جرّب كمان مرة.</p>`; return; }

  // First available staff: one button per time.
  const seen = new Set();
  s.slots = (data || []).filter((r) => !seen.has(r.starts_at) && seen.add(r.starts_at));

  if (!s.slots.length) {
    box.innerHTML = `<div class="empty"><p class="title">ما في أوقات فاضية بهذا اليوم</p><p>جرّب يوم ثاني.</p></div>`;
    return;
  }
  const parts = [
    ['صباحاً', (h) => h < 12],
    ['بعد الظهر', (h) => h >= 12 && h < 17],
    ['مساءً', (h) => h >= 17],
  ];
  box.innerHTML = parts.map(([label, test]) => {
    const items = s.slots.map((r, i) => [r, i]).filter(([r]) => test(hourOf(r.starts_at)));
    if (!items.length) return '';
    return `<section class="slot-group"><h3>${label}</h3><div class="slots">
      ${items.map(([r, i]) => `<button class="slot" data-slot="${i}">${fmtTime(r.starts_at)}</button>`).join('')}
    </div></section>`;
  }).join('');
}

// ---------------------------------------------------------------- 4. Details
function stepDetails() {
  const draft = loadDraft();
  const who = hasStaffChoice() ? staffName(s.slot.staff_id) : null;
  app.innerHTML = `
    ${header('time', 'تأكيد الموعد')}
    <div class="summary-card">
      ${tile(s.slot.starts_at)}
      <div class="grow">
        <div style="font-size:26px;font-weight:800;line-height:1.1"><span class="num">${fmtTime(s.slot.starts_at)}</span></div>
        <div class="headline" style="margin-top:4px">${esc(s.service.name)}</div>
        <div class="muted" style="font-size:14px">${fmtDate(s.slot.starts_at)}${who ? ` · عند ${esc(who)}` : ''}</div>
      </div>
      <span class="num" style="font-weight:700">${price(s.service.price)}</span>
    </div>

    <form id="details" novalidate>
      <p class="section-label">بياناتك</p>
      <div class="group">
        <div class="row field-row"><label for="c-name">الاسم</label>
          <input id="c-name" autocomplete="name" maxlength="60" placeholder="الاسم الكامل" value="${esc(draft.name || '')}" required /></div>
        <div class="row field-row"><label for="c-phone">الجوال</label>
          <input id="c-phone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" placeholder="050-000-0000" value="${esc(draft.phone || '')}" required /></div>
        <div class="row field-row"><label for="c-notes">ملاحظة</label>
          <input id="c-notes" maxlength="300" placeholder="اختياري" /></div>
      </div>
      <p class="section-foot">رح يوصلك تأكيد وتذكير على واتساب لهذا الرقم.</p>
      <p class="error" id="c-error" role="alert"></p>
    </form>`;
  app.onclick = null;

  const btn = $('#primary');
  btn.textContent = 'احجز الموعد';
  const nameEl = $('#c-name');
  const phoneEl = $('#c-phone');
  const valid = () => nameEl.value.trim().length >= 2 && normalizePhone(phoneEl.value);
  const sync = () => { btn.disabled = !valid(); };
  nameEl.addEventListener('input', sync);
  phoneEl.addEventListener('input', sync);
  phoneEl.addEventListener('blur', () => {
    $('#c-error').textContent = phoneEl.value && !normalizePhone(phoneEl.value)
      ? 'الرقم لازم يكون رقم جوال إسرائيلي، مثل 0501234567.' : '';
  });
  sync();

  $('#details').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!valid()) return;
    const name = nameEl.value.trim();
    const rawPhone = phoneEl.value.trim();
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
        return go('time');
      }
      $('#c-error').textContent = error.message.includes('TOO_MANY_BOOKINGS')
        ? 'عندك 3 مواعيد قادمة عند هاي المصلحة، وهذا الحد.'
        : 'ما زبط الحجز. جرّب كمان مرة.';
      return;
    }
    saveDraft({ name, phone: rawPhone });
    s.result = data;
    go('done');
  });
}

// ---------------------------------------------------------------- 5. Done
function stepDone() {
  const r = s.result;
  const end = new Date(new Date(r.starts_at).getTime() + s.service.duration_min * 60000).toISOString();
  app.innerHTML = `
    <div class="confirm">
      ${tile(r.starts_at, true)}
      <h1 class="large-title" tabindex="-1">تم الحجز</h1>
      <p class="headline">${esc(s.service.name)}</p>
      <p class="muted">${fmtDate(r.starts_at)} · الساعة <span class="num">${fmtTime(r.starts_at)}</span></p>
      ${r.staff_name && hasStaffChoice() ? `<p class="muted">عند ${esc(r.staff_name)}</p>` : ''}
      ${s.biz.address ? `<p class="muted">${esc(s.biz.address)}</p>` : ''}
    </div>
    <div style="display:grid;gap:8px;margin-top:28px">
      <button class="btn large gray block" id="ics">أضف للتقويم</button>
      <button class="btn plain block" id="again">احجز موعد ثاني</button>
    </div>
    <p class="section-foot" style="text-align:center;margin-top:18px">وصلك تأكيد على واتساب. لو بدك تلغي، في رابط إلغاء بالرسالة.</p>`;
  $('#ics').addEventListener('click', () => downloadIcs({
    title: `${s.service.name} — ${s.biz.name}`,
    start: r.starts_at, end,
    location: s.biz.address || s.biz.name,
  }));
  $('#again').addEventListener('click', () => { s.service = null; s.slot = null; go('service'); });
}

// ---------------------------------------------------------------- Cancel (link from WhatsApp)
function renderCancel() {
  bar.hidden = true;
  app.innerHTML = `
    <header class="biz"><h1 class="large-title" tabindex="-1">إلغاء موعد</h1>
      <p class="meta">${esc(s.biz.name)}</p></header>
    <form id="cancel-form" novalidate>
      <p class="section-label">للتأكيد، اكتب رقم الجوال اللي حجزت فيه</p>
      <div class="group">
        <div class="row field-row"><label for="x-phone">الجوال</label>
          <input id="x-phone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" placeholder="050-000-0000" value="${esc(loadDraft().phone || '')}" /></div>
      </div>
      <p class="error" id="x-error" role="alert"></p>
      <div style="display:grid;gap:8px;margin-top:20px">
        <button class="btn large destructive block" type="submit">إلغاء الموعد</button>
        <a class="btn plain block" href="/b/${esc(slug)}">لا، خلّيه</a>
      </div>
    </form>`;
  $('#cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = normalizePhone($('#x-phone').value);
    if (!phone) return ($('#x-error').textContent = 'الرقم لازم يكون رقم جوال، مثل 0501234567.');
    setLoading(e.submitter, true, 'جارٍ الإلغاء…');
    const { data, error } = await supabase.rpc('cancel_booking', { p_id: cancelId, p_phone: phone });
    setLoading(e.submitter, false);
    if (error || !data) return ($('#x-error').textContent = 'ما لقينا موعد قادم بهذا الرقم. يمكن انلغى من قبل أو الموعد مرّ.');
    app.innerHTML = `<div class="confirm">
      <h1 class="large-title" tabindex="-1">انلغى الموعد</h1>
      <p class="muted">ما رح نذكّرك فيه.</p></div>
      <div style="margin-top:28px"><a class="btn large block" href="/b/${esc(slug)}">احجز موعد جديد</a></div>`;
  });
}
