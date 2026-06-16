require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const tipos = await prisma.$queryRawUnsafe(`
    SELECT tipo, COUNT(*) as c FROM tareas
    WHERE tipo IS NOT NULL
    GROUP BY tipo
    ORDER BY c DESC
  `);
  console.log('Tipos de tarea en DEV:');
  tipos.forEach(t => console.log(`  ${Number(t.c).toString().padStart(6)}  ${t.tipo}`));

  console.log('\nTitulos comunes de Notificación (top 15):');
  const notifs = await prisma.$queryRawUnsafe(`
    SELECT
      CASE
        WHEN titulo LIKE 'APS%' THEN 'APS #... asignado'
        WHEN titulo LIKE 'Campaña nueva%' THEN 'Campaña nueva - ...'
        WHEN titulo LIKE 'Nuevo comentario en revision%' THEN 'Nuevo comentario en revision artes'
        WHEN titulo LIKE 'Nuevo comentario en revisión%' THEN 'Nuevo comentario en revisión artes'
        WHEN titulo LIKE 'Arte aprobado%' THEN 'Arte aprobado ...'
        WHEN titulo LIKE 'Arte rechazado%' THEN 'Arte rechazado ...'
        ELSE SUBSTRING(titulo, 1, 60)
      END as titulo_pattern,
      COUNT(*) as c
    FROM tareas
    WHERE tipo = 'Notificación'
    GROUP BY titulo_pattern
    ORDER BY c DESC
    LIMIT 20
  `);
  notifs.forEach(n => console.log(`  ${Number(n.c).toString().padStart(6)}  "${n.titulo_pattern}"`));

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
