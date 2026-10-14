-- ============================================================
-- Migración 018 — Mensajes: log único de actividad del admin
--
-- Toda la actividad queda registrada en public.mensajes por TRIGGERS
-- (asignar/devolver/completar territorios, solicitudes, verificaciones,
-- aceptación y puntos nuevos). La vista "Nueva actividad" del escritorio
-- lo muestra como feed con leído/no leído (badge en el nav), borrar por
-- fila y "Vaciar actividad". Solo el admin la ve; el log es auditable y
-- el admin puede borrarlo cuando quiera.
--
-- Además: grant de SELECT a service_role sobre puntos_solicitudes y
-- mensajes (herramientas/tests; la RLS sigue protegiendo el dato).
--
-- Idempotente: create table if not exists + drop/create policy/trigger.
--   psql <connection> -f migrations/018_mensajes.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla
-- ------------------------------------------------------------
create table if not exists public.mensajes (
  id uuid primary key default gen_random_uuid(),
  tipo text not null
    constraint mensajes_tipo_chk check (tipo in (
      'asignacion', 'devolucion', 'completado',
      'solicitud', 'solicitud_resuelta',
      'verificacion', 'punto_nuevo', 'punto_aceptado'
    )),
  titulo text not null,
  detalle text,
  actor uuid references auth.users(id),
  territorio_id uuid references public.territorios(id),
  punto_id uuid references public.puntos(id),
  leido boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists mensajes_fecha_idx
  on public.mensajes (created_at desc);
create index if not exists mensajes_no_leidos_idx
  on public.mensajes (created_at desc) where not leido;

alter table public.mensajes enable row level security;

-- Grants (sin default privileges en el proyecto): la RLS admin filtra
grant select, insert, update, delete on public.mensajes to authenticated;
grant select on public.mensajes to service_role;
-- 017 dejó a service_role sin SELECT sobre solicitudes: se agrega aquí
grant select on public.puntos_solicitudes to service_role;

-- Solo admin: todo el ciclo (el "borrar cuando quieras" es suyo)
drop policy if exists "mensajes_admin" on public.mensajes;
create policy "mensajes_admin" on public.mensajes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- 2. Triggers de registro (security definer: leen auth.users para el email)
-- ------------------------------------------------------------
create or replace function public.mensajes_registrar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_nombre text;
begin
  -- ===== INSERT en territorios_asignaciones: proceso iniciado =====
  if tg_table_name = 'territorios_asignaciones' and tg_op = 'INSERT' then
    if new.estado = 'activa' then
      select nombre into v_nombre from public.territorios where id = new.territorio_id;
      select email into v_email from auth.users where id = new.user_id;
      insert into public.mensajes (tipo, titulo, detalle, actor, territorio_id)
      values ('asignacion',
              'Territorio ' || coalesce(v_nombre, '(sin nombre)') || ' asignado',
              'Proceso iniciado → ' || coalesce(v_email, 'usuario'),
              coalesce(new.assigned_by, new.user_id), new.territorio_id);
    end if;
    return new;
  end if;

  -- ===== UPDATE en territorios_asignaciones: proceso cerrado =====
  if tg_table_name = 'territorios_asignaciones' and tg_op = 'UPDATE' then
    if new.estado is distinct from old.estado and new.estado in ('devuelta', 'completado') then
      select nombre into v_nombre from public.territorios where id = new.territorio_id;
      if new.estado = 'devuelta' then
        select email into v_email from auth.users where id = new.devuelta_por;
        insert into public.mensajes (tipo, titulo, detalle, actor, territorio_id)
        values ('devolucion',
                'Territorio ' || coalesce(v_nombre, '(sin nombre)') || ' devuelto',
                'Proceso cerrado sin completar' || case when v_email is not null then ' por ' || v_email else '' end,
                new.devuelta_por, new.territorio_id);
      else
        select email into v_email from auth.users where id = new.completado_por;
        insert into public.mensajes (tipo, titulo, detalle, actor, territorio_id)
        values ('completado',
                'Territorio ' || coalesce(v_nombre, '(sin nombre)') || ' completado',
                case when v_email is null then 'Proceso cerrado automáticamente al 100 %'
                     else 'Proceso cerrado por ' || v_email end,
                new.completado_por, new.territorio_id);
      end if;
    end if;
    return new;
  end if;

  -- ===== INSERT en puntos_solicitudes: nueva solicitud =====
  if tg_table_name = 'puntos_solicitudes' and tg_op = 'INSERT' then
    select email into v_email from auth.users where id = new.user_id;
    insert into public.mensajes (tipo, titulo, detalle, actor)
    values ('solicitud',
            'Solicitud de punto: ' || new.nombre,
            'Enviada por ' || coalesce(v_email, 'usuario'),
            new.user_id);
    return new;
  end if;

  -- ===== UPDATE en puntos_solicitudes: resuelta =====
  if tg_table_name = 'puntos_solicitudes' and tg_op = 'UPDATE' then
    if new.estado is distinct from old.estado and new.estado in ('aceptada', 'rechazada') then
      select email into v_email from auth.users where id = new.resuelta_por;
      insert into public.mensajes (tipo, titulo, detalle, actor, punto_id)
      values ('solicitud_resuelta',
              'Solicitud ' || case when new.estado = 'aceptada' then 'aceptada' else 'rechazada' end || ': ' || new.nombre,
              'Resuelta por ' || coalesce(v_email, 'administración'),
              new.resuelta_por, new.punto_id);
    end if;
    return new;
  end if;

  -- ===== INSERT en puntos: punto nuevo =====
  if tg_table_name = 'puntos' and tg_op = 'INSERT' then
    select email into v_email from auth.users where id = new.user_id;
    insert into public.mensajes (tipo, titulo, detalle, actor, territorio_id, punto_id)
    values ('punto_nuevo',
            'Punto nuevo: ' || coalesce(new.nombre, '(sin nombre)'),
            'Creado por ' || coalesce(v_email, 'usuario'),
            new.user_id, new.territorio_id, new.id);
    return new;
  end if;

  -- ===== UPDATE en puntos: aceptación y/o verificación =====
  if tg_table_name = 'puntos' and tg_op = 'UPDATE' then
    if new.aceptado_at is not null and old.aceptado_at is null then
      select email into v_email from auth.users where id = new.aceptado_por;
      insert into public.mensajes (tipo, titulo, detalle, actor, territorio_id, punto_id)
      values ('punto_aceptado',
              'Punto aceptado: ' || coalesce(new.nombre, '(sin nombre)'),
              'Aceptado por ' || coalesce(v_email, 'administración'),
              new.aceptado_por, new.territorio_id, new.id);
    end if;
    if new.verificado is distinct from old.verificado and new.verificado is not null then
      select email into v_email from auth.users where id = new.verificado_por;
      insert into public.mensajes (tipo, titulo, detalle, actor, territorio_id, punto_id)
      values ('verificacion',
              'Verificación: ' || coalesce(new.nombre, '(sin nombre)'),
              new.verificado || case when v_email is not null then ' por ' || v_email else '' end,
              new.verificado_por, new.territorio_id, new.id);
    end if;
    return new;
  end if;

  return null;
end;
$$;

drop trigger if exists mensajes_asig_ins on public.territorios_asignaciones;
create trigger mensajes_asig_ins
after insert on public.territorios_asignaciones
for each row execute function public.mensajes_registrar();

drop trigger if exists mensajes_asig_upd on public.territorios_asignaciones;
create trigger mensajes_asig_upd
after update on public.territorios_asignaciones
for each row when (new.estado is distinct from old.estado)
execute function public.mensajes_registrar();

drop trigger if exists mensajes_sol_ins on public.puntos_solicitudes;
create trigger mensajes_sol_ins
after insert on public.puntos_solicitudes
for each row execute function public.mensajes_registrar();

drop trigger if exists mensajes_sol_upd on public.puntos_solicitudes;
create trigger mensajes_sol_upd
after update on public.puntos_solicitudes
for each row when (new.estado is distinct from old.estado)
execute function public.mensajes_registrar();

drop trigger if exists mensajes_puntos_ins on public.puntos;
create trigger mensajes_puntos_ins
after insert on public.puntos
for each row execute function public.mensajes_registrar();

drop trigger if exists mensajes_puntos_upd on public.puntos;
create trigger mensajes_puntos_upd
after update on public.puntos
for each row when (
  (new.aceptado_at is not null and old.aceptado_at is null)
  or (new.verificado is distinct from old.verificado and new.verificado is not null)
)
execute function public.mensajes_registrar();
