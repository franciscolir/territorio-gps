-- ============================================================
-- 1. POSTGIS
-- ============================================================
create extension if not exists postgis;

-- ============================================================
-- 2. TABLA DE PUNTOS
-- ============================================================
create table public.puntos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  nombre text not null,
  direccion text,
  categoria text,
  notas text,
  geom geography(Point, 4326) not null,
  deleted_at timestamptz,
  ultima_visita timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index puntos_geom_idx on public.puntos using gist (geom);
create index puntos_user_idx on public.puntos (user_id) where deleted_at is null;

-- ============================================================
-- 3. COMUNAS RM
-- ============================================================
create table public.comunas_rm (
  id serial primary key,
  codigo_comuna text,
  nombre text not null,
  geom geometry(MultiPolygon, 4326) not null
);

create index comunas_rm_geom_idx on public.comunas_rm using gist (geom);

-- ============================================================
-- 4. RLS (versión actualizada)
-- ============================================================
alter table public.puntos enable row level security;
alter table public.comunas_rm enable row level security;

-- Tabla de perfiles para saber quién es admin
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Cada usuario ve su propio perfil
create policy "profiles_select_self" on public.profiles
  for select to authenticated
  using (auth.uid() = id);

grant select on public.profiles to authenticated;

-- Comunas: lectura para todos los autenticados
create policy "comunas_select_all" on public.comunas_rm
  for select to authenticated using (true);

-- Proyectos nuevos de Supabase ya no otorgan privilegios por defecto a
-- anon/authenticated en el esquema public: sin este grant, PostgREST
-- responde "permission denied for table comunas_rm" y el selector de
-- comunas queda vacío.
grant select on public.comunas_rm to authenticated;

-- PUNTOS — permisos por rol (el detalle vive en §12, porque las policies
-- referencian la columna territorio_id y la tabla de asignaciones, que se
-- crean más abajo):
--   · admin: ve todo y edita todo
--   · colaborador: ve solo su TERRITORIO ACTIVO y los puntos que él creó;
--     crea/edita solo dentro de ese territorio (ver §12).
drop policy if exists "puntos_select_all" on public.puntos;
drop policy if exists "puntos_insert_auth" on public.puntos;
drop policy if exists "puntos_update_admin" on public.puntos;

-- Función helper para saber si soy admin (usada por el frontend)
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Trigger para crear profile automáticamente al crear usuario
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 5. RPCs
-- ============================================================
create or replace function public.puntos_en_radio(
  lat double precision,
  lng double precision,
  radio_m double precision
)
returns table (
  id uuid,
  nombre text,
  direccion text,
  categoria text,
  notas text,
  lat double precision,
  lng double precision
)
language sql
security invoker
set search_path = public, extensions
as $$
  select
    p.id, p.nombre, p.direccion, p.categoria, p.notas,
    st_y(p.geom::geometry) as lat,
    st_x(p.geom::geometry) as lng
  from public.puntos p
  where p.deleted_at is null
    and st_dwithin(
      p.geom,
      st_setsrid(st_makepoint(lng, lat), 4326)::geography,
      radio_m
    );
$$;

create or replace function public.guardar_punto(
  p_id uuid,
  p_nombre text,
  p_direccion text,
  p_categoria text,
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
    -- INSERT: cualquier autenticado
    insert into public.puntos (user_id, nombre, direccion, categoria, notas, geom)
    values (
      auth.uid(), p_nombre, p_direccion, p_categoria, p_notas,
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
        categoria = p_categoria,
        notas = p_notas,
        geom = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
        updated_at = now()
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.eliminar_punto(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede eliminar puntos';
  end if;
  update public.puntos
  set deleted_at = now()
  where id = p_id;
end;
$$;

-- ============================================================
-- 6. TERRITORIOS (dibujados a mano en el mapa)
-- ============================================================
create table if not exists public.territorios (
  id uuid primary key default gen_random_uuid(),
  comuna text,
  nombre text not null default 'Territorio',
  color text not null default '#3b82f6',
  geom geometry(Polygon, 4326) not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create index if not exists territorios_geom_idx on public.territorios using gist (geom);

alter table public.territorios enable row level security;

-- Permisos de tabla para los roles de PostgREST (sin esto da
-- "permission denied for table territorios" aunque las policies existan)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.territorios to authenticated;
grant select on public.territorios to anon;

-- TERRITORIOS: admin ve todos; el colaborador solo su territorio activo (§12).
drop policy if exists "territorios_select_all" on public.territorios;
drop policy if exists "territorios_insert_auth" on public.territorios;
drop policy if exists "territorios_insert_admin" on public.territorios;
create policy "territorios_insert_admin" on public.territorios
  for insert to authenticated
  with check (public.is_admin() and auth.uid() = created_by);

-- Solo admin renombra / recolorea
drop policy if exists "territorios_update_admin" on public.territorios;
create policy "territorios_update_admin" on public.territorios
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Solo admin elimina
drop policy if exists "territorios_delete_admin" on public.territorios;
create policy "territorios_delete_admin" on public.territorios
  for delete to authenticated
  using (public.is_admin());

-- ============================================================
-- 7. CONFIG APP (clave/valor compartida entre usuarios)
-- ============================================================
create table if not exists public.app_config (
  key text primary key,
  value jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now()
);

alter table public.app_config enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.app_config to authenticated;
grant select on public.app_config to anon;
-- service_role (scripts con SERVICE_ROLE_KEY) también necesita acceso,
-- si no PostgREST responde "permission denied for table app_config"
grant select, insert, update, delete on public.app_config to service_role;

-- Lectura para todos; escritura solo admin
drop policy if exists "app_config_select" on public.app_config;
create policy "app_config_select" on public.app_config
  for select to authenticated
  using (true);

drop policy if exists "app_config_insert_admin" on public.app_config;
create policy "app_config_insert_admin" on public.app_config
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "app_config_update_admin" on public.app_config;
create policy "app_config_update_admin" on public.app_config
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Semilla opcional: sin fila = todas las comunas activas
insert into public.app_config (key, value)
values ('comunas_activas', null)
on conflict (key) do nothing;

-- ============================================================
-- 8. GUARDAR TERRITORIO CON RECORTE GARANTIZADO
-- ============================================================
-- Pieza poligonal de mayor área: makevalid / intersection / difference
-- pueden devolver colecciones o varios trozos (p.ej. un vecino parte el
-- territorio en dos). Se usa dentro de guardar_territorio.
create or replace function public.mayor_poligono(g geometry)
returns geometry
language sql
immutable
set search_path = public, extensions
as $$
  select d.geom
  from (
    select (st_dump(st_makevalid(g))).geom as geom
  ) d
  where st_geometrytype(d.geom) = 'ST_Polygon'
  order by st_area(d.geom) desc
  limit 1;
$$;

-- Recorta el polígono nuevo antes de insertarlo:
--   1. nunca fuera de la comuna elegida (o de la RM si no hay comuna)
--   2. nunca solapando territorios existentes (se resta la unión de vecinos)
--   3. misma rejilla de coordenadas (≈1 cm) en todos los territorios
-- Devuelve { id, pct, recortado }: pct = % del área dibujada que sobrevivió
-- al recorte; si es < 2% se rechaza (caso "lo dibujó casi sobre otro").
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

  -- T2: solo administración crea territorios (defensa en profundidad: ya lo
  -- exige la policy de insert, aquí se avisa antes de recortar nada)
  if not public.is_admin() then
    raise exception 'Solo un administrador puede crear territorios';
  end if;

  -- Serializa los guardados: el chequeo de solape (st_union de vecinos)
  -- deja de ser correcto si dos usuarios guardan a la vez.
  perform pg_advisory_xact_lock(hashtext('public.territorios'));

  -- Polígono válido (si el trazo se autointersecta, nos quedamos con la
  -- pieza mayor) y su área de referencia
  v_geom := public.mayor_poligono(p_geom);
  if v_geom is null or st_isempty(v_geom) then
    raise exception 'La geometría dibujada no es un polígono válido';
  end if;
  v_area0 := st_area(v_geom::geography);

  -- 1) Contra la comuna
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

  -- 2) Contra los territorios existentes (cero solapes)
  select st_union(public.mayor_poligono(s.geom))
  into v_nb
  from public.territorios s;
  if v_nb is not null then
    v_geom := public.mayor_poligono(st_difference(v_geom, v_nb));
    if v_geom is null or st_isempty(v_geom) then
      raise exception 'El territorio queda completamente dentro de otro territorio';
    end if;
  end if;

  -- 3) Regla: como mínimo el 2% del área dibujada debe sobrevivir
  v_pct := st_area(v_geom::geography) / nullif(v_area0, 0);
  if v_pct is null or v_pct < 0.02 then
    raise exception 'Quedó menos del 2%% del área dibujada (se solapa casi por completo con otro territorio)';
  end if;

  -- 4) Misma rejilla que el resto de los territorios e insert
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

-- ============================================================
-- 9. ESTADO DE PUNTOS Y ASIGNACIÓN DE TERRITORIOS
-- ============================================================
-- Migración para bases que ya tenían la versión con "categoria".
-- Deja todos los puntos existentes en estado 'pendiente'.

-- 9.1 Tipo de estado (reemplaza a "categoria")
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'estado_punto' and n.nspname = 'public'
  ) then
    create type public.estado_punto as enum ('pendiente', 'visitado', 'erroneo', 'no_pasar');
  end if;
end $$;

alter table public.puntos
  add column if not exists estado public.estado_punto not null default 'pendiente';

alter table public.puntos drop column if exists categoria;

-- 9.2 RPCs que usaban categoria
drop function if exists public.puntos_en_radio(double precision, double precision, double precision);
create or replace function public.puntos_en_radio(
  lat double precision,
  lng double precision,
  radio_m double precision
)
returns table (
  id uuid,
  nombre text,
  direccion text,
  estado public.estado_punto,
  notas text,
  lat double precision,
  lng double precision
)
language sql
security invoker
set search_path = public, extensions
as $$
  select
    p.id, p.nombre, p.direccion, p.estado, p.notas,
    st_y(p.geom::geometry) as lat,
    st_x(p.geom::geometry) as lng
  from public.puntos p
  where p.deleted_at is null
    and st_dwithin(
      p.geom,
      st_setsrid(st_makepoint(lng, lat), 4326)::geography,
      radio_m
    );
$$;

drop function if exists public.guardar_punto(uuid, text, text, text, text, double precision, double precision);
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
    -- INSERT: cualquier autenticado
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

-- 9.3 Asignación de territorio a un usuario (uno por territorio).
--     Ciclo de vida (T-colaborador): estado 'activa' | 'devuelta'. Un
--     colaborador devuelve el territorio aunque no cubra el 100%; al devolverlo
--     desaparece de su app (RLS) y queda libre para reasignar. El historial
--     se conserva con devuelta_at / devuelta_por.
create table if not exists public.territorios_asignaciones (
  id uuid primary key default gen_random_uuid(),
  territorio_id uuid not null references public.territorios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id),
  assigned_at timestamptz default now(),
  estado text not null default 'activa',
  notas text,
  devuelta_at timestamptz,
  devuelta_por uuid references auth.users(id),
  completado_at timestamptz,
  completado_por uuid references auth.users(id),
  constraint territorios_asig_estado_chk check (estado in ('activa', 'devuelta', 'completado'))
);

-- Un territorio solo puede estar con UN usuario activo a la vez, y un usuario
-- solo puede tener UN territorio activo (índices parciales: no bloquean el
-- historial de devueltas).
create unique index if not exists territorios_asig_activa_territorio
  on public.territorios_asignaciones (territorio_id) where estado = 'activa';
create unique index if not exists territorios_asig_activa_user
  on public.territorios_asignaciones (user_id) where estado = 'activa';

alter table public.territorios_asignaciones enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.territorios_asignaciones to authenticated;
grant select, insert, update, delete on public.territorios_asignaciones to service_role;

-- Admin ve todas (activas y devueltas); el colaborador solo la suya.
drop policy if exists "asig_select" on public.territorios_asignaciones;
create policy "asig_select_propia" on public.territorios_asignaciones
  for select to authenticated
  using (public.is_admin() or user_id = auth.uid());

drop policy if exists "asig_insert_admin" on public.territorios_asignaciones;
create policy "asig_insert_admin" on public.territorios_asignaciones
  for insert to authenticated with check (public.is_admin());

drop policy if exists "asig_update_admin" on public.territorios_asignaciones;
create policy "asig_update_admin" on public.territorios_asignaciones
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "asig_delete_admin" on public.territorios_asignaciones;
create policy "asig_delete_admin" on public.territorios_asignaciones
  for delete to authenticated using (public.is_admin());

-- 9.4 Listar usuarios para asignar (los perfiles solo son visibles por su dueño;
--     security definer permite listarlos para el panel de asignación).
--     T3: SOLO el admin recibe la lista; los demás reciben filas vacías,
--     así ningún usuario autenticado puede enumerar los correos del equipo.
create or replace function public.usuarios_asignables()
returns table (id uuid, email text)
language sql
security definer
set search_path = public
as $$
  select p.id, coalesce(p.email, '')::text as email
  from public.profiles p
  where public.is_admin()
  order by p.email;
$$;

revoke execute on function public.usuarios_asignables() from public, anon;
grant execute on function public.usuarios_asignables() to authenticated;
-- ============================================================
-- 10. MARCAR ESTADO DESDE TERRENO (T1)
-- ============================================================
-- La policy de UPDATE de puntos es solo-admin, así que el estado no se
-- podía cambiar desde el rol de campo. Esta RPC (security definer) permite
-- a cualquier autenticado cambiar ÚNICAMENTE estado/updated_at, y devuelve
-- el estado anterior para poder "Deshacer" en el cliente.
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

  -- T-colaborador: solo su territorio activo (o puntos que él mismo creó).
  -- Antes cualquier autenticado podía cambiar el estado de cualquier punto.
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
      -- "última visita" = último cambio a un estado no pendiente
      ultima_visita = case when p_estado = 'pendiente' then ultima_visita else now() end,
      updated_at = now()
  where id = p_id;

  return v_prev;
end;
$$;

revoke execute on function public.marcar_estado(uuid, public.estado_punto) from public, anon;
grant execute on function public.marcar_estado(uuid, public.estado_punto) to authenticated;

-- ============================================================
-- 11. TERRITORIO_ID + ÍNDICES (T6)
-- ============================================================
-- La pertenencia punto→territorio se calculaba en el cliente con ray-casting en
-- cada render. Ahora la mantiene la DB: la lista, los contadores y los
-- avances pasan a ser una comparación de ids.
alter table public.puntos
  add column if not exists territorio_id uuid references public.territorios(id) on delete set null;

create index if not exists puntos_estado_idx
  on public.puntos (estado) where deleted_at is null;
create index if not exists puntos_territorio_idx
  on public.puntos (territorio_id) where deleted_at is null;

-- Poblado inicial de los puntos existentes
update public.puntos p
set territorio_id = s.id
from public.territorios s
where p.deleted_at is null
  and p.territorio_id is null
  and st_covers(s.geom, p.geom::geometry);

-- Recalcula el territorio al insertar o mover un punto
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

-- Al crear o borrar un territorio hay que reasignar los puntos afectados.
-- OJO: este trigger solo toca territorio_id (nunca geom), así que no vuelve a
-- disparar puntos_sync_territorio y no hay bucle.
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

-- ============================================================
-- 12. COLABORADOR: TERRITORIO ÚNICO + DEVOLUCIÓN (T-colaborador)
-- ============================================================
-- Modelo: el admin asigna un territorio a un colaborador (§9.3); el
-- colaborador ve SOLO ese territorio y sus puntos, puede crear/editar puntos
-- dentro de él y devolverlo aunque no cubra el 100%. Al devolverlo deja
-- de verlo y el territorio queda libre para reasignar.

-- Helper security definer: las policies de §4/§6 llaman a esta función y
-- no pueden consultar territorios_asignaciones con su propio RLS (círculo
-- vicioso); ejecutando como owner se resuelve, igual que is_admin().
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

-- Policies de puntos (territorio_id y asignaciones ya existen aquí):
--   SELECT: admin ve todo; colaborador su territorio activo + lo que él creó
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

--   INSERT: el colaborador solo dentro de su territorio activo (el trigger
--   puntos_sync_territorio ya seteó territorio_id antes de la comprobación)
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

--   UPDATE: colaborador sobre puntos de su territorio activo; el trigger
--   puntos_bloquear_columnas impide tocar user_id (y deleted_at ajeno),
--   pero deja pasar cambios de estado dentro del territorio
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

-- Grants de puntos: el front hoy solo lee la tabla (las escrituras van por
-- RPCs), pero insert/update quedan por si se usan writes directos.
grant select, insert, update on public.puntos to authenticated;

-- Policy de territorios: admin ve todos; colaborador solo su territorio activo
drop policy if exists "territorios_select_colab" on public.territorios;
create policy "territorios_select_colab" on public.territorios
  for select to authenticated
  using (public.is_admin() or id = public.territorio_activo_usuario(auth.uid()));

-- Trigger: un no-admin no puede tocar user_id / deleted_at / estado con un
-- UPDATE normal (el estado pasa solo por marcar_estado; el borrado lógico
-- por eliminar_punto / eliminar_punto_propio, ambas security definer).
create or replace function public.puntos_bloquear_columnas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  -- user_id: un no-admin nunca lo toca (no "robar" puntos)
  if new.user_id is distinct from old.user_id then
    raise exception 'Sin permiso para modificar user_id';
  end if;
  -- deleted_at: solo sobre puntos propios (las RPCs security definer
  -- validan lo mismo; esto cubre también actualizaciones directas)
  if new.deleted_at is distinct from old.deleted_at
     and old.user_id is distinct from auth.uid() then
    raise exception 'Solo puedes eliminar puntos que tú creaste';
  end if;
  -- estado: el colaborador SÍ puede cambiarlo dentro de su territorio
  -- (lo validan RLS y la RPC marcar_estado)
  return new;
end;
$$;

drop trigger if exists puntos_bloquear_columnas on public.puntos;
create trigger puntos_bloquear_columnas
  before update on public.puntos
  for each row execute function public.puntos_bloquear_columnas();

-- Devolver el territorio asignado (el colaborador, aunque no cubra el 100%).
-- Devuelve el territorio_id para que el front refresque al instante.
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

-- Editar campos de terreno de un punto del territorio activo (nombre,
-- dirección, notas y coordenadas). Las coordenadas nuevas deben seguir
-- dentro del polígono; estado y borrado tienen sus propias RPCs.
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

-- Borrado lógico: el colaborador solo de los puntos que ÉL creó.
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

-- ============================================================
-- 13. CIERRE DE TERRITORIOS E HISTORIAL (T-historial)
-- ============================================================
-- El proceso de un territorio se cierra cuando ya no quedan puntos
-- pendientes (automático) o cuando el admin lo decide (manual).

-- 13.1 Autocompletar: al cambiar el estado de un punto, si al territorio no
--      le quedan 'pendiente', su asignación activa pasa a 'completado'.
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

-- 13.2 Cierre manual (solo admin): marca la asignación activa como completada
--      y guarda las notas del proceso.
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

-- 13.3 Listar usuarios con su estado (solo admin): perfil + territorio activo.
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
