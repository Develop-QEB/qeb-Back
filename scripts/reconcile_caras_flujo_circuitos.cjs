// Reconcilia caras_flujo / caras_contraflujo de RTs de circuito digital con el split
// real de las reservas activas. Útil para arreglar datos pre-fix.
// Uso: node scripts/reconcile_caras_flujo_circuitos.cjs [propuestaId]
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const propuestaId = process.argv[2];
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
  console.log(`=== DB: ${db} ===`);
  console.log(`Propuesta: ${propuestaId || 'TODAS'}\n`);

  const where = propuestaId
    ? `WHERE idquote = ? AND articulo REGEXP '^RT-DIG-[0-9]+-'`
    : `WHERE articulo REGEXP '^RT-DIG-[0-9]+-'`;
  const params = propuestaId ? [propuestaId] : [];

  const [caras] = await conn.query(
    `SELECT id, articulo, caras_flujo, caras_contraflujo FROM solicitudCaras ${where}`,
    params
  );
  console.log(`RTs circuito encontrados: ${caras.length}\n`);

  let fixed = 0;
  for (const c of caras) {
    const [rows] = await conn.query(
      `SELECT
         SUM(CASE WHEN i.tipo_de_cara = 'Flujo' THEN 1 ELSE 0 END) AS flujo,
         SUM(CASE WHEN i.tipo_de_cara = 'Contraflujo' THEN 1 ELSE 0 END) AS ctra
       FROM reservas r
       JOIN espacio_inventario ei ON ei.id = r.inventario_id
       JOIN inventarios i ON i.id = ei.inventario_id
       WHERE r.solicitudCaras_id = ? AND r.deleted_at IS NULL`,
      [c.id]
    );
    const flujoReal = Number(rows[0]?.flujo || 0);
    const ctraReal = Number(rows[0]?.ctra || 0);
    if (c.caras_flujo !== flujoReal || c.caras_contraflujo !== ctraReal) {
      await conn.query(
        `UPDATE solicitudCaras SET caras_flujo = ?, caras_contraflujo = ? WHERE id = ?`,
        [flujoReal, ctraReal, c.id]
      );
      console.log(`✅ #${c.id} ${c.articulo}: ${c.caras_flujo}/${c.caras_contraflujo} → ${flujoReal}/${ctraReal}`);
      fixed++;
    }
  }
  console.log(`\n${fixed} cara(s) reconciliada(s)`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
