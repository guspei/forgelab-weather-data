# forgelab-weather-data

Campo diario de temperaturas mínimas y máximas para Europa, procesado del modelo
ICON-EU del DWD (open data, ~7 km) para el mapa de temperaturas de
[forgelab.studio](https://forgelab.studio/experiments/mapa-temperaturas.html).

Una GitHub Action descarga cada madrugada los campos TMIN_2M/TMAX_2M del run 00z
(+120 h), agrega mínima y máxima por día local (Europe/Berlin) y publica en la
rama `data` un raster Uint8 cuantizado a 0,5 °C (retícula regular de 0,0625°,
recorte lat 34–70,5 / lon -23,5–38,5, 5 días):

- `temperaturas-eu-hd.bin.gz` — cabecera JSON (longitud en los primeros 4 bytes
  LE) + planos `min d0..d4` y `max d0..d4`, row-major con la fila 0 al norte.
- `meta.json` — run, fechas y tamaño.

La rama `data` se reescribe en cada ejecución (un único commit) para que el
repositorio no crezca. Las ejecuciones programadas consultan primero
`https://forgelab.studio/api/map-visit` y no procesan nada si el mapa no ha
tenido visitas en las últimas 48 horas. Fuente de los datos: Deutscher Wetterdienst (DWD) open
data, licencia CC-BY 4.0 — https://opendata.dwd.de/
