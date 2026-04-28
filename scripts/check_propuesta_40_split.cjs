// Verifica el split real flujo/contraflujo de reservas en propuesta 40 vs caras_flujo/contraflujo
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
    SELECT id, articulo, caras, caras_flujo, caras_contraflujo, bonificacion
    FROM solicitudCaras
    WHERE idquote = '40'
    ORDER BY id
  `);

  for (const c of caras) {
    const [rows] = await conn.query(`
      SELECT i.tipo_de_cara, COUNT(*) as cnt
      FROM reservas r
      JOIN espacio_inventario ei ON ei.id = r.inventario_id
      JOIN inventarios i ON i.id = ei.inventario_id
      WHERE r.solicitudCaras_id = ? AND r.deleted_at IS NULL
      GROUP BY i.tipo_de_cara
    `, [c.id]);
    const split = {};
    for (const r of rows) split[r.tipo_de_cara] = Number(r.cnt);
    console.log(`#${c.id} ${c.articulo}`);
    console.log(`  guardado: caras_flujo=${c.caras_flujo}, caras_contraflujo=${c.caras_contraflujo}, bonif=${c.bonificacion}`);
    console.log(`  real:     ${JSON.stringify(split)}`);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
