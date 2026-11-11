// Diagnóstico SOLO LECTURA: ¿por qué una eliminación de reservas no aparece en
// el tab Historial del buscador de formatos (AssignInventarioModal)?
//
// 1) Busca las últimas eliminaciones registradas en `historial`.
// 2) Para la propuesta más reciente (o la que se pase por argv), compara:
//    - reservas soft-deleted reales (deleted_at IS NOT NULL) por cara,
//    - cuántas esconde la regla R5 del endpoint (existe reserva ACTIVA del mismo
//      espacio + misma cara),
//    - cuántas pierden el INNER JOIN a espacio_inventario / inventarios,
//    - cuántas devuelve exactamente el WHERE del endpoint reservas-historial.
//
// Uso: node scripts/diag_historial_reservas.cjs [propuestaId]
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.DATABASE_URL.replace('mysql://', '');
  const [creds, rest] = url.split('@');
  const [user, passEnc] = creds.split(':');
  const pass = decodeURIComponent(passEnc);
  const [hostDb] = rest.split('?');
  const [hostPort, db] = hostDb.split('/');
  const [host, port] = hostPort.split(':');
  const conn = await mysql.createConnection({
    host, port: parseInt(port || '3306'), user, password: pass, database: db,
  });
  console.log(`BD: ${db} @ ${host}`);

  const [ultimas] = await conn.query(
    `SELECT id, ref_id, fecha_hora, LEFT(detalles, 220) AS detalles
       FROM historial
      WHERE accion = 'Eliminación de reservas'
      ORDER BY id DESC LIMIT 5`,
  );
  console.log('\n== Últimas 5 eliminaciones registradas en historial ==');
  for (const r of ultimas) console.log(` #${r.id} propuesta=${r.ref_id} ${r.fecha_hora.toISOString()} ${r.detalles}`);

  const propuestaId = process.argv[2] ? parseInt(process.argv[2]) : (ultimas[0] && ultimas[0].ref_id);
  if (!propuestaId) { console.log('Sin propuesta para diagnosticar'); await conn.end(); return; }
  console.log(`\n== Propuesta ${propuestaId} ==`);

  const [caras] = await conn.query(
    `SELECT sc.id, sc.articulo, sc.formato, sc.inicio_periodo, sc.fin_periodo, sc.grupo_masivo_id,
            (SELECT COUNT(*) FROM reservas r WHERE r.solicitudCaras_id = sc.id AND r.deleted_at IS NULL)     AS activas,
            (SELECT COUNT(*) FROM reservas r WHERE r.solicitudCaras_id = sc.id AND r.deleted_at IS NOT NULL) AS eliminadas
       FROM solicitudCaras sc WHERE sc.idquote = ? ORDER BY sc.id`,
    [String(propuestaId)],
  );
  console.log('Caras (activas / eliminadas):');
  for (const c of caras) console.log(`  cara ${c.id} ${c.articulo} ${c.formato} ${String(c.inicio_periodo).slice(0, 10)}..${String(c.fin_periodo).slice(0, 10)} masivo=${c.grupo_masivo_id} -> activas=${c.activas} eliminadas=${c.eliminadas}`);

  const [[tot]] = await conn.query(
    `SELECT COUNT(*) AS n FROM reservas rsv
       INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
      WHERE sc.idquote = ? AND rsv.deleted_at IS NOT NULL`, [String(propuestaId)]);
  const [[sinJoin]] = await conn.query(
    `SELECT COUNT(*) AS n FROM reservas rsv
       INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
       LEFT JOIN espacio_inventario epIn ON rsv.inventario_id = epIn.id
       LEFT JOIN inventarios i ON epIn.inventario_id = i.id
      WHERE sc.idquote = ? AND rsv.deleted_at IS NOT NULL AND (epIn.id IS NULL OR i.id IS NULL)`, [String(propuestaId)]);
  const [[ocultasR5]] = await conn.query(
    `SELECT COUNT(*) AS n FROM reservas rsv
       INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
      WHERE sc.idquote = ? AND rsv.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM reservas ract
                     WHERE ract.inventario_id = rsv.inventario_id
                       AND ract.solicitudCaras_id = rsv.solicitudCaras_id
                       AND ract.deleted_at IS NULL)`, [String(propuestaId)]);
  const [[endpoint]] = await conn.query(
    `SELECT COUNT(*) AS n FROM reservas rsv
       INNER JOIN espacio_inventario epIn ON rsv.inventario_id = epIn.id
       INNER JOIN inventarios i ON epIn.inventario_id = i.id
       INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
      WHERE sc.idquote = ? AND rsv.deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM reservas ract
                         WHERE ract.inventario_id = rsv.inventario_id
                           AND ract.solicitudCaras_id = rsv.solicitudCaras_id
                           AND ract.deleted_at IS NULL)`, [String(propuestaId)]);
  console.log(`\nReservas soft-deleted reales:            ${tot.n}`);
  console.log(`  pierden INNER JOIN espacio/inventario: ${sinJoin.n}`);
  console.log(`  escondidas por regla R5 (activa misma cara+espacio): ${ocultasR5.n}`);
  console.log(`  => devuelve el endpoint reservas-historial: ${endpoint.n}`);

  const [muestra] = await conn.query(
    `SELECT rsv.id, rsv.inventario_id, rsv.solicitudCaras_id, rsv.estatus, rsv.deleted_at,
            (SELECT COUNT(*) FROM reservas ract WHERE ract.inventario_id = rsv.inventario_id AND ract.solicitudCaras_id = rsv.solicitudCaras_id AND ract.deleted_at IS NULL) AS activas_mismo_espacio_cara,
            (SELECT COUNT(*) FROM reservas ract WHERE ract.inventario_id = rsv.inventario_id AND ract.deleted_at IS NULL) AS activas_mismo_espacio
       FROM reservas rsv INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
      WHERE sc.idquote = ? AND rsv.deleted_at IS NOT NULL
      ORDER BY rsv.deleted_at DESC, rsv.id DESC LIMIT 25`, [String(propuestaId)]);
  console.log('\nÚltimas 25 soft-deleted (id, espacio, cara, estatus, deleted_at, activas mismo espacio+cara / mismo espacio):');
  for (const r of muestra) console.log(`  ${r.id} esp=${r.inventario_id} cara=${r.solicitudCaras_id} ${r.estatus} ${r.deleted_at && r.deleted_at.toISOString()} ${r.activas_mismo_espacio_cara}/${r.activas_mismo_espacio}`);

  const [hist] = await conn.query(
    `SELECT id, accion, fecha_hora, LEFT(detalles, 160) AS detalles FROM historial
      WHERE tipo = 'Propuesta' AND ref_id = ? ORDER BY id DESC LIMIT 8`, [propuestaId]);
  console.log('\nÚltimos 8 movimientos en historial de la propuesta:');
  for (const h of hist) console.log(`  #${h.id} ${h.fecha_hora.toISOString()} ${h.accion} ${h.detalles}`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
