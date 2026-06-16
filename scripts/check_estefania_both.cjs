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
    const u = await c.usuario.findUnique({
      where: { id: 1057647 },
      select: { id: true, nombre: true, correo_electronico: true, user_role: true, puesto: true, area: true, deleted_at: true },
    });
    console.log(`[${label}]`, JSON.stringify(u, null, 2));
  } finally {
    await c.$disconnect();
  }
}

(async () => {
  await fetch(path.join(__dirname, '..', '.env'), 'DEV');
  await fetch(path.join(__dirname, '..', '.env.backup-prod'), 'PROD');
})().catch(e => { console.error(e); process.exit(1); });
