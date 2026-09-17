// Backfill del versionado de circuitos completados.
//
// Recorre todas las propuestas con reservas activas y crea la version 1 de cada
// circuito que HOY este completo (N/N). La version se fecha con la ultima
// fecha_reserva activa del circuito (aproxima cuando se completo) en vez de NOW().
//
// Idempotente: circuitos que ya tienen una version identica se saltan.
// Requiere haber corrido antes: node scripts/add_tabla_circuito_completado.cjs
//
// Uso:
//   npx ts-node src/scripts/backfill-circuitos-completados.ts            (dry-run)
//   npx ts-node src/scripts/backfill-circuitos-completados.ts --commit
import 'dotenv/config';
import prisma from '../utils/prisma';
import { evaluarCompletadoPropuesta, tablasCompletadoDisponibles } from '../services/circuito-completado.service';

async function main() {
  const commit = process.argv.includes('--commit');

  // Guardia: corre contra DATABASE_URL. Si eso es produccion, exigir --prod
  // ademas de --commit para que no se ejecute por accidente.
  const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return '?'; } })();
  console.log(`Base: ${host}`);
  const esProd = /prod|ondigitalocean/i.test(host);
  if (commit && esProd && !process.argv.includes('--prod')) {
    console.error('DATABASE_URL apunta a PRODUCCION. Para escribir ahi agrega --prod (ademas de --commit).');
    process.exit(1);
  }

  if (!(await tablasCompletadoDisponibles())) {
    console.error('Faltan las tablas. Correr primero: node scripts/add_tabla_circuito_completado.cjs');
    process.exit(1);
  }

  // Opcionales: --propuesta 123 (solo esa) / --limit N (las N mas recientes).
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const soloPropuesta = arg('--propuesta');
  const limit = Number(arg('--limit') || 0);

  // Propuestas no borradas, de la mas reciente a la mas vieja. Se evalua por
  // propuesta (queries chicos con indice) en vez de un agregado global, que en
  // bases grandes tarda minutos.
  const propuestas = soloPropuesta
    ? [{ idquote: String(soloPropuesta) }]
    : await prisma.$queryRawUnsafe<{ idquote: string }[]>(
        `SELECT CAST(id AS CHAR) AS idquote FROM propuesta WHERE deleted_at IS NULL ORDER BY id DESC${limit > 0 ? ` LIMIT ${limit}` : ''}`
      );
  console.log(`${propuestas.length} propuesta(s) a evaluar. Modo: ${commit ? 'COMMIT' : 'dry-run'}`);

  if (!commit) {
    console.log('Dry-run: no se escribe nada. Corre con --commit para versionar los circuitos completos.');
    console.log('Tip: --limit 50 para probar con las 50 propuestas mas recientes, o --propuesta <id> para una sola.');
    return;
  }

  let totalNuevos = 0;
  let i = 0;
  for (const p of propuestas) {
    i++;
    try {
      const nuevos = await evaluarCompletadoPropuesta(p.idquote, { origen: 'backfill', usarFechaUltimaReserva: true });
      totalNuevos += nuevos.length;
      if (nuevos.length > 0) console.log(`[${i}/${propuestas.length}] propuesta ${p.idquote}: ${nuevos.length} version(es) nueva(s)`);
    } catch (e) {
      console.error(`[${i}/${propuestas.length}] propuesta ${p.idquote}: ERROR`, (e as Error).message);
    }
  }
  console.log(`\nListo. ${totalNuevos} version(es) creadas.`);
}

// process.exit explicito: utils/prisma deja timers vivos (keepalive) y el
// script no terminaria solo.
main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
