import prisma from '../utils/prisma';

// Migration: crea la tabla pruebas_color usada por el modulo "Gestor artes
// Propuestas - prueba de color". Idempotente — chequea si la tabla existe
// antes de crearla. Feedback 2026-08-15.
async function main() {
  console.log('DB URL:', (process.env.DATABASE_URL || '').replace(/:[^@/]*@/, ':***@'));

  const check: any[] = await prisma.$queryRawUnsafe(`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pruebas_color'
  `);
  const tablaExiste = check.length > 0;
  console.log(`tabla pruebas_color existe: ${tablaExiste}`);

  if (tablaExiste) {
    console.log('nada que hacer.');
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE pruebas_color (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      propuesta_id      INT NOT NULL,
      sc_id             INT NOT NULL,
      campania_id       INT NULL,
      reserva_id        INT NULL,
      archivo           VARCHAR(500) NOT NULL,
      archivo_data      LONGTEXT NULL,
      nombre_arte       VARCHAR(255) NULL,
      notas             TEXT NULL,
      estatus           VARCHAR(50) NOT NULL DEFAULT 'solicitada',
      version           INT NOT NULL DEFAULT 1,
      created_by        INT NOT NULL,
      created_by_nombre VARCHAR(255) NOT NULL,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at        DATETIME NULL,
      INDEX idx_pc_propuesta (propuesta_id),
      INDEX idx_pc_campania  (campania_id),
      INDEX idx_pc_sc        (sc_id),
      INDEX idx_pc_reserva   (reserva_id),
      INDEX idx_pc_estatus   (estatus)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const post: any[] = await prisma.$queryRawUnsafe(`
    SHOW COLUMNS FROM pruebas_color
  `);
  console.log('columnas creadas:');
  console.table(post);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
