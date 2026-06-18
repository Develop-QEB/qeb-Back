const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function parseDatabaseUrl(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  return m[1].replace(/^"|"$/g, '');
}

async function run(envPath, label) {
  const c = new PrismaClient({ datasources: { db: { url: parseDatabaseUrl(envPath) } }, log: ['error'] });
  try {
    const es = await c.usuario.findMany({
      where: { nombre: { contains: 'Estefania' }, deleted_at: null },
      select: { id: true, nombre: true, correo_electronico: true, area: true, puesto: true, user_role: true },
      orderBy: { id: 'asc' },
    });
    console.log(`\n[${label}] Usuarios "Estefania":`, es.length);
    es.forEach(u => console.log(`  id=${u.id} | ${u.nombre} | ${u.correo_electronico} | ${u.area} | ${u.puesto} | rol=${u.user_role}`));
  } finally { await c.$disconnect(); }
}

(async () => {
  await run(path.join(__dirname, '..', '.env'), 'DEV');
  await run(path.join(__dirname, '..', '.env.backup-prod'), 'PROD');
})().catch(e => { console.error(e); process.exit(1); });
