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

  // Criterio Kiosco Guadalajara Tradicional
  const [rows] = await conn.query(`
    SELECT * FROM criterios_autorizacion
    WHERE (formato = 'Kiosco' OR formato = 'KIOSCO')
      AND tipo = 'Tradicional'
      AND (plaza = 'GUADALAJARA' OR plaza = 'TODAS')
      AND activo = 1
    ORDER BY plaza
  `);
  console.log('Criterios Kiosco Tradicional Guadalajara/TODAS:');
  console.table(rows);

  // Cara real solicitud 36
  const [caras] = await conn.query(`
    SELECT id, articulo, ciudad, estados, formato, tipo, caras, bonificacion,
           costo, tarifa_publica, autorizacion_dg, autorizacion_dcm
    FROM solicitudCaras
    WHERE idquote IN (SELECT id FROM propuesta WHERE solicitud_id = 36)
       OR idquote = '36'
  `);
  console.log('\nCaras de solicitud 36:');
  console.table(caras);

  // Análisis
  const cara = caras.find(c => (c.articulo || '').startsWith('RT-KCS'));
  if (cara) {
    const totalCaras = Number(cara.caras) + Number(cara.bonificacion || 0);
    const tarifaEf = totalCaras > 0 ? Number(cara.costo) / totalCaras : 0;
    console.log(`\nAnálisis cara ${cara.articulo}:`);
    console.log(`  totalCaras = ${cara.caras} + ${cara.bonificacion} = ${totalCaras} (${totalCaras % 2 === 0 ? 'par' : 'impar'})`);
    console.log(`  tarifaEfectiva = ${cara.costo} / ${totalCaras} = $${tarifaEf.toFixed(2)}`);
    if (rows.length > 0) {
      const cri = rows[0];
      console.log(`  vs criterio: max_dg=${cri.tarifa_max_dg}/${cri.caras_max_dg} | dcm=${cri.tarifa_min_dcm}-${cri.tarifa_max_dcm}/${cri.caras_min_dcm}-${cri.caras_max_dcm}`);
    }
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
