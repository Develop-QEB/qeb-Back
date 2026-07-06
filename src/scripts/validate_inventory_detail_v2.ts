// Compara byte-a-byte la respuesta de computeInventoryDetailSql (nueva, con
// ROW_NUMBER + paginacion en DB) contra computeInventoryDetailLegacy (findMany
// completo + slice en JS) para ~30 combinaciones de filtros. Falla si detecta
// una sola discrepancia en items/pagination/byPlaza/allCoords.
//
// Correr: npx ts-node src/scripts/validate_inventory_detail_v2.ts
// (Usa la DB que apunta .env — normalmente DEV/PRUEBAS Hostinger.)
//
// Notas:
// - No hace mock HTTP, llama las funciones directo — no necesita JWT.
// - Mide tiempo de cada implementacion para reportar el speedup real.
// - Al final imprime un summary; exit code 1 si algun test fallo.
import { DashboardController, InventoryDetailParams, InventoryDetailResult } from '../controllers/dashboard.controller';

const ctrl = new DashboardController();

type TestCase = {
  name: string;
  params: Partial<InventoryDetailParams>;
};

const base: InventoryDetailParams = {
  estados: [], ciudades: [], formatos: [], nses: [], tipos: [],
  catorcena_id: undefined, fecha_inicio: undefined, fecha_fin: undefined,
  estatusFiltro: undefined,
  pageNum: 1, limitNum: 50, skip: 0, wantCoords: false,
};
const withPage = (p: Partial<InventoryDetailParams>): InventoryDetailParams => {
  const merged = { ...base, ...p };
  merged.skip = (merged.pageNum - 1) * merged.limitNum;
  return merged;
};

// Set representativo de filtros para deep-diff.
const CASES: TestCase[] = [
  { name: 'sin filtros - page 1',                   params: { } },
  { name: 'sin filtros - page 2',                   params: { pageNum: 2 } },
  { name: 'sin filtros - page 10 (edge)',           params: { pageNum: 10 } },
  { name: 'sin filtros - limit 100',                params: { limitNum: 100 } },
  { name: 'sin filtros - includeCoords',            params: { wantCoords: true } },

  { name: 'estatus=Vendido',                        params: { estatusFiltro: 'Vendido' } },
  { name: 'estatus=Vendido + includeCoords',        params: { estatusFiltro: 'Vendido', wantCoords: true } },
  { name: 'estatus=Reservado',                      params: { estatusFiltro: 'Reservado' } },
  { name: 'estatus=Disponible',                     params: { estatusFiltro: 'Disponible' } },
  { name: 'estatus=Bloqueado',                      params: { estatusFiltro: 'Bloqueado' } },
  { name: 'estatus=ValorInexistente (empty)',       params: { estatusFiltro: 'NoExiste' } },

  { name: 'estado=Jalisco',                         params: { estados: ['Jalisco'] } },
  { name: 'estado=Jalisco + estatus=Vendido',       params: { estados: ['Jalisco'], estatusFiltro: 'Vendido' } },
  { name: 'plaza=Guadalajara',                      params: { ciudades: ['Guadalajara'] } },
  { name: 'multi estado (Jalisco,CDMX,NL)',         params: { estados: ['Jalisco', 'CDMX', 'Nuevo Leon'] } },
  { name: 'tipo=Tradicional',                       params: { tipos: ['Tradicional'] } },
  { name: 'tipo=Digital',                           params: { tipos: ['Digital'] } },
  { name: 'combo estado+plaza+tipo',                params: { estados: ['Jalisco'], ciudades: ['Guadalajara'], tipos: ['Tradicional'] } },

  { name: 'fechas custom (rango pequeno)',          params: { fecha_inicio: '2026-04-01', fecha_fin: '2026-04-14' } },
  { name: 'fechas custom + estatus=Vendido',        params: { fecha_inicio: '2026-04-01', fecha_fin: '2026-04-14', estatusFiltro: 'Vendido' } },
  { name: 'fechas custom + includeCoords',          params: { fecha_inicio: '2026-04-01', fecha_fin: '2026-04-14', wantCoords: true } },

  { name: 'page tamano 1',                          params: { limitNum: 1 } },
  { name: 'page tamano 500',                        params: { limitNum: 500 } },
];

type Diff = { path: string; legacy: unknown; sql: unknown };

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

// Normaliza byPlaza para deep-diff: sort por (count desc, plaza asc) — el sort
// por count solo del codigo original no es estable ante ties.
function normalize(r: InventoryDetailResult): InventoryDetailResult {
  const byPlaza = [...r.byPlaza].sort((a, b) => b.count - a.count || a.plaza.localeCompare(b.plaza));
  const allCoords = [...r.allCoords].sort((a, b) => a.id - b.id);
  return { ...r, byPlaza, allCoords };
}

function diff(pathPrefix: string, legacy: unknown, sql: unknown, out: Diff[]): void {
  const ls = stableStringify(legacy);
  const ss = stableStringify(sql);
  if (ls === ss) return;

  // Bajamos un nivel para localizar la diferencia
  if (Array.isArray(legacy) && Array.isArray(sql)) {
    if (legacy.length !== sql.length) {
      out.push({ path: pathPrefix + '.length', legacy: legacy.length, sql: sql.length });
      return;
    }
    for (let i = 0; i < legacy.length; i++) {
      diff(`${pathPrefix}[${i}]`, legacy[i], sql[i], out);
    }
    return;
  }
  if (legacy && sql && typeof legacy === 'object' && typeof sql === 'object') {
    const keys = new Set([...Object.keys(legacy), ...Object.keys(sql)]);
    for (const k of keys) {
      diff(`${pathPrefix}.${k}`, (legacy as Record<string, unknown>)[k], (sql as Record<string, unknown>)[k], out);
    }
    return;
  }
  out.push({ path: pathPrefix, legacy, sql });
}

async function runCase(tc: TestCase) {
  const params = withPage(tc.params);
  const tLegacyStart = Date.now();
  const legacy = await ctrl.computeInventoryDetailLegacy(params);
  const tLegacy = Date.now() - tLegacyStart;
  const tSqlStart = Date.now();
  const sql = await ctrl.computeInventoryDetailSql(params);
  const tSql = Date.now() - tSqlStart;

  const diffs: Diff[] = [];
  diff('items', legacy.items, sql.items, diffs);
  diff('pagination', legacy.pagination, sql.pagination, diffs);
  diff('byPlaza', normalize(legacy).byPlaza, normalize(sql).byPlaza, diffs);
  diff('allCoords', normalize(legacy).allCoords, normalize(sql).allCoords, diffs);

  return { tc, tLegacy, tSql, diffs, legacyTotal: legacy.pagination.total, sqlTotal: sql.pagination.total };
}

async function main() {
  console.log('Validando computeInventoryDetailSql vs computeInventoryDetailLegacy');
  console.log(`Casos: ${CASES.length}\n`);

  let failed = 0;
  const speedups: number[] = [];
  for (const tc of CASES) {
    process.stdout.write(`  ${tc.name.padEnd(46)} `);
    try {
      const r = await runCase(tc);
      const speedup = r.tSql > 0 ? r.tLegacy / r.tSql : 1;
      speedups.push(speedup);
      if (r.diffs.length === 0) {
        process.stdout.write(`OK  legacy=${r.tLegacy}ms sql=${r.tSql}ms  (${speedup.toFixed(1)}x)  total=${r.sqlTotal}\n`);
      } else {
        failed++;
        process.stdout.write(`FAIL ${r.diffs.length} diffs — legacy=${r.tLegacy}ms sql=${r.tSql}ms\n`);
        // Mostrar hasta 3 diffs para no explotar la consola
        for (const d of r.diffs.slice(0, 3)) {
          console.log(`      ${d.path}: legacy=${JSON.stringify(d.legacy)?.slice(0,120)} sql=${JSON.stringify(d.sql)?.slice(0,120)}`);
        }
        if (r.diffs.length > 3) console.log(`      ... y ${r.diffs.length - 3} mas`);
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`ERROR ${msg}\n`);
    }
  }

  const avgSpeedup = speedups.length > 0 ? speedups.reduce((a,b) => a+b, 0) / speedups.length : 0;
  console.log(`\nResumen: ${CASES.length - failed}/${CASES.length} OK.  Speedup promedio: ${avgSpeedup.toFixed(1)}x`);
  if (failed > 0) {
    console.log(`\n${failed} casos con diferencias. Revisar antes de mergear.`);
    process.exit(1);
  } else {
    console.log('Todo cuadra. Deep-diff limpio.');
  }
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
