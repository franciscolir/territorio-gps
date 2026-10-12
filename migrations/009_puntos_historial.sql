-- ============================================================
-- Migración 009 — Bitácora de movimientos por punto
-- Idempotente. Requiere haber aplicado la 007 (rename a territorios).
--   psql <connection> -f migrations/009_puntos_historial.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla de log (una fila por movimiento)
-- ------------------------------------------------------------
create table if not exists public.puntos_historial (
  id uuid primary key default gen_random_uuid(),
  punto_id uuid not null references public.puntos(id) on delete cascade,
  tipo text not null,
  estado_anterior text,
  estado_nuevo text,
  territorio_anterior uuid,
  territorio_nuevo uuid,
  user_id uuid references auth.users(id),
  at timestamptz not null default now(),
  constraint puntos_historial_tipo_chk check (
    tipo in ('creado', 'estado', 'territorio', 'borrado', 'restaurado', 'nota')
  )
);

create index if not exists puntos_hist_punto_idx
  on public.puntos_historial (punto_id, at desc);

-- RLS habilitado SIN policies de cliente: el único camino de lectura es la
-- RPC punto_historial() (security definer); la escritura la hace el trigger
-- también security definer. Así ningún cliente puede tocar la bitácora.
alter table public.puntos_historial enable row level security;

-- ------------------------------------------------------------
-- 2. Trigger: registra cada movimiento del punto
-- ------------------------------------------------------------
create or replace function public.puntos_historial_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.puntos_historial
      (punto_id, tipo, estado_nuevo, territorio_nuevo, user_id)
    values
      (new.id, 'creado', new.estado::text, new.territorio_id, auth.uid());
    return new;
  end if;

  if new.estado is distinct from old.estado then
    insert into public.puntos_historial
      (punto_id, tipo, estado_anterior, estado_nuevo, user_id)
    values
      (new.id, 'estado', old.estado::text, new.estado::text, auth.uid());
  end if;

  if new.territorio_id is distinct from old.territorio_id then
    insert into public.puntos_historial
      (punto_id, tipo, territorio_anterior, territorio_nuevo, user_id)
    values
      (new.id, 'territorio', old.territorio_id, new.territorio_id, auth.uid());
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    insert into public.puntos_historial
      (punto_id, tipo, user_id)
    values
      (new.id, case when new.deleted_at is not null then 'borrado' else 'restaurado' end,
       auth.uid());
  end if;

  if new.notas is distinct from old.notas then
    insert into public.puntos_historial
      (punto_id, tipo, user_id)
    values
      (new.id, 'nota', auth.uid());
  end if;

  return new;
end;
$$;

drop trigger if exists puntos_historial_ins on public.puntos;
create trigger puntos_historial_ins
  after insert on public.puntos
  for each row execute function public.puntos_historial_log();

drop trigger if exists puntos_historial_upd on public.puntos;
create trigger puntos_historial_upd
  after update on public.puntos
  for each row execute function public.puntos_historial_log();

-- ------------------------------------------------------------
-- 3. RPC: log de un punto (movimientos + asignaciones de su territorio)
-- ------------------------------------------------------------
create or replace function public.punto_historial(p_punto uuid)
returns table (
  ev_at timestamptz,
  ev_tipo text,
  ev_actor text,
  ev_detalle text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territorio uuid;
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select puntos.territorio_id, puntos.user_id
  into v_territorio, v_owner
  from public.puntos
  where puntos.id = p_punto and puntos.deleted_at is null;

  if not found then
    raise exception 'Punto no encontrado';
  end if;

  if not public.is_admin()
     and v_owner is distinct from auth.uid()
     and v_territorio is distinct from public.territorio_activo_usuario(auth.uid()) then
    raise exception 'Sin permiso para ver este punto';
  end if;

  return query
    select h.at,
           h.tipo,
           coalesce(p.email, 'Sistema'),
           case h.tipo
             when 'creado' then 'Punto creado'
             when 'estado' then 'Estado: ' || coalesce(h.estado_anterior, '—') ||
                                ' → ' || coalesce(h.estado_nuevo, '—')
             when 'territorio' then 'Territorio: ' || coalesce(tn.nombre, '(ninguno)')
             when 'borrado' then 'Marcado como eliminado'
             when 'restaurado' then 'Restaurado'
             when 'nota' then 'Notas actualizadas'
             else h.tipo
           end
    from public.puntos_historial h
    left join public.profiles p on p.id = h.user_id
    left join public.territorios tn on tn.id = h.territorio_nuevo
    where h.punto_id = p_punto

    union all

    select a.assigned_at,
           'asignado',
           coalesce(p.email, '—'),
           'Asignado a ' || coalesce(p.email, '—')
    from public.territorios_asignaciones a
    left join public.profiles p on p.id = a.user_id
    where a.territorio_id = v_territorio and a.assigned_at is not null

    union all

    select a.devuelta_at,
           'devuelto',
           coalesce(p.email, '—'),
           'Territorio devuelto'
    from public.territorios_asignaciones a
    left join public.profiles p on p.id = a.devuelta_por
    where a.territorio_id = v_territorio and a.devuelta_at is not null

    union all

    select a.completado_at,
           'completado',
           coalesce(p.email, '—'),
           'Territorio completado'
    from public.territorios_asignaciones a
    left join public.profiles p on p.id = a.completado_por
    where a.territorio_id = v_territorio and a.completado_at is not null

    order by 1 desc nulls last;
end;
$$;

revoke execute on function public.punto_historial(uuid) from public, anon;
grant execute on function public.punto_historial(uuid) to authenticated;
