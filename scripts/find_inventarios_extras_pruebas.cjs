// Identifica inventarios en pruebas que NO están en prod (los "sobrantes")
// y reporta cuáles tienen reservas/espacios para evaluar el impacto de borrarlos.
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
  const prod = await mysql.createConnection({ ...parseUrl(process.env.PROD_DB_URL), ssl: { rejectUnauthorized: false } });
  const pruebas = await mysql.createConnection(parseUrl(process.env.DATABASE_URL));

  // Codigos en prod
  const [prodRows] = await prod.query(`SELECT codigo_unico FROM inventarios WHERE codigo_unico IS NOT NULL`);
  const prodSet = new Set(prodRows.map(r => String(r.codigo_unico).trim()));

  // Inventarios en pruebas que NO están en prod
  const [pruebasRows] = await pruebas.query(
    `SELECT id, codigo_unico, mueble, plaza, estatus FROM inventarios WHERE codigo_unico IS NOT NULL`
  );
  const sobrantes = pruebasRows.filter(r => !prodSet.has(String(r.codigo_unico).trim()));
  // Inventarios sin codigo_unico (raros) los reporto separado
  const [sinCodigo] = await pruebas.query(`SELECT id FROM inventarios WHERE codigo_unico IS NULL`);

  console.log(`Prod: ${prodSet.size}`);
  console.log(`Pruebas: ${pruebasRows.length} (con codigo_unico) + ${sinCodigo.length} (sin codigo_unico)`);
  console.log(`SOBRANTES en pruebas (no están en prod): ${sobrantes.length}\n`);

  if (sobrantes.length === 0) {
    console.log('✅ Pruebas ya está igual a prod.');
    await prod.end(); await pruebas.end();
    return;
  }

  // Para cada sobrante, contar reservas (que se romperían si lo borramos)
  const sobrantesIds = sobrantes.map(r => r.id);
  // Reservas vinculadas vía espacio_inventario
  const [reservasLinks] = await pruebas.query(`
    SELECT ei.inventario_id AS inv_id, COUNT(r.id) AS reservas
    FROM espacio_inventario ei
    LEFT JOIN reservas r ON r.inventario_id = ei.id AND r.deleted_at IS NULL
    WHERE ei.inventario_id IN (${sobrantesIds.map(() => '?').join(',')})
    GROUP BY ei.inventario_id
  `, sobrantesIds);
  const reservasByInv = new Map(reservasLinks.map(r => [r.inv_id, Number(r.reservas)]));

  let conReservas = 0;
  let sinReservas = 0;
  for (const s of sobrantes) {
    if ((reservasByInv.get(s.id) || 0) > 0) conReservas++;
    else sinReservas++;
  }

  console.log(`Sobrantes SIN reservas (se pueden borrar): ${sinReservas}`);
  console.log(`Sobrantes CON reservas (riesgoso borrar): ${conReservas}\n`);

  // Breakdown por mueble
  const byMueble = {};
  for (const s of sobrantes) byMueble[s.mueble || '(null)'] = (byMueble[s.mueble || '(null)'] || 0) + 1;
  console.log('Sobrantes por mueble:');
  console.table(byMueble);

  // Muestra de algunos
  console.log('\nMuestra de sobrantes (primeros 15):');
  console.table(sobrantes.slice(0, 15).map(s => ({
    id: s.id,
    codigo_unico: (s.codigo_unico || '').slice(0, 40),
    mueble: s.mueble,
    plaza: s.plaza,
    estatus: s.estatus,
    reservas: reservasByInv.get(s.id) || 0,
  })));

  await prod.end(); await pruebas.end();
}

main().catch(e => { console.error(e); process.exit(1); });
