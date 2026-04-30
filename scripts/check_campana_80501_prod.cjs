const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });

  const [r] = await conn.query(
    `SELECT c.id, c.nombre, c.fecha_inicio, c.fecha_fin, c.status, c.cotizacion_id,
            ct.fecha_inicio AS cot_ini, ct.fecha_fin AS cot_fin, ct.tipo_periodo, ct.nombre_campania
     FROM campania c
     LEFT JOIN cotizacion ct ON ct.id = c.cotizacion_id
     WHERE c.id = 80501`
  );
  console.log('Campaña 80501:');
  console.log(r[0] || 'NO ENCONTRADA');

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
