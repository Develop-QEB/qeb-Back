// Crea el índice compuesto idx_historial_tipo_ref(tipo, ref_id) en `historial`.
//
// Para qué: toda lectura de historial por recurso hace
//   WHERE tipo = ? AND ref_id = ?
// y la tabla solo tiene índices por fecha_entrega y usuario_id, así que cada
// consulta es un full scan sobre una tabla con `detalles` MEDIUMTEXT (las
// fotografías de campañas grandes pesan MBs). La pega, entre otras, la pestaña
// "Acciones" del Historial de Inventario (getAcciones en inventarios.controller).
//
// Es idempotente: si el índice ya existe, no hace nada.
//
// La conexión se toma del entorno — este script NO trae credenciales:
//   node -r dotenv/config scripts/add_idx_historial_tipo_ref.cjs
// usa DATABASE_URL del .env (¡ojo: hoy apunta a PROD!). Para correrlo contra
// pruebas, pasa la URL explícita:
//   DB_URL="mysql://usuario:pass@host:3306/basededatos" node scripts/add_idx_historial_tipo_ref.cjs
const mysql = require('mysql2/promise');

const INDEX_NAME = 'idx_historial_tipo_ref';

function parseUrl(raw) {
  const clean = String(raw).trim().replace(/^"|"$/g, '');
  const u = new URL(clean);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl: /ssl-mode=REQUIRED|sslaccept=strict/i.test(u.search) ? { rejectUnauthorized: false } : undefined,
  };
}

async function run() {
  const raw = process.env.DB_URL || process.env.DATABASE_URL;
  if (!raw) {
    console.error('✖ Falta DB_URL o DATABASE_URL en el entorno. Ver el encabezado de este script.');
    process.exitCode = 1;
    return;
  }

  const cfg = parseUrl(raw);
  // Nunca imprimir usuario/password: solo a dónde vamos.
  console.log(`\n========== ${cfg.host} / ${cfg.database} ==========`);

  const conn = await mysql.createConnection(cfg);
  try {
    const [existing] = await conn.query(
      'SHOW INDEX FROM historial WHERE Key_name = ?', [INDEX_NAME]
    );
    if (existing.length > 0) {
      console.log(`✔ El índice ${INDEX_NAME} YA existe. Nada que hacer.`);
      return;
    }

    const [rows] = await conn.query('SELECT COUNT(*) AS n FROM historial');
    console.log(`• historial tiene ${Number(rows[0].n).toLocaleString('es-MX')} filas.`);
    console.log(`• Creando índice ${INDEX_NAME}(tipo, ref_id) ...`);
    const t0 = Date.now();
    await conn.query(`ALTER TABLE historial ADD INDEX ${INDEX_NAME} (tipo, ref_id)`);
    console.log(`✔ Índice creado en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  } catch (err) {
    console.error('✖ Error:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

run();
