// Backfill de la foto del pase a ventas para campañas HISTORICAS.
//
// Para las campañas aprobadas ANTES de esta feature no existe el registro exacto
// de que reservas cruzaron de la propuesta. Se aproxima por fecha:
//
//   reserva.fecha_reserva <= DATE(campania.fecha_aprobacion)  ->  "vino de la propuesta"
//
// LIMITACION conocida: `reservas.fecha_reserva` es DATE (sin hora), asi que las
// piezas repuestas el MISMO dia del pase a ventas quedan marcadas como "de
// propuesta". Las filas backfilleadas se marcan con origen='backfill' para poder
// distinguirlas de las exactas (origen='aprobacion').
//
// Se salta las propuestas que YA tienen foto (no pisa lo exacto).
// Campañas sin fecha_aprobacion no se pueden aproximar: se omiten y la Vista
// Compartir simplemente no colorea por origen.
//
// Requiere: node scripts/add_tabla_pase_ventas_reserva.cjs
//
// Uso:
//   npx ts-node --transpile-only src/scripts/backfill-pase-ventas.ts             (dry-run)
//   npx ts-node --transpile-only src/scripts/backfill-pase-ventas.ts --commit
//   ... --limit 100      solo las N campañas mas recientes
import 'dotenv/config';
import prisma from '../utils/prisma';
import { tablaPaseVentasDisponible } from '../services/pase-ventas.service';

interface CampRow { campania_id: number; propuesta_id: number; fecha_aprobacion: Date }

async function main() {
  const commit = process.argv.includes('--commit');
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const limit = Number(arg('--limit') || 0);

  const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return '?'; } })();
  console.log(`Base: ${host}`);
  const esProd = /prod|ondigitalocean/i.test(host);
  if (commit && esProd && !process.argv.includes('--prod')) {
    console.error('DATABASE_URL apunta a PRODUCCION. Para escribir ahi agrega --prod (ademas de --commit).');
    process.exit(1);
  }
  if (!(await tablaPaseVentasDisponible())) {
    console.error('Falta la tabla. Correr primero: node scripts/add_tabla_pase_ventas_reserva.cjs');
    process.exit(1);
  }

  const campanas = await prisma.$queryRawUnsafe<CampRow[]>(
    `SELECT cam.id AS campania_id, cot.id_propuesta AS propuesta_id, cam.fecha_aprobacion
       FROM campania cam
       INNER JOIN cotizacion cot ON cot.id = cam.cotizacion_id
      WHERE cam.fecha_aprobacion IS NOT NULL AND cot.id_propuesta IS NOT NULL
      ORDER BY cam.id DESC${limit > 0 ? ` LIMIT ${limit}` : ''}`
  );
  console.log(`${campanas.length} campaña(s) con fecha de aprobacion. Modo: ${commit ? 'COMMIT' : 'dry-run'}`);

  if (!commit) {
    console.log('Dry-run: no se escribe nada. Corre con --commit para registrar la foto aproximada.');
    console.log('Tip: --limit 50 para probar con las 50 campañas mas recientes.');
    return;
  }

  let conFoto = 0, backfilleadas = 0, filas = 0;
  let i = 0;
  for (const c of campanas) {
    i++;
    const idquote = String(c.propuesta_id);
    try {
      const ya = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
        'SELECT COUNT(*) AS n FROM pase_ventas_reserva WHERE propuesta_id = ?', Number(c.propuesta_id));
      if (Number(ya[0]?.n) > 0) { conFoto++; continue; }

      // Sin filtro de deleted_at: las piezas desplazadas/quitadas tambien deben
      // quedar clasificadas (salen en gris en la Vista Compartir).
      const n = await prisma.$executeRawUnsafe(
        `INSERT IGNORE INTO pase_ventas_reserva
           (propuesta_id, campania_id, reserva_id, solicitud_caras_id, espacio_inventario_id, inventario_id, estatus, fecha_pase, origen)
         SELECT ?, ?, r.id, r.solicitudCaras_id, r.inventario_id, ei.inventario_id, r.estatus, ?, 'backfill'
           FROM solicitudCaras sc
           INNER JOIN reservas r ON r.solicitudCaras_id = sc.id
           LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
          WHERE sc.idquote = ? AND r.fecha_reserva <= DATE(?)`,
        Number(c.propuesta_id), Number(c.campania_id), c.fecha_aprobacion, idquote, c.fecha_aprobacion,
      );
      if (n > 0) { backfilleadas++; filas += n; console.log(`[${i}/${campanas.length}] campaña ${c.campania_id} (propuesta ${idquote}): ${n} reserva(s)`); }
    } catch (e) {
      console.error(`[${i}/${campanas.length}] campaña ${c.campania_id}: ERROR`, (e as Error).message);
    }
  }
  console.log(`\nListo. ${backfilleadas} campaña(s) backfilleadas (${filas} filas). ${conFoto} ya tenian foto.`);
}

// process.exit explicito: utils/prisma deja timers vivos (keepalive).
main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
