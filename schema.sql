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