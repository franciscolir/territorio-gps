-- ============================================================
-- Migración 020 — Bitácora de mensajes por punto (móvil)
--
-- El móvil ya no reescribe una única nota: cada mensaje se guarda como una
-- entrada inmutable con autor y fecha. `public.puntos.notas` se mantiene como
-- espejo del ÚLTIMO mensaje para que admin/desktop y la revisión sigan
-- funcionando sin cambios (el trigger de la 009 registra el cambio como
-- tipo 'nota' en puntos_historial).
--
-- Acceso a la tabla: RLS habilitado SIN policies de cliente. Todo pasa por las
-- RPCs security definer de abajo (mismo predicado de visibilidad del punto que
-- la policy "puntos_select_colab" de la 016).
-- Idempotente: create table if not exists + drop/create function.
--   psql <connection> -f migrations/020_notas_puntos.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla
-- ------------------------------------------------------------
create table if not exists public.puntos_notas (
  id uuid primary key default gen_random_uuid(),
  punto_id uuid not null references public.puntos(id) on delete cascade,
  texto text not null,
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists puntos_notas_punto_idx
  on public.puntos_notas (punto_id, created_at);

alter table public.puntos_notas enable row level security;

-- ------------------------------------------------------------
-- 2. RPC: agregar un mensaje (colaborador con acceso al punto)
-- ------------------------------------------------------------
create or replace function public.agregar_nota_punto(p_id uuid, p_texto text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ver boolean;
  v_id uuid;
  v_texto text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  v_texto := nullif(trim(coalesce(p_texto, '')), '');
  if v_texto is null then
    raise exception 'El mensaje está vacío';
  end if;

  select exists (
    select 1 from public.puntos pu
    where pu.id = p_id
      and pu.deleted_at is null
      and (
        public.is_admin()
        or pu.user_id = auth.uid()
        or pu.territorio_id = public.territorio_activo_usuario(auth.uid())
        or exists (
          select 1 from public.tareas_verificacion t
          where t.punto_id = pu.id
            and t.user_id = auth.uid()
            and t.estado = 'pendiente'
        )
      )
  ) into v_ver;

  if not v_ver then
    raise exception 'Punto no disponible';
  end if;

  insert into public.puntos_notas (punto_id, texto, user_id)
  values (p_id, v_texto, auth.uid())
  returning id into v_id;

  -- Espejo del último mensaje (dispara el log 'nota' de la 009)
  update public.puntos
  set notas = v_texto, updated_at = now()
  where id = p_id;

  return v_id;
end;
$$;

revoke execute on function public.agregar_nota_punto(uuid, text) from public, anon;
grant execute on function public.agregar_nota_punto(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. RPC: leer la bitácora de un punto (texto + autor + fecha)
-- ------------------------------------------------------------
create or replace function public.notas_punto(p_punto uuid)
returns table (
  nota_id uuid,
  texto text,
  autor text,
  at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ver boolean;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select exists (
    select 1 from public.puntos pu
    where pu.id = p_punto
      and pu.deleted_at is null
      and (
        public.is_admin()
        or pu.user_id = auth.uid()
        or pu.territorio_id = public.territorio_activo_usuario(auth.uid())
        or exists (
          select 1 from public.tareas_verificacion t
          where t.punto_id = pu.id
            and t.user_id = auth.uid()
            and t.estado = 'pendiente'
        )
      )
  ) into v_ver;

  if not v_ver then
    raise exception 'Punto no disponible';
  end if;

  return query
    select n.id, n.texto, coalesce(p.email, '—'), n.created_at
    from public.puntos_notas n
    left join public.profiles p on p.id = n.user_id
    where n.punto_id = p_punto
    order by n.created_at asc;
end;
$$;

revoke execute on function public.notas_punto(uuid) from public, anon;
grant execute on function public.notas_punto(uuid) to authenticated;
