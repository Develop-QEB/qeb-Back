// Borra los registros de historial que empiezan con "Suplantó identidad de ..."
// — feedback 2026-07-15: no queremos que aparezcan en ningún screen.
//
// Uso:
//   node scripts/borrar_historial_suplanto_dev.cjs           # dry-run
//   node scripts/borrar_historial_suplanto_dev.cjs --commit  # ejecuta

require('dotenv').config();
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) { console.error('URL invalida'); process.exit(1); }
  const [, user, password, host, port, database] = m;
  // SEGURIDAD: NO permitir contra prod DigitalOcean sin flag explicito adicional
  if (host.includes('ondigitalocean')) {
    console.error('SEGURIDAD: DATABASE_URL apunta a prod (ondigitalocean). Este script es solo para dev.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database, ssl: undefined,
  });
  console.log(`Conectado a ${host} db=${database} (dev)`);
  console.log('Modo:', COMMIT ? 'COMMIT (borra)' : 'DRY-RUN (solo cuenta y muestra)');

  // 1) Contar cuántos existen
  const [countRows] = await conn.query(
    `SELECT COUNT(*) AS c FROM historial WHERE accion LIKE ? OR accion LIKE ?`,
    ['%Suplantó identidad%', '%Suplanto identidad%']
  );
  const total = Number(countRows[0].c);
  console.log(`\nRegistros con "Suplantó identidad": ${total}`);

  if (total === 0) {
    console.log('Nada que borrar. Salgo.');
    await conn.end();
    return;
  }

  // 2) Muestra hasta 10 ejemplos
  const [samples] = await conn.query(
    `SELECT id, tipo, ref_id, accion, usuario_id, fecha_hora
     FROM historial
     WHERE accion LIKE ? OR accion LIKE ?
     ORDER BY id DESC LIMIT 10`,
    ['%Suplantó identidad%', '%Suplanto identidad%']
  );
  console.log('\nUltimos 10 registros:');
  samples.forEach(s => {
    console.log(`  id=${s.id} | tipo=${s.tipo} | ref=${s.ref_id} | usr=${s.usuario_id} | ${s.fecha_hora?.toISOString?.() || s.fecha_hora}`);
    console.log(`     accion: ${s.accion}`);
  });

  if (!COMMIT) {
    console.log('\n[DRY-RUN] No se borro nada. Corre con --commit para ejecutar el DELETE.');
    await conn.end();
    return;
  }

  // 3) DELETE
  console.log('\n>>> Ejecutando DELETE...');
  await conn.beginTransaction();
  try {
    const [res] = await conn.query(
      `DELETE FROM historial WHERE accion LIKE ? OR accion LIKE ?`,
      ['%Suplantó identidad%', '%Suplanto identidad%']
    );
    console.log(`  DELETE historial: affected=${res.affectedRows}`);
    if (res.affectedRows !== total) {
      console.warn(`  AVISO: DELETE afecto ${res.affectedRows}, esperaba ${total}. Verificar antes de COMMIT.`);
    }
    await conn.commit();
    console.log('>>> COMMIT ok');
  } catch (e) {
    await conn.rollback();
    console.error('>>> ROLLBACK por error:', e.message);
    await conn.end();
    process.exit(1);
  }

  // 4) Verificar
  const [after] = await conn.query(
    `SELECT COUNT(*) AS c FROM historial WHERE accion LIKE ? OR accion LIKE ?`,
    ['%Suplantó identidad%', '%Suplanto identidad%']
  );
  console.log(`\nVerificacion post: ${Number(after[0].c)} registros restantes (esperado 0)`);

  await conn.end();
  console.log('\n=== FIN ===');
}

main().catch(e => { console.error(e); process.exit(1); });
