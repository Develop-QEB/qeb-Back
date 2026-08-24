// Crea la tabla `conflictos_ocupacion` (estado del monitor de conflictos de
// ocupacion) en la base de DESARROLLO/PRUEBAS (Hostinger).
//
// Para que: el monitor necesita recordar que celdas ya detecto y notifico. Sin
// esta tabla no puede distinguir un conflicto nuevo de uno que ya se aviso, y
// cada corrida notificaria lo mismo otra vez.
//
// Es idempotente: si la tabla ya existe, no hace nada. NO toca prod.
// Correr: node scripts/add_tabla_conflictos_ocupacion.cjs
const mysql = require('mysql2/promise');

// SOLO DESARROLLO/PRUEBAS — intencionalmente NO incluye prod (DigitalOcean).
const DEV = {
  label: 'DEV/PRUEBAS u658050396_QEB_PRUEBAS',
  host: 'srv1978.hstgr.io',
  port: 3306,
  user: 'u658050396_QEB_PRUEBAS',
  password: '/uQ3FCrLG5:6',
  database: 'u658050396_QEB_PRUEBAS',
  ssl: undefined,
};

const TABLA = 'conflictos_ocupacion';

const DDL = `
CREATE TABLE ${TABLA} (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  inventario_id    INT NOT NULL,
  anio             INT NOT NULL,
  numero_catorcena INT NOT NULL,
  tipo             VARCHAR(20) NOT NULL,
  reservas         INT NOT NULL,
  origenes         INT NOT NULL,
  detectado_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  visto_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notificado_at    DATETIME NULL,
  resuelto_at      DATETIME NULL,
  limpiado_at        DATETIME NULL,
  limpiado_por       VARCHAR(100) NULL,
  reserva_conservada INT NULL,
  reservas_liberadas TEXT NULL,
  UNIQUE KEY uq_celda (inventario_id, anio, numero_catorcena),
  KEY idx_estado (resuelto_at, tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function run() {
  console.log(`\n========== ${DEV.label} ==========`);
  const conn = await mysql.createConnection({
    host: DEV.host, port: DEV.port, user: DEV.user,
    password: DEV.password, database: DEV.database, ssl: DEV.ssl,
  });
  try {
    const [existing] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name = ?`,
      [DEV.database, TABLA]
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
