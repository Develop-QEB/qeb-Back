require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({log: ['error']});
(async () => {
  console.log('Aplicando ALTER TABLE biblioteca_artes para corregir collation...');
  const statements = [
    `ALTER TABLE biblioteca_artes
       MODIFY archivo VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
       MODIFY tipo VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'tradicional',
       MODIFY nombre_arte VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
       MODIFY nota TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
       MODIFY estatus_operaciones VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL`,
  ];
  for (const s of statements) {
    await prisma.$executeRawUnsafe(s);
    console.log('OK:', s.split('\n')[0].slice(0, 70));
  }
  const check = await prisma.$queryRawUnsafe(`
    SELECT column_name, collation_name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'biblioteca_artes'
      AND collation_name IS NOT NULL
  `);
  console.log('\nCollations resultantes:');
  check.forEach(c => console.log(`  ${c.column_name}: ${c.collation_name}`));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
