// Compara user_role + puesto + area entre dev (.env) y prod (.env.backup-prod)
// para todos los usuarios activos. READ-ONLY: no modifica nada.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function parseDatabaseUrl(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  if (!m) throw new Error(`No DATABASE_URL en ${envPath}`);
  return m[1].replace(/^"|"$/g, '');
}

async function fetchUsuarios(envPath, label) {
  const url = parseDatabaseUrl(envPath);
  const client = new PrismaClient({
    datasources: { db: { url } },
    log: ['error'],
  });
  try {
    const usuarios = await client.usuario.findMany({
      where: { deleted_at: null },
      select: { id: true, nombre: true, correo_electronico: true, user_role: true, puesto: true, area: true },
      orderBy: { id: 'asc' },
    });
    console.log(`[${label}] usuarios activos: ${usuarios.length}`);
    return usuarios;
  } finally {
    await client.$disconnect();
  }
}

(async () => {
  const devPath = path.join(__dirname, '..', '.env');
  const prodPath = path.join(__dirname, '..', '.env.backup-prod');

  const [dev, prod] = await Promise.all([
    fetchUsuarios(devPath, 'DEV'),
    fetchUsuarios(prodPath, 'PROD'),
  ]);

  const byId = new Map();
  dev.forEach(u => byId.set(u.id, { dev: u }));
  prod.forEach(u => {
    if (!byId.has(u.id)) byId.set(u.id, {});
    byId.get(u.id).prod = u;
  });

  const onlyInDev = [];
  const onlyInProd = [];
  const diffRol = [];
  const diffPuesto = [];
  const diffArea = [];

  for (const [id, pair] of byId) {
    if (!pair.prod) { onlyInDev.push(pair.dev); continue; }
    if (!pair.dev) { onlyInProd.push(pair.prod); continue; }
    if ((pair.dev.user_role || '') !== (pair.prod.user_role || '')) {
      diffRol.push({ id, nombre: pair.dev.nombre, dev: pair.dev.user_role, prod: pair.prod.user_role });
    }
    if ((pair.dev.puesto || '') !== (pair.prod.puesto || '')) {
      diffPuesto.push({ id, nombre: pair.dev.nombre, dev: pair.dev.puesto, prod: pair.prod.puesto });
    }
    if ((pair.dev.area || '') !== (pair.prod.area || '')) {
      diffArea.push({ id, nombre: pair.dev.nombre, dev: pair.dev.area, prod: pair.prod.area });
    }
  }

  console.log('\n=== DIFERENCIAS user_role (dev vs prod) ===', diffRol.length);
  diffRol.forEach(d => console.log(`  id=${d.id} ${d.nombre}\n    DEV : ${JSON.stringify(d.dev)}\n    PROD: ${JSON.stringify(d.prod)}`));

  console.log('\n=== DIFERENCIAS puesto ===', diffPuesto.length);
  diffPuesto.forEach(d => console.log(`  id=${d.id} ${d.nombre}\n    DEV : ${JSON.stringify(d.dev)}\n    PROD: ${JSON.stringify(d.prod)}`));

  console.log('\n=== DIFERENCIAS area ===', diffArea.length);
  diffArea.forEach(d => console.log(`  id=${d.id} ${d.nombre}\n    DEV : ${JSON.stringify(d.dev)}\n    PROD: ${JSON.stringify(d.prod)}`));

  console.log('\n=== Solo en DEV (no existen en PROD) ===', onlyInDev.length);
  onlyInDev.forEach(u => console.log(`  id=${u.id} ${u.nombre} | ${u.user_role} | ${u.puesto}`));

  console.log('\n=== Solo en PROD (no existen en DEV) ===', onlyInProd.length);
  onlyInProd.forEach(u => console.log(`  id=${u.id} ${u.nombre} | ${u.user_role} | ${u.puesto}`));
})().catch(e => { console.error(e); process.exit(1); });
