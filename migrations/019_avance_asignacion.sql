-- ============================================================
-- Migración 019 — Avance por asignación (base = pendientes al abrir)
--
-- Regla de negocio:
--   * El avance de un proceso se calcula SOBRE los puntos 'pendiente'
--     al momento de asignar (snapshot en territorio.puntos_base).
--     Avance = (base − pendientes actuales) / base × 100.
--     'Visitado', 'No pasar' y 'Erróneo' cuentan como gestionados.
--   * 'Erróneo' y 'No pasar' se conservan entre asignaciones (los
--     reinicia solo 'visitado' → 'pendiente', como ya hacía 010).
--   * Un territorio SIN puntos pendientes no puede asignarse: el
--     INSERT de la asignación falla con un error claro (antes 011
--     lo abría y lo cerraba solo en el mismo instante).
--
-- Idempotente: add column if not exists + create or replace + update.
--   psql <connection> -f migrations/019_avance_asignacion.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

alter table public.territorios_asignaciones
  add column if not exists puntos_base integer;

-- Reemplaza la versión de 011: tras el reinicio de visitados, exige
-- al menos un punto 'pendiente' y guarda el snapshot en puntos_base.
create or replace function public.territorio_reiniciar_visitados()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pend integer;
begin
  -- Solo al iniciar un proceso de trabajo activo
  if new.estado <> 'activa' then
    return new;
  end if;

  -- 1) Las visitas del proceso anterior no cuentan en este: vuelven a
  --    pendiente. 'erroneo' y 'no_pasar' se heredan tal cual.
  update public.puntos
  set estado = 'pendiente',
      updated_at = now()
  where territorio_id = new.territorio_id
    and deleted_at is null
    and estado = 'visitado';

  -- 2) Base del avance: pendientes tras el reinicio (regla de negocio)
  select count(*) into v_pend
  from public.puntos p
  where p.territorio_id = new.territorio_id
    and p.deleted_at is null
    and p.estado = 'pendiente';

  -- 3) Sin trabajo pendiente no hay proceso que abrir
  if v_pend = 0 then
    raise exception 'Este territorio no tiene puntos pendientes de gestión: no puede asignarse';
  end if;

  update public.territorios_asignaciones
  set puntos_base = v_pend
  where id = new.id;

  return new;
end;
$$;

-- Backfill: procesos activos creados antes de esta migración
update public.territorios_asignaciones a
set puntos_base = (
  select count(*)
  from public.puntos p
  where p.territorio_id = a.territorio_id
    and p.deleted_at is null
    and p.estado = 'pendiente'
)
where a.estado = 'activa'
  and a.puntos_base is null;
