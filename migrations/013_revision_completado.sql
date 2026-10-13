-- ============================================================
-- Migración 013 — Ventana de revisión tras el cierre del proceso
--
-- El móvil cierra el proceso (estado 'completado') en el instante en que
-- se marca el último punto pendiente y ahí mismo ofrece la tabla de
-- revisión con edición in situ (estados + notas). Pero
-- territorio_activo_usuario() solo consideraba asignaciones 'activa',
-- así que esa edición fallaba con «No tienes un territorio asignado» /
-- «Punto fuera de tu territorio» justo en la ventana de revisión.
--
-- Regla nueva: la asignación 'activa' manda; si no hay, cuenta la más
-- reciente 'completado' del usuario (su proceso cerrado, en revisión)
-- hasta que central reasigne o devuelva el territorio.
-- Idempotente: create or replace.
--   psql <connection> -f migrations/013_revision_completado.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

create or replace function public.territorio_activo_usuario(p_uid uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select a.territorio_id
  from public.territorios_asignaciones a
  where a.user_id = p_uid
    and a.estado in ('activa', 'completado')
  order by case a.estado when 'activa' then 0 else 1 end,
           a.assigned_at desc nulls last
  limit 1;
$$;

revoke execute on function public.territorio_activo_usuario(uuid) from public, anon;
grant execute on function public.territorio_activo_usuario(uuid) to authenticated;
