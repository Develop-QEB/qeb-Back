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

  // Distribución tipo_de_cara por tipo_de_mueble Kiosco
  const [byFormato] = await conn.query(`
    SELECT tipo_de_mueble, tipo_de_cara, COUNT(*) AS total
    FROM inventarios
    WHERE tipo_de_mueble LIKE '%kiosc%' OR tipo_de_mueble LIKE '%kiosk%' OR mueble LIKE '%kiosc%' OR mueble LIKE '%kiosk%'
    GROUP BY tipo_de_mueble, tipo_de_cara
    ORDER BY tipo_de_mueble, tipo_de_cara
  `);
  console.log('KIOSCOS POR tipo_de_mueble/tipo_de_cara:');
  console.table(byFormato);

  // Ejemplos de Kiosco contraflujo si existen
  const [contraflujo] = await conn.query(`
    SELECT id, codigo_unico, tipo_de_mueble, mueble, tipo_de_cara, plaza
    FROM inventarios
    WHERE (tipo_de_mueble LIKE '%kiosc%' OR tipo_de_mueble LIKE '%kiosk%' OR mueble LIKE '%kiosc%' OR mueble LIKE '%kiosk%')
      AND tipo_de_cara = 'Contraflujo'
    LIMIT 10
  `);
  console.log('\nEjemplos Kiosco Contraflujo (primeros 10):');
  console.table(contraflujo);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
