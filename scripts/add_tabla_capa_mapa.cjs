// Crea la tabla `capa_mapa`: capas de puntos de interes / poligonos KML que
// Trafico usa en el Buscador de Formatos para armar un circuito (conservar
// SOLO lo cercano a ciertos pines, o EXCLUIR lo que cae dentro de poligonos).
//
// Para que: hoy esas capas viven en memoria del navegador y se pierden al
// cerrar el modal. La Vista Compartir (interna y publica) necesita mostrarlas
// como capas activables para que el cliente vea POR QUE el circuito quedo
// donde quedo ("cerca de sucursales", "lejos de la competencia", etc.).
//
// Ancla: solicitud_caras_id (el circuito). `idquote` (= propuesta.id) va
// denormalizado para listar todas las capas de una propuesta con un indice y
// sin join. Como la Vista Compartir de una campaña es la MISMA pagina que la
// de la propuesta (todo se resuelve por idquote), las capas aplican a ambas
// sin copiarlas en el pase a ventas.
//
// Idempotente: si la tabla ya existe, no hace nada.
//
// Por default corre SOLO en DESARROLLO/PRUEBAS (Hostinger). Para produccion:
//   node scripts/add_tabla_capa_mapa.cjs           -> DEV/PRUEBAS
//   node scripts/add_tabla_capa_mapa.cjs --prod    -> usa DATABASE_URL del .env
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

const TABLA = 'capa_mapa';

const DDL = `
CREATE TABLE ${TABLA} (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  solicitud_caras_id INT NOT NULL,
  -- = propuesta.id (solicitudCaras.idquote), denormalizado para listar por propuesta
  idquote            VARCHAR(255) NOT NULL,
  nombre             VARCHAR(255) NOT NULL,
  -- 'incluir' (conservar lo cercano/dentro) | 'excluir' (conservar lo lejano/fuera)
  modo               VARCHAR(10)  NOT NULL,
  -- 'poi' | 'custom' | 'address' | 'kml' | 'mixto'
  origen             VARCHAR(10)  NOT NULL,
  -- JSON: {"pines":[{lat,lng,name,range}], "poligonos":[{name,paths:[{lat,lng}]}]}
  -- Mismo formato que consume @react-google-maps/api: sin mapper en ninguna punta.
  geometria          LONGTEXT     NOT NULL,
  -- KML original en Spaces (solo trazabilidad; la geometria de arriba es la que se pinta)
  archivo_url        VARCHAR(500) NULL,
  visible_cliente    TINYINT(1)   NOT NULL DEFAULT 1,
  total_pines        INT NOT NULL DEFAULT 0,
  total_poligonos    INT NOT NULL DEFAULT 0,
  creado_por         INT NULL,
  creado_por_nombre  VARCHAR(255) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at         DATETIME NULL,
  KEY idx_capa_sc (solicitud_caras_id, deleted_at),
  KEY idx_capa_idquote (idquote, deleted_at)
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
