-- ============================================================
-- Migración 021 — Reiniciar territorio (admin): 1 llamada, todo o nada
--
-- El card de gestión del panel admin ofrece el toggle [Reset]: devuelve los
-- 'visitado' del territorio a 'pendiente' ('erroneo' y 'no_pasar' se
-- mantienen) y, si hay un proceso activo, lo cierra como 'devuelta' dejando
-- el territorio libre para un nuevo proceso.
--
-- Todo en UNA transacción server-side (antes era 1 RPC marcar_estado por
-- punto desde el cliente): atómico, rápido (1 round-trip) y auditable
-- (el trigger puntos_historial_log de la 009 registra el cambio de estado
-- de cada punto; mensajes_registrar de la 018 registra el cierre del
-- proceso; territorios_autocompletar de la 013 no interviene porque tras
-- el reinicio siempre quedan pendientes).
--
-- Idempotente: drop/create function.
--   psql <connection> -f migrations/021_reiniciar_territorio.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

create or replace function public.reiniciar_territorio(p_territorio uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reiniciados integer;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede reiniciar territorios';
  end if;

  -- Cierra el proceso activo (queda en el historial como 'devuelta' con
  -- auditoría de fecha y quién lo reinició)
  update public.territorios_asignaciones
  set estado = 'devuelta',
      devuelta_at = now(),
      devuelta_por = auth.uid()
  where territorio_id = p_territorio
    and estado = 'activa';

  -- Reinicia los visitados a pendiente; erroneo y no_pasar se conservan
  update public.puntos
  set estado = 'pendiente',
      updated_at = now()
  where territorio_id = p_territorio
    and deleted_at is null
    and estado = 'visitado';

  get diagnostics v_reiniciados = row_count;
  return v_reiniciados;
end;
$$;

revoke execute on function public.reiniciar_territorio(uuid) from public, anon;
grant execute on function public.reiniciar_territorio(uuid) to authenticated;
