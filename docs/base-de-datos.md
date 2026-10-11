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
| `sector_id` | uuid → `sectores` `on delete set null` | lo mantiene un trigger (T6) |
| `deleted_at` | timestamptz | borrado lógico (nunca se borra filas) |
| `created_at` / `updated_at` | timestamptz | |

> La columna histórica `categoria` fue reemplazada por `estado`
> (sección 9 de `schema.sql`).

### `public.sectores`

Polígonos dibujados a mano. `geom` es `geometry(Polygon,4326)`, nunca se
**edita** (solo se crea/borra; rename/color no tocan geometría).

| Columna | Notas |
|---|---|
| `comuna` | nombre de la comuna a la que pertenece (texto, denormalizado) |
| `nombre`, `color` | editable por admin |
| `created_by` | creador |

### `public.sectores_asignaciones`

Ciclo de vida de la asignación de un sector a un colaborador.

| Columna | Notas |
|---|---|
| `id` | PK surrogate (`gen_random_uuid()`) |
| `sector_id` | → `sectores`; un sector solo con 1 proceso activo |
| `user_id` | colaborador asignado; un usuario solo con 1 sector activo |
| `assigned_by` / `assigned_at` | quién asignó y cuándo |
| `estado` | `'activa'` \| `'devuelta'` (check + default `'activa'`) |
| `devuelta_at` / `devuelta_por` | auditoría de la devolución |

Índices parciales: **un sector solo con 1 asignación activa** y **un usuario
solo con 1 sector activo** (`where estado = 'activa'`). Las filas devueltas
se conservan como historial. El colaborador devuelve el sector con la RPC
`devolver_sector()` aunque no cubra el 100 %: al devolverlo deja de verlo
(RLS) y el sector queda libre para reasignar.

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
| `puntos` | admin: todo · colaborador: su **sector activo** + lo que él creó | `auth.uid() = user_id` y (admin o dentro de su sector activo) | admin, o colaborador sobre puntos de su sector activo (ver trigger `puntos_bloquear_columnas`) | — (borrado lógico vía RPC) |
| `sectores` | admin: todos · colaborador: solo su sector activo | **solo admin** (+ `created_by = auth.uid()`) | solo admin | solo admin |
| `sectores_asignaciones` | admin: todas · colaborador: solo la suya | solo admin | solo admin | solo admin |
| `comunas_rm` | autenticado | — | — | — |
| `profiles` | solo la propia | (trigger, definer) | — | — |
| `app_config` | autenticado | solo admin | solo admin | — |

Notas:

- `public.is_admin()` y `public.sector_activo_usuario(uid)` (`security
  definer`) son las fuentes de verdad del rol y del sector vigente; las
  policies las usan. `sector_activo_usuario` debe ser definer porque sus
  policy consultan `sectores_asignaciones`, que tiene su propio RLS
  (círculo vicioso).
- El trigger `puntos_bloquear_columnas` impide que un no-admin toque
  `user_id` (ni `deleted_at` ajeno); el `estado` sí lo puede cambiar dentro
  de su sector: pasa por `marcar_estado` (o UPDATE directo bajo RLS).
- Sin `grant` de tabla no basta con la policy: `sectores`, `app_config`,
  `sectores_asignaciones`, `comunas_rm`, `profiles` y `puntos` tienen grants
  explícitos (si no, PostgREST responde `permission denied for table …`).
  Los proyectos nuevos de Supabase ya no otorgan privilegios por defecto a
  `anon`/`authenticated` en el esquema `public`; la migración `004` los aplica.

---

## RPCs

| Función | Seguridad | Qué hace |
|---|---|---|
| `guardar_punto(id, nombre, direccion, estado, notas, lat, lng)` | invoker | Inserta (cualquier autenticado) o actualiza (solo admin). Devuelve el id. |
| `eliminar_punto(id)` | invoker | Solo admin; borrado lógico (`deleted_at`). |
| `marcar_estado(id, estado)` → `estado_anterior` | **definer** | Cualquier autenticado cambia únicamente `estado`/`updated_at`; devuelve el valor anterior para el «Deshacer». Valida que el punto pertenezca al sector activo del colaborador (o que él lo haya creado). |
| `puntos_en_radio(lat, lng, radio_m)` | invoker | Puntos vivos dentro de un radio (búsqueda por referencia). |
| `guardar_sector(comuna, nombre, color, geom)` | invoker | **T2.** Exige admin, serializa con `pg_advisory_xact_lock`, recorta contra la comuna y contra los vecinos (cero solapes), rechaza si sobrevive <2 % del área, `st_snaptogrid(1e-7)` e inserta. Devuelve `{id, pct, recortado}`. |
| `usuarios_asignables()` | **definer** | **T3.** Devuelve `id, email` de todos los perfiles **solo si el llamador es admin**; si no, 0 filas. |
| `sector_activo_usuario(uid)` → uuid | **definer** | Sector asignado activo de un usuario (la usan las policies). |
| `devolver_sector()` → uuid | **definer** | El colaborador devuelve su sector activa (`estado='devuelta'` + auditoría) y recibe el `sector_id`. |
| `actualizar_punto_terreno(id, nombre, direccion, notas, lat, lng)` | **definer** | El colaborador edita campos de terreno de un punto de su sector activo; rechaza coordenadas fuera del polígono. No toca `estado`/`user_id`/`deleted_at`. |
| `eliminar_punto_propio(id)` | **definer** | Borrado lógico de puntos creados por el propio colaborador. |

`guardar_punto` y `eliminar_punto` mantienen el chequeo de admin en el cuerpo
porque son `security invoker` y ejecutan bajo RLS.

---

## Triggers

| Trigger | Cuándo | Qué hace |
|---|---|---|
| `on_auth_user_created` | INSERT en `auth.users` | Crea `profiles` (definer) |
| `puntos_sync_sector` | INSERT o UPDATE de `geom` en `puntos` | Calcula `puntos.sector_id` con `st_covers` (sector más pequeño si hay empate) |
| `sectores_resync_puntos` | INSERT o DELETE en `sectores` | Recalcula `sector_id` de los puntos vivos |
| `puntos_bloquear_columnas` | UPDATE en `puntos` | Bloquea que un no-admin toque `user_id` ni `deleted_at` ajeno; deja pasar cambios de `estado` dentro del sector |

`sectores_resync_puntos` solo escribe `sector_id` (nunca `geom`), así que no
vuelve a disparar `puntos_sync_sector`: no hay bucle.

---

## Índices

| Índice | Columna(s) | Para qué |
|---|---|---|
| `puntos_geom_idx` | `geom` (GiST) | búsquedas espaciales / radio |
| `puntos_user_idx` | `user_id` WHERE `deleted_at is null` | filtros por usuario |
| `puntos_estado_idx` | `estado` WHERE `deleted_at is null` | filtros/chips de estado (T6) |
| `puntos_sector_idx` | `sector_id` WHERE `deleted_at is null` | puntos por sector (T6) |
| `sectores_geom_idx` | `geom` (GiST) | hit-test y recortes |
| `comunas_rm_geom_idx` | `geom` (GiST) | encuadre de cámara |

---

## Migraciones

Aplicar en orden sobre una base existente (idempotentes, se pueden repetir):

```bash
psql "$DATABASE_URL" -f migrations/001_seguridad_p0.sql   # T1–T3
psql "$DATABASE_URL" -f migrations/002_rendimiento_t6.sql  # T6
psql "$DATABASE_URL" -f migrations/003_colaborador.sql     # sector único + devolución
psql "$DATABASE_URL" -f migrations/004_grants_tablas.sql   # grants (nuevos proyectos)
psql "$DATABASE_URL" -f migrations/005_asignaciones_y_estado.sql  # reasignar + estado
```

o vía SQL Editor de Supabase.

| Archivo | Contenido |
|---|---|
| `001_seguridad_p0.sql` | policy `sectores_insert_admin` (reemplaza a `sectores_insert_auth`), `guardar_sector` con chequeo de admin + advisory lock, `usuarios_asignables` restringido, RPC `marcar_estado` + grants |
| `002_rendimiento_t6.sql` | `puntos.sector_id` + backfill, índices por `estado`/`sector_id`, triggers `puntos_sync_sector` y `sectores_resync_puntos` |
| `003_colaborador.sql` | ciclo de vida de asignaciones (`estado`/`devuelta_*` + unicidad parcial), helper `sector_activo_usuario`, RLS de `puntos`/`sectores` por sector activo, trigger `puntos_bloquear_columnas`, RPCs `devolver_sector` / `actualizar_punto_terreno` / `eliminar_punto_propio`, `marcar_estado` con validación de sector |
| `004_grants_tablas.sql` | grants explícitos de `comunas_rm`, `profiles` y `puntos` (proyectos sin default privileges) |
| `005_asignaciones_y_estado.sql` | clave surrogate en `sectores_asignaciones` (antes `sector_id` PK bloqueaba reasignar tras devolver), reasegura unicidad de activos y cierra duplicados; trigger deja pasar `estado` del colaborador |

### Verificación rápida tras migrar

```sql
-- las RPCs nuevas existen y son ejecutables por authenticated
select proname from pg_proc
where proname in ('marcar_estado','guardar_sector','devolver_sector',
                  'actualizar_punto_terreno','eliminar_punto_propio',
                  'sector_activo_usuario');

-- todos los puntos vivos tienen sector (o están fuera de todo sector)
select count(*) from public.puntos where deleted_at is null and sector_id is null;

-- la policy de sectores es la nueva (solo el sector activo del colaborador)
select polname from pg_policies where tablename = 'sectores' and cmd = 'SELECT';

-- los índices parciales de unicidad activa existen
select indexname from pg_indexes
where indexname in ('sectores_asig_activa_sector','sectores_asig_activa_user');
```

---

## Seguridad: qué queda en la DB y qué en el front

- **En la DB (lo que importa):** permisos, unicidad de sectores, recorte
  geométrico, integridad de estados (enum), borrado lógico.
- **En el front (comodidad):** ocultar botones que fallarían, deshacer,
  validación de rangos de lat/lng antes de llamar a la RPC.

La clave anon/publicable que vive en `index.html` no es un secreto: el
verdadero límite es RLS.
