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

---

## P2 — pendiente

### T11 · PWA para terreno
La app de terreno ya tiene cola offline en `localStorage`; queda el lado
instalable/cacheado del navegador:
- Service worker que cachea `movil.html`, CSS, JS, fuentes y la última carga
  de puntos/territorios.
- Instalable (manifest + ícono), pantalla de «sin conexión».

### T12 · Exportación CSV / GeoJSON
- Exportar el territorio o la comuna visible: puntos (con estado y notas) y el
  polígono del territorio.
- Botón en la ficha del territorio; para compartir con quien no usa la app.

### T13 · Bitácora de cambios de estado
- La vista **Historial** ya trae el **registro vivo** por punto (última visita y
  estado) y el historial de procesos por territorio. Queda pendiente la
  **bitácora append-only** por cada cambio de estado
  (`puntos_historial (punto_id, estado_anterior, estado_nuevo, user_id, at)`),
  poblada por trigger desde `marcar_estado`.
- Sirve para auditoría fina y productividad por cuadrilla (quién visitó qué y
  cuándo, no solo el último estado).

### T14 · Marcadores y lista con muchos datos
- Clustering de marcadores (`supercluster`) cuando el alcance es «Toda RM».
- Lista virtualizada (o paginación) para territorios con miles de puntos.
- Hoy: todo cabe en memoria y se repinta completo; el cuello de botella
  real es el número de nodos DOM de marcadores.

### T15 · Geocodificación robusta
- Debounce + caché de Nominatim y respeto de su política de uso
  (identificación de la app, ≤1 req/s).
- Alternativa: proxy propio o MapLibre/Photon; sin clave no hay SLA.

### Mejoras menores abiertas
- Exportar el historial (CSV) desde las vistas Historial/Usuarios.
- Filtros persistentes (estado/territorio) entre sesiones.
- Detección de puntos duplicados al crear (mismo nombre a <10 m).
- Auditar accesibilidad: `aria-label` en botones de solo ícono, foco
  atrapado en modales, contraste de chips.
- Quedan 3 warnings de lint (`catch (_)` / `catch (_err)` sin usar);
  se resuelven al pasar a `no-unused-vars: error` con `caughtErrors`.
- Decidir si `app_config` debe permitir `DELETE` (hoy no hay policy).

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
