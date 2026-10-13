-- ============================================================
-- Migración 007 — Rename: sectores → territorios
-- Idempotente. Convierte una base creada con el schema anterior al nuevo
-- vocabulario. Los cuerpos PL/pgSQL guardan el texto de las tablas, así que
-- además de renombrar los objetos hay que recrear funciones, triggers y
-- policies que los referencian.
--   psql <connection> -f migrations/007_rename_territorios.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tablas y columnas
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.sectores') is not null
     and to_regclass('public.territorios') is null then
    alter table public.sectores rename to territorios;
  end if;

  if to_regclass('public.sectores_asignaciones') is not null
     and to_regclass('public.territorios_asignaciones') is null then
    alter table public.sectores_asignaciones rename to territorios_asignaciones;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'puntos' and column_name = 'sector_id'
  ) then
    alter table public.puntos rename column sector_id to territorio_id;
  end if;

  -- La columna dentro de la tabla de asignaciones también cambia de nombre.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'territorios_asignaciones'
      and column_name = 'sector_id'
  ) then
    alter table public.territorios_asignaciones rename column sector_id to territorio_id;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Índices con nombre viejo
-- ------------------------------------------------------------
alter index if exists public.sectores_geom_idx rename to territorios_geom_idx;
alter index if exists public.sectores_asig_activa_sector rename to territorios_asig_activa_territorio;
alter index if exists public.sectores_asig_activa_user rename to territorios_asig_activa_user;
alter index if exists public.puntos_sector_idx rename to puntos_territorio_idx;

-- ------------------------------------------------------------
-- 3. Fuera los objetos con nombre/funciones viejos
-- ------------------------------------------------------------
-- Las policies PRIMERO: varias dependen de sector_activo_usuario(uuid)
-- (error 2BP01 si se dropea la función antes). Se recrean en 10 y 11.
drop policy if exists "sectores_select_all" on public.territorios;
drop policy if exists "sectores_insert_auth" on public.territorios;
drop policy if exists "sectores_insert_admin" on public.territorios;
drop policy if exists "sectores_update_admin" on public.territorios;
drop policy if exists "sectores_delete_admin" on public.territorios;
drop policy if exists "sectores_select_colab" on public.territorios;
drop policy if exists "puntos_select_colab" on public.puntos;
drop policy if exists "puntos_insert_colab" on public.puntos;
drop policy if exists "puntos_update_colab" on public.puntos;

drop trigger if exists puntos_sync_sector on public.puntos;
drop trigger if exists sectores_resync_puntos on public.territorios;
drop function if exists public.puntos_sync_sector();
drop function if exists public.sectores_resync_puntos();
drop function if exists public.guardar_sector(text, text, text, geometry);
drop function if exists public.sector_activo_usuario(uuid);
drop function if exists public.devolver_sector();

-- ------------------------------------------------------------
-- 4. guardar_territorio (antes guardar_sector)
-- ------------------------------------------------------------
create or replace function public.guardar_territorio(
  p_comuna text,
  p_nombre text,
  p_color text,
  p_geom geometry
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_geom  geometry;
  v_base  geometry;
  v_nb    geometry;
  v_area0 double precision;
  v_pct   double precision;
  v_id    uuid;
begin
  if p_geom is null then
    raise exception 'La geometría dibujada está vacía';
  end if;

  if not public.is_admin() then
    raise exception 'Solo un administrador puede crear territorios';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.territorios'));

  v_geom := public.mayor_poligono(p_geom);
  if v_geom is null or st_isempty(v_geom) then
    raise exception 'La geometría dibujada no es un polígono válido';
  end if;
  v_area0 := st_area(v_geom::geography);

  v_base :=
    case
      when p_comuna is null then
        (select st_union(c.geom) from public.comunas_rm c)
      else
        (select c.geom from public.comunas_rm c where c.nombre = p_comuna)
    end;
  if p_comuna is not null and v_base is null then
    raise exception 'Comuna no encontrada: %', p_comuna;
  end if;
  if v_base is not null then
    v_geom := public.mayor_poligono(st_intersection(v_geom, v_base));
    if v_geom is null or st_isempty(v_geom) then
      raise exception 'El territorio queda completamente fuera de la comuna';
    end if;
  end if;

  select st_union(public.mayor_poligono(s.geom))
  into v_nb
  from public.territorios s;
  if v_nb is not null then
    v_geom := public.mayor_poligono(st_difference(v_geom, v_nb));
    if v_geom is null or st_isempty(v_geom) then
      raise exception 'El territorio queda completamente dentro de otro territorio';
    end if;
  end if;

  v_pct := st_area(v_geom::geography) / nullif(v_area0, 0);
  if v_pct is null or v_pct < 0.02 then
    raise exception 'Quedó menos del 2%% del área dibujada (se solapa casi por completo con otro territorio)';
  end if;

  v_geom := st_snaptogrid(v_geom, 1e-7);
  v_geom := public.mayor_poligono(v_geom);
  if v_geom is null or st_isempty(v_geom) then
    raise exception 'No se pudo preparar la geometría para guardar';
  end if;

  insert into public.territorios (comuna, nombre, color, geom, created_by)
  values (p_comuna, p_nombre, p_color, v_geom, auth.uid())
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'pct', round(v_pct * 100)::int,
    'recortado', v_pct < 0.995
  );
end;
$$;

-- ------------------------------------------------------------
-- 5. Sincronización punto → territorio
-- ------------------------------------------------------------
create or replace function public.puntos_sync_territorio()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select s.id into new.territorio_id
  from public.territorios s
  where st_covers(s.geom, new.geom::geometry)
  order by st_area(s.geom) desc
  limit 1;
  return new;
end;
$$;

drop trigger if exists puntos_sync_territorio on public.puntos;
create trigger puntos_sync_territorio
  before insert or update of geom on public.puntos
  for each row execute function public.puntos_sync_territorio();

create or replace function public.territorios_resync_puntos()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.puntos p
  set territorio_id = (
    select s.id from public.territorios s
    where st_covers(s.geom, p.geom::geometry)
    order by st_area(s.geom) desc
    limit 1
  )
  where p.deleted_at is null;
  return coalesce(new, old);
end;
$$;

drop trigger if exists territorios_resync_puntos on public.territorios;
create trigger territorios_resync_puntos
  after insert or delete on public.territorios
  for each row execute function public.territorios_resync_puntos();

-- ------------------------------------------------------------
-- 6. territorio_activo_usuario (antes sector_activo_usuario)
-- ------------------------------------------------------------
create or replace function public.territorio_activo_usuario(p_uid uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select a.territorio_id
  from public.territorios_asignaciones a
  where a.user_id = p_uid and a.estado = 'activa'
  limit 1;
$$;

revoke execute on function public.territorio_activo_usuario(uuid) from public, anon;
grant execute on function public.territorio_activo_usuario(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7. marcar_estado (body actualizado a territorio_id / territorio_activo_usuario)
-- ------------------------------------------------------------
create or replace function public.marcar_estado(
  p_id uuid,
  p_estado public.estado_punto
)
returns public.estado_punto
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev public.estado_punto;
  v_territorio uuid;
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select puntos.estado, puntos.territorio_id, puntos.user_id
  into v_prev, v_territorio, v_owner
  from public.puntos
  where puntos.id = p_id and puntos.deleted_at is null
  for update;

  if not found then
    raise exception 'Punto no encontrado';
  end if;

  if not public.is_admin()
     and v_owner is distinct from auth.uid()
     and v_territorio is distinct from public.territorio_activo_usuario(auth.uid()) then
    raise exception 'Punto fuera de tu territorio';
  end if;

  if v_prev = p_estado then
    return v_prev;
  end if;

  update public.puntos
  set estado = p_estado,
      updated_at = now()
  where id = p_id;

  return v_prev;
end;
$$;

revoke execute on function public.marcar_estado(uuid, public.estado_punto) from public, anon;
grant execute on function public.marcar_estado(uuid, public.estado_punto) to authenticated;

-- ------------------------------------------------------------
-- 8. devolver_territorio (antes devolver_sector)
-- ------------------------------------------------------------
create or replace function public.devolver_territorio()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territorio uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  update public.territorios_asignaciones
  set estado = 'devuelta',
      devuelta_at = now(),
      devuelta_por = auth.uid()
  where user_id = auth.uid() and estado = 'activa'
  returning territorio_id into v_territorio;

  if v_territorio is null then
    raise exception 'No tienes un territorio asignado';
  end if;
  return v_territorio;
end;
$$;

revoke execute on function public.devolver_territorio() from public, anon;
grant execute on function public.devolver_territorio() to authenticated;

-- ------------------------------------------------------------
-- 9. actualizar_punto_terreno (territorio_id / territorio_activo_usuario)
-- ------------------------------------------------------------
create or replace function public.actualizar_punto_terreno(
  p_id uuid,
  p_nombre text,
  p_direccion text,
  p_notas text,
  p_lat double precision,
  p_lng double precision
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_territorio uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select public.territorio_activo_usuario(auth.uid()) into v_territorio;
  if v_territorio is null then
    raise exception 'No tienes un territorio asignado';
  end if;

  if not exists (
    select 1 from public.territorios s
    where s.id = v_territorio
      and st_covers(s.geom, st_setsrid(st_makepoint(p_lng, p_lat), 4326))
  ) then
    raise exception 'Las coordenadas quedan fuera de tu territorio';
  end if;

  update public.puntos
  set nombre = p_nombre,
      direccion = p_direccion,
      notas = p_notas,
      geom = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
      updated_at = now()
  where id = p_id
    and deleted_at is null
    and territorio_id = v_territorio;

  if not found then
    raise exception 'Punto no disponible en tu territorio';
  end if;
  return p_id;
end;
$$;

revoke execute on function public.actualizar_punto_terreno(uuid, text, text, text, double precision, double precision) from public, anon;
grant execute on function public.actualizar_punto_terreno(uuid, text, text, text, double precision, double precision) to authenticated;

-- ------------------------------------------------------------
-- 10. Policies de territorios (nombres nuevos)
-- ------------------------------------------------------------
drop policy if exists "territorios_insert_admin" on public.territorios;
create policy "territorios_insert_admin" on public.territorios
  for insert to authenticated
  with check (public.is_admin() and auth.uid() = created_by);

drop policy if exists "territorios_update_admin" on public.territorios;
create policy "territorios_update_admin" on public.territorios
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "territorios_delete_admin" on public.territorios;
create policy "territorios_delete_admin" on public.territorios
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "territorios_select_colab" on public.territorios;
create policy "territorios_select_colab" on public.territorios
  for select to authenticated
  using (public.is_admin() or id = public.territorio_activo_usuario(auth.uid()));

-- ------------------------------------------------------------
-- 11. Policies de puntos (referencian territorio_activo_usuario)
-- ------------------------------------------------------------
drop policy if exists "puntos_select_colab" on public.puntos;
create policy "puntos_select_colab" on public.puntos
  for select to authenticated
  using (
    deleted_at is null
    and (
      public.is_admin()
      or user_id = auth.uid()
      or territorio_id = public.territorio_activo_usuario(auth.uid())
    )
  );

drop policy if exists "puntos_insert_colab" on public.puntos;
create policy "puntos_insert_colab" on public.puntos
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and (
      public.is_admin()
      or territorio_id = public.territorio_activo_usuario(auth.uid())
    )
  );

drop policy if exists "puntos_update_colab" on public.puntos;
create policy "puntos_update_colab" on public.puntos
  for update to authenticated
  using (
    public.is_admin()
    or territorio_id = public.territorio_activo_usuario(auth.uid())
  )
  with check (
    public.is_admin()
    or territorio_id = public.territorio_activo_usuario(auth.uid())
  );

-- ------------------------------------------------------------
-- 12. Grants (siguen a las tablas al renombrar; idempotentes por si acaso)
-- ------------------------------------------------------------
grant select, insert, update, delete on public.territorios to authenticated;
grant select on public.territorios to anon;
grant select, insert, update, delete on public.territorios_asignaciones to authenticated;
grant select, insert, update, delete on public.territorios_asignaciones to service_role;
grant select, insert, update on public.puntos to authenticated;
