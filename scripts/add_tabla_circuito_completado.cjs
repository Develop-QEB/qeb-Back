// Crea las tablas del versionado de circuitos completados (Vista Compartir):
//
//   circuito_completado          -> una fila por cada vez que un circuito
//                                   (solicitudCaras) llega a N/N reservas.
//                                   Guarda la fecha de "completado" y la version.
//   circuito_completado_reserva  -> las reservas (piezas) que integraban el
//                                   circuito en ese momento (la "foto").
//
// Para que: la Vista Compartir (interna + publica + mapa) muestra SIEMPRE la
// ultima version completada de cada circuito. Si despues una pieza se desplaza
// (multireservas) o se quita a mano, sigue apareciendo pero en gris.
//
// Idempotente: si las tablas ya existen, no hace nada.
//
// Por default corre SOLO en DESARROLLO/PRUEBAS (Hostinger), igual que los demas
// scripts de este folder. Para produccion hay que pedirlo explicitamente:
//   node scripts/add_tabla_circuito_completado.cjs           -> DEV/PRUEBAS
//   node scripts/add_tabla_circuito_completado.cjs --prod    -> usa DATABASE_URL del .env
const mysql = require('mysql2/promise');

// SOLO DESARROLLO/PRUEBAS (mismas credenciales que add_tabla_conflictos_ocupacion.cjs).
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

const DDL = {
  circuito_completado: `
CREATE TABLE circuito_completado (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  solicitud_caras_id INT NOT NULL,
  idquote            VARCHAR(255) NOT NULL,
  version            INT NOT NULL,
  fecha_completado   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  caras_esperadas    INT NOT NULL,
  total_reservas     INT NOT NULL,
  origen             VARCHAR(50) NULL,
  usuario_id         INT NULL,
  usuario_nombre     VARCHAR(255) NULL,
  UNIQUE KEY uq_cc_sc_version (solicitud_caras_id, version),
  KEY idx_cc_idquote (idquote)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`,
  circuito_completado_reserva: `
CREATE TABLE circuito_completado_reserva (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  completado_id         INT NOT NULL,
  reserva_id            INT NOT NULL,
  espacio_inventario_id INT NOT NULL,
  inventario_id         INT NULL,
  estatus               VARCHAR(255) NULL,
  KEY idx_ccr_completado (completado_id),
  KEY idx_ccr_reserva (reserva_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`,
};

async function run() {
  const T = targetFromArgs();
  console.log(`\n========== ${T.label} ==========`);
  const conn = await mysql.createConnection({
    host: T.host, port: T.port, user: T.user, password: T.password, database: T.database, ssl: T.ssl,
  });
  try {
    for (const [tabla, ddl] of Object.entries(DDL)) {
      const [existing] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [T.database, tabla]
      );
      if (Number(existing[0].n) > 0) {
        console.log(`✔ La tabla ${tabla} YA existe. Nada que hacer.`);
        continue;
      }
      console.log(`• Creando tabla ${tabla} ...`);
      const t0 = Date.now();
      await conn.query(ddl);
      console.log(`✔ Tabla ${tabla} creada en ${Date.now() - t0} ms.`);
    }
    console.log('\nSiguiente paso (opcional): npx ts-node src/scripts/backfill-circuitos-completados.ts');
  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('✖ Error:', err.message);
  process.exit(1);
});
