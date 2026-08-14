import prisma from '../utils/prisma';

async function main() {
  console.log('DB URL:', (process.env.DATABASE_URL || '').replace(/:[^@/]*@/, ':***@'));

  const eq: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, nombre, descripcion, color, deleted_at,
           (SELECT COUNT(*) FROM usuario_equipo ue WHERE ue.equipo_id = e.id) AS n_miembros
      FROM equipo e
     WHERE id IN (40, 41)
     ORDER BY id
  `);
  console.log('\n=== Equipos 40 / 41 ===');
  console.table(eq);

  for (const e of eq) {
    console.log(`\n--- Miembros equipo ${e.id} (${e.nombre}) ---`);
    const miembros: any[] = await prisma.$queryRawUnsafe(`
      SELECT u.id, u.nombre, u.user_role, u.area
        FROM usuario_equipo ue
        JOIN usuario u ON u.id = ue.usuario_id
       WHERE ue.equipo_id = ${e.id} AND u.deleted_at IS NULL
       ORDER BY u.user_role, u.nombre
    `);
    console.table(miembros);
  }

  const columnaExiste: any[] = await prisma.$queryRawUnsafe(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'equipo' AND COLUMN_NAME = 'proposito'
  `);
  console.log(`\ncolumna equipo.proposito ya existe? ${columnaExiste.length > 0}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
