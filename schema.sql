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

-- Comunas: lectura para todos los autenticados
create policy "comunas_select_all" on public.comunas_rm
  for select to authenticated using (true);

-- Puntos: todos los autenticados ven todos los puntos activos
create policy "puntos_select_all" on public.puntos
  for select to authenticated
  using (deleted_at is null);

-- Cualquier autenticado puede crear
create policy "puntos_insert_auth" on public.puntos
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Solo admin puede actualizar (editar o borrado lógico)
create policy "puntos_update_admin" on public.puntos
  for update to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_admin = true
    )
  );

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
    extensions.st_y(p.geom::extensions.geometry) as lat,
    extensions.st_x(p.geom::extensions.geometry) as lng
  from public.puntos p
  where p.deleted_at is null
    and extensions.st_dwithin(
      p.geom,
      extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography,
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
      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography
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
        geom = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
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
-- 6. SECTORES (dibujados a mano en el mapa)
-- ============================================================
create table if not exists public.sectores (
  id uuid primary key default gen_random_uuid(),
  comuna text,
  nombre text not null default 'Sector',
  color text not null default '#3b82f6',
  geom geometry(Polygon, 4326) not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create index if not exists sectores_geom_idx on public.sectores using gist (geom);

alter table public.sectores enable row level security;

-- Permisos de tabla para los roles de PostgREST (sin esto da
-- "permission denied for table sectores" aunque las policies existan)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.sectores to authenticated;
grant select on public.sectores to anon;

-- Todos los autenticados ven los sectores
drop policy if exists "sectores_select_all" on public.sectores;
create policy "sectores_select_all" on public.sectores
  for select to authenticated
  using (true);

-- Cualquier autenticado crea los suyos
drop policy if exists "sectores_insert_auth" on public.sectores;
create policy "sectores_insert_auth" on public.sectores
  for insert to authenticated
  with check (auth.uid() = created_by);

-- Solo admin renombra / recolorea
drop policy if exists "sectores_update_admin" on public.sectores;
create policy "sectores_update_admin" on public.sectores
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Solo admin elimina
drop policy if exists "sectores_delete_admin" on public.sectores;
create policy "sectores_delete_admin" on public.sectores
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
-- 8. GUARDAR SECTOR CON RECORTE GARANTIZADO
-- ============================================================
-- Pieza poligonal de mayor área: makevalid / intersection / difference
-- pueden devolver colecciones o varios trozos (p.ej. un vecino parte el
-- sector en dos). Se usa dentro de guardar_sector.
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
--   2. nunca solapando sectores existentes (se resta la unión de vecinos)
--   3. misma rejilla de coordenadas (≈1 cm) en todos los sectores
-- Devuelve { id, pct, recortado }: pct = % del área dibujada que sobrevivió
-- al recorte; si es < 2% se rechaza (caso "lo dibujó casi sobre otro").
create or replace function public.guardar_sector(
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
      raise exception 'El sector queda completamente fuera de la comuna';
    end if;
  end if;

  -- 2) Contra los sectores existentes (cero solapes)
  select st_union(public.mayor_poligono(s.geom))
  into v_nb
  from public.sectores s;
  if v_nb is not null then
    v_geom := public.mayor_poligono(st_difference(v_geom, v_nb));
    if v_geom is null or st_isempty(v_geom) then
      raise exception 'El sector queda completamente dentro de otro sector';
    end if;
  end if;

  -- 3) Regla: como mínimo el 2% del área dibujada debe sobrevivir
  v_pct := st_area(v_geom::geography) / nullif(v_area0, 0);
  if v_pct is null or v_pct < 0.02 then
    raise exception 'Quedó menos del 2%% del área dibujada (se solapa casi por completo con otro sector)';
  end if;

  -- 4) Misma rejilla que el resto de los sectores e insert
  v_geom := st_snaptogrid(v_geom, 1e-7);
  v_geom := public.mayor_poligono(v_geom);
  if v_geom is null or st_isempty(v_geom) then
    raise exception 'No se pudo preparar la geometría para guardar';
  end if;

  insert into public.sectores (comuna, nombre, color, geom, created_by)
  values (p_comuna, p_nombre, p_color, v_geom, auth.uid())
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'pct', round(v_pct * 100)::int,
    'recortado', v_pct < 0.995
  );
end;
$$;