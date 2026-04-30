// Actualiza fechas de campaña 37 y su cotización a mayo 1 - mayo 30 2026
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

  const fechaInicio = '2026-05-01';
  const fechaFin = '2026-05-30';

  // Antes
  const [before] = await conn.query(
    `SELECT c.id AS camp_id, c.fecha_inicio AS camp_ini, c.fecha_fin AS camp_fin,
            ct.id AS cot_id, ct.fecha_inicio AS cot_ini, ct.fecha_fin AS cot_fin, ct.tipo_periodo
     FROM campania c JOIN cotizacion ct ON ct.id = c.cotizacion_id WHERE c.id = 37`
  );
  console.log('ANTES:', before[0]);

  await conn.query(
    `UPDATE campania SET fecha_inicio = ?, fecha_fin = ? WHERE id = 37`,
    [fechaInicio, fechaFin]
  );
  await conn.query(
    `UPDATE cotizacion SET fecha_inicio = ?, fecha_fin = ? WHERE id = ?`,
    [fechaInicio, fechaFin, before[0].cot_id]
  );

  const [after] = await conn.query(
    `SELECT c.id AS camp_id, c.fecha_inicio AS camp_ini, c.fecha_fin AS camp_fin,
            ct.fecha_inicio AS cot_ini, ct.fecha_fin AS cot_fin
     FROM campania c JOIN cotizacion ct ON ct.id = c.cotizacion_id WHERE c.id = 37`
  );
  console.log('\nDESPUÉS:', after[0]);

  await conn.end();
  console.log('\n✅ Listo. Refresca la página de la campaña.');
}

main().catch(e => { console.error(e); process.exit(1); });
