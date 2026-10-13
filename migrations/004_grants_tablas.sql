-- Migración 004 — Grants de tablas (proyectos sin default privileges)
-- Los proyectos nuevos de Supabase ya no crean `alter default privileges`
-- sobre el esquema public: sin grants explícitos, PostgREST responde
-- "permission denied for table X" (p. ej. el selector de comunas vacío).
-- Idempotente: se puede re-ejecutar sin daño.
--   psql <connection> -f migrations/004_grants_tablas.sql
--   (o SQL editor de Supabase)

grant select on public.comunas_rm to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update on public.puntos to authenticated;
