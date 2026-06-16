const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function parseDatabaseUrl(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  return m[1].replace(/^"|"$/g, '');
}

async function fetch(envPath, label) {
  const url = parseDatabaseUrl(envPath);
  const c = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  try {
    const id = 1057647;
    const counts = await c.$queryRawUnsafe(`
      SELECT tipo, estatus, COUNT(*) as c
      FROM tareas
      WHERE id_responsable = ? OR id_asignado LIKE '%${id}%'
      GROUP BY tipo, estatus
      ORDER BY c DESC
    `, id);
    console.log(`\n[${label}] Tareas para Estefania (id ${id}):`);
    counts.forEach(r => console.log(`  ${r.tipo} | ${r.estatus} | ${Number(r.c)}`));
  } finally {
    await c.$disconnect();
  }
}

(async () => {
  await fetch(path.join(__dirname, '..', '.env'), 'DEV');
  await fetch(path.join(__dirname, '..', '.env.backup-prod'), 'PROD');
})().catch(e => { console.error(e); process.exit(1); });
