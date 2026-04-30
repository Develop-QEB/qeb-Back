// Mata queries atoradas (>600s) en prod. Solo del usuario doadmin.
// Lee credenciales de PROD_DB_URL (no hardcodeadas).
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

  // 1. Listar candidatas
  const [stuck] = await conn.query(`
    SELECT id, time, command, state, LEFT(info, 200) AS query_preview
    FROM information_schema.processlist
    WHERE time > 600
      AND command IN ('Execute', 'Prepare', 'Query')
      AND user = 'doadmin'
    ORDER BY time DESC
  `);
  console.log(`Queries atoradas (>600s): ${stuck.length}`);
  console.table(stuck.map(r => ({ id: r.id, time_s: r.time, command: r.command, state: r.state, query: (r.query_preview || '').slice(0, 80) })));

  if (stuck.length === 0) {
    console.log('\n✅ Nada que matar.');
    await conn.end();
    return;
  }

  // 2. Matar uno por uno
  console.log('\nMatando...');
  let killed = 0, failed = 0;
  for (const r of stuck) {
    try {
      await conn.query(`KILL ${r.id}`);
      killed++;
    } catch (e) {
      console.error(`  ❌ KILL ${r.id}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n✅ Matadas: ${killed} | ❌ Fallidas: ${failed}`);

  // 3. Estado después
  const [remaining] = await conn.query(`
    SELECT command, state, COUNT(*) as n
    FROM information_schema.processlist
    WHERE user = 'doadmin'
    GROUP BY command, state
    ORDER BY n DESC
  `);
  console.log('\nEstado después:');
  console.table(remaining);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
