const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
function parseDatabaseUrl(p) {
  return fs.readFileSync(p, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m)[1].replace(/^"|"$/g, '');
}
(async () => {
  const url = parseDatabaseUrl(path.join(__dirname, '..', '.env.backup-prod'));
  const c = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  const es = await c.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { nombre: { contains: 'Estefa' } },
        { nombre: { contains: 'Estef' } },
        { nombre: { contains: 'Stefa' } },
      ],
    },
    select: { id: true, nombre: true, correo_electronico: true, area: true, puesto: true, user_role: true },
    orderBy: { id: 'asc' },
  });
  console.log(`[PROD] Coincidencias Estef* / Stefa*:`, es.length);
  es.forEach(u => console.log(`  id=${u.id} | ${u.nombre} | ${u.correo_electronico} | area=${u.area} | puesto=${u.puesto} | rol=${u.user_role}`));
  await c.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
