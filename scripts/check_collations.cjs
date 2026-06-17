require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  const r = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name, collation_name
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND column_name = 'archivo'
      AND table_name IN ('biblioteca_artes', 'reservas', 'artes_tradicionales', 'imagenes_digitales')
    ORDER BY table_name
  `);
  console.log('Collations de columna `archivo`:');
  r.forEach(row => console.log(`  ${row.table_name}.${row.column_name}: ${row.collation_name}`));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
