# Arquitectura

Visión general de cómo está organizado Territorio GPS y por qué.

## Forma de entrega

Sitio estático sin build, con **dos aplicaciones** que comparten `lib.js` y
la misma base Supabase:

- `index.html` — app de **escritorio/central** (admin y visualización).
- `movil.html` + `movil.js` — app de **terreno/colaborador** (territorio único).

`index.html` carga, en este orden:

```html
<link  rel="stylesheet" href="styles.css" />
<script src="https://unpkg.com/maplibre-gl@4.7.1/...">   <!-- mapa -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/...">
<script src="lib.js"></script>   <!-- funciones puras (globales) -->
<script src="app.js"></script>   <!-- todo el comportamiento -->
```

`movil.html` hace lo mismo con Tailwind CDN (en línea) + `lib.js` + `movil.js`.
Los archivos son **scripts clásicos** (no `type="module"`): así la app
también funciona abierta desde disco (`file://`), donde los módulos están
bloqueados por CORS. La "interfaz" entre ambos son los nombres de función
globales, declarados en `eslint.config.js → libGlobals` para que el lint
cruce archivos.

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `index.html` | Estructura semántica de la app de escritorio: login, barra de vistas (**Territorios · Historial · Usuarios**), panel lateral, mapa, modales, toasts. Sin lógica. |
| `styles.css` | Todo el estilo de la app de escritorio. Tokens Material-3 al inicio; responsive al final (`@media 860px`, `480px`). |
| `movil.html` | Shell de la app de terreno: login, tarjeta del territorio, lista/mapa/sync, bottom sheets. Estilo con Tailwind CDN + tokens del mockup. |
| `movil.js` | Lógica de terreno: territorio único, fichas de punto, estados, devolución y **cola offline**. |
| `lib.js` | Funciones **puras**: escaping, geometría EWKB/GeoJSON, punto-en-polígono, EWKT, círculos, parseo de links/coordenadas, etiquetas de estado, cola offline, avance de territorio, duplicados, escapado CSV, GeoJSON de territorio y geocaché de Nominatim. Sin DOM ni estado. |
| `app.js` | Estado global de escritorio, cliente Supabase, mapa, eventos, RPCs, UI y vistas (Historial/Usuarios). |
| `sw.js` | Service worker de la app de terreno (PWA): precache del shell, red-primero para navegación y Supabase, *stale-while-revalidate* para CDN. |
| `manifest.webmanifest` | Manifest PWA: nombre, `start_url: movil.html`, colores y iconos (se registra desde `movil.html`). |
| `icons/` · `scripts/gen-icons.js` | Iconos PNG del manifest, generados sin dependencias (`node scripts/gen-icons.js`). |
| `supabase/functions/` | Edge Functions (p. ej. `crear-usuario`, con `service_role`). |

## Estado global (`app.js`)

Todo el estado vive en variables de módulo (`let` en el top level):

| Grupo | Variables |
|---|---|
| Sesión | `currentUser`, `isAdmin` |
| Datos | `allPoints`, `allComunas`, `allTerritorios`, `usuarios`, `asignaciones` (historial: territorio_id → filas de procesos) |
| Mapa | `map`, `comunaFeatures`, `pointMarkers`, `tempMarker`, `refMarker` |
| Alcance/selection | `puntosScope` (region·comuna·territorio), `territorioSelectedId`, `territorioHoverId` |
| Dibujo | `drawActive`, `drawVerts`, `drawColor`, `drawSnap`, `snapRingsCache`, `pendingTerritorio` |
| Referencia | `refMode`, `refRadius`, `refResultsIds` |
| UI | `currentView` (territorios · historial · usuarios), `assignOpen` (vista de asignación del territorio), `histTab`, `estadoFiltro`, `lastEstadoUndo` |
| Config | `comunasActivas`, `configError` |

No hay store ni framework: la actualización es **imperativa + render manual**.
Cada mutación relevante llama a las funciones de repintado correspondientes:

```
refreshPointsViews()   → renderList + renderMarkers + renderTerritorioList
setTerritorioSelected()    → syncSelectedCard + renderList + renderMarkers
                         + renderTerritorioDetail + renderAssign (cierra si deselecta)
refreshAfterEstado()   → renderList + renderTerritorioList + renderTerritorioDetail
```

Las **vistas** (barra superior) las cambia `setView()`: oculta/muestra `#main`
(mapa + panel) o las secciones `#viewHistorial` / `#viewUsuarios`, y al volver a
*Territorios* reajusta el mapa (`map.resize()`). *Historial* consulta
`territorios_asignaciones` y `puntos`; *Usuarios* usa la RPC `listar_usuarios` y
la Edge Function `crear-usuario` para el alta.

Dentro del *Historial*:
- `loadHistorialTerritorios()` → **todos** los territorios (ordenados por
  comuna) cruzados con su proceso más reciente (`asigPorTerr`).
- `loadHistorialPuntos()` → agrupa `puntos` en **comuna → territorio** y pinta
  filas combinadas (`rowspan`) con el texto en vertical; el botón **Ver**
  delega en `abrirHistorialPunto()`, que llama a la RPC `punto_historial` y
  rellena `#puntoHistorial`.

La vista de asignación (menú ⋮ → Asignar) ocupa la zona de territorios y lista
los **procesos de trabajo** del territorio: filas de `territorios_asignaciones`
(usuario, fecha de asignación, fecha de cierre, estado En proceso/Devuelto/Completado).
`asignaciones` guarda el historial completo por territorio; `asigActiva()` devuelve
el proceso en curso.

## Flujo de arranque

```
getSession() ─┬─ con sesión → startApp(user)
              └─ sin sesión → vista login
                               └─ signInWithPassword → startApp(user)

startApp()  (guarda: solo una vez, evita mapa duplicado)
  ├─ profiles.is_admin → isAdmin
  ├─ oculta ✏️ si no es admin (y aparece solo con comuna elegida)
  ├─ applyInitialSidebarState()   (móvil: panel colapsado)
  ├─ loadConfig()   (app_config.comunas_activas)
  ├─ loadComunas()  (comunas_rm → comunaFeatures)
  └─ initMap()
       └─ map.on('load')
            ├─ loadUsuarios()      (solo admin)
            ├─ loadAsignaciones()
            ├─ loadPoints()
            ├─ initTerritorioLayers()
            └─ loadTerritorios()
```

`onAuthStateChange` cubre `SIGNED_OUT` (sesión revocada/expirada → recarga al
login) y `SIGNED_IN` (sesión abierta en otra pestaña → arranque perezoso).

## Capas del mapa

Orden de pintado (debajo → arriba):

1. `comunas-fill` / `comunas-outline` / `comunas-labels`
2. `territorios-fill` / `territorios-outline` / `territorios-labels` (feature-state `selected`/`hover`)
3. `ref-circle-fill` / `ref-circle-line` (modo referencia)
4. `draw-fill` / `draw-line` / `draw-vert-dots` (trazo en curso)
5. Marcadores DOM (`maplibregl.Marker`) — un `<div class="pin">` por punto

Los colores de los territorios vienen del dato (`['get','color']`), no del CSS.
`text-font` está fijado a `Noto Sans Regular`: en OpenFreeMap la pila por
defecto (Open Sans) responde 404 y deja la fuente entera en estado *errored*,
matando también los polígonos de la misma fuente.

## Pertenencia punto → territorio (T6)

Antes: ray-casting en el cliente (`pointInGeometry`) en cada render.
Ahora: la columna `puntos.territorio_id` la mantiene un trigger en la DB
(`puntos_sync_territorio` al insertar/mover, `territorios_resync_puntos` al crear o
borrar un territorio).

```js
function pointsInTerritorio(s) {
  return allPoints.filter((p) => {
    if (p.territorio_id) return p.territorio_id === s.id; // comparación de ids
    return p.lat != null && pointInGeometry(p.lng, p.lat, s.geom); // fallback
  });
}
```

El fallback cubre puntos fuera de todo territorio y puntos creados antes de la
migración. Los contadores (`territorioBreakdown`) y las barras de avance heredan
la mejora sin cambios.

## Escrituras: actualización local, no recarga

`savePoint()` y `deletePoint()` modifican `allPoints` en memoria y llaman a
`refreshPointsViews()` en lugar de volver a bajar la tabla completa
(`loadPoints()` queda como recarga total para sesión/fallo). Cambios de
estado ya se hacían en local.

## Errores de UI

- `toast(msg, isError)` para confirmaciones.
- `showUndoToast(msg, onUndo)` con 5 s para deshacer el estado.
- Si falta una tabla/función en la DB, los loaders degradan con un mensaje
  accionable («ejecuta la sección N de schema.sql») en vez de romper la app.

## Convenciones

- Comentarios en español, formato `// T<n>: …` para cambios del plan.
- `escapeHtml()` en **todo** dato que se inserta con `innerHTML` (hay un test
  que lo verifica; revisar `searchInRadius` y `renderList` al tocar HTML).
- Los permisos se chequean en la DB; el chequeo de `isAdmin` en el front es
  solo para no mostrar acciones que fallarían.

## App de terreno (`movil.js`)

Mismo patrón (scripts clásicos, estado en `let` top-level, renders
imperativos) pero con un alcance mucho menor: **un colaborador, un territorio
activo, sus puntos**.

```
boot() → getSession() ─┬─ con sesión → entrar(user)
                       └─ vista login

entrar()
  ├─ leerCola()            (localStorage: cola offline)
  ├─ refrescar()
  │    ├─ territorios_asignaciones (estado='activa', con territorios(*) anidado)
  │    └─ puntos (territorio_id = mi territorio; RLS ya limita igual)
  └─ pintarTodo()

tabs: ruta (lista) · mapa (MapLibre: polígono + pins) · sync (cola)
```

### Permisos del colaborador (la DB manda)

La RLS de la migración 003 hace el filtrado; el front solo pinta lo que el
servidor devuelve:

| Acción | RPC / vía | Validación en DB |
|---|---|---|
| Ver territorio y puntos | SELECT | solo su territorio activo + lo que él creó |
| Cambiar estado | `marcar_estado` | punto en su territorio activo |
| Crear punto | `guardar_punto` | INSERT dentro del polígono (trigger calcula `territorio_id`) |
| Editar punto | `actualizar_punto_terreno` | punto de su territorio; coordenadas dentro del polígono |
| Borrar punto | `eliminar_punto_propio` | solo puntos con `user_id = auth.uid()` |
| Devolver territorio | `devolver_territorio` | su asignación activa → `estado='devuelta'` |

### Cola offline

- Cada acción fallida por red se encola en `localStorage` con
  `nuevaOpCola`/`colaAgregar` (helpers puros de `lib.js`, testeados).
- `colaAgregar` deduplica por `(tipo, clave)`: dos cambios de estado del
  mismo punto = solo el último viaja.
- `sincronizar()` reproduce la cola en orden (`ejecutarOp`): si la red
  falla se corta; si el servidor rechaza (p. ej. territorio devuelto) se
  descarta la operación y se sigue.
- Disparadores: botón *Sincronizar ahora*, evento `online`, e intervalo
  de 45 s mientras haya cola.
