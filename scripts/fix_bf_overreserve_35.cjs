// Limpia las reservas duplicadas en BF de solicitud 35 pruebas.
// El bug: BF reservaba todos los inventarios del CTO en vez de solo `bonificacion`.
// Fix: borrar las reservas extras del BF (mantener solo `bonificacion` reservas)
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.DATABASE_URL.replace('mysql://', '');
  const [creds, rest] = url.split('@');
  const [user, passEnc] = creds.split(':');
  const pass = decodeURIComponent(passEnc);
  const [hostDb] = rest.split('?');
  const [hostPort, db] = hostDb.split('/');
  const [host, port] = hostPort.split(':');
  const conn = await mysql.createConnection({
    host, port: parseInt(port || '3306'), user, password: pass, database: db,
  });
  console.log(`=== DB: ${db} ===\n`);

  // Casos a corregir
  const cases = [
    { caraId: 205, articulo: 'BF-DIG-03-MX', keepCount: 10 }, // bonificacion=10
    { caraId: 204, articulo: 'BF-DIG-03-MX', keepCount: 2 },  // bonificacion=2
  ];

  for (const c of cases) {
    const [rs] = await conn.query(`
      SELECT r.id, r.estatus, inv.codigo_unico, inv.tipo_de_cara
      FROM reservas r
      LEFT JOIN espacio_inventario epIn ON epIn.id = r.inventario_id
      LEFT JOIN inventarios inv ON inv.id = epIn.inventario_id
      WHERE r.solicitudCaras_id = ? AND r.deleted_at IS NULL
      ORDER BY r.id ASC
    `, [c.caraId]);
    console.log(`\nCara ${c.caraId} (${c.articulo}): tiene ${rs.length} reservas, mantener ${c.keepCount}`);

    if (rs.length <= c.keepCount) {
      console.log(`  ✅ Sin necesidad de borrar`);
      continue;
    }

    const idsBorrar = rs.slice(c.keepCount).map(r => r.id);
    console.log(`  🗑️ Borrando ${idsBorrar.length} reservas extras (manteniendo las primeras ${c.keepCount})`);
    const ph = idsBorrar.map(() => '?').join(',');
    const [del] = await conn.query(
      `UPDATE reservas SET deleted_at = NOW() WHERE id IN (${ph})`,
      idsBorrar
    );
    console.log(`  ✅ Marcadas como deleted_at: ${del.affectedRows}`);
  }

  await conn.end();
  console.log('\n✅ Limpieza completa');
}

main().catch(e => { console.error(e); process.exit(1); });
