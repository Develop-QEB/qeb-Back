const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });

  const [counts] = await conn.query(`
    SELECT mueble, COUNT(*) as total, SUM(CASE WHEN estatus = 'Disponible' THEN 1 ELSE 0 END) as disponibles
    FROM inventarios
    WHERE mueble IN ('BOLERO', 'KIOSCO', 'VIDRIO INTERIOR', 'VIDRIOS EXTERIOR', 'MUPIS', 'PARABUS', 'PARABUS CON MUPI',
                     'MODULO TIPO A', 'MODULO TIPO B', 'MODULO TIPO C', 'MODULO TIPO D')
    GROUP BY mueble ORDER BY mueble
  `);
  console.log('Conteos por mueble (recién migrados):');
  console.table(counts);

  const [total] = await conn.query(`SELECT COUNT(*) as n FROM inventarios`);
  console.log(`\nTotal en inventarios: ${total[0].n}`);

  const [espacios] = await conn.query(`SELECT COUNT(*) as n FROM espacio_inventario`);
  console.log(`Total en espacio_inventario: ${espacios[0].n}`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
