# Base de datos (Supabase / PostgreSQL + PostGIS)

Fuente de verdad: [`schema.sql`](../schema.sql) (instalación nueva).
Para bases ya desplegadas: [`migrations/`](../migrations) (idempotentes).

---

## Tablas

### `public.puntos`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | uuid → `auth.users` | creador, `on delete cascade` |
| `nombre` | text NOT NULL | |
| `direccion` | text | |
| `estado` | `estado_punto` NOT NULL | enum: `pendiente`, `visitado`, `erroneo`, `no_pasar` (default `pendiente`) |
| `notas` | text | admin: libre · colaborador: vía `actualizar_punto_terreno` |
| `geom` | `geography(Point,4326)` NOT NULL | índice GiST |
| `territorio_id` | uuid → `territorios` `on delete set null` | lo mantiene un trigger (T6) |
| `ultima_visita` | timestamptz | último cambio a un estado no `pendiente` (lo fija `marcar_estado`) |
| `deleted_at` | timestamptz | borrado lógico (nunca se borra filas) |
| `created_at` / `updated_at` | timestamptz | |

> La columna histórica `categoria` fue reemplazada por `estado`
> (sección 9 de `schema.sql`).

### `public.territorios`

Polígonos dibujados a mano. `geom` es `geometry(Polygon,4326)`, nunca se
**edita** (solo se crea/borra; rename/color no tocan geometría).

| Columna | Notas |
|---|---|
| `comuna` | nombre de la comuna a la que pertenece (texto, denormalizado) |
| `nombre`, `color` | editable por admin |
| `created_by` | creador |

### `public.territorios_asignaciones`

Ciclo de vida de la asignación de un territorio a un colaborador.

| Columna | Notas |
|---|---|
| `id` | PK surrogate (`gen_random_uuid()`) |
| `territorio_id` | → `territorios`; un territorio solo con 1 proceso activo |
| `user_id` | colaborador asignado; un usuario solo con 1 territorio activo |
| `assigned_by` / `assigned_at` | quién asignó y cuándo |
| `estado` | `'activa'` \| `'devuelta'` \| `'completado'` (check + default `'activa'`) |
| `notas` | notas del proceso (se fijan al completar) |
| `devuelta_at` / `devuelta_por` | auditoría de la devolución |
| `completado_at` / `completado_por` | auditoría del cierre |

Índices parciales: **un territorio solo con 1 proceso activo** y **un usuario
solo con 1 territorio activo** (`where estado = 'activa'`). Las filas devueltas
y completadas se conservan como historial. El colaborador devuelve el territorio
con la RPC `devolver_territorio()` aunque no cubra el 100 %: al devolverlo deja
de verlo (RLS) y el territorio queda libre para reasignar. El proceso se cierra
solo cuando no quedan puntos `pendiente` (trigger `territorios_autocompletar`) o
manualmente con `completar_territorio()` (admin).

### `public.comunas_rm`

`nombre`, `codigo_comuna`, `geom geometry(MultiPolygon,4326)`. Cargada por
`npm run seed`. RLS: lectura para todos los autenticados.

### `public.profiles`

`id` (= `auth.users.id`), `email`, `is_admin`. Se crea con el trigger
`on_auth_user_created`. Cada usuario solo puede leer **su** fila.

### `public.app_config`

Clave/valor JSON. Fila única relevante: `comunas_activas` (`null` = todas).
Lectura para todos, escritura solo admin.

---

## Row Level Security

| Tabla | Select | Insert | Update | Delete |
|---|---|---|---|---|
| `puntos` | admin: todo · colaborador: su **territorio activo** + lo que él creó | `auth.uid() = user_id` y (admin o dentro de su territorio activo) | admin, o colaborador sobre puntos de su territorio activo (ver trigger `puntos_bloquear_columnas`) | — (borrado lógico vía RPC) |
| `territorios` | admin: todos · colaborador: solo su territorio activo | **solo admin** (+ `created_by = auth.uid()`) | solo admin | solo admin |
| `territorios_asignaciones` | admin: todas · colaborador: solo la suya | solo admin | solo admin | solo admin |
| `comunas_rm` | autenticado | — | — | — |
| `profiles` | solo la propia | (trigger, definer) | — | — |
| `app_config` | autenticado | solo admin | solo admin | — |

Notas:

- `public.is_admin()` y `public.territorio_activo_usuario(uid)` (`security
  definer`) son las fuentes de verdad del rol y del territorio vigente; las
  policies las usan. `territorio_activo_usuario` debe ser definer porque sus
  policy consultan `territorios_asignaciones`, que tiene su propio RLS
  (círculo vicioso).
- El trigger `puntos_bloquear_columnas` impide que un no-admin toque
  `user_id` (ni `deleted_at` ajeno); el `estado` sí lo puede cambiar dentro
  de su territorio: pasa por `marcar_estado` (o UPDATE directo bajo RLS).
- Sin `grant` de tabla no basta con la policy: `territorios`, `app_config`,
  `territorios_asignaciones`, `comunas_rm`, `profiles` y `puntos` tienen grants
  explícitos (si no, PostgREST responde `permission denied for table …`).
  Los proyectos nuevos de Supabase ya no otorgan privilegios por defecto a
  `anon`/`authenticated` en el esquema `public`; la migración `004` los aplica.

---

## RPCs

| Función | Seguridad | Qué hace |
|---|---|---|
| `guardar_punto(id, nombre, direccion, estado, notas, lat, lng)` | invoker | Inserta (cualquier autenticado) o actualiza (solo admin). Devuelve el id. |
| `eliminar_punto(id)` | invoker | Solo admin; borrado lógico (`deleted_at`). |
| `marcar_estado(id, estado)` → `estado_anterior` | **definer** | Cualquier autenticado cambia únicamente `estado`/`updated_at` (y fija `ultima_visita` si el estado no es `pendiente`); devuelve el valor anterior para el «Deshacer». Valida que el punto pertenezca al territorio activo del colaborador (o que él lo haya creado). |
| `puntos_en_radio(lat, lng, radio_m)` | invoker | Puntos vivos dentro de un radio (búsqueda por referencia). |
| `guardar_territorio(comuna, nombre, color, geom)` | invoker | **T2.** Exige admin, serializa con `pg_advisory_xact_lock`, recorta contra la comuna y contra los vecinos (cero solapes), rechaza si sobrevive <2 % del área, `st_snaptogrid(1e-7)` e inserta. Devuelve `{id, pct, recortado}`. |
| `usuarios_asignables()` | **definer** | **T3.** Devuelve `id, email` de todos los perfiles **solo si el llamador es admin**; si no, 0 filas. |
| `territorio_activo_usuario(uid)` → uuid | **definer** | Territorio asignado activo de un usuario (la usan las policies). |
| `devolver_territorio()` → uuid | **definer** | El colaborador devuelve su territorio activo (`estado='devuelta'` + auditoría) y recibe el `territorio_id`. |
| `actualizar_punto_terreno(id, nombre, direccion, notas, lat, lng)` | **definer** | El colaborador edita campos de terreno de un punto de su territorio activo; rechaza coordenadas fuera del polígono. No toca `estado`/`user_id`/`deleted_at`. |
| `eliminar_punto_propio(id)` | **definer** | Borrado lógico de puntos creados por el propio colaborador. |
| `completar_territorio(territorio, notas)` | **definer** | Solo admin: cierra el proceso activo como `completado` (auditoría + notas). |
| `listar_usuarios()` | **definer** | Solo admin: `id, email, is_admin` + territorio activo y fecha de asignación (`desde`). |

`guardar_punto` y `eliminar_punto` mantienen el chequeo de admin en el cuerpo
porque son `security invoker` y ejecutan bajo RLS.

---

## Triggers

| Trigger | Cuándo | Qué hace |
|---|---|---|
| `on_auth_user_created` | INSERT en `auth.users` | Crea `profiles` (definer) |
| `puntos_sync_territorio` | INSERT o UPDATE de `geom` en `puntos` | Calcula `puntos.territorio_id` con `st_covers` (territorio más pequeño si hay empate) |
| `territorios_resync_puntos` | INSERT o DELETE en `territorios` | Recalcula `territorio_id` de los puntos vivos |
| `puntos_bloquear_columnas` | UPDATE en `puntos` | Bloquea que un no-admin toque `user_id` ni `deleted_at` ajeno; deja pasar cambios de `estado` dentro del territorio |
| `territorios_autocompletar` | UPDATE de `estado` en `puntos` | Si al territorio no le quedan puntos `pendiente`, cierra su proceso activo como `completado` |

`territorios_resync_puntos` solo escribe `territorio_id` (nunca `geom`), así que no
vuelve a disparar `puntos_sync_territorio`: no hay bucle.

---

## Índices

| Índice | Columna(s) | Para qué |
|---|---|---|
| `puntos_geom_idx` | `geom` (GiST) | búsquedas espaciales / radio |
| `puntos_user_idx` | `user_id` WHERE `deleted_at is null` | filtros por usuario |
| `puntos_estado_idx` | `estado` WHERE `deleted_at is null` | filtros/chips de estado (T6) |
| `puntos_territorio_idx` | `territorio_id` WHERE `deleted_at is null` | puntos por territorio (T6) |
| `territorios_geom_idx` | `geom` (GiST) | hit-test y recortes |
| `comunas_rm_geom_idx` | `geom` (GiST) | encuadre de cámara |

---

## Migraciones

Aplicar en orden sobre una base existente (idempotentes, se pueden repetir):

```bash
psql "$DATABASE_URL" -f migrations/001_seguridad_p0.sql   # T1–T3
psql "$DATABASE_URL" -f migrations/002_rendimiento_t6.sql  # T6
psql "$DATABASE_URL" -f migrations/003_colaborador.sql     # territorio único + devolución
psql "$DATABASE_URL" -f migrations/004_grants_tablas.sql   # grants (nuevos proyectos)
psql "$DATABASE_URL" -f migrations/005_asignaciones_y_estado.sql  # reasignar + estado
psql "$DATABASE_URL" -f migrations/006_grants_asignaciones.sql    # grants territorios/asignaciones
psql "$DATABASE_URL" -f migrations/007_rename_territorios.sql     # sectores → territorios
psql "$DATABASE_URL" -f migrations/008_historial_usuarios.sql     # completado + historial + usuarios
```

o vía SQL Editor de Supabase.

| Archivo | Contenido |
|---|---|
| `001_seguridad_p0.sql` | policy `territorios_insert_admin` (reemplaza a `territorios_insert_auth`), `guardar_territorio` con chequeo de admin + advisory lock, `usuarios_asignables` restringido, RPC `marcar_estado` + grants |
| `002_rendimiento_t6.sql` | `puntos.territorio_id` + backfill, índices por `estado`/`territorio_id`, triggers `puntos_sync_territorio` y `territorios_resync_puntos` |
| `003_colaborador.sql` | ciclo de vida de asignaciones (`estado`/`devuelta_*` + unicidad parcial), helper `territorio_activo_usuario`, RLS de `puntos`/`territorios` por territorio activo, trigger `puntos_bloquear_columnas`, RPCs `devolver_territorio` / `actualizar_punto_terreno` / `eliminar_punto_propio`, `marcar_estado` con validación de territorio |
| `004_grants_tablas.sql` | grants explícitos de `comunas_rm`, `profiles` y `puntos` (proyectos sin default privileges) |
| `005_asignaciones_y_estado.sql` | clave surrogate en `territorios_asignaciones` (antes `territorio_id` PK bloqueaba reasignar tras devolver), reasegura unicidad de activos y cierra duplicados; trigger deja pasar `estado` del colaborador |
| `006_grants_asignaciones.sql` | grants de `territorios` y `territorios_asignaciones` para `authenticated` |
| `007_rename_territorios.sql` | rename `sectores` → `territorios` (tablas, columna, RPCs, triggers, policies) |
| `008_historial_usuarios.sql` | estado `completado`, `notas`/`completado_*`, `puntos.ultima_visita`, trigger `territorios_autocompletar`, RPCs `completar_territorio` y `listar_usuarios` |

### Verificación rápida tras migrar

```sql
-- las RPCs nuevas existen y son ejecutables por authenticated
select proname from pg_proc
where proname in ('marcar_estado','guardar_territorio','devolver_territorio',
                  'actualizar_punto_terreno','eliminar_punto_propio',
                  'territorio_activo_usuario','completar_territorio','listar_usuarios');

-- todos los puntos vivos tienen territorio (o están fuera de todo territorio)
select count(*) from public.puntos where deleted_at is null and territorio_id is null;

-- la policy de territorios es la nueva (solo el territorio activo del colaborador)
select polname from pg_policies where tablename = 'territorios' and cmd = 'SELECT';

-- los índices parciales de unicidad activa existen
select indexname from pg_indexes
where indexname in ('territorios_asig_activa_territorio','territorios_asig_activa_user');
```

---

## Seguridad: qué queda en la DB y qué en el front

- **En la DB (lo que importa):** permisos, unicidad de territorios, recorte
  geométrico, integridad de estados (enum), borrado lógico.
- **En el front (comodidad):** ocultar botones que fallarían, deshacer,
  validación de rangos de lat/lng antes de llamar a la RPC.

La clave anon/publicable que vive en `index.html` no es un secreto: el
verdadero límite es RLS.
