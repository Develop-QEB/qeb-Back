// Crea idx_criterios_lookup(formato, tipo, plaza, activo) en criterios_autorizacion
// SOLO en DEV/PRUEBAS (Hostinger). Abarata el findFirst de calcularEstadoAutorizacion
// (se llama por cara en bulk). Idempotente. NO toca prod.
// Correr: node scripts/add_idx_criterios_lookup.cjs
const mysql = require('mysql2/promise');
const DEV = {
  host: 'srv1978.hstgr.io', port: 3306,
  user: 'u658050396_QEB_PRUEBAS', password: '/uQ3FCrLG5:6',
  database: 'u658050396_QEB_PRUEBAS', ssl: undefined,
};
const INDEX = 'idx_criterios_lookup';
async function run() {
  const conn = await mysql.createConnection(DEV);
  try {
    const [ex] = await conn.query(`SHOW INDEX FROM criterios_autorizacion WHERE Key_name = ?`, [INDEX]);
    if (ex.length) { console.log(`✔ ${INDEX} YA existe.`); }
    else {
      const t0 = Date.now();
      await conn.query(`CREATE INDEX ${INDEX} ON criterios_autorizacion (formato, tipo, plaza, activo)`);
      console.log(`✔ Índice creado en ${((Date.now()-t0)/1000).toFixed(2)}s`);
    }
    const [plan] = await conn.query(
      `EXPLAIN SELECT * FROM criterios_autorizacion WHERE formato='PARABUS' AND tipo='Tradicional' AND plaza='GUADALAJARA' AND activo=1 LIMIT 1`
    );
    for (const r of plan) console.log(`  EXPLAIN: type=${r.type} key=${r.key || '(ninguno)'} rows≈${r.rows}`);
  } finally { await conn.end(); }
  console.log('Listo.');
}
run().catch(e => { console.error('Error:', e.message); process.exit(1); });
