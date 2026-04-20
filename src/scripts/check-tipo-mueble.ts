import 'dotenv/config';
import prisma from '../utils/prisma';

async function main() {
  const sample = await prisma.$queryRaw<Array<{tipo_de_mueble: string | null; cnt: bigint}>>`
    SELECT tipo_de_mueble, COUNT(*) as cnt
    FROM inventarios
    WHERE tipo_de_mueble IS NOT NULL
    GROUP BY tipo_de_mueble
    ORDER BY cnt DESC
    LIMIT 20
  `;
  console.log('tipo_de_mueble distinct values:');
  sample.forEach(r => console.log(`  "${r.tipo_de_mueble}" — ${r.cnt} rows`));
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
