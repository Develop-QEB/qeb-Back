require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const akary = await prisma.usuario.findMany({
    where: { OR: [{ correo_electronico: { contains: 'akary' } }, { nombre: { contains: 'Akary' } }] },
    select: { id: true, nombre: true, correo_electronico: true, user_role: true },
  });
  console.log('Coincidencias "akary":', akary.length);
  akary.forEach(u => console.log(`  id=${u.id} ${u.nombre} | ${u.correo_electronico} | ${u.user_role}`));

  const total = await prisma.usuario.count({ where: { deleted_at: null } });
  console.log('\nTotal usuarios activos en esta BD:', total);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
