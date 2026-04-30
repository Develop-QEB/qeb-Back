// Convierte 7 tablas a utf8mb4_general_ci para resolver collation mismatch con Prisma.
// Ejecuta una a la vez, verifica después de cada una.
const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });
  console.log(`=== DB: ${database} @ ${host} ===\n`);

  // Verificar collation de la conexión actual
  const [vars] = await conn.query(`SHOW VARIABLES LIKE 'collation_connection'`);
  console.log(`collation_connection: ${vars[0]?.Value}\n`);

  // Tablas en orden: chicas primero
  const tablas = ['campania', 'cotizacion', 'cliente', 'solicitud', 'propuesta', 'solicitudCaras', 'tareas'];

  for (const t of tablas) {
    const start = Date.now();
    process.stdout.write(`Convirtiendo ${t}... `);
    try {
      await conn.query(`ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
      const ms = Date.now() - start;
      console.log(`✅ ${ms}ms`);
    } catch (e) {
      console.log(`❌ FALLÓ: ${e.message}`);
      console.log('  Aborto. Revisa manualmente esta tabla.');
      await conn.end();
      process.exit(1);
    }
  }

  // Verificar todas
  console.log('\nVerificación final:');
  const [check] = await conn.query(`
    SELECT TABLE_NAME, COLLATION_NAME, COUNT(*) AS columnas
    FROM information_schema.columns
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME IN ('propuesta', 'solicitudCaras', 'cotizacion', 'campania', 'cliente', 'solicitud', 'tareas')
      AND COLLATION_NAME IS NOT NULL
    GROUP BY TABLE_NAME, COLLATION_NAME
    ORDER BY TABLE_NAME
  `, [database]);
  console.table(check);

  await conn.end();
  console.log('\n✅ Conversión completa. Refresca el sitio.');
}

main().catch(e => { console.error(e); process.exit(1); });
