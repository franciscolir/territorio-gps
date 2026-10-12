# Roadmap

Estado de la rama `feat/plan-p0-p1`: **P0 y P1 ejecutados**. Este documento
deja pendiente lo de P2 y abre las decisiones que conviene tratar después.

---

## Hecho en esta rama

| # | Tarea | Qué cambió |
|---|---|---|
| T1 | Rol de cuadrilla real | RPC `marcar_estado` (solo `estado`/`updated_at`, devuelve el anterior); `setEstadoPunto` deja de exigir admin y usa la RPC |
| T2 | Territorios solo admin | policy `territorios_insert_admin`, chequeo + `pg_advisory_xact_lock` en `guardar_territorio`, botones ✏️/Editar/Asignar ocultos y `startDraw` con gate |
| T3 | Correos del equipo | `usuarios_asignables()` con `where public.is_admin()`; el front no la llama si no es admin |
| T4 | XSS + sesión | `escapeHtml` en el error de `searchInRadius`; `onAuthStateChange` para `SIGNED_OUT`/`SIGNED_IN` y arranque único (`startApp`) |
| T5 | Proyecto mantenible | `index.html` (solo markup) + `styles.css` + `lib.js` + `app.js`; ESLint 0 errores |
| T6 | Rendimiento | `puntos.territorio_id` con triggers + índices (estado/territorio_id), actualización local en `savePoint`/`deletePoint`, debounce del filtro, `pointsInTerritorio` por id |
| T7 | Tests | Vitest: 30 tests sobre `lib.js` (`npm test`) |
| T8 | Responsive | `@media 860px/480px`, panel como overlay en móvil, arranque colapsado, clic en mapa para cerrar |
| T9 | App de terreno | `movil.html`/`movil.js`: territorio único asignado, lista/mapa/fichas de punto, alta y edición dentro del polígono, estados con deshacer, **devolución de territorio** y **cola offline** en `localStorage` con auto-sync. Falta solo PWA (service worker + manifest) |
| T10 | RLS por territorio | `territorio_activo_usuario`, policies de `puntos`/`territorios` por territorio activo, trigger `puntos_bloquear_columnas`, RPCs `devolver_territorio`/`actualizar_punto_terreno`/`eliminar_punto_propio` (migración 003) |
| T-H | Vistas e historial | Rename `sectores` → `territorios` (007), barra **Territorios · Historial · Usuarios**, cierre de procesos (**auto al 100 %** + manual), `notas` por proceso, `puntos.ultima_visita`, `listar_usuarios` y alta de usuarios con Edge Function `crear-usuario` (008) |
| T-H2 | Historial y bitácora | Pestaña *Territorios* con **todos** los territorios por comuna; pestaña *Puntos* agrupada por comuna/territorio con **texto vertical en filas combinadas** y botón **Ver**; tabla `puntos_historial` (log por movimiento, trigger security definer) + RPC `punto_historial` (009) |
| T-H3 | Marco verde y cabeceras | «Territorios activos» enmarcado en verde con contador; cabecera `th` sticky de las tablas (`overflow: clip` en `.hist-table`) |
| T-H4 | Filtros persistentes | `prefGet`/`prefSet` recuerdan comuna, territorio, estado, texto de búsqueda y alcance del mapa entre sesiones |
| T-H5 | Historial navegable | Botón **Ver** en *Historial → Territorios*: abre la bitácora de procesos del territorio (nº, usuario, cierre, estado, notas) |
| T-H6 | Ciclo de vida cerrado | `visitado` → `pendiente` al reasignar (010) y cierre **inmediato** como `completado` si no queda nada pendiente (011): ya no hay procesos eternos |
| T-H7 | Duplicados | `duplicadoCercano` avisa al crear un punto con el mismo nombre a <10 m (web y móvil) |
| T-H8 | Accesibilidad | `aria-label` en 16 botones de solo ícono, foco atrapado en modales + foco devuelto al cerrar, `--outline`/`--est-erroneo` a `#6e727a` (4,8:1 WCAG AA) |
| T-H9 | Exportación CSV | Botón **Exportar CSV** en Historial (ambas pestañas), Usuarios y el modal de bitácora; `csvEscape` con BOM y anti-fórmula |
| T-H10 | Lint y tests estrictos | `no-unused-vars: error` con `caughtErrors`; 48 tests sobre `lib.js` (`npm test`), lint a 0 |
| T-H11 | Exportación del territorio | Menú **⋮** de la ficha: **Exportar GeoJSON** (polígono + puntos con estado/notas) y **Exportar puntos (CSV)**; items visibles para todos, acciones de admin reservadas (`territorioFeatureCollection` en `lib.js`) |
| T-H12 | PWA de terreno | `manifest.webmanifest` + iconos PNG (`scripts/gen-icons.js`, sin dependencias) + `sw.js`: precache del shell, red-primero con caché para Supabase y *stale-while-revalidate* para los CDN. Registrada solo en `movil.html`, con recarga única al actualizar |
| T-H13 | Geocaching | Caché de Nominatim en `localStorage` (7 días, 200 entradas, clave normalizada) + ≤1 petición/s; `geoClave`/`geoCacheLeer`/`geoCachePoner` en `lib.js` |

---

## P2 — pendiente

### T11 · PWA para terreno — ✅ hecha
- `manifest.webmanifest` con `start_url: movil.html`, `display: standalone`,
  colores del proyecto y 3 iconos (192, 512 y maskable) generados por
  `scripts/gen-icons.js` **sin dependencias** (PNG escrito a mano con zlib).
- `sw.js` precachea el shell (`movil.html`, `lib.js`, `movil.js`, manifest,
  iconos) con `cache: 'reload'`; navegación y Supabase van **red primero**
  con la caché como respaldo; los CDN (fuentes, maplibre, tailwind,
  supabase-js) y los **tiles del mapa** usan *stale-while-revalidate*, con
  respaldo de respuestas opacas —sin eso no habría offline real, porque
  esos recursos se piden sin `crossorigin` y `resp.ok` sale `false`—.
  Las escrituras (POST/PATCH) nunca pasan por el SW: siguen en la cola de
  `localStorage`. Caché versionada (`terreno-v1`) que `activate` limpia.
- Se registra **solo** desde `movil.html` (y solo en http/https): el
  escritorio no cambia. Recarga única cuando hay un SW nuevo.
- Ojo: `movil.html` carga todo desde CDN; sin la caché del SW no hay offline.

Queda opcional: **push notifications** y pantalla de «sin conexión» propia
(hoy el shell se abre directamente, que es lo que importa en terreno).

### T12 · Exportación del territorio — ✅ hecha
Menú **⋮** de la ficha del territorio: **Exportar GeoJSON** (polígono +
puntos con estado/notas/última visita, para QGIS/geojson.io/Google Earth) y
**Exportar puntos (CSV)**. Ambos items están visibles para cualquier usuario
que vea el territorio; las acciones de administración siguen reservadas.
Ver `territorioFeatureCollection` en `lib.js` (3 tests).
Queda opcional exportar la **comuna visible** (varios polígonos juntos).

### T13 · Exportación del historial — ✅ hecha
La bitácora por punto y la vista Historial ya se exportan en CSV (T-H9).

### T14 · Marcadores y lista con muchos datos
- Clustering de marcadores (`supercluster`) cuando el alcance es «Toda RM».
- Lista virtualizada (o paginación) para territorios con miles de puntos.
- Hoy: todo cabe en memoria y se repinta completo; el cuello de botella
  real es el número de nodos DOM de marcadores.

### T15 · Geocodificación robusta — ✅ hecha
- Caché local (`localStorage`, `gps_geo_cache`): clave normalizada
  (minúsculas, sin acentos, espacios colapsados), TTL de 7 días y tope de
  200 entradas descartando las más antiguas. También cachea los «sin
  resultados», para no repetir una dirección inexistente.
- **≤1 petición/s** a Nominatim (`GEO_MIN_MS = 1000` en `lib.js`), que es lo
  que pide su política de uso; la identificación va por el `Referer` que el
  navegador envía solo (no se puede fijar `User-Agent` desde `fetch`).
- `format=jsonv2` en lugar del `json` deprecado. Helpers puros en `lib.js`
  (`geoClave`, `geoCacheLeer`, `geoCachePoner`) con 4 tests.
- Pendiente opcional: proxy propio o MapLibre/Photon si hace falta SLA.

### Mejoras menores — ✅ cerradas (ronda 1)
- Exportar el historial (CSV) desde Historial (Territorios/Puntos), Usuarios
  y el modal de bitácora → **T-H9**.
- Filtros persistentes (comuna/territorio/estado/texto/alcance) → **T-H4**.
- Duplicados <10 m al crear → **T-H7**.
- Accesibilidad (aria-label, foco en modales, contraste) → **T-H8**.
- Lint `no-unused-vars: error` con `caughtErrors` (0 warnings) → **T-H10**.
- **`app_config` y `DELETE`: decisión — no.** La app solo hace `select` +
  `upsert` (insert+update); el grant de `delete` no tenía policy y RLS lo
  bloqueaba, así que era engañoso. Migración **012** revoca el privilegio
  para `authenticated` y lo deja en `service_role` (scripts).

Queda abierta **T14** (clustering de marcadores y lista virtualizada); la
exportación de la comuna visible queda como ampliación opcional de **T12**.

---

## Decisiones técnicas registradas

1. **Scripts clásicos, no módulos** — funciona también desde `file://`.
   Requiere declarar las globales de `lib.js` en `eslint.config.js`.
2. **`security definer` para RPCs de rol** (`marcar_estado`,
   `usuarios_asignables`) en vez de column-level grants, porque Supabase da
   los privilegios de tabla a *todos* los autenticados y no se pueden
   separar admin/no-admin por grant.
3. **Borrado lógico** (`deleted_at`) y sin policy de `DELETE`: se conserva
   historial y las FK no rompen.
4. **Recorte de territorios en la DB** (`guardar_territorio`): la integridad
   geométrica no puede depender del cliente.
5. **Render imperativo sin framework**: funciona bien al tamaño actual
   (~2.300 líneas de JS). Si el estado crece, migrar a módulos + bundler es
   el momento de replantearlo (ver T5).
6. **`app_config` sin `DELETE` para clientes** (012): la tabla es
   clave/valor y la app solo lee y hace `upsert`. Tener el grant sin
   policy daba un falso «está permitido»; con `revoke` el privilegio queda
   solo en `service_role`, que es quien limpia filas desde scripts.
7. **Un solo service worker, registrado solo por `movil.html`** (T11): su
   scope es `/` porque `sw.js` vive en la raíz, así que también intercepta
   navegaciones del escritorio. Por eso el handler es conservador — red
   primero y, sin red, solo sirve `movil.html` para rutas que terminan en
   `movil.html`; el escritorio nunca recibe el shell de terreno. No se
   precachea nada del escritorio: no es el objetivo de la T11.
