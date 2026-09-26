import { supabase, requireSession } from '../lib/supabase.js';
import {
  $, $$, esc, toast, fmtTime, isoDay, price, normalizePhone, slugify, setLoading,
  DAYS, STATUS_LABELS, TZ,
} from '../lib/ui.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  session: null,
  business: null,
  services: [],
  staff: [],
  editingServiceId: null,
};

// Password-reset links land here with a recovery session.
supabase.auth.onAuthStateChange(async (event) => {
  if (event === 'PASSWORD_RECOVERY') {
    const pw = prompt('اكتب كلمة سر جديدة (٨ أحرف على الأقل):');
    if (pw && pw.length >= 8) {
      const { error } = await supabase.auth.updateUser({ password: pw });
      toast(error ? error.message : 'تم تغيير كلمة السر ✅', error ? 'err' : 'ok');
    }
  }
});

state.session = await requireSession();
if (state.session) await boot();

async function boot() {
  const { data: biz, error } = await supabase
    .from('businesses').select('*').eq('owner_id', state.session.user.id).maybeSingle();
  if (error) return toast(error.message, 'err');

  if (!biz) return showOnboarding();
  state.business = biz;
  $('#biz-name').textContent = biz.name;
  $('#onboarding').classList.add('hidden');
  $('#app').classList.remove('hidden');

  const link = `${location.origin}/b/${biz.slug}`;
  $('#share-link').textContent = link;
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
  $('#onboarding').classList.remove('hidden');
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
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug))
      return (err.textContent = 'الرابط لازم يكون ٣–٤٠ حرف إنجليزي صغير، أرقام أو شَرطة.');
    if (rawPhone && !phone) return (err.textContent = 'رقم الجوال غير صحيح.');
    if (!staffName) return (err.textContent = 'اكتب اسمك.');

    setLoading(btn, true);
    const { data: free } = await supabase.rpc('slug_available', { p_slug: slug });
    if (!free) {
      setLoading(btn, false);
      return (err.textContent = 'هذا الرابط محجوز — جرّب اسم ثاني.');
    }

    const { data: biz, error } = await supabase.from('businesses').insert({
      owner_id: state.session.user.id,
      name, slug, phone,
      category: $('#onb-category').value,
    }).select().single();
    if (error) {
      setLoading(btn, false);
      return (err.textContent = error.message);
    }

    await supabase.from('staff').insert({ business_id: biz.id, name: staffName });
    setLoading(btn, false);
    toast('تم إنشاء المصلحة 🎉 أضف خدماتك الآن');
    await boot();
    switchTab('services');
  });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
  if (name === 'hours') renderHoursStaffSelect();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});

$('#logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.href = '/';
});

$('#copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#share-link').textContent);
  toast('تم نسخ الرابط');
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

async function loadAppointments() {
  const date = $('#appt-date').value || isoDay(0);
  // Fetch a generous UTC window, then filter by Israel-local date (DST-safe).
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
  const body = $('#appt-body');
  body.innerHTML = rows.length ? rows.map(apptRow).join('')
    : `<tr><td colspan="6" class="empty">لا يوجد مواعيد بهذا اليوم</td></tr>`;

  loadStats();
}

function apptRow(a) {
  const wa = a.customer_phone.replace('+', '');
  const actions = a.status === 'confirmed' ? `
      <button class="btn ghost sm" data-act="completed" data-id="${a.id}">✔ تم</button>
      <button class="btn ghost sm" data-act="no_show" data-id="${a.id}">لم يحضر</button>
      <button class="btn danger sm" data-act="cancelled" data-id="${a.id}">إلغاء</button>` : '';
  return `<tr>
    <td><b>${fmtTime(a.starts_at)}</b><div class="hint">${fmtTime(a.ends_at)}</div></td>
    <td>${esc(a.customer_name)}<div class="hint"><a href="https://wa.me/${wa}" target="_blank" dir="ltr">${esc(a.customer_phone)}</a></div>
        ${a.notes ? `<div class="hint">📝 ${esc(a.notes)}</div>` : ''}</td>
    <td>${esc(a.service_name)}<div class="hint">${price(a.price)}</div></td>
    <td>${esc(a.staff?.name || '')}</td>
    <td><span class="badge ${a.status}">${STATUS_LABELS[a.status]}</span></td>
    <td style="white-space:nowrap">${actions}</td>
  </tr>`;
}

$('#appt-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'cancelled' && !confirm('إلغاء الموعد؟ الزبون رح يوصله إشعار.')) return;
  const { error } = await supabase.from('appointments').update({ status: b.dataset.act }).eq('id', b.dataset.id);
  if (error) return toast(error.message, 'err');
  toast('تم التحديث');
  loadAppointments();
});

$('#appt-date').addEventListener('change', loadAppointments);

async function loadStats() {
  const today = isoDay(0);
  const now = new Date();
  const week = new Date(Date.now() + 7 * 86400000);
  const { data } = await supabase
    .from('appointments')
    .select('starts_at, price, status')
    .eq('business_id', state.business.id)
    .eq('status', 'confirmed')
    .gte('starts_at', new Date(Date.now() - 86400000).toISOString())
    .lt('starts_at', week.toISOString());
  const list = data || [];
  const todays = list.filter((a) => dayOf(a.starts_at) === today);
  const upcoming = list.filter((a) => new Date(a.starts_at) > now);
  const revenue = todays.reduce((s, a) => s + Number(a.price), 0);
  $('#stats').innerHTML = `
    <div class="card stat"><span class="muted">مواعيد اليوم</span><b>${todays.length}</b></div>
    <div class="card stat"><span class="muted">قادمة هذا الأسبوع</span><b>${upcoming.length}</b></div>
    <div class="card stat"><span class="muted">دخل متوقّع اليوم</span><b>${price(revenue)}</b></div>`;
}

function subscribeRealtime() {
  supabase
    .channel('appts')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'appointments',
      filter: `business_id=eq.${state.business.id}`,
    }, (payload) => {
      if (payload.eventType === 'INSERT') toast(`🔔 حجز جديد: ${payload.new.customer_name}`);
      loadAppointments();
    })
    .subscribe();
}

// ---- Manual booking (phone / walk-in) ----
$('#add-appt').addEventListener('click', () => {
  if (!state.services.some((s) => s.active)) return toast('أضف خدمة أولاً', 'err');
  $('#ap-service').innerHTML = state.services.filter((s) => s.active)
    .map((s) => `<option value="${s.id}">${esc(s.name)} (${s.duration_min} د)</option>`).join('');
  $('#ap-staff').innerHTML = `<option value="">أي موظف</option>` + state.staff.filter((s) => s.active)
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
    : `<option value="">لا يوجد أوقات فاضية</option>`;
}

$('#appt-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  const phone = normalizePhone($('#ap-phone').value);
  const name = $('#ap-name').value.trim();
  if (!$('#ap-slot').value) return ($('#ap-error').textContent = 'اختر ساعة.');
  if (name.length < 2) return ($('#ap-error').textContent = 'اكتب اسم الزبون.');
  if (!phone) return ($('#ap-error').textContent = 'رقم الجوال غير صحيح.');

  const { error } = await supabase.rpc('create_booking', {
    p_slug: state.business.slug,
    p_service_id: $('#ap-service').value,
    p_staff_id: $('#ap-staff').value || null,
    p_starts_at: $('#ap-slot').value,
    p_name: name,
    p_phone: phone,
    p_notes: null,
  });
  if (error) return ($('#ap-error').textContent = bookingError(error.message));
  $('#appt-dialog').close();
  toast('تم الحجز ✅');
  $('#appt-date').value = $('#ap-date').value;
  loadAppointments();
});

function bookingError(msg) {
  if (msg.includes('SLOT_TAKEN')) return 'هذا الوقت انحجز — اختر وقت ثاني.';
  if (msg.includes('TOO_MANY_BOOKINGS')) return 'لهذا الرقم ٣ حجوزات قادمة — الحد الأقصى.';
  return msg;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
async function loadServices() {
  const { data, error } = await supabase.from('services').select('*')
    .eq('business_id', state.business.id).order('sort').order('created_at');
  if (error) return toast(error.message, 'err');
  state.services = data;
  $('#svc-body').innerHTML = data.length ? data.map((s) => `<tr>
      <td>${esc(s.name)}${s.description ? `<div class="hint">${esc(s.description)}</div>` : ''}</td>
      <td>${s.duration_min} د</td>
      <td>${price(s.price)}</td>
      <td><input type="checkbox" data-toggle-svc="${s.id}" ${s.active ? 'checked' : ''} style="width:auto" /></td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" data-edit-svc="${s.id}">تعديل</button>
        <button class="btn danger sm" data-del-svc="${s.id}">حذف</button>
      </td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">ما في خدمات بعد — أضف أول خدمة</td></tr>`;
}

$('#add-service').addEventListener('click', () => openServiceDialog(null));

function openServiceDialog(svc) {
  state.editingServiceId = svc?.id || null;
  $('#svc-title').textContent = svc ? 'تعديل خدمة' : 'خدمة جديدة';
  $('#svc-name').value = svc?.name || '';
  $('#svc-duration').value = svc?.duration_min || 30;
  $('#svc-price').value = svc?.price ?? 0;
  $('#svc-desc').value = svc?.description || '';
  $('#svc-dialog').showModal();
}

$('#svc-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  const row = {
    business_id: state.business.id,
    name: $('#svc-name').value.trim(),
    duration_min: Number($('#svc-duration').value),
    price: Number($('#svc-price').value || 0),
    description: $('#svc-desc').value.trim() || null,
  };
  if (!row.name) return toast('اكتب اسم الخدمة', 'err');
  if (!(row.duration_min >= 5 && row.duration_min <= 600)) return toast('المدة بين ٥ و ٦٠٠ دقيقة', 'err');

  const q = state.editingServiceId
    ? supabase.from('services').update(row).eq('id', state.editingServiceId)
    : supabase.from('services').insert(row);
  const { error } = await q;
  if (error) return toast(error.message, 'err');
  $('#svc-dialog').close();
  toast('تم الحفظ');
  loadServices();
});

$('#svc-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-svc]');
  const del = e.target.closest('[data-del-svc]');
  if (edit) openServiceDialog(state.services.find((s) => s.id === edit.dataset.editSvc));
  if (del && confirm('حذف الخدمة؟ المواعيد السابقة بتضل محفوظة.')) {
    const { error } = await supabase.from('services').delete().eq('id', del.dataset.delSvc);
    if (error) return toast(error.message, 'err');
    loadServices();
  }
});
$('#svc-body').addEventListener('change', async (e) => {
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
  $('#staff-body').innerHTML = data.map((s) => `<tr>
      <td>${esc(s.name)}</td>
      <td><input type="checkbox" data-toggle-staff="${s.id}" ${s.active ? 'checked' : ''} style="width:auto" /></td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" data-rename-staff="${s.id}">تغيير الاسم</button>
        <button class="btn danger sm" data-del-staff="${s.id}">حذف</button>
      </td></tr>`).join('');
}

$('#add-staff').addEventListener('click', async () => {
  const name = prompt('اسم الموظف:')?.trim();
  if (!name) return;
  const { error } = await supabase.from('staff').insert({ business_id: state.business.id, name });
  if (error) return toast(error.message, 'err');
  toast('تمت الإضافة — عدّل ساعات عمله من "ساعات العمل"');
  loadStaff();
});

$('#staff-body').addEventListener('click', async (e) => {
  const ren = e.target.closest('[data-rename-staff]');
  const del = e.target.closest('[data-del-staff]');
  if (ren) {
    const cur = state.staff.find((s) => s.id === ren.dataset.renameStaff);
    const name = prompt('الاسم الجديد:', cur.name)?.trim();
    if (!name) return;
    await supabase.from('staff').update({ name }).eq('id', cur.id);
    loadStaff();
  }
  if (del) {
    if (state.staff.length <= 1) return toast('لازم يضل موظف واحد على الأقل', 'err');
    if (!confirm('حذف الموظف؟ كل مواعيده رح تنحذف كمان. الأفضل تلغي تفعيله بدل الحذف.')) return;
    await supabase.from('staff').delete().eq('id', del.dataset.delStaff);
    loadStaff();
  }
});
$('#staff-body').addEventListener('change', async (e) => {
  const id = e.target.dataset.toggleStaff;
  if (!id) return;
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
  $('#hours-rows').innerHTML = DAYS.map((d, i) => {
    const h = byDay[i] || { is_open: false, start_time: '09:00', end_time: '18:00' };
    return `<div class="hours-row" data-day="${i}">
      <b>${d}</b>
      <label style="margin:0"><input type="checkbox" class="h-open" ${h.is_open ? 'checked' : ''} /> مفتوح</label>
      <input type="time" class="h-start" value="${h.start_time.slice(0, 5)}" />
      <input type="time" class="h-end" value="${h.end_time.slice(0, 5)}" />
    </div>`;
  }).join('');
}

$('#save-hours').addEventListener('click', async (e) => {
  const staffId = $('#hours-staff').value;
  const rows = $$('.hours-row').map((r) => ({
    staff_id: staffId,
    weekday: Number(r.dataset.day),
    is_open: $('.h-open', r).checked,
    start_time: $('.h-start', r).value,
    end_time: $('.h-end', r).value,
  }));
  const bad = rows.find((r) => r.is_open && r.end_time <= r.start_time);
  if (bad) return toast(`ساعة الإغلاق لازم تكون بعد ساعة الفتح (${DAYS[bad.weekday]})`, 'err');

  setLoading(e.target, true);
  const { error } = await supabase.from('working_hours').upsert(rows);
  setLoading(e.target, false);
  toast(error ? error.message : 'تم حفظ ساعات العمل', error ? 'err' : 'ok');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function fillSettings() {
  const b = state.business;
  $('#s-name').value = b.name;
  $('#s-phone').value = b.phone ? '0' + b.phone.slice(4) : '';
  $('#s-address').value = b.address || '';
  $('#s-desc').value = b.description || '';
  $('#s-interval').value = b.slot_interval_min;
  $('#s-notice').value = b.min_notice_min;
  $('#s-days').value = b.max_days_ahead;
  $('#s-wa').checked = b.whatsapp_enabled;
  $('#s-notify').checked = b.notify_owner;
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rawPhone = $('#s-phone').value.trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) return toast('رقم الجوال غير صحيح', 'err');

  const patch = {
    name: $('#s-name').value.trim(),
    phone,
    address: $('#s-address').value.trim() || null,
    description: $('#s-desc').value.trim() || null,
    slot_interval_min: Number($('#s-interval').value),
    min_notice_min: Number($('#s-notice').value),
    max_days_ahead: Number($('#s-days').value),
    whatsapp_enabled: $('#s-wa').checked,
    notify_owner: $('#s-notify').checked,
  };
  const { data, error } = await supabase.from('businesses').update(patch)
    .eq('id', state.business.id).select().single();
  if (error) return toast(error.message, 'err');
  state.business = data;
  $('#biz-name').textContent = data.name;
  toast('تم حفظ الإعدادات');
});
