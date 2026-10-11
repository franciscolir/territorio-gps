# Manual de usuario

Aplicación para levantar y clasificar puntos GPS agrupados en **sectores**
de una comuna de la Región Metropolitana.

---

## 1. Ingreso

1. Abre la app. Se muestra la pantalla de acceso.
2. Escribe tu correo y contraseña → **Ingresar**.
3. Si la sesión expira o un administrador la revoca, la app vuelve a la
   pantalla de acceso automáticamente.

Arriba a la izquierda verás la marca, tu correo y el botón de **salir**.

---

## 2. El panel lateral

El panel tiene dos zonas:

- **Sectores**: los polígonos de la comuna seleccionada, con su avance.
  Cuando eliges un sector, esta zona se compacta.
- **Puntos**: los puntos **del sector seleccionado**, con buscador de texto y
  chips de filtro por estado.

Sin sector seleccionado, la lista de puntos muestra *«Selecciona un sector
para ver sus puntos»*.

### Elegir comuna

Usa el selector **Comuna** en la cabecera. Solo aparecen las comunas
habilitadas (las desactiva un admin desde ⚙️ Ajustes). La vista salta a esa
comuna y **solo se muestran sus sectores**.

Sin comuna elegida, el panel muestra un **resumen de los sectores
asignados** (los que tienen un proceso de trabajo en curso) con su comuna,
colaborador y avance; al pulsar uno se abre esa comuna y queda el sector
seleccionado.

### Abrir / cerrar el panel

- Botón **☰** en el riel del borde izquierdo.
- En pantallas angostas (celular/tablet) el panel arranca cerrado como
  overlay: el primer clic sobre el mapa lo vuelve a cerrar.

---

## 3. Sectores

### Seleccionar

Haz clic sobre un polígono en el mapa o sobre su tarjeta en el panel. El
sector queda resaltado y habilita:

- la lista de sus puntos,
- el marcado de puntos nuevos dentro de él,
- el botón **📍 encuadrar** para ajustar la vista a su polígono.

**Esc** o el botón **Todos** (junto al título *Sectores*) deselecciona.

### Crear (solo administración)

1. Elige una comuna en el selector: en el riel del mapa, bajo la lupa 🔍,
   aparece el botón **✏️**.
2. Pulsa **✏️** y elige un color en la paleta de la barra superior.
3. Haz clic en el mapa para agregar vértices. Hay **imán (snap)** a bordes de
   comunas y sectores vecinos, y un contador en vivo de cuántos puntos caen
   dentro del trazo.
4. Cierra con **Cerrar sector** o haciendo clic en el primer vértice.
5. Ponle nombre y **Guardar**.

La base de datos recorta el polígono: nunca queda fuera de la comuna ni se
solapa con otro sector. Si el recorte deja menos del 2 % de lo dibujado, se
rechaza con un mensaje. Tras guardar verás qué porcentaje sobrevivió y cuántos
puntos quedaron dentro.

Atajos durante el trazo: **Ctrl/Cmd + Z** quita el último vértice (o botón
*Deshacer*), **Esc** cancela.

### Editar / eliminar (solo administración)

- Todo se maneja desde las **opciones ⋮** de la ficha del sector
  (*Asignar*, *Renombrar*, *Editar* → paleta de color, *Eliminar*).

### Asignar y procesos de trabajo (solo administración)

La asignación se gestiona **por sector**, desde su menú ⋮:

1. Selecciona un sector → **⋮ → Asignar**. Se abre la vista de asignación
   ocupando la zona de sectores.
2. Si el sector no tiene proceso en curso: elige el usuario y pulsa
   **Asignar**. Se inicia un **proceso de trabajo**.
3. Cuando el colaborador devuelve el sector (o tú lo cierras con
   **Devolver**), el proceso se marca **Devuelto** con su fecha y el sector
   queda libre para iniciar otro proceso.

La vista muestra el proceso **En curso** (usuario y fecha) y, debajo, el
**historial**: cada fila es un proceso con su usuario, fecha de asignación,
fecha de devolución y estado. Todo queda guardado en la base de datos.

Reglas: **un colaborador solo puede tener un proceso en curso a la vez** y
un sector solo puede tener uno activo (si ya existe, se avisa). El correo de
quien tiene el sector aparece como chip en su tarjeta y en su lista de
sectores.

---

## 4. Puntos

### Crear

1. Selecciona el sector.
2. Haz clic sobre el lugar en el mapa → aparece el pin con
   **«Guardar punto aquí»** (en zonas sin sector, haz **doble clic**).
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
- El contador y la barra de avance del sector se recalculan al instante.

### Alcance de los marcadores

El grupo de botones **Toda RM · Comuna · Sector** (abajo a la derecha) decide
qué puntos se pintan como marcadores. Solo afecta al mapa; la lista lateral
siempre muestra los del sector seleccionado. La preferencia se guarda en el
navegador (⚙️ Ajustes).

---

## 5. Buscar

Botón **🔍** en el riel. Acepta tres tipos de entrada:

1. **Dirección** (geocodificación OpenStreetMap/Nominatim, Chile).
2. **Coordenadas**: `-33.45, -70.66` (coma, punto y coma o espacio).
3. **Link de Google Maps**: pega la URL completa; se leen `@lat,lng`,
   `?q=` y `?ll=`.

En los tres casos la app vuela al lugar, deja el pin temporal y ofrece
guardar el punto ahí.

---

## 6. Modo referencia (búsqueda por radio)

1. Pulsa **◎** (barra inferior).
2. Haz clic en el mapa para fijar la referencia.
3. Mueve el **radio** (100 m – 5 km): se dibuja el círculo y se lista los
   puntos dentro, resaltados en el mapa. Clic en un resultado para volar a él.

Sirve para responder «¿qué direcciones tengo alrededor de esta esquina?».

---

## 7. App de terreno (celular)

La app de terreno es **`movil.html`** (misma URL + `/movil.html`, ver
sección 11): el colaborador ve su sector asignado, cambia estados y sincroniza
incluso sin señal. El botón de vista terreno del panel de escritorio fue
eliminado.

---

## 8. Ajustes (solo administración)

Botón **⚙️**:

- **Comunas a usar**: marca/desmarca comunas. Cambia el selector del mapa
  para **todos** los usuarios.
- **Puntos en el mapa**: alcance por defecto de los marcadores (solo este
  navegador).

---

## 9. Atajos de teclado

| Tecla | Acción |
|---|---|
| **Esc** | Cierra lo que esté encima (vista de asignación → detalle → ajustes → modal de sector → modo dibujo → deselecciona sector) |
| **Ctrl/Cmd + Z** | Deshacer último vértice mientras dibujas |
| **Enter** | Dispara la búsqueda / el login |

---

## 10. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| «Falta la tabla: ejecuta la sección 6 de schema.sql» | Falta una sección del esquema en Supabase |
| «Falta la función SQL: ejecuta la sección 8…» | Falta `guardar_sector` |
| «Solo administradores pueden…» | Operación reservada; pide permiso de admin |
| No aparece mi comuna en el selector | Un admin la desactivó en ⚙️ Ajustes |
| El sector guardó «recortado» | Se ajustó a los límites de la comuna o a sectores vecinos; el % indica cuánto se conservó |
| Un punto quedó «Sin GPS» | Se creó sin coordenadas válidas; edítalo en terreno (admin) |

---

## 11. App de terreno (colaboradores) — `movil.html`

Es la app de la cuadrilla: se abre en el celular con la misma URL + `/movil.html`
(mismo hosting que la de escritorio). Ve **solo su sector asignado y sus puntos**.

### Ingreso y sector

- Entra con tu correo y contraseña (la misma cuenta que te dio central).
- Si no tienes sector asignado ves **«Sin sector asignado»**; pulsa
  *Actualizar* cuando te lo hayan dado.
- La tarjeta superior muestra tu sector, comuna y el avance
  (visitados / erróneos / no pasar / pendientes).

### Lista y mapa

- **Ruta**: lista de puntos con filtros (Todos, Visitados, Incidencias,
  Pendientes). Cada tarjeta tiene *Cómo llegar* (abre Google Maps) y
  *Cambiar estado* (hoja con los 4 estados).
- **Mapa**: el polígono de tu sector con los pins de estado. Toca un pin
  para abrir su ficha; toca el mapa para **crear un punto nuevo** (solo
  dentro del polígono).
- Toca el nombre de un punto para ver/editar su ficha: nombre, dirección,
  notas y coordenadas (hay botón *Usar mi ubicación actual*).

### Crear, editar y borrar

- **Nuevo punto**: en el mapa, toca la ubicación → completa el nombre
  (obligatorio) → *Guardar punto*. Las coordenadas deben quedar dentro
  del sector.
- **Editar**: desde la ficha. Si mueves el punto fuera del polígono, la
  base de datos lo rechaza.
- **Borrar**: solo puedes borrar los puntos **que tú creaste** (sale el
  botón en su ficha).

### Cambiar estado y deshacer

- *Cambiar estado* → Visitado / Erróneo / No pasar / Pendiente. Tras el
  cambio aparece un aviso con **Deshacer** (unos segundos).

### Devolver el sector

- Botón **Devolver** en la tarjeta del sector. Funciona aunque no hayas
  terminado el 100 %: al confirmar, el sector vuelve a central y **dejas
  de verlo al instante** (puntos incluidos). Pídele a tu jefe que te
  asigne otro.

### Sin señal (modo offline)

- Los cambios (estado, nuevo punto, edición, borrado) se guardan en el
  teléfono y aparece el botón flotante **Sincronizar ahora (N)**.
- Al volver la señal se sincronizan solas cada cierto tiempo; si un
  cambio ya no aplica (p. ej. devolviste el sector) se descarta con aviso.
- La pestaña **Sync** muestra el detalle de lo pendiente.
