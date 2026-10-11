# Arquitectura

Visión general de cómo está organizado Territorio GPS y por qué.

## Forma de entrega

Sitio estático sin build, con **dos aplicaciones** que comparten `lib.js` y
la misma base Supabase:

- `index.html` — app de **escritorio/central** (admin y visualización).
- `movil.html` + `movil.js` — app de **terreno/colaborador** (sector único).

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
| `index.html` | Estructura semántica de la app de escritorio: login, panel lateral, mapa, modales, toasts. Sin lógica. |
| `styles.css` | Todo el estilo de la app de escritorio. Tokens Material-3 al inicio; responsive al final (`@media 860px`, `480px`). |
| `movil.html` | Shell de la app de terreno: login, tarjeta del sector, lista/mapa/sync, bottom sheets. Estilo con Tailwind CDN + tokens del mockup. |
| `movil.js` | Lógica de terreno: sector único, fichas de punto, estados, devolución y **cola offline**. |
| `lib.js` | Funciones **puras**: escaping, geometría EWKB/GeoJSON, punto-en-polígono, EWKT, círculos, parseo de links/coordenadas, etiquetas de estado, cola offline y avance de sector. Sin DOM ni estado. |
| `app.js` | Estado global de escritorio, cliente Supabase, mapa, eventos, RPCs, UI. |

## Estado global (`app.js`)

Todo el estado vive en variables de módulo (`let` en el top level):

| Grupo | Variables |
|---|---|
| Sesión | `currentUser`, `isAdmin` |
| Datos | `allPoints`, `allComunas`, `allSectores`, `usuarios`, `asignaciones` |
| Mapa | `map`, `comunaFeatures`, `pointMarkers`, `tempMarker`, `refMarker` |
| Alcance/selection | `puntosScope` (region·comuna·sector), `sectorSelectedId`, `sectorHoverId` |
| Dibujo | `drawActive`, `drawVerts`, `drawColor`, `drawSnap`, `snapRingsCache`, `pendingSector` |
| Referencia | `refMode`, `refRadius`, `refResultsIds` |
| UI | `assignOpen`, `estadoFiltro`, `lastEstadoUndo`, `mobileOpen` |
| Config | `comunasActivas`, `configError` |

No hay store ni framework: la actualización es **imperativa + render manual**.
Cada mutación relevante llama a las funciones de repintado correspondientes:

```
refreshPointsViews()   → renderList + renderMarkers + renderSectorList
setSectorSelected()    → syncSelectedCard + renderList + renderMarkers
                         + renderSectorDetail (+ renderMobile si está abierta)
refreshAfterEstado()   → renderList + renderSectorList + renderSectorDetail
                         (+ renderMobile)
```

## Flujo de arranque

```
getSession() ─┬─ con sesión → startApp(user)
              └─ sin sesión → vista login
                               └─ signInWithPassword → startApp(user)

startApp()  (guarda: solo una vez, evita mapa duplicado)
  ├─ profiles.is_admin → isAdmin
  ├─ oculta ✏️ si no es admin
  ├─ applyInitialSidebarState()   (móvil: panel colapsado)
  ├─ loadConfig()   (app_config.comunas_activas)
  ├─ loadComunas()  (comunas_rm → comunaFeatures)
  └─ initMap()
       └─ map.on('load')
            ├─ loadUsuarios()      (solo admin)
            ├─ loadAsignaciones()
            ├─ loadPoints()
            ├─ initSectorLayers()
            └─ loadSectores()
```

`onAuthStateChange` cubre `SIGNED_OUT` (sesión revocada/expirada → recarga al
login) y `SIGNED_IN` (sesión abierta en otra pestaña → arranque perezoso).

## Capas del mapa

Orden de pintado (debajo → arriba):

1. `comunas-fill` / `comunas-outline` / `comunas-labels`
2. `sectores-fill` / `sectores-outline` / `sectores-labels` (feature-state `selected`/`hover`)
3. `ref-circle-fill` / `ref-circle-line` (modo referencia)
4. `draw-fill` / `draw-line` / `draw-vert-dots` (trazo en curso)
5. Marcadores DOM (`maplibregl.Marker`) — un `<div class="pin">` por punto

Los colores de los sectores vienen del dato (`['get','color']`), no del CSS.
`text-font` está fijado a `Noto Sans Regular`: en OpenFreeMap la pila por
defecto (Open Sans) responde 404 y deja la fuente entera en estado *errored*,
matando también los polígonos de la misma fuente.

## Pertenencia punto → sector (T6)

Antes: ray-casting en el cliente (`pointInGeometry`) en cada render.
Ahora: la columna `puntos.sector_id` la mantiene un trigger en la DB
(`puntos_sync_sector` al insertar/mover, `sectores_resync_puntos` al crear o
borrar un sector).

```js
function pointsInSector(s) {
  return allPoints.filter((p) => {
    if (p.sector_id) return p.sector_id === s.id; // comparación de ids
    return p.lat != null && pointInGeometry(p.lng, p.lat, s.geom); // fallback
  });
}
```

El fallback cubre puntos fuera de todo sector y puntos creados antes de la
migración. Los contadores (`sectorBreakdown`) y las barras de avance heredan
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
imperativos) pero con un alcance mucho menor: **un colaborador, un sector
activo, sus puntos**.

```
boot() → getSession() ─┬─ con sesión → entrar(user)
                       └─ vista login

entrar()
  ├─ leerCola()            (localStorage: cola offline)
  ├─ refrescar()
  │    ├─ sectores_asignaciones (estado='activa', con sectores(*) anidado)
  │    └─ puntos (sector_id = mi sector; RLS ya limita igual)
  └─ pintarTodo()

tabs: ruta (lista) · mapa (MapLibre: polígono + pins) · sync (cola)
```

### Permisos del colaborador (la DB manda)

La RLS de la migración 003 hace el filtrado; el front solo pinta lo que el
servidor devuelve:

| Acción | RPC / vía | Validación en DB |
|---|---|---|
| Ver sector y puntos | SELECT | solo su sector activo + lo que él creó |
| Cambiar estado | `marcar_estado` | punto en su sector activo |
| Crear punto | `guardar_punto` | INSERT dentro del polígono (trigger calcula `sector_id`) |
| Editar punto | `actualizar_punto_terreno` | punto de su sector; coordenadas dentro del polígono |
| Borrar punto | `eliminar_punto_propio` | solo puntos con `user_id = auth.uid()` |
| Devolver sector | `devolver_sector` | su asignación activa → `estado='devuelta'` |

### Cola offline

- Cada acción fallida por red se encola en `localStorage` con
  `nuevaOpCola`/`colaAgregar` (helpers puros de `lib.js`, testeados).
- `colaAgregar` deduplica por `(tipo, clave)`: dos cambios de estado del
  mismo punto = solo el último viaja.
- `sincronizar()` reproduce la cola en orden (`ejecutarOp`): si la red
  falla se corta; si el servidor rechaza (p. ej. sector devuelto) se
  descarta la operación y se sigue.
- Disparadores: botón *Sincronizar ahora*, evento `online`, e intervalo
  de 45 s mientras haya cola.
