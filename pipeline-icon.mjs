// Pipeline ICON-EU → campo diario mín/máx cuantizado para el mapa de temperaturas.
//
// Descarga TMIN_2M/TMAX_2M del último run completo de ICON-EU (DWD open data),
// transcodifica CCSDS→simple con eccodes (grib_set), decodifica en Node,
// agrega por día local (Europe/Berlin, ventana móvil de 6 h → día del punto
// medio) y emite un raster Uint8 cuantizado a 0,5 °C.
//
// Uso: node pipeline-icon.mjs [dirSalida]
// Requiere: curl, bunzip2, grib_set (eccodes) en el PATH.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeGrib2Simple } from './grib-simple.mjs';

const run = promisify(execFile);
const OUT_DIR = process.argv[2] || '.';
const TMP = join(tmpdir(), 'icon-eu-' + process.pid);
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const BASE = 'https://opendata.dwd.de/weather/nwp/icon-eu/grib';
const VARS = [
  { dir: 'tmin_2m', name: 'TMIN_2M', kind: 'min' },
  { dir: 'tmax_2m', name: 'TMAX_2M', kind: 'max' },
];
// Pasos de ICON-EU: horario hasta +78, cada 3 h hasta +120 (el run acaba ahí)
const STEPS = [];
for (let s = 1; s <= 78; s++) STEPS.push(s);
for (let s = 81; s <= 120; s += 3) STEPS.push(s);
const NDAYS = 5; // +120 h desde el run 00z cubren 5 días locales completos

// Recorte de salida: fila 0 = lat 70,5 (norte) … lat 34; col 0 = lon -23,5 … 38,5
const NY = 585, NX = 993, LAT0 = 70.5, LON0 = -23.5, D = 0.0625;
const FULL_NI = 1377, FULL_NJ = 657, FULL_LA1 = 29.5;
const Q = v => {
  const q = Math.round((v - 273.15 + 30) * 2);
  return q < 0 ? 0 : q > 250 ? 250 : q;
};

const fileUrl = (runId, v, step) =>
  `${BASE}/${runId.slice(8)}/${v.dir}/icon-eu_europe_regular-lat-lon_single-level_${runId}_${String(step).padStart(3, '0')}_${v.name}.grib2.bz2`;

async function head(url) {
  try {
    const { stdout } = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-I', '--max-time', '20', url]);
    return stdout.trim() === '200';
  } catch { return false; }
}

async function discoverRun() {
  const now = new Date();
  // Solo runs 00z: cubren los 5 días locales completos (un 12z dejaría el
  // día 0 sin la madrugada y la mínima de hoy saldría mal)
  const cands = [];
  for (const back of [0, 1]) {
    const d = new Date(now.getTime() - back * 86400e3);
    cands.push(d.toISOString().slice(0, 10).replace(/-/g, '') + '00');
  }
  for (const c of cands) {
    if (await head(fileUrl(c, VARS[1], 120))) return c;
  }
  throw new Error('ningún run completo disponible');
}

function berlinDate(ms) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(ms));
}

async function main() {
  const runId = await discoverRun();
  const runStartMs = Date.UTC(+runId.slice(0, 4), +runId.slice(4, 6) - 1, +runId.slice(6, 8), +runId.slice(8));
  const dates = Array.from({ length: NDAYS }, (_, i) => berlinDate(runStartMs + (2 + i * 24) * 3600e3));
  const dayIdx = new Map(dates.map((d, i) => [d, i]));
  console.error(`run ${runId} · días ${dates[0]} … ${dates[dates.length - 1]} · ${STEPS.length * VARS.length} ficheros`);

  const planes = { min: new Uint8Array(NDAYS * NY * NX).fill(255), max: new Uint8Array(NDAYS * NY * NX).fill(255) };
  let done = 0, failed = 0;

  async function processOne(v, step) {
    const bz = join(TMP, `${v.name}_${step}.grib2.bz2`);
    const raw = bz.slice(0, -4);
    const simple = raw.replace('.grib2', '.simple.grib2');
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await run('curl', ['-sf', '--max-time', '120', '-o', bz, fileUrl(runId, v, step)]);
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      await run('bunzip2', ['-f', bz]);
      await run('grib_set', ['-r', '-s', 'packingType=grid_simple', raw, simple]);
      const g = decodeGrib2Simple(readFileSync(simple));
      const rangeMin = g.stat && g.stat.rangeUnit === 0 ? g.stat.rangeLen : (g.stat ? g.stat.rangeLen * 60 : 360);
      const midMs = runStartMs + step * 3600e3 - (rangeMin * 60e3) / 2;
      const di = dayIdx.get(berlinDate(midMs));
      if (di === undefined) return;
      const plane = planes[v.kind];
      const base = di * NY * NX;
      const vals = g.values;
      for (let r = 0; r < NY; r++) {
        const fullRow = (FULL_NJ - 1 - r) * FULL_NI; // fila 0 de salida = norte; grid escanea de sur a norte
        const outRow = base + r * NX;
        for (let c = 0; c < NX; c++) {
          const x = vals[fullRow + c];
          if (x !== x) continue;
          const q = Q(x);
          const cur = plane[outRow + c];
          if (cur === 255 || (v.kind === 'min' ? q < cur : q > cur)) plane[outRow + c] = q;
        }
      }
    } finally {
      for (const f of [bz, raw, simple]) { try { rmSync(f, { force: true }); } catch {} }
      done++;
      if (done % 25 === 0) console.error(`  ${done}/${STEPS.length * VARS.length}`);
    }
  }

  const jobs = [];
  for (const v of VARS) for (const step of STEPS) jobs.push([v, step]);
  const CONC = 6;
  let ji = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (ji < jobs.length) {
      const [v, step] = jobs[ji++];
      try { await processOne(v, step); } catch (e) { failed++; console.error(`  fallo ${v.name}+${step}: ${e.message}`); }
    }
  }));
  if (failed > STEPS.length / 4) throw new Error(`demasiados fallos: ${failed}`);

  const header = Buffer.from(JSON.stringify({
    v: 1, model: 'icon-eu', run: runId, dates, ny: NY, nx: NX,
    lat0: LAT0, lon0: LON0, d: D, scale: 0.5, offset: -30, nan: 255,
    order: 'min d0..d6, max d0..d6; row-major, fila 0 = norte',
    generated: new Date().toISOString(),
  }));
  const head4 = Buffer.alloc(4);
  head4.writeUInt32LE(header.length);
  const bin = Buffer.concat([head4, header, Buffer.from(planes.min), Buffer.from(planes.max)]);
  writeFileSync(join(OUT_DIR, 'temperaturas-eu-hd.bin'), bin);
  writeFileSync(join(OUT_DIR, 'temperaturas-eu-hd.bin.gz'), gzipSync(bin, { level: 9 }));
  writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify({ run: runId, dates, failed, bytes: bin.length }, null, 2));

  // Sondas de cordura (día 0)
  const probe = (lat, lon) => {
    const r = Math.round((LAT0 - lat) / D), c = Math.round((lon - LON0) / D);
    const i = r * NX + c;
    const mn = planes.min[i], mx = planes.max[i];
    return (mn === 255 ? '–' : (mn * 0.5 - 30).toFixed(1)) + '/' + (mx === 255 ? '–' : (mx * 0.5 - 30).toFixed(1));
  };
  console.error(`OK · fallos: ${failed} · bin: ${(bin.length / 1e6).toFixed(1)} MB · gz: ${(gzipSync(bin).length / 1e6).toFixed(1)} MB`);
  console.error(`día 0 (${dates[0]}) mín/máx °C — Madrid: ${probe(40.4, -3.7)} · Ibiza: ${probe(38.98, 1.43)} · Alpes(45.9,6.9): ${probe(45.9, 6.9)} · Kiruna(67.85,20.2): ${probe(67.85, 20.2)}`);
  rmSync(TMP, { recursive: true, force: true });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
