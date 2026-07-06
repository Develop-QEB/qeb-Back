// Indices aditivos para el endpoint /api/dashboard/inventory-detail (getInventoryDetail):
// el endpoint tarda ~9s porque hace findMany sobre inventarios sin indices en las
// columnas de filtro y termina en full-scan.
//
// Es idempotente: si el indice ya existe, no lo re-crea. SOLO toca DEV/PRUEBAS
// (Hostinger). Para aplicar en prod hay que correr los mismos CREATE INDEX en
// DigitalOcean manualmente despues de validar tiempos aca.
//
// Correr: node scripts/add_idx_dashboard_perf.cjs
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

const INDICES = [
  { table: 'inventarios', name: 'idx_inv_estado', cols: 'estado' },
  { table: 'inventarios', name: 'idx_inv_plaza', cols: 'plaza' },
  { table: 'inventarios', name: 'idx_inv_mueble', cols: 'mueble' },
  { table: 'inventarios', name: 'idx_inv_nse', cols: 'nivel_socioeconomico' },
  { table: 'inventarios', name: 'idx_inv_tipo', cols: 'tradicional_digital' },
  { table: 'inventarios', name: 'idx_inv_estatus', cols: 'estatus' },
  { table: 'reservas', name: 'idx_rsv_calendario', cols: 'calendario_id' },
];

async function run() {
  console.log(`\n========== ${DEV.label} ==========`);
  const conn = await mysql.createConnection({
    host: DEV.host, port: DEV.port, user: DEV.user,
    password: DEV.password, database: DEV.database, ssl: DEV.ssl,
  });
  try {
    for (const idx of INDICES) {
      const [existing] = await conn.query(
        `SHOW INDEX FROM ${idx.table} WHERE Key_name = ?`, [idx.name]
      );
      if (existing.length > 0) {
        console.log(`  = ${idx.table}.${idx.name} ya existe.`);
        continue;
      }
      const t0 = Date.now();
      await conn.query(`CREATE INDEX ${idx.name} ON ${idx.table} (${idx.cols})`);
      console.log(`  + ${idx.table}.${idx.name} creado en ${((Date.now() - t0) / 1000).toFixed(2)}s (cols: ${idx.cols})`);
    }

    // Verificar tiempos con EXPLAIN sobre las queries reales del endpoint.
    console.log('\nEXPLAIN inventarios (filtro tipico dashboard):');
    const [plan1] = await conn.query(
      `EXPLAIN SELECT id, plaza, mueble, estatus FROM inventarios
       WHERE estado = 'Jalisco' AND tradicional_digital = 'Tradicional'`
    );
    for (const row of plan1) {
      console.log(`  tabla=${row.table} tipo=${row.type} key=${row.key || '(ninguno)'} rows≈${row.rows}`);
    }

    console.log('\nEXPLAIN reservas (join por calendario):');
    const [plan2] = await conn.query(
      `EXPLAIN SELECT ei.inventario_id, rsv.estatus
       FROM reservas rsv
       INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
       WHERE rsv.deleted_at IS NULL AND rsv.calendario_id IN (1,2,3)`
    );
    for (const row of plan2) {
      console.log(`  tabla=${row.table} tipo=${row.type} key=${row.key || '(ninguno)'} rows≈${row.rows}`);
    }
  } finally {
    await conn.end();
  }
  console.log('\nListo.');
}

run().catch((e) => { console.error('Error:', e.message); process.exit(1); });
