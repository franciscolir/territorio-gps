# Edge Function · `crear-usuario`

Crea usuarios de **terreno** (nunca administradores) desde la vista **Usuarios**.
El navegador no puede crear usuarios con la clave `anon`; la función lo hace con
`SERVICE_ROLE_KEY` tras verificar que quien llama es admin (`is_admin()`).

## Despliegue

Con la [Supabase CLI](https://supabase.com/docs/guides/cli) instalada y el
proyecto enlazado (`supabase link`):

```bash
supabase functions deploy crear-usuario
```

Supabase inyecta automáticamente `SUPABASE_URL`, `SUPABASE_ANON_KEY` y
`SUPABASE_SERVICE_ROLE_KEY` como variables de entorno de la función; no hay que
configurar secretos a mano.

### Alternativa sin CLI

1. Dashboard → **Edge Functions** → **Create function** → nombre `crear-usuario`.
2. Pega el contenido de `index.ts` y despliega.
3. Asegura que el proyecto tenga disponible `SUPABASE_SERVICE_ROLE_KEY` (lo está
   por defecto en las Edge Functions).

## Seguridad

- Exige un JWT válido y comprueba `public.is_admin()`; si no, responde `403`.
- Fuerza `is_admin = false` en `profiles` (aunque el trigger `handle_new_user`
  ya lo deja así por defecto).
- CORS abierto (`*`) es aceptable aquí porque la función valida el JWT del
  llamador; el acceso real queda limitado por `is_admin()`.
