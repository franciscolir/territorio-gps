-- ============================================================
-- Migración 015 — RLS estricto: el móvil solo ve lo que admin le asigna
--
-- La migración 014 abrió el acceso para el "mapa general" sin asignación:
--   · SELECT: todo autenticado veía TODOS los puntos vivos
--   · INSERT: cualquier autenticado creaba puntos (fondo común)
-- Por norma de seguridad eso se revierte:
--   · SELECT: admin ve todo; un colaborador solo los puntos de su territorio
--     activo y los que él creó
--   · INSERT: admin, o colaborador CON territorio activo (el trigger
--     puntos_sync_territorio asigna el territorio por geometría)
--   · guardar_punto: mismo requisito explícito (error claro sin asignación)
-- Las tareas del admin (tareas_verificacion) mantienen su RLS propia:
-- solo el asignado y el admin pueden verlas.
-- Idempotente: drop policy if exists + create or replace.
--   psql <connection> -f migrations/015_rls_estricto.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. SELECT estricto
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

-- ------------------------------------------------------------
-- 2. INSERT estricto: sin territorio activo no se crean puntos
-- ------------------------------------------------------------
drop policy if exists "puntos_insert_colab" on public.puntos;
create policy "puntos_insert_colab" on public.puntos
  for insert to authenticated
  with check (
    public.is_admin()
    or (auth.uid() = user_id and public.territorio_activo_usuario(auth.uid()) is not null)
  );

-- ------------------------------------------------------------
-- 3. guardar_punto: requisito explícito con mensaje claro
-- ------------------------------------------------------------
create or replace function public.guardar_punto(
  p_id uuid,
  p_nombre text,
  p_direccion text,
  p_estado public.estado_punto,
  p_notas text,
  p_lat double precision,
  p_lng double precision
)
returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_admin boolean;
begin
  if p_id is null then
    -- INSERT: admin, o colaborador con territorio activo asignado por admin
    select public.is_admin() into v_admin;
    if not v_admin and public.territorio_activo_usuario(auth.uid()) is null then
      raise exception 'Sin territorio asignado: no puedes crear puntos';
    end if;
    insert into public.puntos (user_id, nombre, direccion, estado, notas, geom)
    values (
      auth.uid(), p_nombre, p_direccion, coalesce(p_estado, 'pendiente'), p_notas,
      st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
    )
    returning id into v_id;
  else
    -- UPDATE: solo admin
    select public.is_admin() into v_admin;
    if not v_admin then
      raise exception 'Solo un administrador puede editar puntos';
    end if;
    update public.puntos
    set nombre = p_nombre,
        direccion = p_direccion,
        estado = coalesce(p_estado, estado),
        notas = p_notas,
        geom = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
        updated_at = now()
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.guardar_punto(uuid, text, text, public.estado_punto, text, double precision, double precision) from public, anon;
grant execute on function public.guardar_punto(uuid, text, text, public.estado_punto, text, double precision, double precision) to authenticated;
