// Verifica fechas de campaña 80501 y su cotización asociada
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

  const [camp] = await conn.query(
    `SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id FROM campania WHERE id = 80501`
  );
  console.log('Campaña 80501:', camp[0] || 'NO ENCONTRADA');

  if (camp[0]?.cotizacion_id) {
    const [cot] = await conn.query(
      `SELECT id, fecha_inicio, fecha_fin, tipo_periodo FROM cotizacion WHERE id = ?`,
      [camp[0].cotizacion_id]
    );
    console.log('Cotización:', cot[0]);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
