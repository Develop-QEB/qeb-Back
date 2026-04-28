// Borra TODAS las reservas BF de cara 205 y 204 y las recrea correctamente
// (tomando inventarios LIBRES, no los que ya tiene el RT pareja)
require('dotenv').config();
const mysql = require('mysql2/promise');

const PLAZA_LIKE = { MX: 'CIUDAD DE M%', MTY: 'MONTERREY%' };

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
  console.log(`=== DB: ${db} ===\n`);

  // Casos: BF a recrear
  const cases = [
    { caraId: 205, articulo: 'BF-DIG-03-MX', cantidad: 10, plaza: 'MX', cto: 'CTO 3' },
    { caraId: 204, articulo: 'BF-DIG-03-MX', cantidad: 2,  plaza: 'MX', cto: 'CTO 3' },
  ];

  await conn.beginTransaction();
  try {
    for (const c of cases) {
      console.log(`\n--- Cara ${c.caraId} (${c.articulo}, cantidad=${c.cantidad}) ---`);

      // 1. Borrar reservas existentes (incluyendo deleted_at, hard delete con UPDATE deleted_at)
      const [del] = await conn.query(
        `UPDATE reservas SET deleted_at = NOW()
         WHERE solicitudCaras_id = ? AND deleted_at IS NULL`,
        [c.caraId]
      );
      console.log(`  Borradas: ${del.affectedRows} reservas`);

      // 2. Get cara info (cliente, periodo)
      const [caraInfo] = await conn.query(`
        SELECT sc.id, sc.idquote, sc.inicio_periodo, sc.fin_periodo
        FROM solicitudCaras sc WHERE sc.id = ?
      `, [c.caraId]);
      const propId = parseInt(caraInfo[0].idquote);
      const fechaIni = caraInfo[0].inicio_periodo;
      const fechaFin = caraInfo[0].fin_periodo;
      const [propRow] = await conn.query(`SELECT cliente_id FROM propuesta WHERE id = ?`, [propId]);
      const clienteId = propRow[0]?.cliente_id || 0;
      console.log(`  Periodo: ${fechaIni.toISOString().split('T')[0]} → ${fechaFin.toISOString().split('T')[0]}`);

      // 3. Inventarios del CTO+plaza
      const like = PLAZA_LIKE[c.plaza];
      const [invs] = await conn.query(`
        SELECT id FROM inventarios WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)
        ORDER BY id
      `, [c.cto, like]);
      console.log(`  Inventarios del circuito: ${invs.length}`);

      // 4. Espacios libres (que no estén reservados en el periodo, excluyendo las que acabo de borrar)
      const invIds = invs.map(i => i.id);
      const ph = invIds.map(() => '?').join(',');
      const [espacios] = await conn.query(`
        SELECT ei.id, ei.inventario_id
        FROM espacio_inventario ei
        WHERE ei.inventario_id IN (${ph})
        ORDER BY ei.inventario_id, ei.numero_espacio
      `, invIds);
      const espaciosPorInv = new Map();
      for (const e of espacios) {
        if (!espaciosPorInv.has(e.inventario_id)) espaciosPorInv.set(e.inventario_id, []);
        espaciosPorInv.get(e.inventario_id).push(e.id);
      }

      const espIds = espacios.map(e => e.id);
      const phE = espIds.map(() => '?').join(',');
      const [conflicts] = await conn.query(`
        SELECT r.inventario_id AS espacio_id, ei.inventario_id AS inv_real
        FROM reservas r
        INNER JOIN espacio_inventario ei ON ei.id = r.inventario_id
        INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
        WHERE ei.id IN (${phE})
          AND r.deleted_at IS NULL
          AND r.estatus NOT IN ('eliminada','Eliminada','cancelado','Cancelado')
          AND NOT (sc.fin_periodo < ? OR sc.inicio_periodo > ?)
      `, [...espIds, fechaIni, fechaFin]);
      const ocupados = new Set(conflicts.map(c => c.espacio_id));
      console.log(`  Espacios ocupados en el periodo: ${ocupados.size}`);

      // 5. Tomar `cantidad` libres (uno por inventario)
      const aReservar = [];
      for (const inv of invs) {
        const opts = espaciosPorInv.get(inv.id) || [];
        const libre = opts.find(eid => !ocupados.has(eid));
        if (libre) aReservar.push(libre);
        if (aReservar.length >= c.cantidad) break;
      }
      console.log(`  A reservar: ${aReservar.length}`);
      if (aReservar.length < c.cantidad) {
        console.log(`  ⚠️ No hay suficientes libres (pedido ${c.cantidad}, libres ${aReservar.length})`);
        continue;
      }

      // 6. Crear reservas con estatus Bonificado
      for (const espId of aReservar) {
        await conn.query(`
          INSERT INTO reservas
            (inventario_id, calendario_id, cliente_id, solicitudCaras_id,
             estatus, estatus_original, arte_aprobado, comentario_rechazo,
             fecha_testigo, imagen_testigo, instalado, tarea, grupo_completo_id)
          VALUES (?, 0, ?, ?, 'Bonificado', 'Bonificado', 'Pendiente', '',
                  NOW(), '', 0, '', NULL)
        `, [espId, clienteId, c.caraId]);
      }
      console.log(`  ✅ ${aReservar.length} reservas BF creadas correctamente`);
    }

    await conn.commit();
    console.log('\n✅ Transacción completa');
  } catch (e) {
    await conn.rollback();
    console.error('Rollback:', e);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
