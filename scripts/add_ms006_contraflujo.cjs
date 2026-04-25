// Inserta MS006 Contraflujo en inventarios + 13 espacios en espacio_inventario
// Lee DATABASE_URL del env. Idempotente: no duplica si ya existe.
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const connUrl = process.env.DATABASE_URL;
  const urlNoProto = connUrl.replace('mysql://', '');
  const [creds, hostDbParams] = urlNoProto.split('@');
  const [user, passEncoded] = creds.split(':');
  const password = decodeURIComponent(passEncoded);
  const [hostPortDbPart] = hostDbParams.split('?');
  const [hostPort, db] = hostPortDbPart.split('/');
  const [host, portStr] = hostPort.split(':');
  const port = parseInt(portStr || '3306');

  const conn = await mysql.createConnection({
    host, port, user, password, database: db,
    ssl: host.includes('digitalocean') ? { rejectUnauthorized: false } : undefined,
  });

  console.log(`=== DB: ${db} ===`);

  // Idempotencia: verificar si ya existe
  const [exists] = await conn.execute(
    "SELECT id FROM inventarios WHERE codigo_unico = 'MS006_Contraflujo_Ciudad de México'"
  );
  if (exists.length > 0) {
    console.log(`⚠ Ya existe inventario id=${exists[0].id}. Saltando INSERT.`);
    const [esp] = await conn.execute(
      'SELECT COUNT(*) as c FROM espacio_inventario WHERE inventario_id = ?',
      [exists[0].id]
    );
    console.log(`  Espacios actuales: ${esp[0].c}`);
    await conn.end();
    return;
  }

  await conn.beginTransaction();
  try {
    // INSERT inventario con los datos del Excel
    const [result] = await conn.execute(`
      INSERT INTO inventarios (
        codigo_unico, ubicacion, tipo_de_cara, cara, mueble,
        latitud, longitud, plaza, estado, municipio, cp,
        tradicional_digital, sentido, tipo_de_mueble,
        ancho, alto, nivel_socioeconomico, total_espacios, tiempo,
        estatus, codigo, isla, mueble_isla, mundialista, cto
      ) VALUES (
        'MS006_Contraflujo_Ciudad de México',
        'AV. LOMAS VERDES - PIERRE LYONNET',
        'Contraflujo',
        'B',
        'MULTISERVICIO',
        19.5073554999999, -99.2595309999999,
        'Ciudad de México', 'Ciudad de México', 'NAUCALPAN', 53117,
        'DIGITAL', 'O-P', 'MULTISERVICIO',
        1.21, 1.77, 'ABC+', 13, 20,
        'Disponible', 'MS006', 'NO', 'NA', 'NO', 'CTO 3'
      )
    `);
    const inventarioId = result.insertId;
    console.log(`✓ Inventario creado con id=${inventarioId}`);

    // INSERT 13 espacios
    const placeholders = Array(13).fill('(?, ?)').join(', ');
    const values = [];
    for (let i = 1; i <= 13; i++) {
      values.push(inventarioId, i);
    }
    await conn.execute(
      `INSERT INTO espacio_inventario (inventario_id, numero_espacio) VALUES ${placeholders}`,
      values
    );
    console.log(`✓ 13 espacios creados para inventario_id=${inventarioId}`);

    await conn.commit();
    console.log('✓ Transacción commit');

    // Verificación
    const [check] = await conn.execute(
      'SELECT id, codigo_unico, tradicional_digital, total_espacios, cto FROM inventarios WHERE id = ?',
      [inventarioId]
    );
    console.log('\nRegistro final:', check[0]);
    const [espChk] = await conn.execute(
      'SELECT COUNT(*) as c FROM espacio_inventario WHERE inventario_id = ?',
      [inventarioId]
    );
    console.log('Espacios creados:', espChk[0].c);
  } catch (e) {
    await conn.rollback();
    console.error('✗ Rollback. Error:', e.message);
    throw e;
  } finally {
    await conn.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
