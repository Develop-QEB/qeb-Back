const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });

  // Estructura de la tabla inventarios
  const [cols] = await conn.query(`SHOW COLUMNS FROM inventarios`);
  console.log('=== Columnas de inventarios ===');
  console.table(cols.map(c => ({ field: c.Field, type: c.Type, null: c.Null, default: c.Default, extra: c.Extra })));

  // Sample row para ver datos reales
  const [sample] = await conn.query(`SELECT * FROM inventarios WHERE mueble = 'Kiosco' LIMIT 2`);
  console.log('\n=== Sample Kiosco (lo que YA está bien) ===');
  console.log(JSON.stringify(sample, null, 2));

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
