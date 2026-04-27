// Recalcula caras_flujo / caras_contraflujo en solicitudCaras de circuitos digitales
// usando el conteo real de inventarios.tipo_de_cara del CTO+plaza.
require('dotenv').config();
const mysql = require('mysql2/promise');

const PLAZA_LIKE = { MX: 'CIUDAD DE M%', MTY: 'MONTERREY%' };

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
    ssl: host.includes('digitalocean') ? { rejectUnauthorized: false } : undefined,
  });
  console.log(`=== DB: ${db} ===`);

  // Cache de counts por (CTO, plazaCode)
  const cache = new Map();
  async function getCounts(cto, plazaCode) {
    const key = `${cto}|${plazaCode}`;
    if (cache.has(key)) return cache.get(key);
    const like = PLAZA_LIKE[plazaCode] || `${plazaCode}%`;
    const [rows] = await conn.execute(
      `SELECT tipo_de_cara, COUNT(*) as c FROM inventarios
       WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)
       GROUP BY tipo_de_cara`,
      [cto, like]
    );
    let flujo = 0, contraflujo = 0;
    for (const r of rows) {
      const tc = (r.tipo_de_cara || '').toLowerCase();
      const cnt = Number(r.c);
      if (tc.startsWith('contraflujo')) contraflujo += cnt;
      else if (tc.startsWith('flujo')) flujo += cnt;
    }
    cache.set(key, { flujo, contraflujo });
    return { flujo, contraflujo };
  }

  // Find all caras with circuito articulo
  const [caras] = await conn.execute(
    `SELECT id, articulo, caras_flujo, caras_contraflujo
     FROM solicitudCaras
     WHERE articulo REGEXP '^(RT|BF|CT|CF)-DIG-[0-9]+-[A-Z]+$'`
  );
  console.log(`Caras circuito encontradas: ${caras.length}`);

  let updated = 0, skipped = 0;
  for (const c of caras) {
    const m = c.articulo.match(/^(RT|BF|CT|CF)-DIG-(\d+)-([A-Z]+)$/i);
    if (!m) continue;
    const ctoNum = parseInt(m[2]);
    const plazaCode = m[3].toUpperCase();
    const cto = `CTO ${ctoNum}`;
    const counts = await getCounts(cto, plazaCode);
    if (counts.flujo === c.caras_flujo && counts.contraflujo === c.caras_contraflujo) {
      skipped++;
      continue;
    }
    await conn.execute(
      `UPDATE solicitudCaras SET caras_flujo = ?, caras_contraflujo = ? WHERE id = ?`,
      [counts.flujo, counts.contraflujo, c.id]
    );
    console.log(`  ✓ cara id=${c.id} (${c.articulo}): ${c.caras_flujo}/${c.caras_contraflujo} → ${counts.flujo}/${counts.contraflujo}`);
    updated++;
  }
  console.log(`\nTotal: ${updated} actualizadas, ${skipped} ya correctas`);
  await conn.end();
}
main().catch(e => { console.error(e); process.exit(1); });
