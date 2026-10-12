-- ============================================================
-- Migración 012 — app_config sin DELETE para clientes
--
-- Decisión registrada: app_config NO permite DELETE desde la app.
--   · La app solo lee y hace upsert (INSERT ... ON CONFLICT DO UPDATE),
--     que necesita insert + update, nunca delete.
--   · El grant de la 007/schema.sql incluía `delete` pero no había policy
--     de DELETE, así que RLS lo rechazaba igualmente: el grant era engañoso.
--   · service_role (scripts de mantenimiento) SÍ conserva delete.
--
-- Menos privilegios = menos superficie si alguna vez se filtra la anon key.
--
-- Idempotente: revoke ... from is idempotente.
--   psql <connection> -f migrations/012_app_config_sin_delete.sql
-- ============================================================

revoke delete on table public.app_config from authenticated;

-- Verificación: solo service_role debe poder borrar
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_name = 'app_config' and privilege_type = 'delete';
--   → service_role (y postgres/owner), nunca authenticated.
