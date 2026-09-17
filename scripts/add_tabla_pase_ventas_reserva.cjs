// Crea la tabla `pase_ventas_reserva`: foto de las reservas que CRUZARON de la
// propuesta a la campaña en el pase a ventas (el flip de tentativa -> firme que
// hace venderReservasPropuestaConGuardian al aprobar).
//
// Para que: cuando un pase a ventas queda INCOMPLETO (piezas que se perdieron
// contra otra campaña firme), el asesor agrega inventario nuevo ya dentro de la
// campaña. La Vista Compartir necesita distinguir visualmente:
//   - lo que se vino de la propuesta  -> azul
//   - lo que se agrego en la campaña  -> verde
// Sin esta tabla no hay forma exacta de saberlo: `reservas.fecha_reserva` es
// solo fecha (sin hora), y lo tipico es agregar las faltantes el MISMO dia del
// pase a ventas.
//
// Idempotente: si la tabla ya existe, no hace nada.
//
// Por default corre SOLO en DESARROLLO/PRUEBAS (Hostinger). Para produccion:
//   node scripts/add_tabla_pase_ventas_reserva.cjs           -> DEV/PRUEBAS
//   node scripts/add_tabla_pase_ventas_reserva.cjs --prod    -> usa DATABASE_URL del .env
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

const TABLA = 'pase_ventas_reserva';

const DDL = `
CREATE TABLE ${TABLA} (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  propuesta_id          INT NOT NULL,
  campania_id           INT NULL,
  reserva_id            INT NOT NULL,
  solicitud_caras_id    INT NULL,
  espacio_inventario_id INT NULL,
  inventario_id         INT NULL,
  estatus               VARCHAR(255) NULL,
  fecha_pase            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 'aprobacion' (exacto, registrado al aprobar) | 'backfill' (aproximado por fecha)
  origen                VARCHAR(20) NULL,
  UNIQUE KEY uq_pvr_reserva (reserva_id),
  KEY idx_pvr_propuesta (propuesta_id)
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
    console.log('\nSiguiente paso (campañas historicas): npx ts-node --transpile-only src/scripts/backfill-pase-ventas.ts --commit');
  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('✖ Error:', err.message);
  process.exit(1);
});
