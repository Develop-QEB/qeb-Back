// Crea la tabla `propuesta_economica`: cotizaciones "GRUPO IMU - Propuesta de
// Servicio" que los asesores arman desde el módulo de Solicitudes (botón
// "Propuesta económica"), en reemplazo del Excel que llenaban a mano.
//
// Mismo patrón que `analisis_ocupacion`: el documento completo (encabezado,
// Vía Pública, Aeropuertos, WiFi, Impresiones, observaciones) va como JSON en
// `data`; se guarda por usuario y se comparte por enlace.
//
// Idempotente: si la tabla ya existe, no hace nada.
//
// Por default corre SOLO en DESARROLLO/PRUEBAS (Hostinger). Para produccion:
//   node scripts/add_tabla_propuesta_economica.cjs           -> DEV/PRUEBAS
//   node scripts/add_tabla_propuesta_economica.cjs --prod    -> usa DATABASE_URL del .env
const mysql = require('mysql2/promise');

// SOLO DESARROLLO/PRUEBAS (mismas credenciales que los demas scripts del folder).
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

const TABLA = 'propuesta_economica';

const DDL = `
CREATE TABLE ${TABLA} (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id          INT NOT NULL,
  nombre              VARCHAR(255) NOT NULL,
  -- JSON con el documento completo (ver PropuestaEconomicaData en el front)
  data                LONGTEXT NOT NULL,
  fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_actualizacion TIMESTAMP NULL,
  KEY idx_propuesta_economica_usuario (usuario_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function run() {
  const T = targetFromArgs();
  console.log(`\n========== ${T.label} ==========`);
  const conn = await mysql.createConnection({
    host: T.host, port: T.port, user: T.user, password: T.password, database: T.database, ssl: T.ssl,
  });
  try {
    const [existing] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [T.database, TABLA]
    );
    if (Number(existing[0].n) > 0) {
      console.log(`✔ La tabla ${TABLA} YA existe. Nada que hacer.`);
      return;
    }
    console.log(`• Creando tabla ${TABLA} ...`);
    const t0 = Date.now();
    await conn.query(DDL);
    console.log(`✔ Tabla ${TABLA} creada en ${Date.now() - t0} ms.`);
  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('✖ Error:', err.message);
  process.exit(1);
});
