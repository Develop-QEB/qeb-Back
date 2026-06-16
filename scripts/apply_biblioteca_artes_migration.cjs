// Aplica migration_biblioteca_artes.sql contra la BD del .env actual.
// Es idempotente (CREATE TABLE IF NOT EXISTS).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const sqlPath = path.join(__dirname, 'migration_biblioteca_artes.sql');
  const raw = fs.readFileSync(sqlPath, 'utf8');
  // Quitar comentarios de linea (--) ANTES de partir por ;
  const sql = raw.split('\n').map(line => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');

  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);

  console.log(`Aplicando ${statements.length} statement(s) desde ${path.basename(sqlPath)}...`);
  for (const stmt of statements) {
    if (!stmt) continue;
    try {
      await prisma.$executeRawUnsafe(stmt);
      console.log('OK:', stmt.slice(0, 70).replace(/\s+/g, ' '), '...');
    } catch (e) {
      console.error('FAIL:', stmt.slice(0, 70).replace(/\s+/g, ' '), '\n  ', e.message);
      throw e;
    }
  }

  const cols = await prisma.$queryRawUnsafe("SHOW COLUMNS FROM biblioteca_artes");
  console.log('\nbiblioteca_artes columnas:');
  cols.forEach(c => console.log(`  ${c.Field} ${c.Type} ${c.Null === 'NO' ? 'NOT NULL' : ''} ${c.Key || ''}`.trim()));

  const indexes = await prisma.$queryRawUnsafe("SHOW INDEX FROM biblioteca_artes");
  console.log('\nbiblioteca_artes indexes:');
  const byKey = new Map();
  indexes.forEach(i => {
    if (!byKey.has(i.Key_name)) byKey.set(i.Key_name, []);
    byKey.get(i.Key_name).push(i.Column_name);
  });
  byKey.forEach((cols, key) => console.log(`  ${key}: (${cols.join(', ')})`));

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
