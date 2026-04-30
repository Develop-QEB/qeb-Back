// Busca / actualiza fechas de una campaña en prod.
// Lee credenciales de PROD_DB_URL (no hardcodeadas).
// Uso:
//   PROD_DB_URL='...' node scripts/find_or_fix_campana_prod.cjs                  → solo busca
//   PROD_DB_URL='...' node scripts/find_or_fix_campana_prod.cjs --apply <campId> → actualiza
const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  if (!url) { console.error('Falta PROD_DB_URL'); process.exit(1); }

  // Parse mysql://user:pass@host:port/db?ssl-mode=REQUIRED
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) { console.error('PROD_DB_URL formato inválido'); process.exit(1); }
  const [, user, password, host, port, database] = m;

  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });
  console.log(`=== DB: ${database} @ ${host} ===\n`);

  const args = process.argv.slice(2);
  const applyIdx = args.indexOf('--apply');
  const apply = applyIdx >= 0;
  const campId = apply ? parseInt(args[applyIdx + 1]) : null;

  if (!apply) {
    // Buscar la campaña por varios criterios
    const [byNombre] = await conn.query(
      `SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id
       FROM campania
       WHERE nombre LIKE ? OR nombre LIKE ? OR nombre LIKE ?
       ORDER BY id DESC
       LIMIT 20`,
      ['%80501%', '%prueba meses%', '%714%']
    );
    console.log('Por nombre LIKE (80501 | prueba meses | 714):');
    console.table(byNombre);

    // También últimas 10 campañas creadas
    const [recent] = await conn.query(
      `SELECT id, nombre, fecha_inicio, fecha_fin, cotizacion_id FROM campania ORDER BY id DESC LIMIT 10`
    );
    console.log('\nÚltimas 10 campañas:');
    console.table(recent);

    console.log('\n→ Identifica el id correcto y corre con --apply <id>');
  } else {
    if (!campId) { console.error('Falta id después de --apply'); process.exit(1); }

    const [before] = await conn.query(
      `SELECT c.id AS camp_id, c.nombre, c.fecha_inicio AS camp_ini, c.fecha_fin AS camp_fin,
              ct.id AS cot_id, ct.fecha_inicio AS cot_ini, ct.fecha_fin AS cot_fin, ct.tipo_periodo
       FROM campania c LEFT JOIN cotizacion ct ON ct.id = c.cotizacion_id WHERE c.id = ?`,
      [campId]
    );
    if (!before[0]) { console.error('Campaña no existe'); await conn.end(); process.exit(1); }
    console.log('ANTES:', before[0]);

    // Match formato existente en prod (midnight MX = 06:00 UTC)
    const fechaInicio = new Date('2026-05-01T06:00:00.000Z');
    const fechaFin = new Date('2026-05-31T06:00:00.000Z');

    await conn.query(
      `UPDATE campania SET fecha_inicio = ?, fecha_fin = ? WHERE id = ?`,
      [fechaInicio, fechaFin, campId]
    );
    if (before[0].cot_id) {
      await conn.query(
        `UPDATE cotizacion SET fecha_inicio = ?, fecha_fin = ? WHERE id = ?`,
        [fechaInicio, fechaFin, before[0].cot_id]
      );
    }

    const [after] = await conn.query(
      `SELECT c.id AS camp_id, c.fecha_inicio AS camp_ini, c.fecha_fin AS camp_fin,
              ct.fecha_inicio AS cot_ini, ct.fecha_fin AS cot_fin
       FROM campania c LEFT JOIN cotizacion ct ON ct.id = c.cotizacion_id WHERE c.id = ?`,
      [campId]
    );
    console.log('\nDESPUÉS:', after[0]);
    console.log('\n✅ Refresca la página de la campaña.');
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
