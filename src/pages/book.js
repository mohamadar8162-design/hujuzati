import { supabase } from '../lib/supabase.js';
import { $, esc, toast, fmtTime, fmtDate, isoDay, price, normalizePhone, setLoading, TZ } from '../lib/ui.js';

// Slug from /b/<slug> (Cloudflare rewrite) or ?b=<slug> (local dev).
const params = new URLSearchParams(location.search);
const slug = (location.pathname.match(/^\/b\/([^/]+)/)?.[1] || params.get('b') || '').toLowerCase();
const cancelId = params.get('cancel');

const DRAFT_KEY = 'hujuzati:customer';
const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } };
const saveDraft = (d) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode */ } };

const s = {
  biz: null,
  step: 'service',          // service → staff → time → details → done
  service: null,
  staffId: null,            // null = any
  date: isoDay(0),
  slot: null,               // { starts_at, staff_id }
  slots: [],
  result: null,
};

init();

async function init() {
  if (!slug) return notFound();
  const { data, error } = await supabase.rpc('get_public_business', { p_slug: slug });
  if (error || !data) return notFound();
  s.biz = data;

  document.title = `احجز موعد — ${data.name}`;
  $('#biz-avatar').textContent = data.name.trim().charAt(0);
  $('#biz-title').textContent = data.name;
  $('#biz-meta').textContent = [data.category, data.address].filter(Boolean).join(' · ');
  $('#loading').classList.add('hidden');
  $('#page').classList.remove('hidden');

  if (cancelId) return renderCancel();
  render();
}

function notFound() {
  $('#loading').classList.add('hidden');
  $('#notfound').classList.remove('hidden');
}

const STEPS = ['service', 'staff', 'time', 'details'];
const hasStaffChoice = () => s.biz.staff.length > 1;

function go(step) { s.step = step; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function render() {
  const visible = STEPS.filter((x) => x !== 'staff' || hasStaffChoice());
  const idx = visible.indexOf(s.step);
  $('#stepper').innerHTML = s.step === 'done' ? '' : visible.map((_, i) => `<span class="${i <= idx ? 'on' : ''}"></span>`).join('');
  ({ service: stepService, staff: stepStaff, time: stepTime, details: stepDetails, done: stepDone })[s.step]();
}

function backBtn(to) { return `<button class="back" data-back="${to}">→ رجوع</button>`; }
$('#step').addEventListener('click', (e) => {
  const b = e.target.closest('[data-back]');
  if (b) go(b.dataset.back);
});

// ---------------- Step 1: service ----------------
function stepService() {
  const list = s.biz.services;
  $('#step').innerHTML = `
    <h2 style="font-size:1.2rem">اختر الخدمة</h2>
    ${s.biz.description ? `<p class="muted">${esc(s.biz.description)}</p>` : ''}
    ${list.length ? list.map((x) => `
      <button class="choice" data-svc="${x.id}">
        <span><b>${esc(x.name)}</b>${x.description ? `<br><small class="muted">${esc(x.description)}</small>` : ''}</span>
        <span style="text-align:left;white-space:nowrap">${price(x.price)}<br><small class="muted">${x.duration_min} دقيقة</small></span>
      </button>`).join('') : `<p class="empty">لا يوجد خدمات متاحة حالياً</p>`}`;
  $('#step').onclick = (e) => {
    const b = e.target.closest('[data-svc]');
    if (!b) return;
    s.service = list.find((x) => x.id === b.dataset.svc);
    s.slot = null;
    if (hasStaffChoice()) go('staff');
    else { s.staffId = s.biz.staff[0]?.id || null; go('time'); }
  };
}

// ---------------- Step 2: staff ----------------
function stepStaff() {
  $('#step').innerHTML = `
    ${backBtn('service')}
    <h2 style="font-size:1.2rem">عند مين؟</h2>
    <button class="choice" data-staff=""><b>أي موظف متاح</b><span class="muted">أسرع موعد</span></button>
    ${s.biz.staff.map((x) => `<button class="choice" data-staff="${x.id}"><b>${esc(x.name)}</b></button>`).join('')}`;
  $('#step').onclick = (e) => {
    const b = e.target.closest('[data-staff]');
    if (!b) return;
    s.staffId = b.dataset.staff || null;
    s.slot = null;
    go('time');
  };
}

// ---------------- Step 3: date + time ----------------
function stepTime() {
  const days = [];
  const max = Math.min(s.biz.max_days_ahead, 30);
  for (let i = 0; i <= max; i++) days.push(isoDay(i));

  const dayBtn = (d, i) => {
    const date = new Date(`${d}T12:00:00Z`);
    const wd = new Intl.DateTimeFormat('ar', { weekday: 'short', timeZone: TZ }).format(date);
    const dm = new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short', timeZone: TZ }).format(date);
    const label = i === 0 ? 'اليوم' : i === 1 ? 'بكرا' : wd;
    return `<button class="day ${d === s.date ? 'on' : ''}" data-day="${d}">${label}<small>${dm}</small></button>`;
  };

  $('#step').innerHTML = `
    ${backBtn(hasStaffChoice() ? 'staff' : 'service')}
    <h2 style="font-size:1.2rem">اختر اليوم والساعة</h2>
    <div class="days">${days.map(dayBtn).join('')}</div>
    <div id="slots"><p class="empty">...جارٍ البحث عن أوقات فاضية</p></div>`;

  $('#step').onclick = (e) => {
    const d = e.target.closest('[data-day]');
    const t = e.target.closest('[data-slot]');
    if (d) {
      s.date = d.dataset.day;
      $('#step .day.on')?.classList.remove('on');
      d.classList.add('on');
      loadSlots();
    }
    if (t) {
      s.slot = s.slots[Number(t.dataset.slot)];
      go('details');
    }
  };
  $('.day.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  loadSlots();
}

async function loadSlots() {
  const box = $('#slots');
  box.innerHTML = `<p class="empty">...جارٍ البحث عن أوقات فاضية</p>`;
  const reqDate = s.date;
  const { data, error } = await supabase.rpc('get_available_slots', {
    p_slug: slug, p_service_id: s.service.id, p_staff_id: s.staffId, p_date: reqDate,
  });
  if (reqDate !== s.date) return;              // user already clicked another day
  if (error) { box.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }

  // "Any staff": keep one row per time (first free staff member).
  const seen = new Set();
  s.slots = (data || []).filter((r) => !seen.has(r.starts_at) && seen.add(r.starts_at));

  box.innerHTML = s.slots.length
    ? `<div class="slots">${s.slots.map((r, i) => `<button class="slot" data-slot="${i}">${fmtTime(r.starts_at)}</button>`).join('')}</div>`
    : `<p class="empty">لا يوجد أوقات فاضية بهذا اليوم — جرّب يوم ثاني</p>`;
}

// ---------------- Step 4: details ----------------
function stepDetails() {
  const draft = loadDraft();
  const staffName = s.biz.staff.find((x) => x.id === s.slot.staff_id)?.name;
  $('#step').innerHTML = `
    ${backBtn('time')}
    <h2 style="font-size:1.2rem">تفاصيلك</h2>
    <div class="summary" style="margin-bottom:16px">
      <div><span class="muted">الخدمة</span><b>${esc(s.service.name)}</b></div>
      <div><span class="muted">الموعد</span><b>${fmtDate(s.slot.starts_at)} · ${fmtTime(s.slot.starts_at)}</b></div>
      ${hasStaffChoice() && staffName ? `<div><span class="muted">عند</span><b>${esc(staffName)}</b></div>` : ''}
      <div><span class="muted">السعر</span><b>${price(s.service.price)}</b></div>
    </div>
    <form id="details" novalidate>
      <div class="field"><label for="c-name">الاسم</label><input id="c-name" autocomplete="name" maxlength="60" value="${esc(draft.name || '')}" /></div>
      <div class="field"><label for="c-phone">رقم الجوال (واتساب)</label>
        <input id="c-phone" type="tel" dir="ltr" autocomplete="tel" placeholder="050-1234567" value="${esc(draft.phone || '')}" />
        <div class="hint">رح يوصلك تأكيد وتذكير على واتساب</div></div>
      <div class="field"><label for="c-notes">ملاحظة (اختياري)</label><input id="c-notes" maxlength="300" /></div>
      <p id="c-error" class="error"></p>
      <button class="btn block" type="submit">تأكيد الحجز</button>
    </form>`;
  $('#step').onclick = null;

  $('#details').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#c-name').value.trim();
    const rawPhone = $('#c-phone').value.trim();
    const phone = normalizePhone(rawPhone);
    const err = $('#c-error');
    if (name.length < 2) return (err.textContent = 'اكتب اسمك.');
    if (!phone) return (err.textContent = 'رقم الجوال غير صحيح (مثلاً 0501234567).');

    const btn = e.submitter;
    setLoading(btn, true);
    const { data, error } = await supabase.rpc('create_booking', {
      p_slug: slug,
      p_service_id: s.service.id,
      p_staff_id: s.slot.staff_id,
      p_starts_at: s.slot.starts_at,
      p_name: name,
      p_phone: phone,
      p_notes: $('#c-notes').value.trim() || null,
    });
    setLoading(btn, false);

    if (error) {
      if (error.message.includes('SLOT_TAKEN')) {
        toast('للأسف حدا سبقك على هذا الوقت — اختر وقت ثاني', 'err');
        return go('time');
      }
      err.textContent = error.message.includes('TOO_MANY_BOOKINGS')
        ? 'عندك ٣ حجوزات قادمة عند هذه المصلحة — هذا الحد الأقصى.'
        : 'صار خطأ، جرّب مرة ثانية.';
      return;
    }
    saveDraft({ name, phone: rawPhone });
    s.result = data;
    go('done');
  });
}

// ---------------- Step 5: done ----------------
function stepDone() {
  const r = s.result;
  $('#step').onclick = null;
  $('#step').innerHTML = `
    <div class="success">
      <div class="check">✓</div>
      <h2>تم الحجز!</h2>
      <p><b>${esc(s.service.name)}</b><br>${fmtDate(r.starts_at)} · الساعة ${fmtTime(r.starts_at)}
      ${r.staff_name && hasStaffChoice() ? `<br>عند ${esc(r.staff_name)}` : ''}</p>
      <p class="muted">رح يوصلك تأكيد على واتساب. إذا بدك تلغي، في رابط إلغاء بالرسالة.</p>
      ${s.biz.address ? `<p class="muted">📍 ${esc(s.biz.address)}</p>` : ''}
      <button class="btn ghost" id="again">حجز موعد ثاني</button>
    </div>`;
  $('#again').addEventListener('click', () => { s.service = null; s.slot = null; go('service'); });
}

// ---------------- Cancel (from WhatsApp link) ----------------
function renderCancel() {
  $('#stepper').innerHTML = '';
  $('#step').innerHTML = `
    <h2 style="font-size:1.2rem">إلغاء موعد</h2>
    <p class="muted">للتأكيد، اكتب رقم الجوال اللي حجزت فيه.</p>
    <form id="cancel-form" novalidate>
      <div class="field"><input id="x-phone" type="tel" dir="ltr" placeholder="050-1234567" value="${esc(loadDraft().phone || '')}" /></div>
      <p id="x-error" class="error"></p>
      <button class="btn danger block" type="submit">إلغاء الموعد</button>
    </form>
    <p style="margin-top:12px"><a href="/b/${esc(slug)}">حجز موعد جديد</a></p>`;
  $('#cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = normalizePhone($('#x-phone').value);
    if (!phone) return ($('#x-error').textContent = 'رقم الجوال غير صحيح.');
    setLoading(e.submitter, true);
    const { data, error } = await supabase.rpc('cancel_booking', { p_id: cancelId, p_phone: phone });
    setLoading(e.submitter, false);
    if (error || !data) return ($('#x-error').textContent = 'ما لقينا موعد فعّال بهذا الرقم (أو الموعد مرّ).');
    $('#step').innerHTML = `<div class="success"><div class="check">✓</div><h2>تم إلغاء الموعد</h2>
      <p><a class="btn" href="/b/${esc(slug)}">حجز موعد جديد</a></p></div>`;
  });
}
