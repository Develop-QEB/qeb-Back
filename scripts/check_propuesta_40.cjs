// Inspecciona el estado de propuesta 40: caras, reservas, alineación con caras esperadas
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
    SELECT id, articulo, caras, caras_flujo, caras_contraflujo, bonificacion, grupo_rt_bf,
           inicio_periodo, fin_periodo
    FROM solicitudCaras
    WHERE idquote = '40'
    ORDER BY grupo_rt_bf, articulo, inicio_periodo
  `);
  console.log(`Total caras propuesta 40: ${caras.length}\n`);

  for (const c of caras) {
    const [resv] = await conn.query(
      `SELECT id, inventario_id, estatus FROM reservas WHERE solicitudCaras_id = ? AND deleted_at IS NULL`,
      [c.id]
    );
    const counts = {};
    for (const r of resv) counts[r.estatus] = (counts[r.estatus] || 0) + 1;
    const cantidadEsperada = (c.articulo || '').toUpperCase().match(/^(BF|CF)/) ? c.bonificacion : c.caras;
    const ok = resv.length === cantidadEsperada ? '✅' : '❌';
    console.log(`${ok} #${c.id} ${c.articulo} | caras=${c.caras}, bonif=${c.bonificacion}, flujo=${c.caras_flujo}, ctra=${c.caras_contraflujo}, grupo=${c.grupo_rt_bf}`);
    console.log(`   periodo: ${c.inicio_periodo.toISOString().slice(0,10)} → ${c.fin_periodo.toISOString().slice(0,10)}`);
    console.log(`   reservas: ${resv.length} (esperado: ${cantidadEsperada}) | estatus: ${JSON.stringify(counts)}`);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
