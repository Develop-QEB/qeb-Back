const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });

  const [cols] = await conn.query('SHOW COLUMNS FROM espacio_inventario');
  console.log('Cols espacio_inventario:');
  console.table(cols.map(c => ({ field: c.Field, type: c.Type, null: c.Null, default: c.Default })));

  const [sample] = await conn.query(
    `SELECT ei.* FROM espacio_inventario ei JOIN inventarios i ON i.id = ei.inventario_id WHERE i.mueble = 'KIOSCO' LIMIT 3`
  );
  console.log('\nSample espacios de un kiosco existente:');
  console.log(JSON.stringify(sample, null, 2));

  // Cuantos espacios tiene un kiosco típico
  const [counts] = await conn.query(
    `SELECT i.codigo_unico, COUNT(ei.id) AS espacios
     FROM inventarios i LEFT JOIN espacio_inventario ei ON ei.inventario_id = i.id
     WHERE i.mueble = 'KIOSCO' GROUP BY i.id LIMIT 5`
  );
  console.log('\nKioscos con conteo de espacios:');
  console.table(counts);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
