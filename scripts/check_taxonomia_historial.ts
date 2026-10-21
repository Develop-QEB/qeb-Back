// Valida la taxonomia del Historial de Acciones contra datos reales.
//
// Responde dos preguntas:
//   1. ¿Clasifica bien? -> distribucion por modulo/categoria y, sobre todo,
//      que porcentaje cae en "sin clasificar". Si ese numero es alto, faltan
//      patrones; imprime los textos mas frecuentes que se quedaron fuera para
//      saber cuales agregar.
//   2. ¿El filtro coincide con la etiqueta? -> por cada modulo y categoria
//      compara el conteo que da el predicado JS (el que pinta el badge)
//      contra el que da el WHERE de Prisma (el que filtra). Si difieren, hay
//      un patron mal traducido y el usuario veria filas de otra categoria al
//      filtrar. Deben cuadrar exactamente.
//
// SOLO LEE. No escribe ni altera nada.
//
// Uso (OJO: el DATABASE_URL del .env apunta a PRODUCCION):
//   DB_URL="mysql://usuario:pass@host:3306/basededatos" npx ts-node scripts/check_taxonomia_historial.ts
//
// Sin DB_URL cae al DATABASE_URL del entorno:
//   npx ts-node -r dotenv/config scripts/check_taxonomia_historial.ts
//
// La muestra son las N filas mas recientes por clave primaria
// (ORDER BY id DESC LIMIT N), que usa el indice del PK y no escanea la tabla
// — importante, porque `historial` tiene `detalles` en MEDIUMTEXT y los scans
// completos sobre ella son justo los que han tumbado el CPU.

import { PrismaClient } from '@prisma/client';
import {
  clasificar, MODULOS, CATEGORIAS, ETAPAS,
  whereModulos, whereCategorias, whereEtapas, SIN_CLASIFICAR, SIN_ETAPA,
} from '../src/utils/historialTaxonomia';

const N = Number(process.env.MUESTRA || 20000);
const url = process.env.DB_URL || process.env.DATABASE_URL;

if (!url) {
  console.error('Falta DB_URL (o DATABASE_URL). Ver el encabezado del script.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: url, log: ['error'] });

const pct = (n: number, total: number) => total === 0 ? '0.0' : ((n / total) * 100).toFixed(1);

function tabla(titulo: string, conteos: Map<string, number>, total: number, etiquetas: Map<string, string>) {
  console.log(`\n── ${titulo} ──`);
  const filas = [...conteos.entries()].sort((a, b) => b[1] - a[1]);
  for (const [value, n] of filas) {
    const label = etiquetas.get(value) ?? value;
    const barra = '█'.repeat(Math.round((n / total) * 40));
    console.log(`  ${label.padEnd(24)} ${String(n).padStart(7)}  ${pct(n, total).padStart(5)}%  ${barra}`);
  }
}

async function main() {
  const host = url!.replace(/\/\/[^@]+@/, '//***@');
  console.log(`Base: ${host}`);
  console.log(`Muestra: las ${N.toLocaleString('es-MX')} filas mas recientes por id\n`);

  const filas = await prisma.historial.findMany({
    select: { id: true, tipo: true, accion: true },
    orderBy: { id: 'desc' },
    take: N,
  });

  if (filas.length === 0) {
    console.log('La tabla `historial` esta vacia.');
    return;
  }

  const minId = filas[filas.length - 1].id;
  console.log(`Filas leidas: ${filas.length.toLocaleString('es-MX')} (id >= ${minId})`);

  // ---- 1. Distribucion ----
  const porEtapa = new Map<string, number>();
  const porModulo = new Map<string, number>();
  const porCategoria = new Map<string, number>();
  const sinModulo = new Map<string, number>();
  const sinCategoria = new Map<string, number>();

  for (const f of filas) {
    const { etapa, modulo, categoria } = clasificar(f.tipo, f.accion);
    porEtapa.set(etapa, (porEtapa.get(etapa) ?? 0) + 1);
    porModulo.set(modulo, (porModulo.get(modulo) ?? 0) + 1);
    porCategoria.set(categoria, (porCategoria.get(categoria) ?? 0) + 1);
    // Agrupa los textos no clasificados colapsando digitos, para que
    // "5 circuito(s)" y "137 circuito(s)" cuenten como el mismo caso.
    const muestra = `[${f.tipo}] ${(f.accion || '').replace(/\d+/g, '#').slice(0, 80)}`;
    if (modulo === SIN_CLASIFICAR) sinModulo.set(muestra, (sinModulo.get(muestra) ?? 0) + 1);
    if (categoria === SIN_CLASIFICAR) sinCategoria.set(muestra, (sinCategoria.get(muestra) ?? 0) + 1);
  }

  const etiquetasM = new Map(MODULOS.map(r => [r.value, r.label]));
  etiquetasM.set(SIN_CLASIFICAR, '(sin clasificar)');
  const etiquetasC = new Map(CATEGORIAS.map(r => [r.value, r.label]));
  etiquetasC.set(SIN_CLASIFICAR, '(sin clasificar)');

  const etiquetasE = new Map(ETAPAS.map(r => [r.value, r.label]));
  etiquetasE.set(SIN_ETAPA, '(fuera del flujo)');

  tabla('ETAPA (donde en el flujo)', porEtapa, filas.length, etiquetasE);
  tabla('MODULO (sobre que se actuo)', porModulo, filas.length, etiquetasM);
  tabla('CATEGORIA (que se hizo)', porCategoria, filas.length, etiquetasC);

  const otroM = porModulo.get(SIN_CLASIFICAR) ?? 0;
  const otroC = porCategoria.get(SIN_CLASIFICAR) ?? 0;
  console.log(`\nSin clasificar -> modulo: ${pct(otroM, filas.length)}%   categoria: ${pct(otroC, filas.length)}%`);

  const topSinClasificar = (m: Map<string, number>, titulo: string) => {
    if (m.size === 0) return;
    console.log(`\n── ${titulo}: textos mas frecuentes (candidatos a patron nuevo) ──`);
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([texto, n]) => console.log(`  ${String(n).padStart(6)}x  ${texto}`));
  };
  topSinClasificar(sinModulo, 'MODULO');
  topSinClasificar(sinCategoria, 'CATEGORIA');

  // ---- 2. Equivalencia filtro (SQL) vs etiqueta (JS) ----
  // El WHERE se acota al mismo rango de ids que la muestra para que los dos
  // conteos hablen de las mismas filas.
  console.log('\n── Equivalencia filtro SQL vs etiqueta JS ──');
  let discrepancias = 0;

  const comparar = async (
    tipoEje: 'etapa' | 'modulo' | 'categoria',
    value: string,
    label: string,
    esperado: number,
    where: ReturnType<typeof whereModulos>,
  ) => {
    const real = await prisma.historial.count({
      where: { AND: [{ id: { gte: minId } }, where as Record<string, unknown>] },
    });
    if (real === esperado) {
      console.log(`  ok    ${tipoEje.padEnd(9)} ${label.padEnd(24)} ${String(esperado).padStart(7)}`);
    } else {
      discrepancias++;
      console.log(`  DIFF  ${tipoEje.padEnd(9)} ${label.padEnd(24)} js=${esperado}  sql=${real}  (delta ${real - esperado})`);
    }
  };

  for (const r of ETAPAS) {
    await comparar('etapa', r.value, r.label, porEtapa.get(r.value) ?? 0, whereEtapas([r.value]));
  }
  await comparar('etapa', SIN_ETAPA, '(fuera del flujo)', porEtapa.get(SIN_ETAPA) ?? 0, whereEtapas([SIN_ETAPA]));

  for (const r of MODULOS) {
    await comparar('modulo', r.value, r.label, porModulo.get(r.value) ?? 0, whereModulos([r.value]));
  }
  await comparar('modulo', SIN_CLASIFICAR, '(sin clasificar)', otroM, whereModulos([SIN_CLASIFICAR]));

  for (const r of CATEGORIAS) {
    await comparar('categoria', r.value, r.label, porCategoria.get(r.value) ?? 0, whereCategorias([r.value]));
  }
  await comparar('categoria', SIN_CLASIFICAR, '(sin clasificar)', otroC, whereCategorias([SIN_CLASIFICAR]));

  console.log(
    discrepancias === 0
      ? '\nOK: filtro y etiqueta coinciden en todos los valores.'
      : `\nATENCION: ${discrepancias} valor(es) con discrepancia. Filtrar por ellos devolveria filas etiquetadas distinto.`,
  );
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
