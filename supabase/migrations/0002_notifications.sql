-- =====================================================================
-- Hujuzati v2 — WhatsApp notifications wiring
-- Calls the `whatsapp` Edge Function:
--   * on new booking     -> {"type":"created","appointment_id":...}
--   * on cancellation    -> {"type":"cancelled","appointment_id":...}
--   * every 10 minutes   -> {"type":"reminders"}
--
-- After running this migration, set the two config values (see README):
--   update private.app_config set value = 'https://<ref>.supabase.co/functions/v1/whatsapp' where key = 'function_url';
--   update private.app_config set value = '<same value as WEBHOOK_SECRET>'                   where key = 'webhook_secret';
-- =====================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.app_config (
  key   text primary key,
  value text not null default ''
);
insert into private.app_config (key) values ('function_url'), ('webhook_secret')
on conflict do nothing;

create or replace function private.call_whatsapp(payload jsonb)
returns void language plpgsql security definer set search_path = public, private as $$
declare
  v_url    text := (select value from private.app_config where key = 'function_url');
  v_secret text := (select value from private.app_config where key = 'webhook_secret');
begin
  if coalesce(v_url, '') = '' then return; end if;   -- not configured yet: silently skip
  perform net.http_post(
    url     := v_url,
    body    := payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret)
  );
end $$;

create or replace function public.tg_appointment_notify()
returns trigger language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'INSERT' and new.status = 'confirmed' then
    perform private.call_whatsapp(jsonb_build_object('type', 'created', 'appointment_id', new.id));
  elsif tg_op = 'UPDATE' and old.status = 'confirmed' and new.status = 'cancelled' then
    perform private.call_whatsapp(jsonb_build_object('type', 'cancelled', 'appointment_id', new.id));
  end if;
  return new;
end $$;

drop trigger if exists appointment_notify on public.appointments;
create trigger appointment_notify
after insert or update of status on public.appointments
for each row execute function public.tg_appointment_notify();

revoke all on function public.tg_appointment_notify() from public;

-- Reminder sweep every 10 minutes (the function picks bookings ~24h ahead).
select cron.unschedule('hujuzati-reminders')
where exists (select 1 from cron.job where jobname = 'hujuzati-reminders');

select cron.schedule(
  'hujuzati-reminders',
  '*/10 * * * *',
  $$ select private.call_whatsapp('{"type":"reminders"}'::jsonb) $$
);
