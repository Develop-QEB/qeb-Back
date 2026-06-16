const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function parseDatabaseUrl(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  return m[1].replace(/^"|"$/g, '');
}

(async () => {
  const url = parseDatabaseUrl(path.join(__dirname, '..', '.env.backup-prod'));
  const c = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  try {
    const r = await c.$queryRawUnsafe("SHOW TABLES LIKE 'biblioteca_artes'");
    console.log('biblioteca_artes en PROD:', r.length > 0 ? 'EXISTE' : 'NO existe');
    if (r.length > 0) {
      const count = await c.$queryRawUnsafe('SELECT COUNT(*) as c FROM biblioteca_artes');
      console.log('Filas:', Number(count[0].c));
    }
  } finally {
    await c.$disconnect();
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
