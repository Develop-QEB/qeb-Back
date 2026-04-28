// Asigna grupo_masivo_id a las caras de propuesta 39 agrupando por
// (articulo, ciudad, estados, formato, tipo, nse) — distintos periodos del mismo grupo.
// El BF correspondiente al RT comparte mismo grupo_masivo_id.
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

  const [caras] = await conn.query(`
    SELECT id, articulo, ciudad, estados, formato, tipo, nivel_socioeconomico,
           grupo_rt_bf, grupo_masivo_id
    FROM solicitudCaras
    WHERE idquote = '39'
    ORDER BY id
  `);
  console.log(`Total caras propuesta 39: ${caras.length}`);

  // Agrupar por (articulo base sin RT/BF, ciudad, estados, formato, tipo, nse)
  // El "articulo base" se obtiene quitando el prefijo RT-/BF-/CT-/CF-
  const groups = new Map();
  for (const c of caras) {
    if (c.grupo_masivo_id) continue; // ya tiene grupo
    const articuloBase = String(c.articulo || '').replace(/^(RT|BF|CT|CF)-/i, '');
    const key = JSON.stringify({
      ab: articuloBase,
      ci: c.ciudad || '',
      es: c.estados || '',
      fm: c.formato || '',
      tp: c.tipo || '',
      ns: c.nivel_socioeconomico || '',
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  let assigned = 0;
  for (const [key, miembros] of groups) {
    if (miembros.length <= 1) continue; // solo cuenta como grupo si hay >1
    const grupoMasivoId = Math.floor(Date.now() / 1000) % 2000000000 + Math.floor(Math.random() * 1000);
    const ids = miembros.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    await conn.query(
      `UPDATE solicitudCaras SET grupo_masivo_id = ? WHERE id IN (${ph})`,
      [grupoMasivoId, ...ids]
    );
    console.log(`  ✅ Grupo ${grupoMasivoId}: ${miembros.length} caras (${miembros[0].articulo}...) → ${JSON.stringify(JSON.parse(key))}`);
    assigned += miembros.length;
  }
  console.log(`\n✅ ${assigned} caras agrupadas en propuesta 39`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
