import prisma from '../utils/prisma';

// Migration: crea las 3 tablas del Filtro Autorizacion "Quitar Posteo":
//   desposteo_solicitudes, desposteo_notas, desposteo_tabuladores.
// Idempotente por tabla (CREATE ... IF NOT EXISTS + verificacion).
async function main() {
  console.log('DB URL:', (process.env.DATABASE_URL || '').replace(/:[^@/]*@/, ':***@'));

  const existe = async (tabla: string): Promise<boolean> => {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tabla}'`
    );
    return rows.length > 0;
  };

  // desposteo_solicitudes ---------------------------------------------------
  if (await existe('desposteo_solicitudes')) {
    console.log('desposteo_solicitudes ya existe, skip.');
  } else {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE desposteo_solicitudes (
        id                     INT AUTO_INCREMENT PRIMARY KEY,
        campania_id            INT NOT NULL,
        aps                    INT NOT NULL,
        post_log_id            INT NULL,
        snapshot_aps           LONGTEXT NULL,
        estatus                VARCHAR(30) NOT NULL DEFAULT 'solicitado',
        solicitado_por_id      INT NOT NULL,
        solicitado_por_nombre  VARCHAR(255) NOT NULL,
        filtro_gc_id           INT NULL,
        filtro_gc_nombre       VARCHAR(255) NULL,
        filtro_gc_at           DATETIME NULL,
        facturacion_id         INT NULL,
        facturacion_nombre     VARCHAR(255) NULL,
        facturacion_at         DATETIME NULL,
        ti_ejecutor_id         INT NULL,
        ti_ejecutor_nombre     VARCHAR(255) NULL,
        ti_ejecutor_at         DATETIME NULL,
        sin_autorizacion       TINYINT(1) NOT NULL DEFAULT 0,
        created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at             DATETIME NULL,
        INDEX idx_ds_camp_aps    (campania_id, aps),
        INDEX idx_ds_estatus     (estatus),
        INDEX idx_ds_solicitante (solicitado_por_id),
        INDEX idx_ds_gc          (filtro_gc_id),
        INDEX idx_ds_facturacion (facturacion_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('desposteo_solicitudes creada.');
  }

  // desposteo_notas ---------------------------------------------------------
  if (await existe('desposteo_notas')) {
    console.log('desposteo_notas ya existe, skip.');
  } else {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE desposteo_notas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        desposteo_id   INT NOT NULL,
        usuario_id     INT NOT NULL,
        usuario_nombre VARCHAR(255) NOT NULL,
        tipo           VARCHAR(40) NOT NULL,
        nota           TEXT NOT NULL,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dn_desposteo (desposteo_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('desposteo_notas creada.');
  }

  // desposteo_tabuladores ---------------------------------------------------
  if (await existe('desposteo_tabuladores')) {
    console.log('desposteo_tabuladores ya existe, skip.');
  } else {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE desposteo_tabuladores (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        monto_min      DECIMAL(12,2) NOT NULL,
        monto_max      DECIMAL(12,2) NULL,
        nivel_escalado VARCHAR(40) NOT NULL,
        activo         TINYINT(1) NOT NULL DEFAULT 1,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_dt_activo (activo)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('desposteo_tabuladores creada (vacia — Jos define reglas despues).');
  }

  console.log('\nEstructura final:');
  for (const t of ['desposteo_solicitudes', 'desposteo_notas', 'desposteo_tabuladores']) {
    const cols: any[] = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM ${t}`);
    console.log(`\n== ${t} (${cols.length} cols)`);
    console.table(cols.map(c => ({ Field: c.Field, Type: c.Type, Null: c.Null, Default: c.Default })));
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
