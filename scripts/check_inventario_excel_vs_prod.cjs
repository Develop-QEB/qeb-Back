// Cruza el Excel de inventario con la tabla inventarios en prod.
// Reporta cuáles codigo_unico del Excel ya existen y cuáles no.
const XLSX = require('xlsx');
const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.PROD_DB_URL;
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });
  console.log(`=== DB: ${database} @ ${host} ===\n`);

  // Leer Excel
  const xlsxPath = 'C:/Users/Mario/Downloads/inventario Grupo IMU - MI MACRO-KIOSCOS-BOLEROS (1).xlsx';
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets['Hoja1'];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Headers: Cod, codigo_unico, ubicacion, tipo_de_cara, cara, mueble, ...
  // codigo_unico es columna 1, mueble es columna 5
  const excelRows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r || !r[1]) continue;
    excelRows.push({
      cod: r[0],
      codigo_unico: String(r[1]).trim(),
      mueble: r[5],
      plaza: r[8],
    });
  }
  console.log(`Filas en Excel: ${excelRows.length}\n`);

  // Pull all codigo_unico de la BD
  const [dbRows] = await conn.query(
    `SELECT codigo_unico, mueble, plaza FROM inventarios WHERE codigo_unico IS NOT NULL`
  );
  const dbMap = new Map();
  for (const r of dbRows) {
    if (r.codigo_unico) dbMap.set(String(r.codigo_unico).trim(), r);
  }
  console.log(`Total inventarios en DB: ${dbRows.length}`);

  // Cruzar
  const existentes = [];
  const nuevos = [];
  for (const r of excelRows) {
    if (dbMap.has(r.codigo_unico)) {
      existentes.push(r);
    } else {
      nuevos.push(r);
    }
  }

  console.log(`\n📊 Resumen:`);
  console.log(`  ✅ Existentes en DB: ${existentes.length}`);
  console.log(`  ➕ Nuevos (no están): ${nuevos.length}`);

  // Breakdown por mueble
  const byMueble = (rows) => {
    const o = {};
    for (const r of rows) o[r.mueble || '(null)'] = (o[r.mueble || '(null)'] || 0) + 1;
    return o;
  };
  console.log(`\nExistentes por mueble:`);
  console.table(byMueble(existentes));
  console.log(`\nNuevos por mueble:`);
  console.table(byMueble(nuevos));

  // Sample new items
  console.log(`\nMuestra de NUEVOS (primeros 15):`);
  console.table(nuevos.slice(0, 15));

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
