// Simula la query con el filtro NUEVO (allowlist Coord Diseño) vs el viejo
// (sin filtro) para Estefania. Conteo de tareas que verá vs ocultas.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});

(async () => {
  const id = 1057647;

  // Condiciones base: tareas asignadas a Estefania (id_responsable o id_asignado)
  // + tareas asignadas a Diseñadores que ella supervisa.
  const disenadores = await prisma.usuario.findMany({
    where: { user_role: 'Diseñadores', deleted_at: null },
    select: { id: true },
  });
  console.log('Diseñadores que Estefania supervisa:', disenadores.length);

  const allIds = [id, ...disenadores.map(d => d.id)];

  // OLD: sin filtro (lo que ve hoy en prod)
  const oldCount = await prisma.tareas.count({
    where: {
      OR: allIds.flatMap(uid => [
        { id_responsable: uid },
        { id_asignado: String(uid) },
        { id_asignado: { startsWith: `${uid},` } },
        { id_asignado: { endsWith: `,${uid}` } },
        { id_asignado: { contains: `,${uid},` } },
      ]),
      estatus: { not: 'Atendido' },
    },
  });
  console.log('OLD (sin filtro): tareas pendientes que vería:', oldCount);

  // NEW: con allowlist Coord Diseño
  const disenoWhitelist = {
    OR: [
      { tipo: { in: ['Revision de artes', 'Revisión de artes', 'Correccion', 'Corrección'] } },
      {
        AND: [
          { tipo: 'Notificación' },
          {
            OR: [
              { titulo: { contains: 'arte' } },
              { titulo: { contains: 'Arte' } },
              { titulo: { contains: 'revisi' } },
              { titulo: { contains: 'Revisi' } },
              { titulo: { contains: 'rechaz' } },
              { titulo: { contains: 'Rechaz' } },
              { titulo: { contains: 'aprob' } },
              { titulo: { contains: 'Aprob' } },
              { titulo: { contains: 'correcc' } },
              { titulo: { contains: 'Correcc' } },
              { titulo: { contains: 'pendiente' } },
              { titulo: { contains: 'Pendiente' } },
              { titulo: { contains: 'Diseño' } },
              { titulo: { contains: 'Diseno' } },
            ],
          },
        ],
      },
    ],
  };

  const newCount = await prisma.tareas.count({
    where: {
      AND: [
        {
          OR: allIds.flatMap(uid => [
            { id_responsable: uid },
            { id_asignado: String(uid) },
            { id_asignado: { startsWith: `${uid},` } },
            { id_asignado: { endsWith: `,${uid}` } },
            { id_asignado: { contains: `,${uid},` } },
          ]),
        },
        disenoWhitelist,
        { estatus: { not: 'Atendido' } },
      ],
    },
  });
  console.log('NEW (con allowlist): tareas pendientes que verá:', newCount);

  console.log(`\nReducción: ${oldCount - newCount} tareas ocultas (${Math.round((1 - newCount/oldCount) * 100)}% del total)`);

  // Muestra qué tipos quedan visibles
  const visibleTypes = await prisma.tareas.findMany({
    where: {
      AND: [
        {
          OR: allIds.flatMap(uid => [
            { id_responsable: uid },
            { id_asignado: String(uid) },
            { id_asignado: { startsWith: `${uid},` } },
            { id_asignado: { endsWith: `,${uid}` } },
            { id_asignado: { contains: `,${uid},` } },
          ]),
        },
        disenoWhitelist,
        { estatus: { not: 'Atendido' } },
      ],
    },
    select: { tipo: true, titulo: true },
  });
  const byType = new Map();
  visibleTypes.forEach(t => {
    const k = `${t.tipo}`;
    byType.set(k, (byType.get(k) || 0) + 1);
  });
  console.log('\nTipos que SÍ verá:');
  [...byType.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toString().padStart(4)}  ${k}`));

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
