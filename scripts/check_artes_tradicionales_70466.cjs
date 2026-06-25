const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
function parseDatabaseUrl(p) {
  return fs.readFileSync(p, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m)[1].replace(/^"|"$/g, '');
}
(async () => {
  // dev URL desde .env actual
  const url = parseDatabaseUrl(path.join(__dirname, '..', '.env'));
  const c = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  try {
    const campanaId = 70466;

    // Buscar reservas de la campaña con sus conteos
    const summary = await c.$queryRawUnsafe(`
      SELECT
        at2.id_reserva,
        COUNT(*) as total_filas,
        COUNT(DISTINCT at2.archivo) as urls_unicas,
        COUNT(DISTINCT at2.archivo) as artes_unicos,
        SUBSTRING(MIN(at2.nota), 1, 60) as first_nota
      FROM artes_tradicionales at2
      INNER JOIN reservas r ON r.id = at2.id_reserva
      INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
      INNER JOIN cotizacion ct ON sc.idquote = CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      INNER JOIN campania cm ON cm.cotizacion_id = ct.id
      WHERE cm.id = ?
      GROUP BY at2.id_reserva
      HAVING total_filas != urls_unicas
      ORDER BY total_filas DESC
      LIMIT 15
    `, campanaId);

    console.log(`Reservas de campaña ${campanaId} donde total_filas != urls_unicas:`, summary.length);
    summary.forEach(s => console.log(`  reserva=${s.id_reserva} | filas=${Number(s.total_filas)} | urls_unicas=${Number(s.urls_unicas)} | nota="${s.first_nota||''}"`));

    if (summary.length > 0) {
      const sample = summary[0].id_reserva;
      const detalle = await c.$queryRawUnsafe(`
        SELECT id, archivo, nota, spot, nombre_arte
        FROM artes_tradicionales
        WHERE id_reserva = ?
        ORDER BY id
      `, sample);
      console.log(`\nDetalle reserva ${sample}:`);
      detalle.forEach(d => console.log(`  id=${d.id} | spot=${d.spot} | archivo=${(d.archivo||'').slice(-60)} | nota="${(d.nota||'').slice(0,30)}"`));
    }
  } finally { await c.$disconnect(); }
})().catch(e => { console.error(e); process.exit(1); });
