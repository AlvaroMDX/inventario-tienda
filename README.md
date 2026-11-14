# Inventario de la tienda

App web sin login ni servidor para llevar el inventario de una tienda desde el móvil.
Se instala en Android como una app más y funciona sin conexión.

## Qué hace

- Logo y nombre de la tienda personalizables (pulsa el recuadro del logo o el título).
- Productos con referencia, nombre, foto, precio y unidades.
- En el listado: `−` / `+` para restar o sumar una unidad; si pulsas el número puedes sumar, restar o fijar
  una cantidad (recuento) con nota.
- **Venta**: buscas productos, ajustas unidades y precio, y al registrarla descuenta del inventario.
  Las ventas se pueden anular desde el Historial (devuelve las unidades).
- **Exportar** a Excel o PDF el inventario actual o un tramo de fechas (stock inicial y final, entradas,
  vendidas, otras salidas e importe vendido; en Excel además las hojas de ventas y movimientos).
- **Copia de seguridad** en Ajustes: descarga un `.json` con todo (fotos incluidas) y lo restaura.

## Dónde están los datos

En el propio navegador del móvil (IndexedDB). No salen del dispositivo. Si se borran los datos de Chrome
o se cambia de móvil se pierden, así que conviene descargar la copia de seguridad de vez en cuando
(la app avisa si pasa una semana sin hacerla).

## Ponerla en el móvil

Tiene que servirse por `https` (por ejemplo GitHub Pages). En el móvil:
Chrome → abrir la dirección → menú ⋮ → **Añadir a pantalla de inicio** / **Instalar aplicación**.

Para probarla en el ordenador basta con abrir `index.html` (ahí no se instala ni funciona sin conexión,
y los datos son distintos de los del móvil).

## Actualizar

Al cambiar ficheros, sube `VERSION` en `sw.js` para que el móvil descarte la caché vieja.
