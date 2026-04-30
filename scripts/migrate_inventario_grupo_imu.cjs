// Migra inventarios del Excel "inventario Grupo IMU - MI MACRO-KIOSCOS-BOLEROS (1).xlsx"
// que NO existen ya en la BD prod (skip por codigo_unico).
// Crea 1 row en `inventarios` y N rows en `espacio_inventario` (N = total_espacios o 1).
//
// Uso (dry-run):
//   PROD_DB_URL='...' node scripts/migrate_inventario_grupo_imu.cjs
//
// Uso (apply):
//   PROD_DB_URL='...' node scripts/migrate_inventario_grupo_imu.cjs --apply

const XLSX = require('xlsx');
const mysql = require('mysql2/promise');

const XLSX_PATH = 'C:/Users/Mario/Downloads/inventario Grupo IMU - MI MACRO-KIOSCOS-BOLEROS (1).xlsx';
const BATCH_SIZE = 100;

// Normalización: campos a mayúsculas para coincidir con el patrón existente en BD
const upper = (v) => v == null ? null : String(v).trim().toUpperCase();
const trim = (v) => v == null ? null : String(v).trim();
const num = (v) => {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/\s+/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v) => {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
};

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.PROD_DB_URL;
  if (!url) { console.error('Falta PROD_DB_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password), database,
    ssl: { rejectUnauthorized: false },
  });
  console.log(`=== DB: ${database} @ ${host} ===`);
  console.log(`Modo: ${apply ? '🔥 APPLY' : '🧪 DRY-RUN'}\n`);

  // Leer Excel
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets['Hoja1'];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // Headers (índices):
  // 0:Cod, 1:codigo_unico, 2:ubicacion, 3:tipo_de_cara, 4:cara, 5:mueble,
  // 6:latitud, 7:longitud, 8:plaza, 9:estado, 10:Municipio, 11:cp,
  // 12:tradicional_digital, 13:sentido, 14:entre_calle_1, 15:entre_calle_2,
  // 16:orientacion, 17:tipo_de_mueble, 18:ancho, 19:alto, 20:archivos_id,
  // 21:tarifa_piso, 22:tarifa_publica, 23:nivel_socioeconomico, 24:total_espacios,
  // 25:tiempo, 26:ESTATUS

  // codigo_unico ya en BD
  const [existRows] = await conn.query(
    `SELECT codigo_unico FROM inventarios WHERE codigo_unico IS NOT NULL`
  );
  const existSet = new Set(existRows.map(r => String(r.codigo_unico).trim()));
  console.log(`En BD: ${existSet.size} codigo_unico existentes\n`);

  // Filtrar nuevos
  const nuevos = [];
  let saltados = 0;
  let errores = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r || !r[1]) continue;
    const codigo_unico = String(r[1]).trim();
    if (existSet.has(codigo_unico)) {
      saltados++;
      continue;
    }
    const lat = num(r[6]);
    const lng = num(r[7]);
    if (lat == null || lng == null) {
      errores.push({ codigo_unico, motivo: 'lat/lng null' });
      continue;
    }
    nuevos.push({
      codigo_unico,
      codigo: trim(r[0]),
      ubicacion: upper(r[2]),
      tipo_de_cara: trim(r[3]) || 'Flujo',
      cara: trim(r[4]) || 'A',
      mueble: upper(r[5]),
      latitud: lat,
      longitud: lng,
      plaza: upper(r[8]),
      estado: trim(r[9]),
      municipio: upper(r[10]),
      cp: intOrNull(r[11]),
      tradicional_digital: trim(r[12]) || 'Tradicional',
      sentido: trim(r[13]),
      entre_calle_1: trim(r[14]),
      entre_calle_2: trim(r[15]),
      orientacion: trim(r[16]),
      tipo_de_mueble: upper(r[17]),
      ancho: num(r[18]) ?? 0,
      alto: num(r[19]) ?? 0,
      archivos_id: null,
      tarifa_piso: num(r[21]),
      tarifa_publica: num(r[22]),
      nivel_socioeconomico: trim(r[23]),
      total_espacios: intOrNull(r[24]) ?? 1,
      tiempo: intOrNull(r[25]) ?? 24,
      estatus: 'Disponible',
      mundialista: 'NO',
      isla: 'NO',
      mueble_isla: 'NA',
    });
  }

  console.log(`📊 Resumen:`);
  console.log(`  Filas en Excel: ${data.length - 1}`);
  console.log(`  Saltadas (ya existen): ${saltados}`);
  console.log(`  Errores (lat/lng null): ${errores.length}`);
  console.log(`  ➕ A insertar: ${nuevos.length}\n`);
  if (errores.length > 0) {
    console.log('Errores:'); console.table(errores.slice(0, 10));
  }

  // Breakdown por mueble
  const byMueble = {};
  for (const n of nuevos) byMueble[n.mueble] = (byMueble[n.mueble] || 0) + 1;
  console.log('A insertar por mueble:');
  console.table(byMueble);

  // Sample preview
  console.log('\nMuestra de fila a insertar (primera):');
  console.log(JSON.stringify(nuevos[0], null, 2));

  if (!apply) {
    console.log('\n🧪 DRY-RUN: no se insertó nada. Corre con --apply para aplicar.');
    await conn.end();
    return;
  }

  // INSERT en batches
  console.log(`\n🔥 Insertando ${nuevos.length} en batches de ${BATCH_SIZE}...\n`);
  let insertedInv = 0;
  let insertedEsp = 0;
  let failed = 0;

  for (let i = 0; i < nuevos.length; i += BATCH_SIZE) {
    const batch = nuevos.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      try {
        const [res] = await conn.query(
          `INSERT INTO inventarios
           (codigo_unico, codigo, ubicacion, tipo_de_cara, cara, mueble,
            latitud, longitud, plaza, estado, municipio, cp,
            tradicional_digital, sentido, entre_calle_1, entre_calle_2,
            orientacion, tipo_de_mueble, ancho, alto, archivos_id,
            tarifa_piso, tarifa_publica, nivel_socioeconomico,
            total_espacios, tiempo, estatus, mundialista, isla, mueble_isla)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.codigo_unico, row.codigo, row.ubicacion, row.tipo_de_cara, row.cara, row.mueble,
            row.latitud, row.longitud, row.plaza, row.estado, row.municipio, row.cp,
            row.tradicional_digital, row.sentido, row.entre_calle_1, row.entre_calle_2,
            row.orientacion, row.tipo_de_mueble, row.ancho, row.alto, row.archivos_id,
            row.tarifa_piso, row.tarifa_publica, row.nivel_socioeconomico,
            row.total_espacios, row.tiempo, row.estatus, row.mundialista, row.isla, row.mueble_isla,
          ]
        );
        const invId = res.insertId;
        insertedInv++;
        // Crear N espacios
        for (let n = 1; n <= row.total_espacios; n++) {
          await conn.query(
            `INSERT INTO espacio_inventario (inventario_id, numero_espacio) VALUES (?, ?)`,
            [invId, n]
          );
          insertedEsp++;
        }
      } catch (e) {
        failed++;
        console.error(`  ❌ ${row.codigo_unico}: ${e.message}`);
      }
    }
    console.log(`  Progreso: ${Math.min(i + BATCH_SIZE, nuevos.length)}/${nuevos.length} (${insertedInv} ok, ${failed} fail)`);
  }

  console.log(`\n✅ Final:`);
  console.log(`  Inventarios insertados: ${insertedInv}`);
  console.log(`  Espacios insertados: ${insertedEsp}`);
  console.log(`  Fallos: ${failed}`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
