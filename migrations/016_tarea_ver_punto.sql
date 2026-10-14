-- ============================================================
-- Migración 016 — RLS: ver el punto de una tarea de verificación
--
-- La migración 015 dejó el SELECT de puntos estricto (territorio activo o
-- propios). Efecto colateral: el embed `puntos(...)` de la consulta de
-- tareas_verificacion llegaba VACÍO cuando el punto de la tarea no era del
-- territorio activo del asignado (ni propio), y la card de la tarea se
-- renderizaba sin datos y con estado "pendiente" de fallback.
--
-- Regla que se agrega al SELECT de puntos: un colaborador también puede leer
-- un punto mientras tenga una tarea de verificación PENDIENTE asignada por
-- admin sobre él. Al resolverla la tarea deja de estar pendiente y la
-- visibilidad del punto termina automáticamente.
-- Idempotente: drop policy if exists + create policy.
--   psql <connection> -f migrations/016_tarea_ver_punto.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

drop policy if exists "puntos_select_colab" on public.puntos;
create policy "puntos_select_colab" on public.puntos
  for select to authenticated
  using (
    deleted_at is null
    and (
      public.is_admin()
      or user_id = auth.uid()
      or territorio_id = public.territorio_activo_usuario(auth.uid())
      -- Tarea de verificación asignada por admin: solo mientras esté pendiente
      or exists (
        select 1
        from public.tareas_verificacion t
        where t.punto_id = puntos.id
          and t.user_id = auth.uid()
          and t.estado = 'pendiente'
      )
    )
  );
