-- Migración 002 — Rendimiento / sector_id (plan P1 · T6)
-- Idempotente: se puede re-ejecutar sin daño.
--   psql <connection> -f migrations/002_rendimiento_t6.sql
-- 11. SECTOR_ID + ÍNDICES (T6)
-- ============================================================
-- La pertenencia punto→sector se calculaba en el cliente con ray-casting en
-- cada render. Ahora la mantiene la DB: la lista, los contadores y los
-- avances pasan a ser una comparación de ids.
alter table public.puntos
  add column if not exists sector_id uuid references public.sectores(id) on delete set null;

create index if not exists puntos_estado_idx
  on public.puntos (estado) where deleted_at is null;
create index if not exists puntos_sector_idx
  on public.puntos (sector_id) where deleted_at is null;

-- Poblado inicial de los puntos existentes
update public.puntos p
set sector_id = s.id
from public.sectores s
where p.deleted_at is null
  and p.sector_id is null
  and st_covers(s.geom, p.geom::geometry);

-- Recalcula el sector al insertar o mover un punto
create or replace function public.puntos_sync_sector()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select s.id into new.sector_id
  from public.sectores s
  where st_covers(s.geom, new.geom::geometry)
  order by st_area(s.geom) desc
  limit 1;
  return new;
end;
$$;

drop trigger if exists puntos_sync_sector on public.puntos;
create trigger puntos_sync_sector
  before insert or update of geom on public.puntos
  for each row execute function public.puntos_sync_sector();

-- Al crear o borrar un sector hay que reasignar los puntos afectados.
-- OJO: este trigger solo toca sector_id (nunca geom), así que no vuelve a
-- disparar puntos_sync_sector y no hay bucle.
create or replace function public.sectores_resync_puntos()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.puntos p
  set sector_id = (
    select s.id from public.sectores s
    where st_covers(s.geom, p.geom::geometry)
    order by st_area(s.geom) desc
    limit 1
  )
  where p.deleted_at is null;
  return coalesce(new, old);
end;
$$;

drop trigger if exists sectores_resync_puntos on public.sectores;
create trigger sectores_resync_puntos
  after insert or delete on public.sectores
  for each row execute function public.sectores_resync_puntos();
