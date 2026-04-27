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
    ssl: host.includes('digitalocean') ? { rejectUnauthorized: false } : undefined,
  });
  console.log(`=== DB: ${db} ===\n`);

  const [byEstatus] = await conn.query(`
    SELECT estatus, COUNT(*) AS total
    FROM reservas
    WHERE deleted_at IS NULL
    GROUP BY estatus
    ORDER BY total DESC
  `);
  console.log('Distribución de estatus en reservas:');
  console.table(byEstatus);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
