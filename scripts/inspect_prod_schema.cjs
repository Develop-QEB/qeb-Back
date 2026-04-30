const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });

  const [tables] = await conn.query(`SHOW TABLES`);
  console.log('Tablas:', tables.map(t => Object.values(t)[0]).filter(n => /camp|cotiza|propues/i.test(n)));

  const [count] = await conn.query(`SELECT COUNT(*) as n FROM campania`);
  console.log('Total campania:', count[0].n);

  // Buscar por número 80501 en cualquier columna textual relevante
  const [search] = await conn.query(`
    SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id, status
    FROM campania
    WHERE id = 80501 OR nombre LIKE '%80501%' OR id IN (
      SELECT cotizacion_id FROM campania WHERE cotizacion_id = 80501
    )
    LIMIT 5
  `);
  console.log('Search 80501:', search);

  // Últimas 10 sin filtro
  const [recent] = await conn.query(`SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id, status FROM campania ORDER BY id DESC LIMIT 10`);
  console.log('Últimas 10:');
  console.table(recent);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
