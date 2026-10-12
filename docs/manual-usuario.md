# Manual de usuario

Aplicación para levantar y clasificar puntos GPS agrupados en **territorios**
de una comuna de la Región Metropolitana.

---

## 1. Ingreso

1. Abre la app. Se muestra la pantalla de acceso.
2. Escribe tu correo y contraseña → **Ingresar**.
3. Si la sesión expira o un administrador la revoca, la app vuelve a la
   pantalla de acceso automáticamente.

Arriba a la izquierda verás la marca, tu correo y el botón de **salir**.

---

## 2. Vistas de la aplicación

Arriba hay una barra con tres vistas:

- **Territorios**: el mapa y el panel lateral (todo lo que describe este manual).
- **Historial** (solo administración): registro de trabajo.
  - Pestaña **Territorios**: **todos** los territorios, ordenados por comuna.
    Una fila por territorio — comuna, territorio, usuario (o *Sin asignar*),
    fecha de asignación, estado (**En proceso / Devuelto / Completado / Libre**),
    fecha de cierre y notas, más un botón **Ver**.
    **Ver** abre el **historial completo del territorio**: cada proceso de
    asignación como una entrada de log, con su número de orden, fecha de
    asignación, usuario, fecha de cierre, estado y notas. El número más alto
    es el proceso más reciente; si está *En proceso* aún no tiene cierre.
  - Pestaña **Puntos**: una fila por punto, **agrupado por comuna y territorio**.
    Las columnas de la izquierda muestran la comuna y el territorio en **texto
    vertical**, abarcando todas las filas del grupo; los puntos sin territorio
    aparecen como *Sin territorio*. Luego: nombre, **última visita**, estado,
    marcas de *No pasar* / *Erróneo* / *Activo* (activo = ni erróneo ni no
    pasar) y notas. Los bloques de territorio **alternan fondo** (uno con color,
    el siguiente sin color) para separarlos visualmente. El **encabezado de la
    tabla queda fijo** al hacer scroll.
  - Botón **Ver** (columna final de *Puntos*): abre la **bitácora** del punto,
    con un log por fila — fecha, tipo de movimiento, detalle y quién lo hizo.
    Registra la creación, cada cambio de estado, cambio de territorio,
    borrado/restauración, edición de notas, y las **asignaciones / devoluciones
    / cierres** del territorio en que está el punto.
- **Usuarios** (solo administración): lista del equipo con su rol, territorio en
  curso y fecha de asignación; y alta de **usuarios de terreno** (email +
  contraseña). Los usuarios creados nunca son administradores.
- **Exportar CSV**: el botón a la derecha de las pestañas descarga la vista de
  **Historial** en CSV — en *Territorios* exporta **todos** los procesos de cada
  territorio (comuna, territorio, nº de proceso, usuario, asignación, cierre,
  estado y notas); en *Puntos* exporta la tabla tal como se ve. En **Usuarios**
  descarga la lista del equipo, y dentro de la bitácora (el **Ver**) hay otro
  botón que descarga ese log. Los archivos se descargan con nombre
  `historial-territorios-AAAA-MM-DD.csv` (o `historial-puntos`, `usuarios`,
  `bitacora-punto`) y Excel los abre directamente con los acentos correctos.

---

## 3. El panel lateral

El panel tiene dos zonas:

- **Territorios**: los polígonos de la comuna seleccionada, con su avance.
  Cuando eliges un territorio, esta zona se compacta.
- **Puntos**: los puntos **del territorio seleccionado**, con buscador de texto y
  chips de filtro por estado.

Sin territorio seleccionado, la lista de puntos muestra *«Selecciona un territorio
para ver sus puntos»*.

### Elegir comuna

Usa el selector **Comuna** en la cabecera. Solo aparecen las comunas
habilitadas (las desactiva un admin desde ⚙️ Ajustes). La vista salta a esa
comuna y **solo se muestran sus territorios**.

Sin comuna elegida, el panel muestra los **territorios activos** (los que tienen
un proceso de trabajo en curso) dentro de un **marco verde** con ese título y el
total, para que se distinga de un vistazo; cada tarjeta trae su comuna,
colaborador y avance. Al pulsar una se abre esa comuna y queda el territorio
seleccionado.

### Abrir / cerrar el panel

- Botón **☰** en el riel del borde izquierdo.
- En pantallas angostas (celular/tablet) el panel arranca cerrado como
  overlay: el primer clic sobre el mapa lo vuelve a cerrar.

---

## 4. Territorios

### Seleccionar

Haz clic sobre un polígono en el mapa o sobre su tarjeta en el panel. El
territorio queda resaltado y habilita:

- la lista de sus puntos,
- el marcado de puntos nuevos dentro de él,
- el botón **📍 encuadrar** para ajustar la vista a su polígono.

**Esc** o el botón **Todos** (junto al título *Territorios*) deselecciona.

### Crear (solo administración)

1. Elige una comuna en el selector: en el riel del mapa, bajo la lupa 🔍,
   aparece el botón **✏️**.
2. Pulsa **✏️** y elige un color en la paleta de la barra superior.
3. Haz clic en el mapa para agregar vértices. Hay **imán (snap)** a bordes de
   comunas y territorios vecinos, y un contador en vivo de cuántos puntos caen
   dentro del trazo.
4. Cierra con **Cerrar territorio** o haciendo clic en el primer vértice.
5. Ponle nombre y **Guardar**.

La base de datos recorta el polígono: nunca queda fuera de la comuna ni se
solapa con otro territorio. Si el recorte deja menos del 2 % de lo dibujado, se
rechaza con un mensaje. Tras guardar verás qué porcentaje sobrevivió y cuántos
puntos quedaron dentro.

Atajos durante el trazo: **Ctrl/Cmd + Z** quita el último vértice (o botón
*Deshacer*), **Esc** cancela.

### Editar / eliminar (solo administración)

- Todo se maneja desde las **opciones ⋮** de la ficha del territorio
  (*Asignar*, *Renombrar*, *Editar* → paleta de color, *Eliminar*).

### Exportar el territorio

El menú **⋮** de la ficha tiene dos exportaciones, visibles para cualquier
usuario que pueda ver el territorio:

- **Exportar GeoJSON** — un archivo con el **polígono del territorio** y
  **todos sus puntos**, cada uno con su estado, dirección, notas y última
  visita. Se abre en QGIS, [geojson.io](https://geojson.io) o Google Earth:
  es lo que compartes con quien no usa la app. Nombre:
  `territorio-comuna-nombre-AAAA-MM-DD.geojson`.
- **Exportar puntos (CSV)** — los mismos puntos en planilla, con columnas
  *Punto, Dirección, Estado, Última visita, Notas, Lat, Lng*. Se abre
  directo en Excel. Nombre: `territorio-comuna-nombre-AAAA-MM-DD.csv`.

### Asignar y procesos de trabajo (solo administración)

La asignación se gestiona **por territorio**, desde su menú ⋮:

1. Selecciona un territorio → **⋮ → Asignar**. Se abre la vista de asignación
   ocupando la zona de territorios.
2. Si el territorio no tiene proceso en curso: elige el usuario y pulsa
   **Asignar**. Se inicia un **proceso de trabajo**: los puntos visitados
   vuelven a `pendiente` (los marcados como erróneo o no pasar se conservan).
3. El proceso se cierra de una de estas formas:
   - **Automática**: cuando ya no quedan puntos `pendiente` en el territorio,
     también al abrirlo si ya no quedaba nada por visitar (un territorio cuyos
     puntos estén todos en *Erróneo* o *No pasar* ya está cubierto).
   - **Completar** (manual): tú cierras el proceso, con notas opcionales.
   - **Devolver**: el colaborador lo devuelve (o tú lo devuelves) y el proceso
      queda **Devuelto**.

En todos los casos el territorio queda libre para iniciar un proceso nuevo.

La vista muestra el proceso **En proceso** (usuario y fecha) y, debajo, el
**historial**: cada fila es un proceso con su usuario, fecha de asignación,
fecha de cierre y estado (**En proceso / Devuelto / Completado**). Todo queda
guardado en la base de datos (y también en la vista **Historial**).

Reglas: **un colaborador solo puede tener un proceso en curso a la vez** y
un territorio solo puede tener uno activo (si ya existe, se avisa). El correo de
quien tiene el territorio aparece como chip en su tarjeta y en su lista de
territorios.

---

## 5. Puntos

### Crear

1. Selecciona el territorio.
2. Haz clic sobre el lugar en el mapa → aparece el pin con
   **«Guardar punto aquí»** (en zonas sin territorio, haz **doble clic**).
   Si haces clic **encima de un punto ya marcado** no se ofrece guardar:
   se abren directamente sus detalles.
3. Completa nombre (obligatorio), dirección, estado y notas → **Guardar**.

También puedes usar el botón **⊕** (abajo a la derecha) para abrir el
formulario con coordenadas en cero y llenarlas a mano.

### Ver detalles

Haz clic sobre el **pin de un punto en el mapa** (o en el botón **Detalles**
de la tarjeta): coordenadas, enlace a Google Maps, notas y, si eres admin,
editar o eliminar. Al pasar el cursor sobre un pin este se agranda
levemente; al seleccionarlo desde la lista queda resaltado con un anillo
de color.

### Cambiar el estado

Cada tarjeta trae 4 botones: **Pendiente · Visitado · Erróneo · No pasar**.
Tras marcar aparece un aviso con **Deshacer** (5 segundos). El mismo flujo
existe en la app de terreno (`movil.html`).

> Los estados los puede marcar cualquier usuario con acceso a la app: es la
> operación de terreno. Editar nombre, dirección, notas, coordenadas o
> eliminar puntos es exclusivo de administración.

### Filtrar

- Texto libre: nombre o dirección.
- Chips **Todos / Pendiente / Visitado / Erróneo / No pasar**.
- El contador y la barra de avance del territorio se recalculan al instante.

La lista muestra de a **100 tarjetas**; si hay más, al final aparece un botón
**Cargar más · quedan N**. Cambiar de territorio o de filtro vuelve al
principio de la lista.

### Alcance de los marcadores

El grupo de botones **Toda RM · Comuna · Territorio** (abajo a la derecha) decide
qué puntos se pintan como marcadores. Solo afecta al mapa; la lista lateral
siempre muestra los del territorio seleccionado. La preferencia se guarda en el
navegador (⚙️ Ajustes).

Con **Toda RM** y más de 150 puntos visibles, el mapa agrupa los que están
cerca: verás una **burbuja azul con el número** de puntos que contiene. Haz
clic para acercarte y el grupo se abre solo. Al elegir un punto desde la
lista, ese punto siempre aparece suelto y resaltado.

---

## 6. Buscar

Botón **🔍** en el riel. Acepta tres tipos de entrada:

1. **Dirección** (geocodificación OpenStreetMap/Nominatim, Chile).
2. **Coordenadas**: `-33.45, -70.66` (coma, punto y coma o espacio).
3. **Link de Google Maps**: pega la URL completa; se leen `@lat,lng`,
   `?q=` y `?ll=`.

En los tres casos la app vuela al lugar, deja el pin temporal y ofrece
guardar el punto ahí.

> La dirección se guarda en el navegador durante **7 días**: si repites la
> misma búsqueda es **instantánea** (y funciona sin conexión). Entre una
> consulta y la siguiente a OpenStreetMap espera al menos **1 segundo**, que
> es lo que exige su política de uso.

---

## 7. Modo referencia (búsqueda por radio)

1. Pulsa **◎** (barra inferior).
2. Haz clic en el mapa para fijar la referencia.
3. Mueve el **radio** (100 m – 5 km): se dibuja el círculo y se lista los
   puntos dentro, resaltados en el mapa. Clic en un resultado para volar a él.

Sirve para responder «¿qué direcciones tengo alrededor de esta esquina?».

---

## 8. App de terreno (celular)

La app de terreno es **`movil.html`** (misma URL + `/movil.html`, ver
sección 11): el colaborador ve su territorio asignado, cambia estados y sincroniza
incluso sin señal. El botón de vista terreno del panel de escritorio fue
eliminado.

---

## 9. Ajustes (solo administración)

Botón **⚙️**:

- **Comunas a usar**: marca/desmarca comunas. Cambia el selector del mapa
  para **todos** los usuarios.
- **Puntos en el mapa**: alcance por defecto de los marcadores (solo este
  navegador).

---

## 10. Atajos de teclado

| Tecla | Acción |
|---|---|
| **Esc** | Cierra lo que esté encima (vista de asignación → detalle → ajustes → modal de territorio → modo dibujo → deselecciona territorio) |
| **Ctrl/Cmd + Z** | Deshacer último vértice mientras dibujas |
| **Enter** | Dispara la búsqueda / el login |

---

## 11. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| «Falta la tabla: ejecuta la sección 6 de schema.sql» | Falta una sección del esquema en Supabase |
| «Falta la función SQL: ejecuta la sección 8…» | Falta `guardar_territorio` |
| «Solo administradores pueden…» | Operación reservada; pide permiso de admin |
| No aparece mi comuna en el selector | Un admin la desactivó en ⚙️ Ajustes |
| El territorio guardó «recortado» | Se ajustó a los límites de la comuna o a territorios vecinos; el % indica cuánto se conservó |
| Un punto quedó «Sin GPS» | Se creó sin coordenadas válidas; edítalo en terreno (admin) |

---

## 12. App de terreno (colaboradores) — `movil.html`

Es la app de la cuadrilla: se abre en el celular con la misma URL + `/movil.html`
(mismo hosting que la de escritorio). Ve **solo su territorio asignado y sus puntos**.

### Ingreso y territorio

- Entra con tu correo y contraseña (la misma cuenta que te dio central).
- Si no tienes territorio asignado ves **«Sin territorio asignado»**; pulsa
  *Actualizar* cuando te lo hayan dado.
- La tarjeta superior muestra tu territorio, comuna y el avance
  (visitados / erróneos / no pasar / pendientes).

### Lista y mapa

- **Ruta**: lista de puntos con filtros (Todos, Visitados, Incidencias,
  Pendientes). Cada tarjeta tiene *Cómo llegar* (abre Google Maps) y
  *Cambiar estado* (hoja con los 4 estados).
- **Mapa**: el polígono de tu territorio con los pins de estado. Toca un pin
  para abrir su ficha; toca el mapa para **crear un punto nuevo** (solo
  dentro del polígono).
- Toca el nombre de un punto para ver/editar su ficha: nombre, dirección,
  notas y coordenadas (hay botón *Usar mi ubicación actual*).

### Crear, editar y borrar

- **Nuevo punto**: en el mapa, toca la ubicación → completa el nombre
  (obligatorio) → *Guardar punto*. Las coordenadas deben quedar dentro
  del territorio.
- **Editar**: desde la ficha. Si mueves el punto fuera del polígono, la
  base de datos lo rechaza.
- **Borrar**: solo puedes borrar los puntos **que tú creaste** (sale el
  botón en su ficha).

### Cambiar estado y deshacer

- *Cambiar estado* → Visitado / Erróneo / No pasar / Pendiente. Tras el
  cambio aparece un aviso con **Deshacer** (unos segundos).

### Devolver el territorio

- Botón **Devolver** en la tarjeta del territorio. Funciona aunque no hayas
  terminado el 100 %: al confirmar, el territorio vuelve a central y **dejas
  de verlo al instante** (puntos incluidos). Pídele a tu jefe que te
  asigne otro.

### Instalar en el celular (app instalable)

- **Android / Chrome**: menú ⋮ → *Instalar aplicación* (o *Añadir a pantalla
  de inicio*). **iPhone / Safari**: compartir → *Añadir a pantalla de inicio*.
- Queda un ícono con el pin blanco sobre azul marino y la app abre a pantalla
  completa, sin barra del navegador.
- La primera vez que la abres se descarga una copia de la app (**service
  worker**). A partir de ahí abre aunque no haya señal: ya está guardada.

### Sin señal (modo offline)

- Los cambios (estado, nuevo punto, edición, borrado) se guardan en el
  teléfono y aparece el botón flotante **Sincronizar ahora (N)**.
- Al volver la señal se sincronizan solas cada cierto tiempo; si un
  cambio ya no aplica (p. ej. devolviste el territorio) se descarta con aviso.
- La pestaña **Sync** muestra el detalle de lo pendiente.
- Los datos que ves también se guardan: si abres la app sin conexión se
  muestran los **últimos puntos y territorios cargados**. Con la cola de la
  sección anterior, el trabajo de terreno no se detiene.
