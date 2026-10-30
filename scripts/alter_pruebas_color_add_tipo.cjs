// Agrega columna `tipo` + indice compuesto a pruebas_color.
// Jos 2026-10-23: Expansion del modulo "Prueba de Color" a "Revision de Artes
// Anticipada" con dos flujos ('prueba_color' default, 'revision_anticipada'
// nuevo). Comportamiento diferenciado al aprobar (RA vincula a biblioteca,
// PC no) y al eliminar RA aprobada se borran los artes de biblioteca.
//
// SEGURO:
//   - Verifica que la columna NO existe antes de aplicar (idempotente).
//   - Columna NOT NULL con DEFAULT 'prueba_color' -> los registros existentes
//     se llenan automaticamente sin perder datos.
//   - Indice compuesto (tipo, propuesta_id) para listado filtrado por pestana.
//
// Uso:
//   node scripts/alter_pruebas_color_add_tipo.cjs            # dry-run (muestra SQL)
//   node scripts/alter_pruebas_color_add_tipo.cjs --commit   # aplica
//
// Antes de --commit en prod, verificar que .env apunta al cluster correcto.

require('dotenv').config();
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) { console.error('DATABASE_URL con formato invalido'); process.exit(1); }
  const [, user, password, host, port, database] = m;

  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database,
    ssl: host.includes('ondigitalocean') ? { rejectUnauthorized: false } : undefined,
  });
  console.log(`Conectado a ${host} db=${database}`);
  console.log('Modo:', COMMIT ? 'COMMIT (aplica cambios)' : 'DRY-RUN');

  // Verificar si la columna ya existe
  const [cols] = await conn.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'pruebas_color' AND column_name = 'tipo'`,
    [database]
  );
  const columnaExiste = cols.length > 0;
  console.log(`\nColumna 'tipo' en pruebas_color: ${columnaExiste ? 'YA EXISTE' : 'NO existe'}`);

  // Verificar si el indice compuesto ya existe
  const [idx] = await conn.query(
    `SELECT DISTINCT index_name FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = 'pruebas_color' AND index_name = 'idx_tipo_propuesta'`,
    [database]
  );
  const indiceExiste = idx.length > 0;
  console.log(`Indice 'idx_tipo_propuesta': ${indiceExiste ? 'YA EXISTE' : 'NO existe'}`);

  const sqls = [];
  if (!columnaExiste) {
    sqls.push(
      `ALTER TABLE pruebas_color ADD COLUMN tipo VARCHAR(25) NOT NULL DEFAULT 'prueba_color'`
    );
  }
  if (!indiceExiste) {
    sqls.push(
      `ALTER TABLE pruebas_color ADD INDEX idx_tipo_propuesta (tipo, propuesta_id)`
    );
  }

  if (sqls.length === 0) {
    console.log('\nNada que hacer, la columna e indice ya existen.');
    await conn.end();
    return;
  }

  console.log('\nSQL a ejecutar:');
  sqls.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));

  if (!COMMIT) {
    console.log('\nDry-run completado. Re-ejecuta con --commit para aplicar.');
    await conn.end();
    return;
  }

  for (const sql of sqls) {
    console.log(`\nEjecutando: ${sql}`);
    const t0 = Date.now();
    await conn.query(sql);
    console.log(`  OK (${Date.now() - t0}ms)`);
  }

  // Verificacion final
  const [verif] = await conn.query(
    `SELECT COUNT(*) as total, SUM(tipo = 'prueba_color') as pc, SUM(tipo = 'revision_anticipada') as ra
     FROM pruebas_color WHERE deleted_at IS NULL`
  );
  console.log('\nVerificacion:');
  console.log(`  Total registros activos: ${verif[0].total}`);
  console.log(`  tipo='prueba_color': ${verif[0].pc}`);
  console.log(`  tipo='revision_anticipada': ${verif[0].ra}`);

  await conn.end();
  console.log('\nHecho.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
