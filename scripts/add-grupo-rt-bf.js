const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Checking if grupo_rt_bf column exists...');
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE solicitud_caras ADD COLUMN grupo_rt_bf INT NULL;
    `);
    console.log('✓ Column grupo_rt_bf added successfully.');
  } catch (err) {
    if (err.message && err.message.includes('Duplicate column')) {
      console.log('Column already exists, skipping.');
    } else {
      throw err;
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
