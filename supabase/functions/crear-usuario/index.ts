// ============================================================
// Edge Function: crear-usuario
// Crea un usuario de TERRENO (nunca admin). La clave anon del navegador no
// puede crear usuarios, así que el trabajo lo hace esta función con la
// SERVICE_ROLE_KEY, después de comprobar que quien llama es administrador.
//
// Despliegue:
//   supabase functions deploy crear-usuario
// La SERVICE_ROLE_KEY la inyecta Supabase automáticamente como secreto.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'No autenticado' }, 401);

    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anon || !service) return json({ error: 'Faltan variables de entorno' }, 500);

    // 1) Verificar que quien llama es admin (con su propio JWT)
    const asUser = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await asUser.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Sesión inválida' }, 401);

    const { data: esAdmin, error: adminErr } = await asUser.rpc('is_admin');
    if (adminErr) return json({ error: adminErr.message }, 500);
    if (!esAdmin) return json({ error: 'Solo administradores pueden crear usuarios' }, 403);

    // 2) Datos de entrada
    const { email, password } = await req.json().catch(() => ({}));
    if (!email || !password || String(password).length < 6) {
      return json({ error: 'Email y contraseña (mínimo 6 caracteres) son obligatorios' }, 400);
    }

    // 3) Crear el usuario con service_role (email ya confirmado) y rol NO admin
    const admin = createClient(url, service);
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { is_admin: false },
    });
    if (error) return json({ error: error.message }, 400);

    await admin
      .from('profiles')
      .upsert({ id: created.user.id, email, is_admin: false }, { onConflict: 'id' });

    return json({ ok: true, id: created.user.id, email });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
