import 'dotenv/config';
import prisma from '../utils/prisma';

async function main() {
  // MySQL collation is case-insensitive, so != UPPER() always false — skip that filter
  const result = await prisma.$executeRaw`
    UPDATE inventarios
    SET tipo_de_mueble = UPPER(tipo_de_mueble)
    WHERE tipo_de_mueble IS NOT NULL
  `;
  console.log(`Updated ${result} rows in inventarios.tipo_de_mueble to uppercase.`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
