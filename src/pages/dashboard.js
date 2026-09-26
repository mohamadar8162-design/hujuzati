import { supabase, requireSession } from '../lib/supabase.js';
import {
  $, $$, esc, toast, fmtTime, fmtDate, isoDay, price, normalizePhone, slugify, setLoading,
  DAYS, STATUS_LABELS, TZ, icon,
} from '../lib/ui.js';

const state = {
  session: null,
  business: null,
  services: [],
  staff: [],
  editingServiceId: null,
  editingStaffId: null,
};

// Icons in the sidebar
$$('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });

// Password-reset links land here with a recovery session.
supabase.auth.onAuthStateChange(async (event) => {
  if (event === 'PASSWORD_RECOVERY') {
    const pw = prompt('اكتب كلمة سر جديدة (8 أحرف على الأقل):');
    if (pw && pw.length >= 8) {
      const { error } = await supabase.auth.updateUser({ password: pw });
      toast(error ? error.message : 'تغيّرت كلمة السر', error ? 'err' : 'ok');
    }
  }
});

async function boot() {
  const { data: biz, error } = await supabase
    .from('businesses').select('*').eq('owner_id', state.session.user.id).maybeSingle();
  if (error) return toast(error.message, 'err');

  if (!biz) return showOnboarding();
  state.business = biz;
  document.title = `${biz.name} — حجوزاتي`;
  $('#biz-name').textContent = biz.name;
  $('#onboarding').hidden = true;
  $('#app').hidden = false;

  const link = `${location.origin}/b/${biz.slug}`;
  $('#share-link').textContent = link.replace(/^https?:\/\//, '');
  $('#open-link').href = link;

  await Promise.all([loadServices(), loadStaff()]);
  $('#appt-date').value = isoDay(0);
  await loadAppointments();
  fillSettings();
  subscribeRealtime();
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
function showOnboarding() {
  $('#onboarding').hidden = false;
  let slugTouched = false;
  $('#onb-slug').addEventListener('input', () => (slugTouched = true));
  $('#onb-name').addEventListener('input', (e) => {
    if (!slugTouched) $('#onb-slug').value = slugify(e.target.value);
  });

  $('#onb-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const err = $('#onb-error');
    err.textContent = '';

    const name = $('#onb-name').value.trim();
    const slug = $('#onb-slug').value.trim().toLowerCase();
    const rawPhone = $('#onb-phone').value.trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    const staffName = $('#onb-staff').value.trim();

    if (name.length < 2) return (err.textContent = 'اكتب اسم المصلحة.');
    if (!staffName) return (err.textContent = 'اكتب اسمك — انت أول موظف.');
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug))
      return (err.textContent = 'الرابط لازم يكون 3–40 حرف: أحرف إنجليزية صغيرة، أرقام أو شَرطة.');
    if (rawPhone && !phone) return (err.textContent = 'رقم الجوال مش صحيح. مثال: 0501234567.');

    setLoading(btn, true, 'جارٍ الإنشاء…');
    const { data: free } = await supabase.rpc('slug_available', { p_slug: slug });
    if (!free) {
      setLoading(btn, false);
      return (err.textContent = `الرابط /b/${slug} محجوز. جرّب اسم ثاني.`);
    }

    const { data: biz, error } = await supabase.from('businesses').insert({
      owner_id: state.session.user.id, name, slug, phone,
      category: $('#onb-category').value,
    }).select().single();
    if (error) {
      setLoading(btn, false);
      return (err.textContent = error.message);
    }

    await supabase.from('staff').insert({ business_id: biz.id, name: staffName });
    setLoading(btn, false);
    await boot();
    switchTab('services');
    toast('المصلحة جاهزة. أضف أول خدمة.');
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function switchTab(name) {
  $$('#tabs [data-tab]').forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name === 'hours') renderHoursStaffSelect();
  window.scrollTo({ top: 0 });
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) switchTab(b.dataset.tab);
});

['#logout', '#logout-2'].forEach((sel) => $(sel).addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.href = '/';
}));

$('#copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#open-link').href);
  toast('انتسخ الرابط');
});

/** Sheet dialogs: Cancel closes, Save runs `onSave` and closes only on success. */
function sheet(dialog, form, onSave) {
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    const ok = await onSave();
    if (btn) btn.disabled = false;
    if (ok) dialog.close();
  });
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

async function loadAppointments() {
  const date = $('#appt-date').value || isoDay(0);
  $('#appt-title').textContent = date === isoDay(0) ? 'اليوم'
    : date === isoDay(1) ? 'بكرا' : fmtDate(`${date}T12:00:00Z`);

  // Generous UTC window, then filter by Israel-local date (DST-safe).
  const from = new Date(`${date}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${date}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 2);

  const { data, error } = await supabase
    .from('appointments')
    .select('*, staff(name)')
    .eq('business_id', state.business.id)
    .gte('starts_at', from.toISOString())
    .lt('starts_at', to.toISOString())
    .order('starts_at');
  if (error) return toast(error.message, 'err');

  const rows = data.filter((a) => dayOf(a.starts_at) === date);
  const active = rows.filter((a) => a.status === 'confirmed' || a.status === 'completed');
  const revenue = active.reduce((sum, a) => sum + Number(a.price), 0);
  $('#stats').innerHTML = rows.length
    ? `<b class="num">${active.length}</b> ${active.length === 1 ? 'موعد' : 'مواعيد'} · <b class="num">${price(revenue)}</b> متوقّع`
    : '';

  $('#appt-list').innerHTML = rows.length ? rows.map(apptRow).join('')
    : `<li><div class="empty"><p class="title">ما في مواعيد</p><p>شارك رابط الحجز، أو أضف موعد أخذته بالتلفون.</p></div></li>`;
}

function apptRow(a) {
  const wa = a.customer_phone.replace('+', '');
  const status = a.status === 'confirmed' ? ''
    : `<span class="status ${a.status}">${STATUS_LABELS[a.status]}</span>`;
  const actions = a.status === 'confirmed' ? `
    <div class="row-actions">
      <button class="btn small gray" data-act="completed" data-id="${a.id}">وصل</button>
      <button class="btn small gray" data-act="no_show" data-id="${a.id}">ما إجا</button>
      <button class="btn small destructive" data-act="cancelled" data-id="${a.id}">إلغاء</button>
    </div>` : '';
  return `<li><div class="row appt${a.status === 'confirmed' ? '' : ' done'}">
    <span class="time">${fmtTime(a.starts_at)}<small>${fmtTime(a.ends_at)}</small></span>
    <span class="grow">${esc(a.customer_name)} ${status}
      <span class="sub">${esc(a.service_name)}${a.staff?.name && state.staff.length > 1 ? ` · ${esc(a.staff.name)}` : ''}</span>
      <span class="sub"><a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="tel" aria-label="واتساب ${esc(a.customer_name)}">${esc('0' + a.customer_phone.slice(4))}</a></span>
      ${a.notes ? `<span class="sub">«${esc(a.notes)}»</span>` : ''}
    </span>
    ${actions}
  </div></li>`;
}

$('#appt-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'cancelled' && !confirm('تلغي الموعد؟ الزبون رح توصله رسالة إلغاء.')) return;
  b.disabled = true;
  const { error } = await supabase.from('appointments').update({ status: b.dataset.act }).eq('id', b.dataset.id);
  if (error) { b.disabled = false; return toast(error.message, 'err'); }
  loadAppointments();
});

$('#appt-date').addEventListener('change', loadAppointments);

function subscribeRealtime() {
  supabase
    .channel('appts')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'appointments',
      filter: `business_id=eq.${state.business.id}`,
    }, (payload) => {
      if (payload.eventType === 'INSERT') toast(`حجز جديد: ${payload.new.customer_name}، ${fmtTime(payload.new.starts_at)}`);
      loadAppointments();
    })
    .subscribe();
}

// ---- Manual booking (phone / walk-in)
$('#add-appt').addEventListener('click', () => {
  const active = state.services.filter((s) => s.active);
  if (!active.length) { switchTab('services'); return toast('أضف خدمة أول', 'err'); }
  $('#ap-service').innerHTML = active
    .map((s) => `<option value="${s.id}">${esc(s.name)} · ${s.duration_min} د</option>`).join('');
  $('#ap-staff').innerHTML = `<option value="">أول موظف متاح</option>` + state.staff.filter((s) => s.active)
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#ap-date').value = $('#appt-date').value || isoDay(0);
  $('#ap-name').value = ''; $('#ap-phone').value = ''; $('#ap-error').textContent = '';
  loadManualSlots();
  $('#appt-dialog').showModal();
});
['#ap-service', '#ap-staff', '#ap-date'].forEach((s) => $(s).addEventListener('change', loadManualSlots));

async function loadManualSlots() {
  const { data, error } = await supabase.rpc('get_available_slots', {
    p_slug: state.business.slug,
    p_service_id: $('#ap-service').value,
    p_staff_id: $('#ap-staff').value || null,
    p_date: $('#ap-date').value,
  });
  if (error) return toast(error.message, 'err');
  const unique = [...new Set((data || []).map((r) => r.starts_at))];
  $('#ap-slot').innerHTML = unique.length
    ? unique.map((t) => `<option value="${t}">${fmtTime(t)}</option>`).join('')
    : `<option value="">ما في وقت فاضي</option>`;
}

sheet($('#appt-dialog'), $('#appt-form'), async () => {
  const err = $('#ap-error');
  const phone = normalizePhone($('#ap-phone').value);
  const name = $('#ap-name').value.trim();
  if (!$('#ap-slot').value) return (err.textContent = 'ما في وقت فاضي بهذا اليوم.', false);
  if (name.length < 2) return (err.textContent = 'اكتب اسم الزبون.', false);
  if (!phone) return (err.textContent = 'رقم الجوال مش صحيح. مثال: 0501234567.', false);

  const { error } = await supabase.rpc('create_booking', {
    p_slug: state.business.slug,
    p_service_id: $('#ap-service').value,
    p_staff_id: $('#ap-staff').value || null,
    p_starts_at: $('#ap-slot').value,
    p_name: name, p_phone: phone, p_notes: null,
  });
  if (error) {
    err.textContent = error.message.includes('SLOT_TAKEN') ? 'هذا الوقت انحجز. اختر وقت ثاني.'
      : error.message.includes('TOO_MANY_BOOKINGS') ? 'لهذا الرقم 3 مواعيد قادمة، وهذا الحد.'
      : error.message;
    return false;
  }
  toast('انحجز الموعد');
  $('#appt-date').value = $('#ap-date').value;
  loadAppointments();
  return true;
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
async function loadServices() {
  const { data, error } = await supabase.from('services').select('*')
    .eq('business_id', state.business.id).order('sort').order('created_at');
  if (error) return toast(error.message, 'err');
  state.services = data;
  $('#svc-list').innerHTML = data.length ? data.map((s) => `<li><div class="row">
      <button class="grow" data-edit-svc="${s.id}" style="all:unset;cursor:pointer;flex:1;min-width:0">
        <span${s.active ? '' : ' class="muted"'}>${esc(s.name)}</span>
        <span class="sub">${s.duration_min} دقيقة · <span class="num">${price(s.price)}</span>${s.active ? '' : ' · مخفية'}</span>
      </button>
      <input type="checkbox" class="switch" data-toggle-svc="${s.id}" ${s.active ? 'checked' : ''} aria-label="${s.active ? 'ظاهرة للزبائن' : 'مخفية عن الزبائن'}: ${esc(s.name)}" />
    </div></li>`).join('')
    : `<li><div class="empty"><p class="title">ما في خدمات لسا</p><p>أضف أول خدمة عشان الزبائن يقدروا يحجزوا.</p></div></li>`;
}

$('#add-service').addEventListener('click', () => openServiceSheet(null));

function openServiceSheet(svc) {
  state.editingServiceId = svc?.id || null;
  $('#svc-title').textContent = svc ? 'تعديل الخدمة' : 'خدمة جديدة';
  $('#svc-name').value = svc?.name || '';
  const dur = $('#svc-duration');
  const d = String(svc?.duration_min || 30);
  if (![...dur.options].some((o) => o.value === d)) dur.add(new Option(`${d} دقيقة`, d));
  dur.value = d;
  $('#svc-price').value = svc ? Number(svc.price) : '';
  $('#svc-desc').value = svc?.description || '';
  $('#svc-dialog').showModal();
}

sheet($('#svc-dialog'), $('#svc-form'), async () => {
  const row = {
    business_id: state.business.id,
    name: $('#svc-name').value.trim(),
    duration_min: Number($('#svc-duration').value),
    price: Number($('#svc-price').value || 0),
    description: $('#svc-desc').value.trim() || null,
  };
  if (!row.name) { toast('اكتب اسم الخدمة', 'err'); return false; }
  const { error } = state.editingServiceId
    ? await supabase.from('services').update(row).eq('id', state.editingServiceId)
    : await supabase.from('services').insert(row);
  if (error) { toast(error.message, 'err'); return false; }
  loadServices();
  return true;
});

$('#svc-list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit-svc]');
  if (edit) openServiceSheet(state.services.find((s) => s.id === edit.dataset.editSvc));
});
$('#svc-list').addEventListener('change', async (e) => {
  const id = e.target.dataset.toggleSvc;
  if (!id) return;
  await supabase.from('services').update({ active: e.target.checked }).eq('id', id);
  loadServices();
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
async function loadStaff() {
  const { data, error } = await supabase.from('staff').select('*')
    .eq('business_id', state.business.id).order('sort').order('created_at');
  if (error) return toast(error.message, 'err');
  state.staff = data;
  $('#staff-list').innerHTML = data.map((s) => `<li><div class="row">
      <button data-edit-staff="${s.id}" style="all:unset;cursor:pointer;flex:1;min-width:0">
        <span${s.active ? '' : ' class="muted"'}>${esc(s.name)}</span>
        ${s.active ? '' : '<span class="sub">مش ظاهر للزبائن</span>'}
      </button>
      <input type="checkbox" class="switch" data-toggle-staff="${s.id}" ${s.active ? 'checked' : ''} aria-label="يستقبل مواعيد: ${esc(s.name)}" />
    </div></li>`).join('');
}

function openStaffSheet(st) {
  state.editingStaffId = st?.id || null;
  $('#staff-title').textContent = st ? 'تعديل الموظف' : 'موظف جديد';
  $('#staff-name').value = st?.name || '';
  $('#staff-hint').hidden = !!st;
  $('#staff-dialog').showModal();
}
$('#add-staff').addEventListener('click', () => openStaffSheet(null));
$('#staff-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit-staff]');
  if (b) openStaffSheet(state.staff.find((s) => s.id === b.dataset.editStaff));
});

sheet($('#staff-dialog'), $('#staff-form'), async () => {
  const name = $('#staff-name').value.trim();
  if (!name) { toast('اكتب اسم الموظف', 'err'); return false; }
  const { error } = state.editingStaffId
    ? await supabase.from('staff').update({ name }).eq('id', state.editingStaffId)
    : await supabase.from('staff').insert({ business_id: state.business.id, name });
  if (error) { toast(error.message, 'err'); return false; }
  loadStaff();
  return true;
});

$('#staff-list').addEventListener('change', async (e) => {
  const id = e.target.dataset.toggleStaff;
  if (!id) return;
  if (!e.target.checked && state.staff.filter((s) => s.active).length <= 1) {
    e.target.checked = true;
    return toast('لازم يضل موظف واحد على الأقل يستقبل مواعيد', 'err');
  }
  await supabase.from('staff').update({ active: e.target.checked }).eq('id', id);
  loadStaff();
});

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------
function renderHoursStaffSelect() {
  const sel = $('#hours-staff');
  const prev = sel.value;
  sel.innerHTML = state.staff.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.hidden = state.staff.length < 2;
  if (prev && state.staff.some((s) => s.id === prev)) sel.value = prev;
  loadHours();
}
$('#hours-staff').addEventListener('change', loadHours);

async function loadHours() {
  const staffId = $('#hours-staff').value;
  if (!staffId) return;
  const { data, error } = await supabase.from('working_hours').select('*').eq('staff_id', staffId);
  if (error) return toast(error.message, 'err');
  const byDay = Object.fromEntries(data.map((h) => [h.weekday, h]));
  // Week starts Saturday — how most local businesses think about it.
  const order = [6, 0, 1, 2, 3, 4, 5];
  $('#hours-rows').innerHTML = order.map((i) => {
    const h = byDay[i] || { is_open: false, start_time: '09:00', end_time: '18:00' };
    return `<div class="row${h.is_open ? '' : ' off'}" data-day="${i}">
      <span class="day-name">${DAYS[i]}</span>
      <input type="checkbox" class="switch h-open" ${h.is_open ? 'checked' : ''} aria-label="مفتوح يوم ${DAYS[i]}" />
      <span class="times">
        <input type="time" class="h-start" value="${h.start_time.slice(0, 5)}" aria-label="من" />
        <span class="muted">–</span>
        <input type="time" class="h-end" value="${h.end_time.slice(0, 5)}" aria-label="لـ" />
      </span>
    </div>`;
  }).join('');
}
$('#hours-rows').addEventListener('change', (e) => {
  if (e.target.classList.contains('h-open')) e.target.closest('.row').classList.toggle('off', !e.target.checked);
});

$('#save-hours').addEventListener('click', async (e) => {
  const staffId = $('#hours-staff').value;
  const rows = $$('#hours-rows .row').map((r) => ({
    staff_id: staffId,
    weekday: Number(r.dataset.day),
    is_open: $('.h-open', r).checked,
    start_time: $('.h-start', r).value,
    end_time: $('.h-end', r).value,
  }));
  const bad = rows.find((r) => r.is_open && r.end_time <= r.start_time);
  if (bad) return toast(`يوم ${DAYS[bad.weekday]}: ساعة الإغلاق لازم تكون بعد الفتح`, 'err');

  setLoading(e.target, true, 'جارٍ الحفظ…');
  const { error } = await supabase.from('working_hours').upsert(rows);
  setLoading(e.target, false);
  toast(error ? error.message : 'انحفظت الساعات', error ? 'err' : 'ok');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function setSelect(sel, value) {
  const v = String(value);
  if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v));
  sel.value = v;
}

/** Resize to ≤1600px wide JPEG in the browser, then upload to the public "covers" bucket. */
async function shrink(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / img.width);
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

$('#cover-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const label = $('label[for="cover-file"]');
  label.textContent = 'جارٍ الرفع…';
  try {
    const blob = await shrink(file);
    const path = `${state.business.id}/cover-${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage.from('covers').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;
    const url = supabase.storage.from('covers').getPublicUrl(path).data.publicUrl;
    const { data, error } = await supabase.from('businesses').update({ cover_url: url }).eq('id', state.business.id).select().single();
    if (error) throw error;
    state.business = data;
    fillSettings();
    toast('انحفظت صورة الغلاف');
  } catch (err) {
    toast(err.message || 'ما زبط الرفع', 'err');
  } finally {
    label.textContent = 'اختيار صورة';
    e.target.value = '';
  }
});

function fillSettings() {
  const b = state.business;
  const thumb = $('#cover-thumb');
  thumb.hidden = !b.cover_url;
  if (b.cover_url) thumb.src = b.cover_url;
  $('#s-name').value = b.name;
  $('#s-phone').value = b.phone ? '0' + b.phone.slice(4) : '';
  $('#s-address').value = b.address || '';
  $('#s-desc').value = b.description || '';
  setSelect($('#s-interval'), b.slot_interval_min);
  setSelect($('#s-notice'), b.min_notice_min);
  setSelect($('#s-days'), b.max_days_ahead);
  $('#s-wa').checked = b.whatsapp_enabled;
  $('#s-notify').checked = b.notify_owner;
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rawPhone = $('#s-phone').value.trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) return toast('رقم الجوال مش صحيح. مثال: 0501234567', 'err');

  const btn = e.submitter;
  setLoading(btn, true, 'جارٍ الحفظ…');
  const { data, error } = await supabase.from('businesses').update({
    name: $('#s-name').value.trim(),
    phone,
    address: $('#s-address').value.trim() || null,
    description: $('#s-desc').value.trim() || null,
    slot_interval_min: Number($('#s-interval').value),
    min_notice_min: Number($('#s-notice').value),
    max_days_ahead: Number($('#s-days').value),
    whatsapp_enabled: $('#s-wa').checked,
    notify_owner: $('#s-notify').checked,
  }).eq('id', state.business.id).select().single();
  setLoading(btn, false);
  if (error) return toast(error.message, 'err');
  state.business = data;
  $('#biz-name').textContent = data.name;
  toast('انحفظت الإعدادات');
});

// ---------------------------------------------------------------------------
// Start — last, so every const/function above is initialised first.
// ---------------------------------------------------------------------------
state.session = await requireSession();
if (state.session) await boot();
