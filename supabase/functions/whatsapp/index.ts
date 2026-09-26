// Hujuzati — WhatsApp notifications (Supabase Edge Function, Deno)
//
// Called by the database (see migrations/0002_notifications.sql):
//   { "type": "created",   "appointment_id": "..." }  → confirm to customer (+ notify owner)
//   { "type": "cancelled", "appointment_id": "..." }  → tell customer it was cancelled
//   { "type": "reminders" }                           → send reminders for bookings in the next 24h
//
// Uses the Meta WhatsApp Cloud API with pre-approved TEMPLATE messages
// (required for business-initiated messages). If WHATSAPP_TOKEN is not set,
// the function runs in dry-run mode and only logs what it would send.

import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;

const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const WEBHOOK_SECRET = env('WEBHOOK_SECRET');
const WA_TOKEN = env('WHATSAPP_TOKEN');
const WA_PHONE_ID = env('WHATSAPP_PHONE_NUMBER_ID');
const WA_LANG = env('WHATSAPP_TEMPLATE_LANG', 'ar');
const SITE_URL = env('SITE_URL', 'https://hujuzati.pages.dev').replace(/\/$/, '');

const TEMPLATES = {
  confirmed: env('TPL_CONFIRMED', 'booking_confirmed'),
  reminder: env('TPL_REMINDER', 'booking_reminder'),
  cancelled: env('TPL_CANCELLED', 'booking_cancelled'),
  owner: env('TPL_OWNER_NEW', 'owner_new_booking'),
};

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Appt = {
  id: string;
  customer_name: string;
  customer_phone: string;
  service_name: string;
  starts_at: string;
  status: string;
  businesses: {
    name: string; slug: string; phone: string | null; timezone: string;
    whatsapp_enabled: boolean; notify_owner: boolean;
  };
  staff: { name: string } | null;
};

const SELECT = 'id, customer_name, customer_phone, service_name, starts_at, status, ' +
  'businesses(name, slug, phone, timezone, whatsapp_enabled, notify_owner), staff(name)';

function when(iso: string, tz: string) {
  const d = new Date(iso);
  return {
    date: new Intl.DateTimeFormat('ar', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(d),
    time: new Intl.DateTimeFormat('ar', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d),
  };
}

const cancelLink = (a: Appt) => `${SITE_URL}/b/${a.businesses.slug}?cancel=${a.id}`;

async function sendTemplate(to: string, template: string, params: string[]) {
  const phone = to.replace(/^\+/, '');
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log('[dry-run]', template, phone, params);
    return { ok: true, dryRun: true };
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: template,
        language: { code: WA_LANG },
        components: [{
          type: 'body',
          parameters: params.map((text) => ({ type: 'text', text })),
        }],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('WhatsApp error', res.status, body);
    return { ok: false, status: res.status, body };
  }
  return { ok: true };
}

async function getAppt(id: string): Promise<Appt | null> {
  const { data, error } = await db.from('appointments').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data as unknown as Appt | null;
}

async function onCreated(id: string) {
  const a = await getAppt(id);
  if (!a || a.status !== 'confirmed') return { skipped: true };
  const b = a.businesses;
  const { date, time } = when(a.starts_at, b.timezone);
  const out: Record<string, unknown> = {};

  if (b.whatsapp_enabled) {
    // {{1}} name, {{2}} business, {{3}} service, {{4}} date, {{5}} time, {{6}} cancel link
    out.customer = await sendTemplate(a.customer_phone, TEMPLATES.confirmed,
      [a.customer_name, b.name, a.service_name, date, time, cancelLink(a)]);
  }
  if (b.notify_owner && b.phone) {
    // {{1}} customer, {{2}} customer phone, {{3}} service (+staff), {{4}} date, {{5}} time
    const svc = a.staff?.name ? `${a.service_name} — ${a.staff.name}` : a.service_name;
    out.owner = await sendTemplate(b.phone, TEMPLATES.owner,
      [a.customer_name, a.customer_phone, svc, date, time]);
  }
  return out;
}

async function onCancelled(id: string) {
  const a = await getAppt(id);
  if (!a || !a.businesses.whatsapp_enabled) return { skipped: true };
  const { date, time } = when(a.starts_at, a.businesses.timezone);
  // {{1}} name, {{2}} business, {{3}} date, {{4}} time, {{5}} rebook link
  return await sendTemplate(a.customer_phone, TEMPLATES.cancelled,
    [a.customer_name, a.businesses.name, date, time, `${SITE_URL}/b/${a.businesses.slug}`]);
}

async function sendReminders() {
  const now = Date.now();
  // Claim due rows atomically (sets reminder_sent_at) so overlapping runs never double-send.
  const { data, error } = await db
    .from('appointments')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('status', 'confirmed')
    .is('reminder_sent_at', null)
    .gt('starts_at', new Date(now + 60 * 60 * 1000).toISOString())        // > 1h from now
    .lte('starts_at', new Date(now + 24 * 60 * 60 * 1000).toISOString())  // ≤ 24h from now
    .lt('created_at', new Date(now - 60 * 60 * 1000).toISOString())       // not just-booked
    .select(SELECT);
  if (error) throw error;

  let sent = 0;
  for (const a of (data ?? []) as unknown as Appt[]) {
    if (!a.businesses.whatsapp_enabled) continue;
    const { date, time } = when(a.starts_at, a.businesses.timezone);
    // {{1}} name, {{2}} business, {{3}} service, {{4}} date, {{5}} time, {{6}} cancel link
    const r = await sendTemplate(a.customer_phone, TEMPLATES.reminder,
      [a.customer_name, a.businesses.name, a.service_name, date, time, cancelLink(a)]);
    if (r.ok) sent++;
    else await db.from('appointments').update({ reminder_sent_at: null }).eq('id', a.id); // retry next run
  }
  return { due: data?.length ?? 0, sent };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!WEBHOOK_SECRET || req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const body = await req.json();
    let result: unknown;
    switch (body.type) {
      case 'created': result = await onCreated(body.appointment_id); break;
      case 'cancelled': result = await onCancelled(body.appointment_id); break;
      case 'reminders': result = await sendReminders(); break;
      default: return Response.json({ error: 'unknown type' }, { status: 400 });
    }
    return Response.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
