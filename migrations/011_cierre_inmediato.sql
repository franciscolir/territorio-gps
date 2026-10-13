-- ============================================================
-- Migración 011 — Cierre inmediato cuando no queda nada por visitar
--
-- 010 reinicia 'visitado' → 'pendiente' al abrir un proceso y
-- territorios_autocompletar cierra el proceso en cada UPDATE de puntos.
--
-- Hueco que deja 010: si el territorio no tiene NI UN punto 'visitado'
-- (todos en 'erroneo'/'no_pasar', que son condiciones permanentes, o
-- directamente sin puntos), el UPDATE de 010 no toca ninguna fila →
-- el trigger de autocompletar no llega a dispararse y el proceso se
-- queda 'activa' para siempre pese a estar al 100 %.
--
-- Esta versión de la misma función añade esa verificación al final:
-- se resetea primero (para no cerrar un proceso con visitas nuevas
-- sin registrar) y luego se comprueba si quedan puntos 'pendiente'.
--
-- Idempotente: create or replace de la función que crea 010.
--   psql <connection> -f migrations/011_cierre_inmediato.sql
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

  -- 1) Las visitas del proceso anterior no cuentan en este: vuelven a
  --    pendiente. 'erroneo' y 'no_pasar' se heredan tal cual.
  update public.puntos
  set estado = 'pendiente',
      updated_at = now()
  where territorio_id = new.territorio_id
    and deleted_at is null
    and estado = 'visitado';

  -- 2) Si tras eso no queda ningún punto por visitar, el territorio ya está
  --    abarcado y el proceso recién abierto se cierra en el mismo instante.
  --    Sin esto, un territorio 100 % erróneo/no_pasar (o vacío) quedaría
  --    'En proceso' para siempre.
  if not exists (
    select 1
    from public.puntos p
    where p.territorio_id = new.territorio_id
      and p.deleted_at is null
      and p.estado = 'pendiente'
  ) then
    update public.territorios_asignaciones
    set estado = 'completado',
        completado_at = coalesce(completado_at, now())
    where id = new.id;
  end if;

  return new;
end;
$$;
