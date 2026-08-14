import prisma from '../utils/prisma';

// Feedback 2026-08-14: agrega columna equipo.proposito para separar los
// equipos de "red de trabajo" (visibilidad, admin/usuarios, asignaciones) de
// los "filtro_autorizacion" (solo usados internamente por el filtro DG).
//
// Corre en dev PRIMERO. Luego el mismo script se aplica en prod cuando Jos
// autorice. El default de la columna es 'red_trabajo' para respetar todos
// los equipos existentes. Solo los IDs 40 y 41 se mueven a filtro_autorizacion.

const EQUIPOS_FILTRO_DG = [40, 41]; // Comercial Via Publica / Comercial Plazas

async function main() {
  console.log('DB URL:', (process.env.DATABASE_URL || '').replace(/:[^@/]*@/, ':***@'));

  console.log('\n=== PRE-CHECK: columna existe ya? ===');
  const colInfo: any[] = await prisma.$queryRawUnsafe(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'equipo' AND COLUMN_NAME = 'proposito'
  `);
  const columnaExiste = colInfo.length > 0;
  console.log(`columna proposito existe: ${columnaExiste}`);

  console.log('\n=== PRE-CHECK: equipos 40/41 existen ===');
  const eq: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, nombre FROM equipo WHERE id IN (${EQUIPOS_FILTRO_DG.join(',')})`
  );
  console.log(`Equipos filtro: ${JSON.stringify(eq)}`);
  if (eq.length !== EQUIPOS_FILTRO_DG.length) {
    console.warn(`ATENCION: se esperaban ${EQUIPOS_FILTRO_DG.length} equipos, hay ${eq.length}. Se seguiran marcando los que existan.`);
  }

  console.log('\n=== EJECUTANDO ===');
  await prisma.$transaction(async (tx) => {
    if (!columnaExiste) {
      await tx.$executeRawUnsafe(
        `ALTER TABLE equipo ADD COLUMN proposito VARCHAR(50) NOT NULL DEFAULT 'red_trabajo'`
      );
      console.log('ALTER TABLE aplicado (columna nueva con default red_trabajo)');

      await tx.$executeRawUnsafe(
        `ALTER TABLE equipo ADD INDEX idx_equipo_proposito (proposito)`
      );
      console.log('INDEX idx_equipo_proposito creado');
    } else {
      console.log('columna ya existente — saltando ALTER');
    }

    const upd: any = await tx.$executeRawUnsafe(
      `UPDATE equipo SET proposito = 'filtro_autorizacion' WHERE id IN (${EQUIPOS_FILTRO_DG.join(',')})`
    );
    console.log(`UPDATE proposito=filtro_autorizacion: ${upd} filas afectadas (esperado <= ${EQUIPOS_FILTRO_DG.length})`);
  });

  console.log('\n=== POST-CHECK ===');
  const post: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, nombre, proposito FROM equipo ORDER BY id`
  );
  console.log('Estado final de equipos:');
  console.table(post);

  const filtro = post.filter((e: any) => e.proposito === 'filtro_autorizacion');
  const red = post.filter((e: any) => e.proposito === 'red_trabajo');
  console.log(`\nResumen: ${filtro.length} equipos de filtro_autorizacion, ${red.length} de red_trabajo`);
}

main()
  .catch((e) => {
    console.error('ERROR:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
