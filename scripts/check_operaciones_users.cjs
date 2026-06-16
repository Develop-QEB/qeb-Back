require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const all = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { area: { contains: 'Operaciones' } },
        { puesto: { contains: 'Operaciones' } },
      ],
    },
    select: { id: true, nombre: true, area: true, puesto: true, user_role: true },
    orderBy: { area: 'asc' },
  });
  console.log('Usuarios activos con Operaciones (area/puesto):', all.length);
  all.forEach(u => console.log(`  id=${u.id} | ${u.nombre} | area="${u.area}" | puesto="${u.puesto}" | rol="${u.user_role}"`));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
