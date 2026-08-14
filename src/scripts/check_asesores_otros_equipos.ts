import prisma from '../utils/prisma';

// Solo SELECT. Verifica si los 22 asesores/GC de los equipos 40 y 41
// pertenecen tambien a otros equipos (los "red_trabajo" originales).
// Si NO estan en ningun otro equipo, al filtrar 40/41 en getUsers?filterByTeam=true
// el dropdown de asignados les va a salir vacio y hay que crear un equipo
// de red_trabajo para el area comercial.

const IDS = [
  // Equipo 40
  1057613, 1057610, 1057608, 1057681, 1057615, 1057609, 1057612, 1057712,
  // Equipo 41
  1057624, 1057614, 1057625, 1057623, 1057618, 1057621, 1057607, 1057617,
  1057619, 1057626, 1057620, 1057611, 1057622, 1057616,
];

async function main() {
  console.log('DB URL:', (process.env.DATABASE_URL || '').replace(/:[^@/]*@/, ':***@'));

  const rows: any[] = await prisma.$queryRawUnsafe(`
    SELECT u.id, u.nombre, u.user_role,
           GROUP_CONCAT(CONCAT(e.id, ':', e.nombre) SEPARATOR ' | ') AS equipos
      FROM usuario u
      LEFT JOIN usuario_equipo ue ON ue.usuario_id = u.id
      LEFT JOIN equipo e ON e.id = ue.equipo_id AND e.deleted_at IS NULL
     WHERE u.id IN (${IDS.join(',')})
     GROUP BY u.id, u.nombre, u.user_role
     ORDER BY u.user_role, u.nombre
  `);

  console.log('\n=== Cada asesor y todos sus equipos ===');
  console.table(rows);

  const soloEn40o41 = rows.filter((r: any) => {
    if (!r.equipos) return false;
    const ids = String(r.equipos).split(' | ').map((s: string) => Number(s.split(':')[0]));
    return ids.every((id: number) => id === 40 || id === 41);
  });
  console.log(`\n${soloEn40o41.length} de ${rows.length} asesores/GC estan SOLO en 40/41 (no en otros equipos):`);
  soloEn40o41.forEach((r: any) => console.log(`  - ${r.nombre} (${r.user_role})`));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
