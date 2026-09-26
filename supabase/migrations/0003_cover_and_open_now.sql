-- =====================================================================
-- Hujuzati v2 — cover photo + "open now" on the public booking page
-- Run after 0001 and 0002. Safe to run more than once.
-- =====================================================================

alter table public.businesses add column if not exists cover_url text
  check (cover_url is null or cover_url ~ '^https://');

-- Public profile now also returns the cover photo and whether the
-- business is open right now (any active staff member on shift).
create or replace function public.get_public_business(p_slug text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', b.id, 'name', b.name, 'slug', b.slug, 'category', b.category,
    'phone', b.phone, 'address', b.address, 'description', b.description,
    'cover_url', b.cover_url,
    'max_days_ahead', b.max_days_ahead,
    'open_now', exists (
      select 1 from public.staff st
      join public.working_hours wh on wh.staff_id = st.id
      where st.business_id = b.id and st.active and wh.is_open
        and wh.weekday = extract(dow from (now() at time zone b.timezone))::int
        and (now() at time zone b.timezone)::time between wh.start_time and wh.end_time
    ),
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

-- Storage: a public "covers" bucket. Owners may only write inside a
-- folder named after their own business id: covers/<business_id>/...
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('covers', 'covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = true;

    drop policy if exists "owners write covers" on storage.objects;
    create policy "owners write covers" on storage.objects for insert to authenticated
      with check (bucket_id = 'covers' and (storage.foldername(name))[1] in
        (select id::text from public.businesses where owner_id = auth.uid()));

    drop policy if exists "owners update covers" on storage.objects;
    create policy "owners update covers" on storage.objects for update to authenticated
      using (bucket_id = 'covers' and (storage.foldername(name))[1] in
        (select id::text from public.businesses where owner_id = auth.uid()));

    drop policy if exists "owners delete covers" on storage.objects;
    create policy "owners delete covers" on storage.objects for delete to authenticated
      using (bucket_id = 'covers' and (storage.foldername(name))[1] in
        (select id::text from public.businesses where owner_id = auth.uid()));
  end if;
end $$;
