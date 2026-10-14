-- ============================================================
-- Migración 017 — Solicitudes de puntos nuevos (móvil → admin)
--
-- Desde el móvil ya NO se escriben puntos directamente en public.puntos:
-- se envía una SOLICITUD que el admin confirma o rechaza desde
-- "Nueva actividad". El punto real se inserta solo al confirmarla, con
-- autoría del solicitante (el trigger de la 014 lo deja aceptado porque
-- quien confirma es el admin).
--
-- Nota de diseño: al confirmar/rechazar la fila NO se borra, pasa a estado
-- 'aceptada'/'rechazada' (auditoría: quién pidió qué y quién decidió). La
-- cola de trabajo del admin son las filas con estado 'pendiente'.
-- Idempotente: create table if not exists + drop/create policy.
--   psql <connection> -f migrations/017_solicitudes_puntos.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla
-- ------------------------------------------------------------
create table if not exists public.puntos_solicitudes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  nombre text not null,
  direccion text,
  notas text,
  lat double precision not null,
  lng double precision not null,
  estado text not null default 'pendiente'
    constraint puntos_sol_estado_chk
    check (estado in ('pendiente', 'aceptada', 'rechazada')),
  notas_admin text,
  punto_id uuid references public.puntos(id),
  created_at timestamptz not null default now(),
  resuelta_at timestamptz,
  resuelta_por uuid references auth.users(id)
);

create index if not exists puntos_sol_pend_idx
  on public.puntos_solicitudes (created_at) where estado = 'pendiente';
create index if not exists puntos_sol_user_idx
  on public.puntos_solicitudes (user_id, estado);

alter table public.puntos_solicitudes enable row level security;

-- Sin default privileges en este proyecto: grants explícitos. El RPC
-- crear_solicitud_punto es security invoker → necesita estos grants.
-- El ciclo (confirmar/rechazar) es security definer (owner) → no requiere.
grant select, insert on public.puntos_solicitudes to authenticated;

-- El creador ve sus solicitudes; el admin las ve todas
drop policy if exists "puntos_sol_select" on public.puntos_solicitudes;
create policy "puntos_sol_select" on public.puntos_solicitudes
  for select to authenticated
  using (public.is_admin() or user_id = auth.uid());

-- Enviar una solicitud es permitido para cualquier autenticado (no es
-- contenido: es una petición que el admin debe confirmar)
drop policy if exists "puntos_sol_insert" on public.puntos_solicitudes;
create policy "puntos_sol_insert" on public.puntos_solicitudes
  for insert to authenticated
  with check (auth.uid() = user_id);

-- El ciclo (confirmar/rechazar) lo resuelven las RPCs security definer;
-- nadie actualiza las filas por la vía directa
drop policy if exists "puntos_sol_update" on public.puntos_solicitudes;
create policy "puntos_sol_update" on public.puntos_solicitudes
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- 2. RPC: crear solicitud (móvil, cualquier colaborador)
-- ------------------------------------------------------------
create or replace function public.crear_solicitud_punto(
  p_nombre text,
  p_direccion text,
  p_notas text,
  p_lat double precision,
  p_lng double precision
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;
  if p_nombre is null or length(trim(p_nombre)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;
  if p_lat is null or p_lng is null then
    raise exception 'Coordenadas requeridas';
  end if;
  insert into public.puntos_solicitudes (user_id, nombre, direccion, notas, lat, lng)
  values (auth.uid(), trim(p_nombre), p_direccion, p_notas, p_lat, p_lng)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.crear_solicitud_punto(text, text, text, double precision, double precision) from public, anon;
grant execute on function public.crear_solicitud_punto(text, text, text, double precision, double precision) to authenticated;

-- ------------------------------------------------------------
-- 3. RPC: confirmar (admin) → crea el punto real y marca la solicitud
-- ------------------------------------------------------------
create or replace function public.confirmar_solicitud(p_solicitud uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sol public.puntos_solicitudes%rowtype;
  v_punto uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede confirmar solicitudes';
  end if;
  select * into v_sol
  from public.puntos_solicitudes
  where id = p_solicitud and estado = 'pendiente'
  for update;
  if not found then
    raise exception 'Solicitud no encontrada o ya resuelta';
  end if;

  insert into public.puntos (user_id, nombre, direccion, estado, notas, geom)
  values (
    v_sol.user_id, v_sol.nombre, v_sol.direccion, 'pendiente', v_sol.notas,
    st_setsrid(st_makepoint(v_sol.lng, v_sol.lat), 4326)::geography
  )
  returning id into v_punto;

  update public.puntos_solicitudes
  set estado = 'aceptada', punto_id = v_punto, resuelta_at = now(), resuelta_por = auth.uid()
  where id = p_solicitud;

  return v_punto;
end;
$$;

revoke execute on function public.confirmar_solicitud(uuid) from public, anon;
grant execute on function public.confirmar_solicitud(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. RPC: rechazar (admin)
-- ------------------------------------------------------------
create or replace function public.rechazar_solicitud(p_solicitud uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede rechazar solicitudes';
  end if;
  update public.puntos_solicitudes
  set estado = 'rechazada',
      notas_admin = nullif(trim(coalesce(p_motivo, '')), ''),
      resuelta_at = now(),
      resuelta_por = auth.uid()
  where id = p_solicitud and estado = 'pendiente';
  if not found then
    raise exception 'Solicitud no encontrada o ya resuelta';
  end if;
end;
$$;

revoke execute on function public.rechazar_solicitud(uuid, text) from public, anon;
grant execute on function public.rechazar_solicitud(uuid, text) to authenticated;
