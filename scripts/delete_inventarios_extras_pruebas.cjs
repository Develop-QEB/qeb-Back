// Borra inventarios de pruebas que NO existen en prod (los "sobrantes").
// Solo borra si NO tienen reservas vinculadas (verifica antes).
//
// Uso (dry-run):
//   PROD_DB_URL='...' node scripts/delete_inventarios_extras_pruebas.cjs
// Uso (apply):
//   PROD_DB_URL='...' node scripts/delete_inventarios_extras_pruebas.cjs --apply
require('dotenv').config();
const mysql = require('mysql2/promise');

function parseUrl(url) {
  const u = url.replace('mysql://', '');
  const [creds, rest] = u.split('@');
  const [user, passEnc] = creds.split(':');
  const password = decodeURIComponent(passEnc);
  const [hostDb] = rest.split('?');
  const [hostPort, database] = hostDb.split('/');
  const [host, port] = hostPort.split(':');
  return { host, port: parseInt(port || '3306'), user, password, database };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prod = await mysql.createConnection({ ...parseUrl(process.env.PROD_DB_URL), ssl: { rejectUnauthorized: false } });
  const pruebas = await mysql.createConnection(parseUrl(process.env.DATABASE_URL));

  // Codigos en prod
  const [prodRows] = await prod.query(`SELECT codigo_unico FROM inventarios WHERE codigo_unico IS NOT NULL`);
  const prodSet = new Set(prodRows.map(r => String(r.codigo_unico).trim()));

  // Sobrantes en pruebas
  const [pruebasRows] = await pruebas.query(`SELECT id, codigo_unico FROM inventarios WHERE codigo_unico IS NOT NULL`);
  const sobrantes = pruebasRows.filter(r => !prodSet.has(String(r.codigo_unico).trim()));

  if (sobrantes.length === 0) {
    console.log('✅ Pruebas ya está igual a prod, nada que borrar.');
    await prod.end(); await pruebas.end();
    return;
  }

  const sobrantesIds = sobrantes.map(r => r.id);
  console.log(`Sobrantes a evaluar: ${sobrantesIds.length}`);

  // Verificar reservas vinculadas (a través de espacio_inventario)
  const [reservasLinks] = await pruebas.query(`
    SELECT COUNT(*) AS n FROM reservas r
    INNER JOIN espacio_inventario ei ON ei.id = r.inventario_id
    WHERE ei.inventario_id IN (${sobrantesIds.map(() => '?').join(',')})
      AND r.deleted_at IS NULL
  `, sobrantesIds);
  const reservasActivas = Number(reservasLinks[0]?.n || 0);

  console.log(`Reservas activas vinculadas: ${reservasActivas}`);
  if (reservasActivas > 0) {
    console.log('⚠️  ABORTAR: hay reservas activas vinculadas. Revisar antes de borrar.');
    await prod.end(); await pruebas.end();
    process.exit(1);
  }

  console.log(`\nModo: ${apply ? '🔥 APPLY' : '🧪 DRY-RUN'}`);

  if (!apply) {
    console.log(`\nA borrar: ${sobrantesIds.length} inventarios + sus espacio_inventario asociados.`);
    console.log('Corre con --apply para ejecutar.');
    await prod.end(); await pruebas.end();
    return;
  }

  // Borrar en batches de 100
  const BATCH = 100;
  let espBorrados = 0, invBorrados = 0;
  for (let i = 0; i < sobrantesIds.length; i += BATCH) {
    const batch = sobrantesIds.slice(i, i + BATCH);
    const ph = batch.map(() => '?').join(',');
    // Espacios primero (FK)
    const [resEsp] = await pruebas.query(
      `DELETE FROM espacio_inventario WHERE inventario_id IN (${ph})`,
      batch
    );
    espBorrados += resEsp.affectedRows;
    // Inventarios
    const [resInv] = await pruebas.query(
      `DELETE FROM inventarios WHERE id IN (${ph})`,
      batch
    );
    invBorrados += resInv.affectedRows;
    console.log(`  Progreso: ${Math.min(i + BATCH, sobrantesIds.length)}/${sobrantesIds.length} (esp:${espBorrados}, inv:${invBorrados})`);
  }

  console.log(`\n✅ Final:`);
  console.log(`  Inventarios borrados: ${invBorrados}`);
  console.log(`  Espacios borrados: ${espBorrados}`);

  // Verificar igualdad final
  const [pruebasNow] = await pruebas.query(`SELECT COUNT(*) as n FROM inventarios WHERE codigo_unico IS NOT NULL`);
  console.log(`\nPruebas ahora: ${pruebasNow[0].n} | Prod: ${prodSet.size} | Diff: ${pruebasNow[0].n - prodSet.size}`);

  await prod.end(); await pruebas.end();
}

main().catch(e => { console.error(e); process.exit(1); });
