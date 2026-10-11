-- ============================================================
-- Migración 006 — Grants faltantes de sectores y sectores_asignaciones
-- La migración 004 otorgó permisos sobre comunas_rm, profiles y puntos,
-- pero omitió estas dos tablas. En proyectos sin default privileges,
-- PostgREST responde "permission denied for table sectores_asignaciones"
-- (42501) y la app de terreno no logra cargar el sector asignado.
-- Idempotente: se puede re-ejecutar sin daño.
--   psql <connection> -f migrations/006_grants_asignaciones.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

grant select, insert, update, delete on public.sectores to authenticated;
grant select, insert, update, delete on public.sectores_asignaciones to authenticated;
