// Carga valores de columna CTO al campo inventarios.cto
// Match por codigo_unico. NO modifica otras columnas.
require('dotenv').config();
const XLSX = require('xlsx');
const path = 'C:\\Users\\Mario\\Downloads\\INVENTARIO GRUPO IMU QEB DIGITAL CON CTO (2).xlsx';
const mysql = require('mysql2/promise');

async function main() {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const pairs = [];
  for (const r of rows) {
    const codigo = (r['codigo_unico '] || r['codigo_unico'] || '').toString().trim();
    const cto = (r['CTO '] || r['CTO'] || '').toString().trim();
    if (codigo && cto) pairs.push({ codigo, cto });
  }
  console.log(`Rows en Excel con codigo_unico + CTO: ${pairs.length}`);

  const connUrl = process.env.DATABASE_URL;
  if (!connUrl) throw new Error('DATABASE_URL no está en env');

  // Parse URL like mysql://user:pass@host:port/db?params
  const urlNoProto = connUrl.replace('mysql://', '');
  const [creds, hostDbParams] = urlNoProto.split('@');
  const [user, passEncoded] = creds.split(':');
  const password = decodeURIComponent(passEncoded);
  const [hostPortDbPart] = hostDbParams.split('?');
  const [hostPort, db] = hostPortDbPart.split('/');
  const [host, portStr] = hostPort.split(':');
  const port = parseInt(portStr || '3306');

  console.log(`Conectando a ${host}:${port}/${db} como ${user}`);
  const conn = await mysql.createConnection({
    host, port, user, password, database: db,
    ssl: host.includes('digitalocean') ? { rejectUnauthorized: false } : undefined,
  });

  // Verificar si la columna cto existe; si no, crearla
  const [cols] = await conn.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventarios' AND COLUMN_NAME = 'cto'`,
    [db]
  );
  if (cols.length === 0) {
    console.log('Columna cto no existe, creándola...');
    await conn.execute(`ALTER TABLE inventarios ADD COLUMN cto VARCHAR(20) NULL`);
    console.log('✓ Columna cto creada');
  } else {
    console.log('✓ Columna cto ya existe');
  }

  let updated = 0, notFound = 0;
  for (const p of pairs) {
    const [res] = await conn.execute(
      'UPDATE inventarios SET cto = ? WHERE codigo_unico = ?',
      [p.cto, p.codigo]
    );
    if (res.affectedRows > 0) updated++;
    else notFound++;
  }
  console.log(`✓ Filas actualizadas: ${updated}`);
  console.log(`✗ codigo_unico no encontrados: ${notFound}`);

  // Sanity check
  const [sample] = await conn.execute(
    'SELECT codigo_unico, cto FROM inventarios WHERE cto IS NOT NULL LIMIT 5'
  );
  console.log('\nMuestra post-update:');
  console.log(sample);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
