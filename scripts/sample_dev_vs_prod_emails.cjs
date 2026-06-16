const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
function parseDatabaseUrl(p) {
  const c = fs.readFileSync(p, 'utf8');
  return c.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m)[1].replace(/^"|"$/g, '');
}
async function run(envPath, label) {
  const c = new PrismaClient({ datasources: { db: { url: parseDatabaseUrl(envPath) } }, log: ['error'] });
  try {
    const total = await c.usuario.count({ where: { deleted_at: null } });
    const sample = await c.usuario.findMany({
      where: { deleted_at: null },
      select: { id: true, nombre: true, correo_electronico: true },
      orderBy: { id: 'asc' },
      take: 5,
    });
    console.log(`\n[${label}] total=${total}, primeros 5:`);
    sample.forEach(u => console.log(`  id=${u.id} ${u.nombre} | ${u.correo_electronico}`));
  } finally { await c.$disconnect(); }
}
(async () => {
  await run(path.join(__dirname, '..', '.env'), 'DEV (.env)');
  await run(path.join(__dirname, '..', '.env.backup-prod'), 'PROD');
})().catch(e => { console.error(e); process.exit(1); });
