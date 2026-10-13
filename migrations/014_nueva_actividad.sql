-- ============================================================
-- Migración 014 — Nueva actividad: doble chequeo y tareas especiales
--
-- Ciclo nuevo de calidad de datos:
--   · Puntos creados por un colaborador quedan «sin aceptar» hasta que el
--     admin los acepta (los del admin se aceptan solos al crear).
--   · Estado 'erroneo'/'no_pasar' puesto por un colaborador queda «sin
--     verificar»: el admin lo confirma o lo rechaza (rechazo → 'pendiente').
--     Si lo pone el admin, queda verificado al instante.
--   · El admin puede asignar la verificación a un usuario X como tarea
--     especial (tabla tareas_verificacion); X confirma/rechaza desde la app
--     móvil y el admin recibe el aviso («confirmado por usuario») con botón
--     Leído.
--   · La aureola del mapa (lado admin) se dibuja para puntos sin aceptar o
--     con erroneo/no_pasar sin verificar; desaparece al resolver.
--
-- También habilita el «mapa general» del móvil sin asignación:
--   · SELECT de puntos: todo autenticado ve los puntos vivos (solo lectura).
--   · INSERT: cualquier autenticado puede crear puntos propios, tenga o no
--     territorio activo (el trigger de geometría le asigna territorio si
--     cae dentro de uno; si no, queda en el fondo común).
--
-- Idempotente: alter add if not exists + create or replace + drop policy.
--   psql <connection> -f migrations/014_nueva_actividad.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columnas nuevas en puntos
-- ------------------------------------------------------------
alter table public.puntos
  add column if not exists verificado text,
  add column if not exists verificado_por uuid references auth.users(id),
  add column if not exists verificado_at timestamptz,
  add column if not exists aceptado_at timestamptz,
  add column if not exists aceptado_por uuid references auth.users(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'puntos_verificado_chk') then
    alter table public.puntos add constraint puntos_verificado_chk
      check (verificado in ('confirmado', 'rechazado'));
  end if;
end $$;

-- Los puntos existentes quedan aceptados de fábrica (no entra al flujo nuevo)
update public.puntos
set aceptado_at = coalesce(created_at, now()),
    aceptado_por = user_id
where aceptado_at is null;

-- ------------------------------------------------------------
-- 2. Trigger de aceptación y verificación
--    (BEFORE: puede escribir sobre NEW; en UPDATE solo corre si cambia estado)
-- ------------------------------------------------------------
create or replace function public.puntos_marcar_verificacion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_admin() then
      new.aceptado_at := now();
      new.aceptado_por := auth.uid();
    end if;
    return new;
  end if;

  if new.estado is distinct from old.estado then
    if new.estado in ('erroneo', 'no_pasar') then
      if public.is_admin() then
        -- el admin lo pone directamente: doble chequeo ya resuelto
        new.verificado := 'confirmado';
        new.verificado_por := auth.uid();
        new.verificado_at := now();
      else
        -- el colaborador propone: queda a la espera del doble chequeo
        new.verificado := null;
        new.verificado_por := null;
        new.verificado_at := null;
      end if;
    else
      -- la verificación solo tiene sentido en erroneo/no_pasar
      new.verificado := null;
      new.verificado_por := null;
      new.verificado_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists puntos_verificacion_ins on public.puntos;
create trigger puntos_verificacion_ins
  before insert on public.puntos
  for each row execute function public.puntos_marcar_verificacion();

drop trigger if exists puntos_verificacion_upd on public.puntos;
create trigger puntos_verificacion_upd
  before update of estado on public.puntos
  for each row execute function public.puntos_marcar_verificacion();

-- ------------------------------------------------------------
-- 3. Tabla tareas_verificacion (tarea especial de doble chequeo)
-- ------------------------------------------------------------
create table if not exists public.tareas_verificacion (
  id uuid primary key default gen_random_uuid(),
  punto_id uuid not null references public.puntos(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  asignado_por uuid references auth.users(id),
  estado text not null default 'pendiente',
  created_at timestamptz not null default now(),
  confirmado_at timestamptz,
  leida_at timestamptz,
  constraint tareas_verificacion_estado_chk
    check (estado in ('pendiente', 'confirmada', 'rechazada'))
);

create index if not exists tareas_verificacion_punto_idx
  on public.tareas_verificacion (punto_id);
create index if not exists tareas_verificacion_user_idx
  on public.tareas_verificacion (user_id, estado);

-- una sola tarea abierta por punto
create unique index if not exists tareas_verificacion_activa
  on public.tareas_verificacion (punto_id) where estado = 'pendiente';

alter table public.tareas_verificacion enable row level security;

drop policy if exists "tareas_select" on public.tareas_verificacion;
create policy "tareas_select" on public.tareas_verificacion
  for select to authenticated
  using (public.is_admin() or user_id = auth.uid());

drop policy if exists "tareas_insert_admin" on public.tareas_verificacion;
create policy "tareas_insert_admin" on public.tareas_verificacion
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "tareas_update_admin" on public.tareas_verificacion;
create policy "tareas_update_admin" on public.tareas_verificacion
  for update to authenticated
  using (public.is_admin());

drop policy if exists "tareas_delete_admin" on public.tareas_verificacion;
create policy "tareas_delete_admin" on public.tareas_verificacion
  for delete to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.tareas_verificacion to authenticated;

-- ------------------------------------------------------------
-- 4. RPCs
-- ------------------------------------------------------------
-- Aceptar punto nuevo (admin; idempotente)
create or replace function public.aceptar_punto(p_punto uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden aceptar puntos';
  end if;
  update public.puntos
  set aceptado_at = now(),
      aceptado_por = auth.uid()
  where id = p_punto and deleted_at is null and aceptado_at is null;
end;
$$;

revoke execute on function public.aceptar_punto(uuid) from public, anon;
grant execute on function public.aceptar_punto(uuid) to authenticated;

-- Resolver verificación: admin directo o usuario X sobre su tarea abierta.
-- 'confirmado'  → el estado del usuario queda validado.
-- 'rechazado'   → el punto vuelve a 'pendiente' (el ciclo lo vuelve a pedir).
create or replace function public.resolver_verificacion(
  p_punto uuid,
  p_resultado text,
  p_tarea uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tarea public.tareas_verificacion;
begin
  if p_resultado not in ('confirmado', 'rechazado') then
    raise exception 'Resultado inválido';
  end if;

  if not public.is_admin() then
    if p_tarea is null then
      raise exception 'Solo administradores pueden verificar directamente';
    end if;
    select * into v_tarea
    from public.tareas_verificacion
    where id = p_tarea and user_id = v_uid and estado = 'pendiente';
    if not found then
      raise exception 'Tarea no encontrada o ya resuelta';
    end if;
  end if;

  if p_resultado = 'confirmado' then
    update public.puntos
    set verificado = 'confirmado',
        verificado_por = v_uid,
        verificado_at = now()
    where id = p_punto and deleted_at is null;
  else
    update public.puntos
    set estado = 'pendiente',
        verificado = null,
        verificado_por = null,
        verificado_at = null
    where id = p_punto and deleted_at is null;
  end if;

  if p_tarea is not null then
    update public.tareas_verificacion
    set estado = case when p_resultado = 'confirmado' then 'confirmada' else 'rechazada' end,
        confirmado_at = now()
    where id = p_tarea;
  end if;
end;
$$;

revoke execute on function public.resolver_verificacion(uuid, text, uuid) from public, anon;
grant execute on function public.resolver_verificacion(uuid, text, uuid) to authenticated;

-- Aviso leído (admin; deja de mostrar «confirmado por usuario»)
create or replace function public.tarea_leida(p_tarea uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo administradores';
  end if;
  update public.tareas_verificacion
  set leida_at = now()
  where id = p_tarea and leida_at is null;
end;
$$;

revoke execute on function public.tarea_leida(uuid) from public, anon;
grant execute on function public.tarea_leida(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. Mapa general: todos los autenticados ven los puntos vivos
-- ------------------------------------------------------------
drop policy if exists "puntos_select_colab" on public.puntos;
create policy "puntos_select_colab" on public.puntos
  for select to authenticated
  using (deleted_at is null);

-- ------------------------------------------------------------
-- 6. Crear puntos sin territorio activo (móvil sin asignación)
--    (el trigger puntos_sync_territorio asigna territorio por geometría;
--     la aceptación del admin pasa por la nueva actividad)
-- ------------------------------------------------------------
drop policy if exists "puntos_insert_colab" on public.puntos;
create policy "puntos_insert_colab" on public.puntos
  for insert to authenticated
  with check (auth.uid() = user_id);
