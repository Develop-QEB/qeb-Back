// Reajusta caras_flujo / caras_contraflujo de las caras RT de circuitos digitales
// en propuesta 38 para que sumen al renta real (no al total del circuito).
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
  });
  console.log(`=== DB: ${db} ===\n`);

  const [caras] = await conn.query(`
    SELECT id, articulo, caras, caras_flujo, caras_contraflujo
    FROM solicitudCaras
    WHERE idquote = '38' AND articulo REGEXP '^RT-DIG-[0-9]+-[A-Z]+$'
  `);
  console.log('Caras RT de circuito en propuesta 38:');
  console.table(caras);

  for (const c of caras) {
    const m = (c.articulo || '').match(/^RT-DIG-(\d+)-([A-Z]+)$/i);
    if (!m) continue;
    const cto = `CTO ${parseInt(m[1])}`;
    const plazaCode = m[2].toUpperCase();
    const like = PLAZA_LIKE[plazaCode] || `${plazaCode}%`;

    // Conteo real del circuito
    const [tot] = await conn.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN tipo_de_cara = 'Flujo' THEN 1 ELSE 0 END) AS flujo,
              SUM(CASE WHEN tipo_de_cara = 'Contraflujo' THEN 1 ELSE 0 END) AS ctra
       FROM inventarios WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)`,
      [cto, like]
    );
    const totalFlujo = Number(tot[0]?.flujo || 0);
    const totalContra = Number(tot[0]?.ctra || 0);
    const totalCirc = totalFlujo + totalContra;
    const renta = Number(c.caras) || 0;

    if (totalCirc === 0 || renta === 0) {
      console.log(`  ${c.articulo}: skip (totalCirc=${totalCirc}, renta=${renta})`);
      continue;
    }

    let flujoCalc = renta < totalCirc
      ? Math.round(renta * totalFlujo / totalCirc)
      : totalFlujo;
    flujoCalc = Math.min(flujoCalc, totalFlujo);
    let contraCalc = Math.min(renta - flujoCalc, totalContra);
    flujoCalc = renta - contraCalc;

    if (flujoCalc === c.caras_flujo && contraCalc === c.caras_contraflujo) {
      console.log(`  ${c.articulo} (cara ${c.id}): ya correcto (${flujoCalc}F + ${contraCalc}CF = ${renta})`);
      continue;
    }

    await conn.query(
      `UPDATE solicitudCaras SET caras_flujo = ?, caras_contraflujo = ? WHERE id = ?`,
      [flujoCalc, contraCalc, c.id]
    );
    console.log(`  ✅ ${c.articulo} (cara ${c.id}): ${c.caras_flujo}/${c.caras_contraflujo} → ${flujoCalc}/${contraCalc} (renta=${renta}, circuito=${totalFlujo}F+${totalContra}CF)`);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
