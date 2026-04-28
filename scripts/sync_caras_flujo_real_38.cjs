// Sincroniza caras_flujo / caras_contraflujo de cada cara de circuito en propuesta 38
// con el conteo REAL de las reservas activas (basado en inventarios.tipo_de_cara).
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
  console.log(`=== DB: ${db} ===\n`);

  const [caras] = await conn.query(`
    SELECT id, articulo, caras, caras_flujo, caras_contraflujo
    FROM solicitudCaras
    WHERE idquote = '38' AND articulo REGEXP '^(RT|BF|CT|CF)-DIG-[0-9]+-[A-Z]+$'
  `);
  console.log('Caras de circuito en propuesta 38:');
  console.table(caras);

  for (const c of caras) {
    // Conteo real de reservas activas por tipo
    const [reservas] = await conn.query(`
      SELECT
        SUM(CASE WHEN inv.tipo_de_cara = 'Flujo' THEN 1 ELSE 0 END) AS flujo,
        SUM(CASE WHEN inv.tipo_de_cara = 'Contraflujo' THEN 1 ELSE 0 END) AS ctra,
        COUNT(*) AS total
      FROM reservas r
      LEFT JOIN espacio_inventario epIn ON epIn.id = r.inventario_id
      LEFT JOIN inventarios inv ON inv.id = epIn.inventario_id
      WHERE r.solicitudCaras_id = ? AND r.deleted_at IS NULL
    `, [c.id]);
    const flujoReal = Number(reservas[0]?.flujo || 0);
    const ctraReal = Number(reservas[0]?.ctra || 0);
    const totalReal = Number(reservas[0]?.total || 0);

    if (flujoReal === c.caras_flujo && ctraReal === c.caras_contraflujo) {
      console.log(`  ${c.articulo} (cara ${c.id}): ya correcto (${flujoReal}F + ${ctraReal}CF, total reservas=${totalReal})`);
      continue;
    }
    await conn.query(
      `UPDATE solicitudCaras SET caras_flujo = ?, caras_contraflujo = ? WHERE id = ?`,
      [flujoReal, ctraReal, c.id]
    );
    console.log(`  ✅ ${c.articulo} (cara ${c.id}): ${c.caras_flujo}/${c.caras_contraflujo} → ${flujoReal}/${ctraReal} (reservas reales=${totalReal})`);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
