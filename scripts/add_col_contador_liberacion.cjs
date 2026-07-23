// Agrega la columna `contador_liberacion_desde` a la tabla `propuesta`.
// Cambio ADITIVO (nullable): la app vieja la ignora, la nueva la usa para el
// contador de la liberación automática de reservas (Criterio 30 días).
//
//   contador_liberacion_desde DATETIME NULL
//
// Semántica: NULL = contar desde `propuesta.fecha` (creación). Se setea a NOW()
// cuando el status pasa de 'Liberada' a otro → reinicia los 30 días.
//
// Uso:
//   node scripts/add_col_contador_liberacion.cjs           # dry-run
//   node scripts/add_col_contador_liberacion.cjs --commit  # aplica
//
// Apuntar DATABASE_URL a la BD destino (dev o prod) antes de correrlo.

require('dotenv').config();
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) { console.error('DATABASE_URL con formato invalido'); process.exit(1); }
  const [, user, password, host, port, database] = m;

  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database, ssl: { rejectUnauthorized: false },
  });
  console.log(`Conectado a ${host} db=${database}`);
  console.log('Modo:', COMMIT ? 'COMMIT (aplica)' : 'DRY-RUN');

  const [cols] = await conn.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'propuesta' AND column_name = 'contador_liberacion_desde'`,
    [database]
  );
  if (cols.length > 0) {
    console.log('\nNada que hacer. La columna contador_liberacion_desde ya existe.');
    await conn.end();
    return;
  }

  const sql = `ALTER TABLE propuesta ADD COLUMN contador_liberacion_desde DATETIME NULL`;
  console.log('\nSQL a ejecutar:\n  ' + sql);

  if (!COMMIT) {
    console.log('\n[DRY-RUN] Corre con --commit para aplicar.');
    await conn.end();
    return;
  }

  await conn.beginTransaction();
  try {
    await conn.query(sql);
    await conn.commit();
    console.log('\n>>> COMMIT ok');
  } catch (e) {
    await conn.rollback();
    console.error('ROLLBACK:', e.message);
    await conn.end();
    process.exit(1);
  }

  const [after] = await conn.query('SHOW COLUMNS FROM propuesta LIKE "contador_liberacion_desde"');
  after.forEach(x => console.log(`Verificación: ${x.Field} | ${x.Type} | null=${x.Null} | default=${x.Default}`));

  await conn.end();
  console.log('\n=== FIN ===');
}

main().catch(e => { console.error(e); process.exit(1); });
