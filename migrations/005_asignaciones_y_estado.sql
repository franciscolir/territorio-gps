-- ============================================================
-- Migración 005 — Corrige ciclo de vida de asignaciones y estado
-- Idempotente: se puede aplicar sobre una base existente.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sectores_asignaciones: clave surrogate
--    La tabla original tenía `sector_id` como PRIMARY KEY: solo cabía UNA
--    fila por sector para siempre, así que tras devolver un sector era
--    imposible reasignarlo (INSERT fallaba con duplicate key). Se cambia
--    por un id surrogate; la regla "un activo por sector / por usuario"
--    vive en los índices únicos parciales de la sección 3.
-- ------------------------------------------------------------
alter table public.sectores_asignaciones
  drop constraint if exists sectores_asignaciones_pkey;

alter table public.sectores_asignaciones
  add column if not exists id uuid;

update public.sectores_asignaciones
set id = gen_random_uuid()
where id is null;

alter table public.sectores_asignaciones
  alter column id set default gen_random_uuid(),
  alter column id set not null;

alter table public.sectores_asignaciones
  add constraint sectores_asignaciones_pkey primary key (id);

-- ------------------------------------------------------------
-- 2. Ciclo de vida (por si la migración 003 no llegó a aplicarse completa)
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

-- ------------------------------------------------------------
-- 3. Un proceso activo por sector y por usuario
--    (si ya hay activos duplicados, se conserva el más reciente)
-- ------------------------------------------------------------
with d as (
  select id,
         row_number() over (
           partition by sector_id
           order by assigned_at desc nulls last, id desc
         ) as rn
  from public.sectores_asignaciones
  where estado = 'activa'
)
update public.sectores_asignaciones a
set estado = 'devuelta',
    devuelta_at = coalesce(a.devuelta_at, now())
from d
where a.id = d.id and d.rn > 1;

with d as (
  select id,
         row_number() over (
           partition by user_id
           order by assigned_at desc nulls last, id desc
         ) as rn
  from public.sectores_asignaciones
  where estado = 'activa'
)
update public.sectores_asignaciones a
set estado = 'devuelta',
    devuelta_at = coalesce(a.devuelta_at, now())
from d
where a.id = d.id and d.rn > 1;

create unique index if not exists sectores_asig_activa_sector
  on public.sectores_asignaciones (sector_id) where estado = 'activa';
create unique index if not exists sectores_asig_activa_user
  on public.sectores_asignaciones (user_id) where estado = 'activa';

-- ------------------------------------------------------------
-- 4. Trigger de puntos: el colaborador SÍ cambia estado
--    (marcar_estado y eliminar_punto_propio son RPCs security definer y
--    este trigger también les corría encima; protegía demasiado)
--    · user_id: nunca lo toca un no-admin (no "robar" puntos)
--    · deleted_at: solo sobre puntos propios
--    · estado: libre dentro de su sector (lo validan RLS y marcar_estado)
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
  if new.user_id is distinct from old.user_id then
    raise exception 'Sin permiso para modificar user_id';
  end if;
  if new.deleted_at is distinct from old.deleted_at
     and old.user_id is distinct from auth.uid() then
    raise exception 'Solo puedes eliminar puntos que tú creaste';
  end if;
  return new;
end;
$$;
