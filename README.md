# Territorio GPS — Gestión de Puntos · RM Chile

Aplicación web de trabajo en terreno para levantar, clasificar y agrupar
**puntos GPS en territorios** de la Región Metropolitana de Chile.

- Mapa interactivo (MapLibre GL) con polígonos de comunas y territorios dibujados a mano.
- Alta de puntos con clic en el mapa, buscador unificado (dirección · coordenadas · link de Google Maps) y búsqueda por radio de referencia.
- Estados por punto (`pendiente`, `visitado`, `erróneo`, `no_pasar`) con barra de avance y deshacer.
- Asignación de territorios a cuadrillas con ciclo de vida **en proceso / devuelto / completado** (un colaborador, un territorio a la vez; se cierra al 100 % o manualmente).
- **Vistas de escritorio**: *Territorios* (mapa + panel), *Historial* (registro de asignaciones y de puntos) y *Usuarios* (alta y estado del equipo de terreno).
- **App de terreno** (`movil.html`) para el colaborador: ve solo su territorio, crea/edita puntos, cambia estados, **devuelve el territorio** y opera con **cola offline**.
- Backend en Supabase (PostgreSQL + PostGIS + RLS).

---

## Índice

- [Requisitos](#requisitos)
- [Puesta en marcha](#puesta-en-marcha)
- [Scripts](#scripts)
- [Estructura del repo](#estructura-del-repo)
- [Roles y permisos](#roles-y-permisos)
- [Migraciones](#migraciones)
- [Tests y lint](#tests-y-lint)
- [Despliegue](#despliegue)
- [Documentación](#documentación)
- [Roadmap](#roadmap)

---

## Requisitos

- Node.js 18+ (solo para `seed`, tests y lint).
- Una cuenta [Supabase](https://supabase.com) con la extensión **PostGIS** habilitada.
- Navegador moderno (Chrome/Edge/Firefox/Safari recientes).

No hay build ni bundler: el front son archivos estáticos que se sirven tal cual
(`index.html` para central, `movil.html` para terreno).

---

## Puesta en marcha

### 1. Base de datos

1. Crea un proyecto en Supabase.
2. En **SQL Editor**, ejecuta de corrido [`schema.sql`](schema.sql).
   Es la fuente de verdad: crea tablas, RLS, RPCs, triggers e índices.
3. (Opcional, primera vez) Carga los polígonos de las comunas de la RM:

   ```bash
   cp .env.example .env        # completa URL y service_role key
   npm install
   npm run seed
   ```

   El seed descarga los límites comunales desde ArcGIS y los sube a
   `comunas_rm` con la service role key (único lugar donde se usa).

### 2. Usuarios

- Los usuarios de terreno se crean desde la vista **Usuarios** de la app
  (Edge Function `crear-usuario`; ver [Despliegue](#despliegue)), o en
  **Supabase → Authentication → Users**. El trigger `handle_new_user` crea su
  fila en `profiles` (siempre `is_admin = false`).
- Para dar permisos de administrador:

  ```sql
  update public.profiles set is_admin = true where email = 'tu@correo.cl';
  ```

### 3. Front

Edita la configuración en la parte superior de `index.html` y de `movil.js`
(misma Supabase para ambas apps):

```js
const SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_...'; // clave publicable/anon
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'; // solo index
```

Luego sirve la carpeta (cualquier servidor estático sirve):

```bash
npx serve .          # o python -m http.server, o el hosting de tu elección
```

> Abrir `index.html` con `file://` funciona en la mayoría de casos, pero se
> recomienda servirlo por HTTP (localStorage, service workers y políticas de
> CORS se comportan mejor).

---

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run seed` | Importa los polígonos de comunas RM a Supabase (usa `.env`) |
| `npm test` | Corre los tests unitarios con Vitest |
| `npm run test:watch` | Tests en modo watch |
| `npm run lint` | ESLint sobre `app.js`, `lib.js`, tests y seed |

---

## Estructura del repo

```
index.html            Shell HTML de escritorio: login, panel, mapa, modales
styles.css            CSS de escritorio (tokens Material-3 + responsive)
movil.html            App de terreno (colaborador): login, territorio único, tabs
movil.js              Lógica de terreno: fichas, estados, devolución, cola offline
lib.js                Funciones puras: geometría, EWKB, estados, escaping, links, cola offline
app.js                Estado global de escritorio, capas del mapa, renders, RPCs
schema.sql            Esquema completo (instalación nueva)
migrations/           Cambios incrementales para bases ya desplegadas
seed-comunas.js       Seed de comunas RM (ArcGIS → Supabase)
tests/lib.test.js     Tests unitarios de lib.js (Vitest)
eslint.config.js      Configuración de lint (browser + node)
supabase/functions/   Edge Functions (crear-usuario)
fonts/                Material Symbols (woff2 autoalojado)
docs/                 Arquitectura, base de datos, manual y roadmap
.env.example          Variables para el seed
```

**Por qué scripts clásicos y no módulos:** la app se sirve como archivos
estáticos y a veces se abre desde disco; `<script src>` sin `type="module"`
funciona en ambos casos. `lib.js` se declara antes que `app.js` y expone sus
funciones como globales; `eslint.config.js` lista esas globales para que el
lint detecte usos/definiciones.

---

## Roles y permisos

La regla está en la base de datos (RLS + RPCs); el front solo la refleja.

| Acción | Admin | Colaborador (terreno) |
|---|---|---|
| Ver puntos y territorios | ✔ todos | ✔ solo su **territorio activo** y sus puntos |
| Crear punto | ✔ | ✔ solo dentro del polígono de su territorio |
| **Cambiar estado** de un punto | ✔ | ✔ de su territorio (vía RPC `marcar_estado`) |
| Editar nombre/dirección/notas/coordenadas | ✔ | ✔ solo puntos de su territorio (vía `actualizar_punto_terreno`) |
| Eliminar punto | ✔ | ✔ solo los que **él creó** (vía `eliminar_punto_propio`) |
| Dibujar, renombrar, recolorear o eliminar territorios | ✔ | ✖ |
| Asignar / devolver territorios | ✔ | ✖ (solo **devuelve** el suyo, vía `devolver_territorio`) |
| Ver la lista de correos del equipo | ✔ | ✖ (la RPC devuelve 0 filas) |
| Configurar comunas activas (`app_config`) | ✔ | ✖ (lectura) |

El estado nunca se actualiza con un `update` directo: `setEstadoPunto()` llama
a `public.marcar_estado()`, que solo toca `estado` y `updated_at` y devuelve
el estado anterior para el botón **Deshacer**.

---

## Migraciones

`schema.sql` es para instalar desde cero. Si la base **ya está en
producción**, aplica solo los cambios nuevos, en orden:

| Archivo | Contenido |
|---|---|
| [`migrations/001_seguridad_p0.sql`](migrations/001_seguridad_p0.sql) | Territorios solo-admin (policy + `guardar_territorio` con advisory lock), `usuarios_asignables` solo-admin, RPC `marcar_estado` |
| [`migrations/002_rendimiento_t6.sql`](migrations/002_rendimiento_t6.sql) | Índice parcial por `estado`, columna `puntos.territorio_id` + backfill + triggers de sincronización |
| [`migrations/003_colaborador.sql`](migrations/003_colaborador.sql) | Ciclo de vida de asignaciones (activo/devuelto), RLS por territorio activo, RPCs `devolver_territorio` / `actualizar_punto_terreno` / `eliminar_punto_propio` |
| [`migrations/004_grants_tablas.sql`](migrations/004_grants_tablas.sql) | Grants explícitos de `comunas_rm`/`profiles`/`puntos` para proyectos Supabase sin default privileges |
| [`migrations/005_asignaciones_y_estado.sql`](migrations/005_asignaciones_y_estado.sql) | Clave surrogate en `territorios_asignaciones` (permite reasignar tras devolver), unicidad de activos y el colaborador ya puede cambiar estados |
| [`migrations/006_grants_asignaciones.sql`](migrations/006_grants_asignaciones.sql) | Grants de `territorios` y `territorios_asignaciones` para `authenticated` (faltaban en la 004; sin ellos la app de terreno no carga el territorio asignado) |
| [`migrations/007_rename_territorios.sql`](migrations/007_rename_territorios.sql) | Rename `sectores` → `territorios` (tablas, columna `territorio_id`, RPCs, triggers y policies) |
| [`migrations/008_historial_usuarios.sql`](migrations/008_historial_usuarios.sql) | Estado `completado` (auto al 100 % + manual), `notas` por proceso, `puntos.ultima_visita` y RPC `listar_usuarios` |

Todas son idempotentes (se pueden re-ejecutar):

```bash
psql "$DATABASE_URL" -f migrations/001_seguridad_p0.sql
psql "$DATABASE_URL" -f migrations/002_rendimiento_t6.sql
psql "$DATABASE_URL" -f migrations/003_colaborador.sql
psql "$DATABASE_URL" -f migrations/004_grants_tablas.sql
psql "$DATABASE_URL" -f migrations/005_asignaciones_y_estado.sql
psql "$DATABASE_URL" -f migrations/006_grants_asignaciones.sql
psql "$DATABASE_URL" -f migrations/007_rename_territorios.sql
psql "$DATABASE_URL" -f migrations/008_historial_usuarios.sql
```

o pega su contenido en el SQL Editor de Supabase.

---

## Tests y lint

```bash
npm test        # 30 tests sobre lib.js (geometría, EWKB, estados, links, cola offline)
npm run lint    # ESLint, 0 errores
```

`lib.js` está pensado para testearse: las funciones no tocan DOM ni estado
global, y los tests cargan su fuente con `new Function()` (ver
`tests/lib.test.js`). Si mueves una función de `app.js` a `lib.js`, agrégala
al `return` del wrapper de tests y a `libGlobals` en `eslint.config.js`.

---

## Despliegue

Es un sitio 100% estático. Opciones:

- **Supabase Hosting**, **Netlify**, **Vercel**, **GitHub Pages**, **Cloudflare Pages**: apunta la raíz del repo y listo (no hay build).
- Si usas otro servidor, sirve la carpeta con `Content-Type: text/html` para `index.html` y `application/javascript` para `*.js`.

No se sube `.env` (está en `.gitignore`); la clave anon/publicable del front
no es secreta: la protección real la da RLS.

### Edge Functions

La vista **Usuarios** crea usuarios de terreno con la función `crear-usuario`
(usa `service_role` y valida que quien llama sea admin). Despliégala una vez:

```bash
supabase functions deploy crear-usuario
```

Detalle en [`supabase/functions/crear-usuario/README.md`](supabase/functions/crear-usuario/README.md).

---

## Documentación

| Documento | Contenido |
|---|---|
| [docs/arquitectura.md](docs/arquitectura.md) | Cómo está organizado el código, estado global y flujo de datos |
| [docs/base-de-datos.md](docs/base-de-datos.md) | Tablas, policies, RPCs, triggers e índices |
| [docs/manual-usuario.md](docs/manual-usuario.md) | Manual de uso por rol |
| [docs/roadmap.md](docs/roadmap.md) | Trabajo pendiente (P2) y decisiones abiertas |

---

## Roadmap

Lo que queda fuera de esta rama (ver [docs/roadmap.md](docs/roadmap.md)):
exportación CSV/GeoJSON, historial de cambios de estado, PWA instalable con
service worker, clustering de marcadores y proxy de Nominatim.
