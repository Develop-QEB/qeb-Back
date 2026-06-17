// Crea el índice compuesto idx_rsv_conflict(inventario_id, deleted_at, estatus)
// en la tabla `reservas` SOLO en la base de DESARROLLO/PRUEBAS (Hostinger).
//
// Para qué: abarata el check de conflicto de createReservaConLock
// (inventario-bloqueo.service.ts) — WHERE inventario_id = ? AND deleted_at IS NULL
// AND estatus IN (...). Importante con el nuevo paralelismo de reservas (lotes de 5).
//
// Es idempotente: si el índice ya existe, no hace nada. NO toca prod.
// Correr: node scripts/add_idx_rsv_conflict.cjs
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

const INDEX_NAME = 'idx_rsv_conflict';

async function run() {
  console.log(`\n========== ${DEV.label} ==========`);
  const conn = await mysql.createConnection({
    host: DEV.host, port: DEV.port, user: DEV.user,
    password: DEV.password, database: DEV.database, ssl: DEV.ssl,
  });
  try {
    // 1) ¿Ya existe el índice?
    const [existing] = await conn.query(
      `SHOW INDEX FROM reservas WHERE Key_name = ?`, [INDEX_NAME]
    );
    if (existing.length > 0) {
      console.log(`✔ El índice ${INDEX_NAME} YA existe. Nada que hacer.`);
    } else {
      console.log(`• Creando índice ${INDEX_NAME} ...`);
      const t0 = Date.now();
      await conn.query(
        `CREATE INDEX ${INDEX_NAME} ON reservas (inventario_id, deleted_at, estatus)`
      );
      console.log(`✔ Índice creado en ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    }

    // 2) Mostrar todos los índices actuales de reservas (para verlos).
    const [idx] = await conn.query(
      `SELECT INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reservas'
       GROUP BY INDEX_NAME`, [DEV.database]
    );
    console.log('\nÍndices actuales en reservas:');
    for (const r of idx) console.log(`  - ${r.name}: (${r.cols})`);

    // 3) EXPLAIN del check de conflicto, para confirmar que usa el índice nuevo.
    console.log('\nEXPLAIN del check de conflicto (debe usar idx_rsv_conflict):');
    const [plan] = await conn.query(
      `EXPLAIN SELECT COUNT(*) c FROM reservas rv
       INNER JOIN solicitudCaras sc ON sc.id = rv.solicitudCaras_id
       WHERE rv.inventario_id = 1
         AND rv.deleted_at IS NULL
         AND rv.estatus IN ('Reservado','Bonificado','Vendido','Vendido bonificado','Con Arte')`
    );
    for (const row of plan) {
      console.log(`  tabla=${row.table} tipo=${row.type} key=${row.key || '(ninguno)'} rows≈${row.rows}`);
    }
  } finally {
    await conn.end();
  }
  console.log('\nListo.');
}

run().catch((e) => { console.error('Error:', e.message); process.exit(1); });
