// Normaliza variantes de NSE en inventarios:
//   "ABC"   → "ABC+"
//   "ABC +" → "ABC+"
// Aplica en pruebas y prod.
require('dotenv').config();
const mysql = require('mysql2/promise');

function parseUrl(url) {
  const u = url.replace('mysql://', '');
  const [creds, rest] = u.split('@');
  const [user, passEnc] = creds.split(':');
  const password = decodeURIComponent(passEnc);
  const [hostDb] = rest.split('?');
  const [hostPort, database] = hostDb.split('/');
  const [host, port] = hostPort.split(':');
  return { host, port: parseInt(port || '3306'), user, password, database };
}

async function normalize(conn, label) {
  console.log(`\n=== ${label} ===`);
  const [before] = await conn.query(`
    SELECT nivel_socioeconomico, COUNT(*) as n
    FROM inventarios
    WHERE nivel_socioeconomico IS NOT NULL
    GROUP BY nivel_socioeconomico
    ORDER BY n DESC
  `);
  console.log('Antes:'); console.table(before);

  const [r1] = await conn.query(
    `UPDATE inventarios SET nivel_socioeconomico = 'ABC+' WHERE nivel_socioeconomico = 'ABC'`
  );
  const [r2] = await conn.query(
    `UPDATE inventarios SET nivel_socioeconomico = 'ABC+' WHERE nivel_socioeconomico = 'ABC +'`
  );
  console.log(`'ABC' → 'ABC+': ${r1.affectedRows}`);
  console.log(`'ABC +' → 'ABC+': ${r2.affectedRows}`);

  const [after] = await conn.query(`
    SELECT nivel_socioeconomico, COUNT(*) as n
    FROM inventarios
    WHERE nivel_socioeconomico IS NOT NULL
    GROUP BY nivel_socioeconomico
    ORDER BY n DESC
  `);
  console.log('Después:'); console.table(after);
}

async function main() {
  const pruebas = await mysql.createConnection(parseUrl(process.env.DATABASE_URL));
  const prod = await mysql.createConnection({ ...parseUrl(process.env.PROD_DB_URL), ssl: { rejectUnauthorized: false } });

  await normalize(pruebas, 'PRUEBAS');
  await normalize(prod, 'PROD');

  await pruebas.end();
  await prod.end();
}

main().catch(e => { console.error(e); process.exit(1); });
