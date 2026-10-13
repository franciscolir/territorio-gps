-- ============================================================
-- Migración 008 — Historial de territorios/puntos y usuarios
-- Idempotente. Requiere haber aplicado la 007 (rename a territorios).
--   psql <connection> -f migrations/008_historial_usuarios.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columnas nuevas
-- ------------------------------------------------------------
alter table public.puntos
  add column if not exists ultima_visita timestamptz;

alter table public.territorios_asignaciones
  add column if not exists notas text,
  add column if not exists completado_at timestamptz,
  add column if not exists completado_por uuid references auth.users(id);

-- El estado ahora admite 'completado'
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'territorios_asig_estado_chk') then
    alter table public.territorios_asignaciones drop constraint territorios_asig_estado_chk;
  end if;
  if exists (select 1 from pg_constraint where conname = 'sectores_asig_estado_chk') then
    alter table public.territorios_asignaciones drop constraint sectores_asig_estado_chk;
  end if;
  alter table public.territorios_asignaciones
    add constraint territorios_asig_estado_chk
    check (estado in ('activa', 'devuelta', 'completado'));
end $$;

-- ------------------------------------------------------------
-- 2. marcar_estado: además registra la última visita
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
      ultima_visita = case when p_estado = 'pendiente' then ultima_visita else now() end,
      updated_at = now()
  where id = p_id;

  return v_prev;
end;
$$;

revoke execute on function public.marcar_estado(uuid, public.estado_punto) from public, anon;
grant execute on function public.marcar_estado(uuid, public.estado_punto) to authenticated;

-- ------------------------------------------------------------
-- 3. Cierre automático al no quedar pendientes
-- ------------------------------------------------------------
create or replace function public.territorios_autocompletar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territorio uuid;
begin
  v_territorio := coalesce(new.territorio_id, old.territorio_id);
  if v_territorio is null then
    return new;
  end if;

  if not exists (
    select 1 from public.puntos p
    where p.territorio_id = v_territorio
      and p.deleted_at is null
      and p.estado = 'pendiente'
  ) then
    update public.territorios_asignaciones
    set estado = 'completado',
        completado_at = coalesce(completado_at, now())
    where territorio_id = v_territorio
      and estado = 'activa';
  end if;

  return new;
end;
$$;

drop trigger if exists territorios_autocompletar on public.puntos;
create trigger territorios_autocompletar
  after update of estado on public.puntos
  for each row execute function public.territorios_autocompletar();

-- ------------------------------------------------------------
-- 4. Cierre manual (solo admin)
-- ------------------------------------------------------------
create or replace function public.completar_territorio(
  p_territorio uuid,
  p_notas text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede completar territorios';
  end if;

  update public.territorios_asignaciones
  set estado = 'completado',
      completado_at = coalesce(completado_at, now()),
      completado_por = auth.uid(),
      notas = coalesce(p_notas, notas)
  where territorio_id = p_territorio
    and estado = 'activa';

  if not found then
    raise exception 'El territorio no tiene un proceso en curso';
  end if;
  return p_territorio;
end;
$$;

revoke execute on function public.completar_territorio(uuid, text) from public, anon;
grant execute on function public.completar_territorio(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 5. Listar usuarios con su estado (solo admin)
-- ------------------------------------------------------------
create or replace function public.listar_usuarios()
returns table (
  id uuid,
  email text,
  is_admin boolean,
  territorio_id uuid,
  territorio text,
  desde timestamptz
)
language sql
security definer
set search_path = public
as $$
  select p.id,
         coalesce(p.email, '')::text as email,
         coalesce(p.is_admin, false) as is_admin,
         a.territorio_id,
         t.nombre as territorio,
         a.assigned_at as desde
  from public.profiles p
  left join public.territorios_asignaciones a
    on a.user_id = p.id and a.estado = 'activa'
  left join public.territorios t
    on t.id = a.territorio_id
  where public.is_admin()
  order by p.email;
$$;

revoke execute on function public.listar_usuarios() from public, anon;
grant execute on function public.listar_usuarios() to authenticated;

-- ------------------------------------------------------------
-- 6. Índice de apoyo para el historial
-- ------------------------------------------------------------
create index if not exists territorios_asig_hist_idx
  on public.territorios_asignaciones (territorio_id, assigned_at desc);
