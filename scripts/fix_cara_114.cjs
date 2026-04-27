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

  const [before] = await conn.query(`SELECT id, articulo, caras, caras_flujo, caras_contraflujo FROM solicitudCaras WHERE id = 114`);
  console.log('ANTES:');
  console.table(before);

  const [r] = await conn.query(
    `UPDATE solicitudCaras SET caras = 25, caras_flujo = 25, caras_contraflujo = 0 WHERE id = 114`
  );
  console.log(`\nFilas actualizadas: ${r.affectedRows}`);

  const [after] = await conn.query(`SELECT id, articulo, caras, caras_flujo, caras_contraflujo FROM solicitudCaras WHERE id = 114`);
  console.log('\nDESPUÉS:');
  console.table(after);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
