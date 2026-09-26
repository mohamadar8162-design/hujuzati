-- =====================================================================
-- Hujuzati v2 — core schema
-- Multi-tenant booking: every business belongs to one auth user (owner).
-- Public (anon) access happens ONLY through SECURITY DEFINER functions.
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.businesses (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null unique references auth.users(id) on delete cascade,
  name               text not null check (char_length(name) between 2 and 80),
  slug               text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  category           text,
  phone              text check (phone is null or phone ~ '^\+972\d{8,9}$'),
  address            text,
  description        text,
  timezone           text not null default 'Asia/Jerusalem',
  slot_interval_min  int  not null default 15  check (slot_interval_min in (5, 10, 15, 20, 30, 60)),
  min_notice_min     int  not null default 60  check (min_notice_min between 0 and 10080),
  max_days_ahead     int  not null default 30  check (max_days_ahead between 1 and 180),
  whatsapp_enabled   boolean not null default true,
  notify_owner       boolean not null default true,
  created_at         timestamptz not null default now()
);

create table public.staff (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  active       boolean not null default true,
  sort         int not null default 0,
  created_at   timestamptz not null default now()
);
create index on public.staff (business_id);

create table public.services (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  description   text,
  duration_min  int  not null check (duration_min between 5 and 600),
  price         numeric(10,2) not null default 0 check (price >= 0),
  active        boolean not null default true,
  sort          int not null default 0,
  created_at    timestamptz not null default now()
);
create index on public.services (business_id);

-- One working range per staff member per weekday (0 = Sunday … 6 = Saturday).
create table public.working_hours (
  staff_id    uuid not null references public.staff(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  is_open     boolean not null default true,
  start_time  time not null default '09:00',
  end_time    time not null default '18:00',
  primary key (staff_id, weekday),
  check (end_time > start_time)
);

create table public.appointments (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  staff_id         uuid not null references public.staff(id) on delete cascade,
  service_id       uuid references public.services(id) on delete set null,
  service_name     text not null,            -- snapshot, survives service edits
  price            numeric(10,2) not null default 0,
  customer_name    text not null check (char_length(customer_name) between 2 and 60),
  customer_phone   text not null check (customer_phone ~ '^\+972\d{8,9}$'),
  notes            text check (notes is null or char_length(notes) <= 300),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'confirmed'
                   check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  reminder_sent_at timestamptz,
  created_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  -- The database itself guarantees a staff member is never double-booked.
  constraint no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status = 'confirmed')
);
create index on public.appointments (business_id, starts_at);
create index on public.appointments (status, starts_at) where reminder_sent_at is null;

-- ---------------------------------------------------------------------
-- Defaults: a new staff member gets working hours for all 7 days
-- (Sat–Thu 09:00–18:00, Friday closed). Owners can edit afterwards.
-- ---------------------------------------------------------------------
create or replace function public.tg_staff_default_hours()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.working_hours (staff_id, weekday, is_open, start_time, end_time)
  select new.id, d, d <> 5, '09:00', '18:00'
  from generate_series(0, 6) as d
  on conflict do nothing;
  return new;
end $$;

create trigger staff_default_hours
after insert on public.staff
for each row execute function public.tg_staff_default_hours();

-- ---------------------------------------------------------------------
-- Row Level Security — owners see and edit only their own business.
-- ---------------------------------------------------------------------
alter table public.businesses    enable row level security;
alter table public.staff         enable row level security;
alter table public.services      enable row level security;
alter table public.working_hours enable row level security;
alter table public.appointments  enable row level security;

create or replace function public.is_owner(p_business uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.businesses where id = p_business and owner_id = auth.uid());
$$;

create policy "owner reads own business"   on public.businesses for select using (owner_id = auth.uid());
create policy "owner creates own business" on public.businesses for insert with check (owner_id = auth.uid());
create policy "owner updates own business" on public.businesses for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner manages staff"    on public.staff    for all using (public.is_owner(business_id)) with check (public.is_owner(business_id));
create policy "owner manages services" on public.services for all using (public.is_owner(business_id)) with check (public.is_owner(business_id));
create policy "owner manages appts"    on public.appointments for all using (public.is_owner(business_id)) with check (public.is_owner(business_id));

create policy "owner manages hours" on public.working_hours for all
  using      (exists (select 1 from public.staff s where s.id = staff_id and public.is_owner(s.business_id)))
  with check (exists (select 1 from public.staff s where s.id = staff_id and public.is_owner(s.business_id)));

-- ---------------------------------------------------------------------
-- Public API (callable by anon) — the only way customers touch data.
-- ---------------------------------------------------------------------

-- Business profile + active services + active staff, by slug.
create or replace function public.get_public_business(p_slug text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', b.id, 'name', b.name, 'slug', b.slug, 'category', b.category,
    'phone', b.phone, 'address', b.address, 'description', b.description,
    'max_days_ahead', b.max_days_ahead,
    'services', coalesce((
      select json_agg(json_build_object('id', s.id, 'name', s.name, 'description', s.description,
                                        'duration_min', s.duration_min, 'price', s.price)
                      order by s.sort, s.created_at)
      from public.services s where s.business_id = b.id and s.active), '[]'::json),
    'staff', coalesce((
      select json_agg(json_build_object('id', st.id, 'name', st.name) order by st.sort, st.created_at)
      from public.staff st where st.business_id = b.id and st.active), '[]'::json)
  )
  from public.businesses b
  where b.slug = lower(p_slug);
$$;

-- Free slots for one day. p_staff_id NULL = any staff member.
create or replace function public.get_available_slots(
  p_slug text, p_service_id uuid, p_staff_id uuid, p_date date
)
returns table (staff_id uuid, starts_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  b   public.businesses;
  svc public.services;
  today date;
begin
  select * into b from public.businesses where slug = lower(p_slug);
  if not found then return; end if;

  select * into svc from public.services
   where id = p_service_id and business_id = b.id and active;
  if not found then return; end if;

  today := (now() at time zone b.timezone)::date;
  if p_date < today or p_date > today + b.max_days_ahead then return; end if;

  return query
  with st as (
    select s.id, wh.start_time, wh.end_time
    from public.staff s
    join public.working_hours wh
      on wh.staff_id = s.id and wh.weekday = extract(dow from p_date)::int and wh.is_open
    where s.business_id = b.id and s.active
      and (p_staff_id is null or s.id = p_staff_id)
  ),
  candidates as (
    select st.id as sid, gs as slot
    from st,
    lateral generate_series(
      (p_date + st.start_time) at time zone b.timezone,
      ((p_date + st.end_time) at time zone b.timezone) - make_interval(mins => svc.duration_min),
      make_interval(mins => b.slot_interval_min)
    ) gs
  )
  select c.sid, c.slot
  from candidates c
  where c.slot >= now() + make_interval(mins => b.min_notice_min)
    and not exists (
      select 1 from public.appointments a
      where a.staff_id = c.sid and a.status = 'confirmed'
        and tstzrange(a.starts_at, a.ends_at) && tstzrange(c.slot, c.slot + make_interval(mins => svc.duration_min))
    )
  order by c.slot, c.sid;
end $$;

-- Create a booking. Re-validates the slot server-side; the exclusion
-- constraint protects against two customers grabbing the same slot.
create or replace function public.create_booking(
  p_slug text, p_service_id uuid, p_staff_id uuid, p_starts_at timestamptz,
  p_name text, p_phone text, p_notes text default null
)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  b        public.businesses;
  svc      public.services;
  v_staff  uuid;
  v_id     uuid;
  v_active int;
begin
  select * into b from public.businesses where slug = lower(p_slug);
  if not found then raise exception 'BUSINESS_NOT_FOUND'; end if;

  select * into svc from public.services where id = p_service_id and business_id = b.id and active;
  if not found then raise exception 'SERVICE_NOT_FOUND'; end if;

  -- Basic abuse guard: max 3 upcoming bookings per phone per business.
  select count(*) into v_active from public.appointments
   where business_id = b.id and customer_phone = p_phone
     and status = 'confirmed' and starts_at > now();
  if v_active >= 3 then raise exception 'TOO_MANY_BOOKINGS'; end if;

  select s.staff_id into v_staff
  from public.get_available_slots(p_slug, p_service_id, p_staff_id,
                                  (p_starts_at at time zone b.timezone)::date) s
  where s.starts_at = p_starts_at
  limit 1;
  if v_staff is null then raise exception 'SLOT_TAKEN'; end if;

  begin
    insert into public.appointments
      (business_id, staff_id, service_id, service_name, price,
       customer_name, customer_phone, notes, starts_at, ends_at)
    values
      (b.id, v_staff, svc.id, svc.name, svc.price,
       trim(p_name), p_phone, nullif(trim(coalesce(p_notes, '')), ''),
       p_starts_at, p_starts_at + make_interval(mins => svc.duration_min))
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';
  end;

  return json_build_object(
    'id', v_id,
    'staff_name', (select name from public.staff where id = v_staff),
    'starts_at', p_starts_at
  );
end $$;

-- Customer self-cancel: needs the booking id (from the WhatsApp link) + phone.
create or replace function public.cancel_booking(p_id uuid, p_phone text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  update public.appointments
     set status = 'cancelled'
   where id = p_id and customer_phone = p_phone
     and status = 'confirmed' and starts_at > now();
  return found;
end $$;

-- Is a slug free? (used on signup)
create or replace function public.slug_available(p_slug text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.businesses where slug = lower(p_slug));
$$;

-- Lock down: anon/authenticated can only call the public functions.
revoke all on function public.get_available_slots(text, uuid, uuid, date) from public;
revoke all on function public.create_booking(text, uuid, uuid, timestamptz, text, text, text) from public;
revoke all on function public.cancel_booking(uuid, text) from public;
revoke all on function public.get_public_business(text) from public;
revoke all on function public.slug_available(text) from public;
revoke all on function public.tg_staff_default_hours() from public;

grant execute on function public.get_public_business(text) to anon, authenticated;
grant execute on function public.get_available_slots(text, uuid, uuid, date) to anon, authenticated;
grant execute on function public.create_booking(text, uuid, uuid, timestamptz, text, text, text) to anon, authenticated;
grant execute on function public.cancel_booking(uuid, text) to anon, authenticated;
grant execute on function public.slug_available(text) to anon, authenticated;

-- Live updates in the owner dashboard (Supabase Realtime respects RLS).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.appointments;
  end if;
end $$;
