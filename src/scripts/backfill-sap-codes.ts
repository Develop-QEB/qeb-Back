import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Buscando solicitudes sin card_code...');

  const rows = await prisma.$queryRaw<{
    sol_id: number;
    sol_card: string | null;
    sol_salesperson: number | null;
    sol_sap_db: string | null;
    cli_card: string | null;
    cli_salesperson: number | null;
    cli_sap_db: string | null;
  }[]>`
    SELECT
      s.id          AS sol_id,
      s.card_code   AS sol_card,
      s.salesperson_code AS sol_salesperson,
      s.sap_database AS sol_sap_db,
      c.card_code   AS cli_card,
      c.salesperson_code AS cli_salesperson,
      c.sap_database AS cli_sap_db
    FROM solicitud s
    JOIN cliente c ON s.cliente_id = c.id
    WHERE s.deleted_at IS NULL
      AND (s.card_code IS NULL OR s.salesperson_code IS NULL OR s.sap_database IS NULL)
      AND (c.card_code IS NOT NULL OR c.salesperson_code IS NOT NULL OR c.sap_database IS NOT NULL)
  `;

  console.log(`Solicitudes a actualizar: ${rows.length}`);

  if (rows.length === 0) {
    console.log('Nada que backfilliar.');
    return;
  }

  let updated = 0;
  for (const row of rows) {
    const data: Record<string, unknown> = {};
    if (row.sol_card === null && row.cli_card !== null) data.card_code = row.cli_card;
    if (row.sol_salesperson === null && row.cli_salesperson !== null) data.salesperson_code = row.cli_salesperson;
    if (row.sol_sap_db === null && row.cli_sap_db !== null) data.sap_database = row.cli_sap_db;

    if (Object.keys(data).length > 0) {
      await prisma.solicitud.update({ where: { id: row.sol_id }, data });
      console.log(`  Solicitud #${row.sol_id} → card_code=${data.card_code ?? '(sin cambio)'} sap_db=${data.sap_database ?? '(sin cambio)'}`);
      updated++;
    }
  }

  console.log(`\nListo. ${updated} solicitudes actualizadas.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
