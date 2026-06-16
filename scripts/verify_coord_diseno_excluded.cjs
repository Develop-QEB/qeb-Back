// Verifica que los filtros NOT: { user_role: 'Coordinador de Diseño' } excluyen
// a Estefania Navas (id 1057647). NO escribe en BD.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const coordId = 1057647;

  // Simulación 1: filtro de Seguimiento Campaña (propuestas.controller.ts:2049)
  const fakeIds = [coordId, 12, 34];
  const a = await prisma.usuario.findMany({
    where: {
      id: { in: fakeIds },
      deleted_at: null,
      NOT: { user_role: 'Coordinador de Diseño' }
    },
    select: { id: true, nombre: true, user_role: true }
  });
  console.log('Seguimiento Campaña, ids incluyen Coord Diseño:');
  console.log('  Input ids:', fakeIds, '| Resultado:', a.map(u => `${u.id}/${u.user_role}`));
  console.log('  Coord excluida:', !a.some(u => u.id === coordId));

  // Simulación 2: filtro de Atender Propuesta auto (solicitudes.controller.ts:2816)
  const b = await prisma.usuario.findMany({
    where: {
      OR: [
        { puesto: { contains: 'Tráfico' } },
        { puesto: { contains: 'Trafico' } },
        { area: { contains: 'Tráfico' } },
        { area: { contains: 'Trafico' } }
      ],
      deleted_at: null,
      NOT: { user_role: 'Coordinador de Diseño' }
    },
    select: { id: true, nombre: true, puesto: true, user_role: true }
  });
  console.log('\nAtender Propuesta auto (Tráfico): usuarios filtrados:', b.length);
  console.log('  Coord en resultado:', b.some(u => u.id === coordId), '(esperado: false)');

  // Simulación 3: filtro de Atender Propuesta con asignados específicos
  const c = await prisma.usuario.findMany({
    where: {
      id: { in: [coordId, 7, 8] },
      deleted_at: null,
      NOT: { user_role: 'Coordinador de Diseño' }
    },
    select: { id: true, nombre: true, user_role: true }
  });
  console.log('\nAtender Propuesta con asignados específicos {1057647,7,8}:');
  console.log('  Resultado:', c.map(u => `${u.id}/${u.user_role}`));
  console.log('  Coord excluida:', !c.some(u => u.id === coordId));

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
