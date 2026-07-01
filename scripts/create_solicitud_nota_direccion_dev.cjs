// Crea la tabla solicitud_nota_direccion en DEV (Hostinger).
// SEGURO: solo hace CREATE TABLE IF NOT EXISTS, no toca datos existentes.
//
// Uso:
//   node scripts/create_solicitud_nota_direccion_dev.cjs
//   node scripts/create_solicitud_nota_direccion_dev.cjs --commit   (aplica)

require('dotenv').config();
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) { console.error('URL invalida'); process.exit(1); }
  const [, user, password, host, port, database] = m;
  // SEGURIDAD: NO permitir contra prod DigitalOcean sin flag explicito adicional
  if (host.includes('ondigitalocean')) {
    console.error('SEGURIDAD: DATABASE_URL apunta a prod (ondigitalocean). Este script es solo para dev.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database, ssl: undefined,
  });
  console.log(`Conectado a ${host} db=${database} (dev)`);

  const sql = `
    CREATE TABLE IF NOT EXISTS solicitud_nota_direccion (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      id_solicitud INT NOT NULL,
      texto TEXT NOT NULL,
      id_usuario INT NULL,
      usuario_nombre VARCHAR(255) NULL,
      usuario_rol VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_solicitud_nota_direccion_id_solicitud (id_solicitud)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  // Verificar si ya existe
  const [existing] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ? AND table_name = 'solicitud_nota_direccion'`,
    [database]
  );
  const alreadyExists = Number(existing[0].c) > 0;
  console.log(`Tabla solicitud_nota_direccion existe: ${alreadyExists}`);

  console.log('\n--- SQL a ejecutar ---');
  console.log(sql.trim());
  console.log('--- fin SQL ---\n');

  if (!COMMIT) {
    console.log('[DRY-RUN] No se ejecuto. Corre con --commit para aplicar.');
    await conn.end();
    return;
  }

  if (alreadyExists) {
    console.log('Tabla ya existe, no se hace nada. (CREATE TABLE IF NOT EXISTS igual no da error, pero salgo aqui.)');
    await conn.end();
    return;
  }

  await conn.query(sql);
  console.log('Tabla creada correctamente.');

  // Verificar
  const [after] = await conn.query('SHOW COLUMNS FROM solicitud_nota_direccion');
  console.log('\nColumnas de la tabla creada:');
  after.forEach(c => console.log(`  ${c.Field} | ${c.Type} | null=${c.Null} | default=${c.Default}`));

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
