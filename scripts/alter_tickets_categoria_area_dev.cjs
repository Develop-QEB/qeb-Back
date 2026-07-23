// Agrega columnas categoria y area a la tabla tickets en dev (Hostinger).
// SEGURO: solo hace ALTER TABLE si las columnas no existen. No toca datos existentes.
//
// Uso:
//   node scripts/alter_tickets_categoria_area_dev.cjs           # dry-run
//   node scripts/alter_tickets_categoria_area_dev.cjs --commit  # aplica

require('dotenv').config();
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  if (host.includes('ondigitalocean')) {
    console.error('SEGURIDAD: DATABASE_URL apunta a prod. Este script es solo para dev.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database,
  });
  console.log(`Conectado a ${host} db=${database} (dev)`);
  console.log('Modo:', COMMIT ? 'COMMIT (aplica)' : 'DRY-RUN');

  // Verificar si las columnas existen
  const [cols] = await conn.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'tickets' AND column_name IN ('categoria', 'area')`,
    [database]
  );
  const existentes = cols.map(c => c.column_name || c.COLUMN_NAME);
  console.log('\nColumnas existentes en tickets:', existentes.length ? existentes.join(', ') : 'ninguna de las nuevas');

  const sqls = [];
  if (!existentes.includes('categoria')) {
    sqls.push(`ALTER TABLE tickets ADD COLUMN categoria VARCHAR(255) NULL`);
  }
  if (!existentes.includes('area')) {
    sqls.push(`ALTER TABLE tickets ADD COLUMN area VARCHAR(50) NOT NULL DEFAULT 'QEB'`);
    sqls.push(`ALTER TABLE tickets ADD INDEX idx_tickets_area (area)`);
  }

  if (sqls.length === 0) {
    console.log('\nNada que hacer. Ambas columnas ya existen.');
    await conn.end();
    return;
  }

  console.log('\nSQL a ejecutar:');
  sqls.forEach(s => console.log('  ' + s));

  const [count] = await conn.query('SELECT COUNT(*) c FROM tickets');
  console.log(`\nTickets existentes: ${Number(count[0].c)} (quedan area='QEB', categoria=NULL)`);

  if (!COMMIT) {
    console.log('\n[DRY-RUN] Corre con --commit para aplicar.');
    await conn.end();
    return;
  }

  await conn.beginTransaction();
  try {
    for (const s of sqls) {
      await conn.query(s);
      console.log('  OK: ' + s.substring(0, 70));
    }
    await conn.commit();
    console.log('\n>>> COMMIT ok');
  } catch (e) {
    await conn.rollback();
    console.error('ROLLBACK:', e.message);
    await conn.end();
    process.exit(1);
  }

  // Verificar post
  const [after] = await conn.query('SHOW COLUMNS FROM tickets');
  const newCols = after.filter(x => x.Field === 'categoria' || x.Field === 'area');
  console.log('\nVerificación post:');
  newCols.forEach(x => console.log(`  ${x.Field} | ${x.Type} | null=${x.Null} | default=${x.Default}`));

  await conn.end();
  console.log('\n=== FIN ===');
}

main().catch(e => { console.error(e); process.exit(1); });
