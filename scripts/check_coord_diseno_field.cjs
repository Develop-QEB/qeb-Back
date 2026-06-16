require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const a = await prisma.usuario.findMany({
    where: { user_role: 'Coordinador de Diseño', deleted_at: null },
    select: { id: true, nombre: true, area: true, puesto: true, user_role: true }
  });
  console.log('user_role = "Coordinador de Diseño":', a.length);
  a.forEach(u => console.log(`  id=${u.id} ${u.nombre} | area=${u.area} | puesto=${u.puesto} | user_role=${u.user_role}`));

  const b = await prisma.usuario.findMany({
    where: { puesto: { contains: 'Coordinador de Diseño' }, deleted_at: null },
    select: { id: true, nombre: true, puesto: true, user_role: true }
  });
  console.log('\npuesto contiene "Coordinador de Diseño":', b.length);
  b.forEach(u => console.log(`  id=${u.id} ${u.nombre} | puesto=${u.puesto} | user_role=${u.user_role}`));

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
