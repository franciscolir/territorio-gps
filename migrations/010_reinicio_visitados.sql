-- ============================================================
-- Migración 007 — Nuevo proceso de trabajo al (re)asignar un territorio
--
-- Regla de negocio: cada asignación activa inicia un proceso nuevo.
--   · puntos 'visitado'   → vuelven a 'pendiente'
--   · puntos 'erroneo'    → conservan su estado (se hereda)
--   · puntos 'no_pasar'   → conservan su estado (se hereda)
--
-- Se implementa como trigger AFTER INSERT en territorios_asignaciones:
-- cubre la asignación hecha desde la app de escritorio o por RPC.
-- La creación de puntos nunca trae 'visitado', y los borrados
-- (deleted_at) no se tocan.
-- Idempotente: create or replace + drop if exists.
--   psql <connection> -f migrations/007_reinicio_visitados.sql
--   (o pegar en el SQL Editor de Supabase)
-- ============================================================

create or replace function public.territorio_reiniciar_visitados()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Solo al iniciar un proceso de trabajo activo
  if new.estado <> 'activa' then
    return new;
  end if;

  update public.puntos
  set estado = 'pendiente',
      updated_at = now()
  where territorio_id = new.territorio_id
    and deleted_at is null
    and estado = 'visitado';

  return new;
end;
$$;

drop trigger if exists territorios_asig_reiniciar on public.territorios_asignaciones;
create trigger territorios_asig_reiniciar
  after insert on public.territorios_asignaciones
  for each row
  execute function public.territorio_reiniciar_visitados();
