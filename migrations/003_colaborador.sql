-- ============================================================
-- Migración 003 — Colaborador: sector único + devolución
-- Idempotente: se puede aplicar sobre una base existente.
-- Equivale a §9.3 (ciclo de vida) y §12 de schema.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Ciclo de vida de la asignación: estado + auditoría de devolución
-- ------------------------------------------------------------
alter table public.sectores_asignaciones
  add column if not exists estado text not null default 'activa',
  add column if not exists devuelta_at timestamptz,
  add column if not exists devuelta_por uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sectores_asig_estado_chk'
  ) then
    alter table public.sectores_asignaciones
      add constraint sectores_asig_estado_chk
      check (estado in ('activa', 'devuelta'));
  end if;
end $$;

-- Un sector solo con UN usuario activo; un usuario solo con UN sector activo
create unique index if not exists sectores_asig_activa_sector
  on public.sectores_asignaciones (sector_id) where estado = 'activa';
create unique index if not exists sectores_asig_activa_user
  on public.sectores_asignaciones (user_id) where estado = 'activa';

-- Admin ve todas (activas y devueltas); el colaborador solo la suya
drop policy if exists "asig_select" on public.sectores_asignaciones;
drop policy if exists "asig_select_propia" on public.sectores_asignaciones;
create policy "asig_select_propia" on public.sectores_asignaciones
  for select to authenticated
  using (public.is_admin() or user_id = auth.uid());

-- ------------------------------------------------------------
-- 2. Helper de sector activo (security definer; la usan las policies)
-- ------------------------------------------------------------
create or replace function public.sector_activo_usuario(p_uid uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select a.sector_id
  from public.sectores_asignaciones a
  where a.user_id = p_uid and a.estado = 'activa'
  limit 1;
$$;

revoke execute on function public.sector_activo_usuario(uuid) from public, anon;
grant execute on function public.sector_activo_usuario(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. RLS de puntos: admin ve todo; colaborador su sector activo
--    + lo que él creó
-- ------------------------------------------------------------
drop policy if exists "puntos_select_all" on public.puntos;
drop policy if exists "puntos_select_colab" on public.puntos;
create policy "puntos_select_colab" on public.puntos
  for select to authenticated
  using (
    deleted_at is null
    and (
      public.is_admin()
      or user_id = auth.uid()
      or sector_id = public.sector_activo_usuario(auth.uid())
    )
  );

-- INSERT: solo dentro del sector activo (el trigger puntos_sync_sector
-- ya calculó sector_id antes de la comprobación)
drop policy if exists "puntos_insert_auth" on public.puntos;
drop policy if exists "puntos_insert_colab" on public.puntos;
create policy "puntos_insert_colab" on public.puntos
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and (
      public.is_admin()
      or sector_id = public.sector_activo_usuario(auth.uid())
    )
  );

-- UPDATE: colaborador sobre puntos de su sector activo (el trigger de la
-- sección 5 protege user_id / deleted_at / estado)
drop policy if exists "puntos_update_admin" on public.puntos;
drop policy if exists "puntos_update_colab" on public.puntos;
create policy "puntos_update_colab" on public.puntos
  for update to authenticated
  using (
    public.is_admin()
    or sector_id = public.sector_activo_usuario(auth.uid())
  )
  with check (
    public.is_admin()
    or sector_id = public.sector_activo_usuario(auth.uid())
  );

-- ------------------------------------------------------------
-- 4. RLS de sectores: admin ve todos; colaborador solo su sector activo
-- ------------------------------------------------------------
drop policy if exists "sectores_select_all" on public.sectores;
drop policy if exists "sectores_select_colab" on public.sectores;
create policy "sectores_select_colab" on public.sectores
  for select to authenticated
  using (public.is_admin() or id = public.sector_activo_usuario(auth.uid()));

-- ------------------------------------------------------------
-- 5. Trigger: el colaborador no toca user_id / deleted_at / estado
-- ------------------------------------------------------------
create or replace function public.puntos_bloquear_columnas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.deleted_at is distinct from old.deleted_at
     or new.estado is distinct from old.estado then
    raise exception 'Sin permiso para modificar user_id, deleted_at o estado';
  end if;
  return new;
end;
$$;

drop trigger if exists puntos_bloquear_columnas on public.puntos;
create trigger puntos_bloquear_columnas
  before update on public.puntos
  for each row execute function public.puntos_bloquear_columnas();

-- ------------------------------------------------------------
-- 6. RPC: devolver el sector asignado (aunque no cubra el 100%)
-- ------------------------------------------------------------
create or replace function public.devolver_sector()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sector uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  update public.sectores_asignaciones
  set estado = 'devuelta',
      devuelta_at = now(),
      devuelta_por = auth.uid()
  where user_id = auth.uid() and estado = 'activa'
  returning sector_id into v_sector;

  if v_sector is null then
    raise exception 'No tienes un sector asignado';
  end if;
  return v_sector;
end;
$$;

revoke execute on function public.devolver_sector() from public, anon;
grant execute on function public.devolver_sector() to authenticated;

-- ------------------------------------------------------------
-- 7. RPC: editar campos de terreno de un punto del sector activo
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
  v_sector uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select public.sector_activo_usuario(auth.uid()) into v_sector;
  if v_sector is null then
    raise exception 'No tienes un sector asignado';
  end if;

  if not exists (
    select 1 from public.sectores s
    where s.id = v_sector
      and st_covers(s.geom, st_setsrid(st_makepoint(p_lng, p_lat), 4326))
  ) then
    raise exception 'Las coordenadas quedan fuera de tu sector';
  end if;

  update public.puntos
  set nombre = p_nombre,
      direccion = p_direccion,
      notas = p_notas,
      geom = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
      updated_at = now()
  where id = p_id
    and deleted_at is null
    and sector_id = v_sector;

  if not found then
    raise exception 'Punto no disponible en tu sector';
  end if;
  return p_id;
end;
$$;

revoke execute on function public.actualizar_punto_terreno(uuid, text, text, text, double precision, double precision) from public, anon;
grant execute on function public.actualizar_punto_terreno(uuid, text, text, text, double precision, double precision) to authenticated;

-- ------------------------------------------------------------
-- 8. RPC: borrado lógico de puntos creados por el propio colaborador
-- ------------------------------------------------------------
create or replace function public.eliminar_punto_propio(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  update public.puntos
  set deleted_at = now()
  where id = p_id
    and user_id = auth.uid()
    and deleted_at is null;

  if not found then
    raise exception 'Solo puedes borrar puntos que tú creaste';
  end if;
end;
$$;

revoke execute on function public.eliminar_punto_propio(uuid) from public, anon;
grant execute on function public.eliminar_punto_propio(uuid) to authenticated;

-- ------------------------------------------------------------
-- 9. marcar_estado: además valida el sector activo del colaborador
--    (antes cualquier autenticado podía cambiar estados ajenos)
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
  v_sector uuid;
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select puntos.estado, puntos.sector_id, puntos.user_id
  into v_prev, v_sector, v_owner
  from public.puntos
  where puntos.id = p_id and puntos.deleted_at is null
  for update;

  if not found then
    raise exception 'Punto no encontrado';
  end if;

  if not public.is_admin()
     and v_owner is distinct from auth.uid()
     and v_sector is distinct from public.sector_activo_usuario(auth.uid()) then
    raise exception 'Punto fuera de tu sector';
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
