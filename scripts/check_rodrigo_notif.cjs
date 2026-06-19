const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
function parseDatabaseUrl(p) {
  return fs.readFileSync(p, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m)[1].replace(/^"|"$/g, '');
}
async function run(envPath, label) {
  const c = new PrismaClient({ datasources: { db: { url: parseDatabaseUrl(envPath) } }, log: ['error'] });
  try {
    const r = await c.usuario.findMany({
      where: { nombre: { contains: 'Rodrigo Margain' }, deleted_at: null },
      select: { id: true, nombre: true, correo_electronico: true, area: true, puesto: true, user_role: true },
    });
    console.log(`\n[${label}] Rodrigo Margain:`, r.length);
    r.forEach(u => console.log(`  id=${u.id} | ${u.nombre} | ${u.correo_electronico} | ${u.user_role} | ${u.puesto}`));
    if (r.length === 0) { return; }
    const id = r[0].id;

    // Tareas (tipo != 'Notificación') asignadas/responsable
    const tareas = await c.$queryRawUnsafe(`
      SELECT tipo, estatus, COUNT(*) as c
      FROM tareas
      WHERE (id_responsable = ?
             OR id_asignado = ?
             OR id_asignado LIKE '${id},%'
             OR id_asignado LIKE '%,${id}'
             OR id_asignado LIKE '%,${id},%')
        AND tipo IS NOT NULL AND tipo != 'Notificación'
      GROUP BY tipo, estatus
      ORDER BY c DESC
    `, id, String(id));
    console.log(`\n[${label}] TAREAS de Rodrigo:`);
    tareas.forEach(t => console.log(`  ${t.tipo} | ${t.estatus} | ${Number(t.c)}`));

    // Notificaciones (tipo = 'Notificación')
    const notifs = await c.$queryRawUnsafe(`
      SELECT estatus, COUNT(*) as c
      FROM tareas
      WHERE (id_responsable = ?
             OR id_asignado = ?
             OR id_asignado LIKE '${id},%'
             OR id_asignado LIKE '%,${id}'
             OR id_asignado LIKE '%,${id},%')
        AND tipo = 'Notificación'
      GROUP BY estatus
      ORDER BY c DESC
    `, id, String(id));
    console.log(`\n[${label}] NOTIFICACIONES de Rodrigo:`);
    notifs.forEach(n => console.log(`  ${n.estatus} | ${Number(n.c)}`));
  } finally { await c.$disconnect(); }
}
(async () => {
  await run(path.join(__dirname, '..', '.env'), 'DEV');
  await run(path.join(__dirname, '..', '.env.backup-prod'), 'PROD');
})().catch(e => { console.error(e); process.exit(1); });
