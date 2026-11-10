// Agrega las columnas de VIGENCIA del bloqueo administrativo a `inventarios`.
// Cambio ADITIVO (todas nullables): la app vieja las ignora, la nueva las usa
// para la vigencia de 'No Disponible' / 'Inhabilitado'
// (src/services/vigencia-bloqueo.service.ts).
//
//   bloqueo_tipo         VARCHAR(50) NULL   -- clasificación pendiente (bloqueo programado)
//   bloqueo_fecha_inicio DATE NULL          -- desde cuándo aplica
//   bloqueo_fecha_fin    DATE NULL          -- hasta cuándo; NULL = indefinido
//   bloqueo_usuario_id   INT NULL           -- quién bloqueó (recibe la tarea al vencer)
//   bloqueo_aviso_at     DATETIME NULL      -- cuándo se creó la tarea de vencimiento
//
// Por default corre SOLO en DESARROLLO/PRUEBAS (Hostinger). Para producción:
//   node scripts/add_cols_vigencia_bloqueo_inventario.cjs                  -> DEV, dry-run
//   node scripts/add_cols_vigencia_bloqueo_inventario.cjs --commit         -> DEV, aplica
//   node scripts/add_cols_vigencia_bloqueo_inventario.cjs --prod --commit  -> PROD (DATABASE_URL del .env)
// Idempotente: solo agrega las columnas que falten.

const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

// SOLO DESARROLLO/PRUEBAS (mismas credenciales que los demás scripts del folder).
const DEV = {
  label: 'DEV/PRUEBAS u658050396_QEB_PRUEBAS',
  host: 'srv1978.hstgr.io',
  port: 3306,
  user: 'u658050396_QEB_PRUEBAS',
  password: '/uQ3FCrLG5:6',
  database: 'u658050396_QEB_PRUEBAS',
  ssl: undefined,
};

function targetFromArgs() {
  if (!process.argv.includes('--prod')) return DEV;
  require('dotenv').config();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('--prod requiere DATABASE_URL en el .env');
  const parsed = new URL(url);
  return {
    label: `PROD (${parsed.hostname})`,
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    ssl: { rejectUnauthorized: false },
  };
}

const COLUMNAS = [
  ['bloqueo_tipo', 'VARCHAR(50) NULL'],
  ['bloqueo_fecha_inicio', 'DATE NULL'],
  ['bloqueo_fecha_fin', 'DATE NULL'],
  ['bloqueo_usuario_id', 'INT NULL'],
  ['bloqueo_aviso_at', 'DATETIME NULL'],
];

async function main() {
  const T = targetFromArgs();
  const conn = await mysql.createConnection({
    host: T.host, port: T.port, user: T.user, password: T.password, database: T.database, ssl: T.ssl,
  });
  console.log(`Conectado a ${T.label} (${T.host} db=${T.database})`);
  console.log('Modo:', COMMIT ? 'COMMIT (aplica)' : 'DRY-RUN');

  const [cols] = await conn.query(
    `SELECT column_name AS column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'inventarios' AND column_name IN (?)`,
    [T.database, COLUMNAS.map(c => c[0])]
  );
  const existentes = new Set(cols.map(c => c.column_name));
  const faltantes = COLUMNAS.filter(([nombre]) => !existentes.has(nombre));

  if (faltantes.length === 0) {
    console.log('\nNada que hacer. Las 5 columnas ya existen.');
    await conn.end();
    return;
  }

  const sql = `ALTER TABLE inventarios\n  ` +
    faltantes.map(([nombre, def]) => `ADD COLUMN ${nombre} ${def}`).join(',\n  ');
  console.log('\nSQL a ejecutar:\n' + sql);

  if (!COMMIT) {
    console.log('\n[DRY-RUN] Corre con --commit para aplicar.');
    await conn.end();
    return;
  }

  try {
    await conn.query(sql);
    console.log('\n>>> ALTER ok');
  } catch (e) {
    console.error('ERROR:', e.message);
    await conn.end();
    process.exit(1);
  }

  const [after] = await conn.query("SHOW COLUMNS FROM inventarios LIKE 'bloqueo_%'");
  after.forEach(x => console.log(`Verificación: ${x.Field} | ${x.Type} | null=${x.Null} | default=${x.Default}`));

  await conn.end();
  console.log('\n=== FIN ===');
}

main().catch(e => { console.error(e); process.exit(1); });
