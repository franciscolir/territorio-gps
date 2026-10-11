-- Migración 001 — Seguridad / roles (plan P0 · T1-T3)
-- Para bases que ya están en producción con el schema.sql anterior.
-- Idempotente: se puede re-ejecutar sin daño.
--   psql <connection> -f migrations/001_seguridad_p0.sql
--   (o SQL editor de Supabase)
-- Solo admin crea sectores (antes podía crearlos cualquier autenticado:
-- tanto la policy como guardar_sector lo exigen ahora)
drop policy if exists "sectores_insert_auth" on public.sectores;
drop policy if exists "sectores_insert_admin" on public.sectores;
create policy "sectores_insert_admin" on public.sectores
  for insert to authenticated
  with check (public.is_admin() and auth.uid() = created_by);

-- ============================================================
-- 8 (actualizada): guardar_sector exige admin y serializa el guardado

-- ============================================================
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

  -- T2: solo administración crea sectores (defensa en profundidad: ya lo
  -- exige la policy de insert, aquí se avisa antes de recortar nada)
  if not public.is_admin() then
    raise exception 'Solo un administrador puede crear sectores';
  end if;

  -- Serializa los guardados: el chequeo de solape (st_union de vecinos)
  -- deja de ser correcto si dos usuarios guardan a la vez.
  perform pg_advisory_xact_lock(hashtext('public.sectores'));

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

-- ============================================================
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
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select puntos.estado into v_prev
  from public.puntos
  where puntos.id = p_id and puntos.deleted_at is null
  for update;

  if not found then
    raise exception 'Punto no encontrado';
  end if;

  if v_prev = p_estado then
    return v_prev;
  end if;

  update public.puntos
  set estado = p_estado,
      updated_at = now()
  where id = p_id;

  return v_prev;
end;
$$;

revoke execute on function public.marcar_estado(uuid, public.estado_punto) from public, anon;
grant execute on function public.marcar_estado(uuid, public.estado_punto) to authenticated;
