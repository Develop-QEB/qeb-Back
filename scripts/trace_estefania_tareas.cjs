// READ-ONLY: investiga origen de las tareas asignadas a Estefania.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function parseDatabaseUrl(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  return m[1].replace(/^"|"$/g, '');
}

async function run(envPath, label) {
  const url = parseDatabaseUrl(envPath);
  const c = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  const id = 1057647;
  try {
    console.log(`\n========== ${label} ==========`);

    // 1) Propuestas con Estefania como asignada
    const propuestasAsignadas = await c.$queryRawUnsafe(`
      SELECT COUNT(*) as c FROM propuesta
      WHERE id_asignado = ? OR id_asignado LIKE '${id},%' OR id_asignado LIKE '%,${id}' OR id_asignado LIKE '%,${id},%'
    `, String(id));
    console.log(`Propuestas donde Estefania está como id_asignado: ${Number(propuestasAsignadas[0].c)}`);

    // 2) Solicitudes con Estefania como asignada
    const solicitudesAsignadas = await c.$queryRawUnsafe(`
      SELECT COUNT(*) as c FROM solicitud
      WHERE id_asignado = ? OR id_asignado LIKE '${id},%' OR id_asignado LIKE '%,${id}' OR id_asignado LIKE '%,${id},%'
    `, String(id));
    console.log(`Solicitudes donde Estefania está como id_asignado: ${Number(solicitudesAsignadas[0].c)}`);

    // 3) Muestra rangos de fechas de creación de las tareas (Pendiente)
    const fechas = await c.$queryRawUnsafe(`
      SELECT tipo,
             MIN(created_at) as primera,
             MAX(created_at) as ultima,
             COUNT(*) as c
      FROM tareas
      WHERE (id_responsable = ? OR id_asignado LIKE '%${id}%')
        AND estatus = 'Pendiente'
        AND tipo IN ('Notificación','Seguimiento Campaña','Atender Propuesta')
      GROUP BY tipo
      ORDER BY c DESC
    `, id);
    console.log('\nTareas Pendientes mal asignadas — rango de fechas:');
    fechas.forEach(r => console.log(`  ${r.tipo}: ${Number(r.c)} | primera ${r.primera} | última ${r.ultima}`));

    // 4) Últimas 5 tareas creadas (para ver lo más reciente)
    const recientes = await c.$queryRawUnsafe(`
      SELECT id, tipo, titulo, estatus, created_at, id_propuesta, id_solicitud, campania_id
      FROM tareas
      WHERE (id_responsable = ? OR id_asignado LIKE '%${id}%')
        AND tipo IN ('Notificación','Seguimiento Campaña','Atender Propuesta')
      ORDER BY created_at DESC
      LIMIT 5
    `, id);
    console.log('\nÚltimas 5 tareas creadas:');
    recientes.forEach(r => console.log(`  [${r.created_at?.toISOString?.()||r.created_at}] ${r.tipo} | ${r.estatus} | "${r.titulo}" | propuesta=${r.id_propuesta} campania=${r.campania_id}`));

    // 5) Tareas creadas en los últimos 30 días (probable evidencia de creación reciente)
    const recientes30 = await c.$queryRawUnsafe(`
      SELECT COUNT(*) as c
      FROM tareas
      WHERE (id_responsable = ? OR id_asignado LIKE '%${id}%')
        AND tipo IN ('Notificación','Seguimiento Campaña','Atender Propuesta')
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `, id);
    console.log(`\nCreadas en últimos 30 días: ${Number(recientes30[0].c)}`);

  } finally {
    await c.$disconnect();
  }
}

(async () => {
  await run(path.join(__dirname, '..', '.env.backup-prod'), 'PROD');
  await run(path.join(__dirname, '..', '.env'), 'DEV');
})().catch(e => { console.error(e); process.exit(1); });
