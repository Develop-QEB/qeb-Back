const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port] = m;
  // Conectar SIN especificar database para ver todas
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    ssl: { rejectUnauthorized: false },
  });

  const [dbs] = await conn.query(`SHOW DATABASES`);
  console.log('Bases de datos en el cluster:');
  console.table(dbs);

  // Para cada DB que no sea sistema, contar campania
  for (const row of dbs) {
    const dbName = Object.values(row)[0];
    if (['information_schema', 'mysql', 'performance_schema', 'sys', '_dodb'].includes(dbName)) continue;
    try {
      const [count] = await conn.query(`SELECT COUNT(*) as n FROM \`${dbName}\`.campania`);
      console.log(`  ${dbName}.campania: ${count[0].n} registros`);
    } catch (e) {
      console.log(`  ${dbName}: sin tabla campania`);
    }
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
