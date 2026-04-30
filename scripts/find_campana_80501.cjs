// Busca campaña 80501 por id, IMU code o nombre
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

  // Por id exacto
  const [byId] = await conn.query(`SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id FROM campania WHERE id = ?`, ['80501']);
  console.log('Por id=80501:', byId);

  // Por nombre LIKE
  const [byNombre] = await conn.query(`SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id FROM campania WHERE nombre LIKE '%80501%' OR nombre LIKE '%prueba meses 714%'`);
  console.log('\nPor nombre LIKE:', byNombre);

  // Buscar columnas relevantes en la tabla
  const [cols] = await conn.query(`SHOW COLUMNS FROM campania`);
  console.log('\nColumnas campania:', cols.map(c => c.Field).join(', '));

  // Las últimas 5 campañas creadas
  const [recent] = await conn.query(`SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id FROM campania ORDER BY id DESC LIMIT 5`);
  console.log('\nÚltimas 5 campañas:', recent);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
