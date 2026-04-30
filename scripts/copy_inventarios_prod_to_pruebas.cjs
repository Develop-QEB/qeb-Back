// Copia inventarios + espacio_inventario de prod a pruebas (Hostinger).
// Solo agrega los que faltan en pruebas (skip por codigo_unico).
//
// Uso (dry-run):
//   PROD_DB_URL='...' node scripts/copy_inventarios_prod_to_pruebas.cjs
// Uso (apply):
//   PROD_DB_URL='...' node scripts/copy_inventarios_prod_to_pruebas.cjs --apply
require('dotenv').config();
const mysql = require('mysql2/promise');

const BATCH_SIZE = 50;

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
  const prodCfg = parseUrl(process.env.PROD_DB_URL);
  const pruebasCfg = parseUrl(process.env.DATABASE_URL);

  const prod = await mysql.createConnection({ ...prodCfg, ssl: { rejectUnauthorized: false } });
  const pruebas = await mysql.createConnection(pruebasCfg);

  console.log(`PROD: ${prodCfg.database} @ ${prodCfg.host}`);
  console.log(`PRUEBAS: ${pruebasCfg.database} @ ${pruebasCfg.host}`);
  console.log(`Modo: ${apply ? '🔥 APPLY' : '🧪 DRY-RUN'}\n`);

  // Codigos en pruebas
  const [pruebasRows] = await pruebas.query(`SELECT codigo_unico FROM inventarios WHERE codigo_unico IS NOT NULL`);
  const pruebasSet = new Set(pruebasRows.map(r => String(r.codigo_unico).trim()));
  console.log(`En pruebas: ${pruebasSet.size} codigo_unico\n`);

  // Inventarios completos de prod (los que faltan en pruebas)
  const [prodInventarios] = await prod.query(`SELECT * FROM inventarios WHERE codigo_unico IS NOT NULL`);
  const faltantes = prodInventarios.filter(r => !pruebasSet.has(String(r.codigo_unico).trim()));
  console.log(`En prod: ${prodInventarios.length}`);
  console.log(`Faltan en pruebas: ${faltantes.length}\n`);

  if (faltantes.length === 0) {
    console.log('✅ Pruebas ya está al día.');
    await prod.end(); await pruebas.end();
    return;
  }

  // Resumen por mueble
  const byMueble = {};
  for (const r of faltantes) byMueble[r.mueble || '(null)'] = (byMueble[r.mueble || '(null)'] || 0) + 1;
  console.log('A copiar por mueble:');
  console.table(byMueble);

  // Map prod_id → faltantes (para luego buscar espacios)
  const prodIdsAfaltar = new Set(faltantes.map(r => r.id));

  // Espacios de prod para esos inventarios
  const [prodEspacios] = await prod.query(`SELECT * FROM espacio_inventario`);
  const espaciosPorInvId = new Map();
  for (const e of prodEspacios) {
    if (prodIdsAfaltar.has(e.inventario_id)) {
      if (!espaciosPorInvId.has(e.inventario_id)) espaciosPorInvId.set(e.inventario_id, []);
      espaciosPorInvId.get(e.inventario_id).push(e);
    }
  }
  let totalEspacios = 0;
  for (const arr of espaciosPorInvId.values()) totalEspacios += arr.length;
  console.log(`Espacios a copiar: ${totalEspacios}\n`);

  // Sample
  console.log('Muestra (primero):');
  const sample = { ...faltantes[0] };
  delete sample.id; // no se inserta el id de prod
  console.log(JSON.stringify(sample, null, 2));

  if (!apply) {
    console.log('\n🧪 DRY-RUN: no se insertó nada. Corre con --apply.');
    await prod.end(); await pruebas.end();
    return;
  }

  // Insertar
  console.log(`\n🔥 Insertando ${faltantes.length} inventarios en pruebas...\n`);
  let okInv = 0, okEsp = 0, fail = 0;

  // Columnas a copiar (excluye id)
  const cols = Object.keys(faltantes[0]).filter(c => c !== 'id');
  const placeholders = cols.map(() => '?').join(',');
  const colsSql = cols.map(c => `\`${c}\``).join(',');

  for (let i = 0; i < faltantes.length; i++) {
    const r = faltantes[i];
    try {
      const values = cols.map(c => r[c]);
      const [res] = await pruebas.query(
        `INSERT INTO inventarios (${colsSql}) VALUES (${placeholders})`,
        values
      );
      const newId = res.insertId;
      okInv++;

      // Espacios
      const espacios = espaciosPorInvId.get(r.id) || [];
      for (const e of espacios) {
        await pruebas.query(
          `INSERT INTO espacio_inventario (inventario_id, numero_espacio) VALUES (?, ?)`,
          [newId, e.numero_espacio]
        );
        okEsp++;
      }
    } catch (e) {
      fail++;
      if (fail <= 5) console.error(`  ❌ ${r.codigo_unico}: ${e.message}`);
    }
    if ((i + 1) % BATCH_SIZE === 0 || i === faltantes.length - 1) {
      console.log(`  Progreso: ${i + 1}/${faltantes.length} (${okInv} ok, ${fail} fail)`);
    }
  }

  console.log(`\n✅ Final:`);
  console.log(`  Inventarios: ${okInv}`);
  console.log(`  Espacios: ${okEsp}`);
  console.log(`  Fallos: ${fail}`);

  await prod.end(); await pruebas.end();
}

main().catch(e => { console.error(e); process.exit(1); });
