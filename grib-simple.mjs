// Lector mínimo de GRIB2 con empaquetado simple (plantilla 5.0), para ficheros
// ya transcodificados con `grib_set -r -s packingType=grid_simple`.
// Devuelve geometría (plantilla 3.0 lat/lon regular), metadatos del intervalo
// estadístico (plantilla 4.8) y el array de valores Float32.

function readSM16(buf, off) {
  const u = buf.readUInt16BE(off);
  return (u & 0x8000 ? -1 : 1) * (u & 0x7fff);
}

export function decodeGrib2Simple(buf) {
  if (buf.slice(0, 4).toString() !== 'GRIB' || buf[7] !== 2) throw new Error('no es GRIB2');
  let off = 16;
  const out = { grid: null, stat: null, values: null };
  let R = 0, E = 0, D = 0, nbits = 0, npts = 0;
  let bitmap = null;

  while (off < buf.length - 4) {
    if (buf.slice(off, off + 4).toString() === '7777') break;
    const len = buf.readUInt32BE(off);
    const sec = buf[off + 4];

    if (sec === 3) {
      const tmpl = buf.readUInt16BE(off + 12);
      if (tmpl !== 0) throw new Error('plantilla de grid no soportada: ' + tmpl);
      out.grid = {
        ni: buf.readUInt32BE(off + 30),
        nj: buf.readUInt32BE(off + 34),
        la1: buf.readInt32BE(off + 46) / 1e6,
        lo1: buf.readInt32BE(off + 50) / 1e6,
        la2: buf.readInt32BE(off + 55) / 1e6,
        lo2: buf.readInt32BE(off + 59) / 1e6,
        di: buf.readUInt32BE(off + 63) / 1e6,
        dj: buf.readUInt32BE(off + 67) / 1e6,
        scan: buf[off + 71],
      };
    } else if (sec === 4) {
      const tmpl = buf.readUInt16BE(off + 7);
      out.stat = { template: tmpl };
      if (tmpl === 8) {
        out.stat.endYear = buf.readUInt16BE(off + 34);
        out.stat.endMonth = buf[off + 36];
        out.stat.endDay = buf[off + 37];
        out.stat.endHour = buf[off + 38];
        out.stat.process = buf[off + 46]; // 2 = máximo, 3 = mínimo
        out.stat.rangeUnit = buf[off + 48]; // 1 = hora
        out.stat.rangeLen = buf.readUInt32BE(off + 49);
      }
    } else if (sec === 5) {
      npts = buf.readUInt32BE(off + 5);
      const tmpl = buf.readUInt16BE(off + 9);
      if (tmpl !== 0) throw new Error('empaquetado no soportado: ' + tmpl + ' (¿falta grib_set?)');
      R = buf.readFloatBE(off + 11);
      E = readSM16(buf, off + 15);
      D = readSM16(buf, off + 17);
      nbits = buf[off + 19];
    } else if (sec === 6) {
      const ind = buf[off + 5];
      if (ind === 0) bitmap = buf.slice(off + 6, off + len);
      else if (ind !== 255) throw new Error('bitmap no soportado: ' + ind);
    } else if (sec === 7) {
      const data = buf.slice(off + 5, off + len);
      const scale = Math.pow(2, E), dscale = Math.pow(10, -D);
      const vals = new Float32Array(out.grid ? out.grid.ni * out.grid.nj : npts).fill(NaN);
      let vi = 0;
      const put = (x) => { vals[vi++] = (R + x * scale) * dscale; };
      if (nbits === 0) {
        // Campo constante
        for (let i = 0; i < vals.length; i++) if (!bitmap || (bitmap[i >> 3] >> (7 - (i & 7))) & 1) { vals[i] = R * dscale; }
        out.values = vals;
      } else if (!bitmap) {
        if (nbits === 16) {
          for (let i = 0; i + 1 < data.length && vi < vals.length; i += 2) put(data.readUInt16BE(i));
        } else if (nbits === 8) {
          for (let i = 0; i < data.length && vi < vals.length; i++) put(data[i]);
        } else if (nbits === 24) {
          for (let i = 0; i + 2 < data.length && vi < vals.length; i += 3) put((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        } else {
          // Lector de bits genérico
          let acc = 0, nacc = 0, di = 0;
          while (vi < vals.length && di < data.length) {
            acc = (acc << 8) | data[di++];
            nacc += 8;
            while (nacc >= nbits && vi < vals.length) {
              nacc -= nbits;
              put((acc >>> nacc) & ((1 << nbits) - 1));
              acc &= (1 << nacc) - 1;
            }
          }
        }
        out.values = vals;
      } else {
        throw new Error('bitmap con datos: no implementado');
      }
    }
    off += len;
  }
  if (!out.values || !out.grid) throw new Error('GRIB incompleto');
  return out;
}
