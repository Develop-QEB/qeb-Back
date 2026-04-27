import 'dotenv/config';
import prisma from '../utils/prisma';

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`MODO: ${APPLY ? 'APLICAR' : 'DRY RUN (use --apply para guardar)'}`);
  console.log('Filtro: propuestas con status=Atendido que tengan campaña ligada');

  // Listar las propuestas afectadas
  const afectadas: any[] = await prisma.$queryRawUnsafe(`
    SELECT p.id, p.status, p.descripcion, p.updated_at,
           cm.id AS camp_id, cm.nombre AS camp_nombre, cm.status AS camp_status
    FROM propuesta p
    INNER JOIN cotizacion ct ON ct.id_propuesta = p.id
    INNER JOIN campania cm ON cm.cotizacion_id = ct.id
    WHERE p.status = 'Atendido'
    ORDER BY p.id ASC
  `);

  console.log(`\nPropuestas afectadas: ${afectadas.length}`);
  afectadas.forEach(p =>
    console.log(JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? Number(v) : v)))
  );

  if (afectadas.length === 0) {
    await prisma.$disconnect();
    return;
  }

  if (!APPLY) {
    console.log('\nDRY RUN: nada se modificó. Re-ejecuta con --apply para guardar.');
    await prisma.$disconnect();
    return;
  }

  // Aplicar el cambio: status Atendido -> Aprobada SOLO para las que tienen campaña
  const ids = afectadas.map(p => Number(p.id));
  const placeholders = ids.map(() => '?').join(',');
  const result: any = await prisma.$executeRawUnsafe(
    `UPDATE propuesta SET status = 'Aprobada', updated_at = NOW() WHERE id IN (${placeholders}) AND status = 'Atendido'`,
    ...ids
  );

  console.log(`\nUpdate aplicado. Filas afectadas: ${result}`);

  // Verificación post-update
  const verif: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM propuesta WHERE id IN (${placeholders})`,
    ...ids
  );
  console.log('\nVerificación post-update:');
  verif.forEach(p =>
    console.log(JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? Number(v) : v)))
  );

  await prisma.$disconnect();
})();
