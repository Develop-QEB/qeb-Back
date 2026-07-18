// Arma la matriz de Gerente Comercial → Asesores en dev para poder probar el
// filtro DG. Feedback 2026-07-17.
//
// Acciones:
//   1) Asegura usuario "Angel Antonio Gonzalez Reynoso" (crear si no existe).
//   2) Rodrigo Luna López (id=1057616): user_role → 'Gerente Comercial Plazas'.
//   3) Angel (id=nuevo): user_role → 'Gerente Comercial Vía Pública'.
//   4) Crea equipo "Comercial Vía Pública": Angel + 7 asesores.
//   5) Crea equipo "Comercial Plazas": Rodrigo + 13 asesores.
//
// Uso:
//   node scripts/armar_matriz_gerente_comercial_dev.cjs           # dry-run
//   node scripts/armar_matriz_gerente_comercial_dev.cjs --commit  # ejecuta

require('dotenv').config();
const mysql = require('mysql2/promise');

const COMMIT = process.argv.includes('--commit');

const ANGEL_NOMBRE = 'Angel Antonio Gonzalez Reynoso';
const ANGEL_EMAIL = 'user_angel@qeb-dev.local';
const RODRIGO_ID = 1057616;

// Nombres de los asesores por gerente (según la matriz Excel).
const ASESORES_VIA_PUBLICA = [
  'Brissa Nayeli Gonzalez Heras',
  'Ana Maria Lopez Gonzalez',
  'Maria Fernanda Mejia Sanchez',
  'Aldonza Ojeda Poire',
  'Sara Pichardo Guzman',
  'Aldo Adrian Tavera Gil',
  'Estrella Nando Behar',
];
const ASESORES_PLAZAS = [
  'Lissett Valdez Lopez',
  'Edna Jasiel Gonzalez Labastida',
  'Valeria Tostado Ibañez',
  'Leonor Barrañón Reyes',
  'Joaquin Fernando Calderon Ramirez',
  'Maria Begoña Beorlegui Estevez',
  'Noemi Guadalupe Muñoz Perez',
  'Jonathan Alva Sanchez',
  'Victor Rolando Mendiola Tello',
  'Hilda Leticia Linas Gutierrez',
  'Alejandro Isaac Herrera Reyes',
  'Elvia Ibarra Ramírez',
  'Monica Sofia Sanchez Ruiz',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) { console.error('URL invalida'); process.exit(1); }
  const [, user, password, host, port, database] = m;
  if (host.includes('ondigitalocean')) {
    console.error('SEGURIDAD: host es prod. Este script solo aplica a dev.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database,
  });
  console.log(`Conectado a ${host} db=${database} (dev)`);
  console.log('Modo:', COMMIT ? 'COMMIT (aplica)' : 'DRY-RUN');

  const findUserByName = async (nombre) => {
    const first = nombre.split(' ')[0];
    const last = nombre.split(' ').slice(-1)[0];
    const [r] = await conn.query(
      `SELECT id, nombre, user_role FROM usuario WHERE deleted_at IS NULL AND nombre LIKE ? LIMIT 1`,
      [`%${first}%${last}%`]
    );
    return r[0] || null;
  };

  // --- 1) Resolver Angel ---
  let angel = await findUserByName(ANGEL_NOMBRE);
  console.log(`\n[Angel] Buscar "${ANGEL_NOMBRE}":`, angel ? `id=${angel.id} rol=${angel.user_role}` : 'NO EXISTE — se creará');

  // --- 2) Verificar Rodrigo ---
  const [rodrigoRows] = await conn.query(`SELECT id, nombre, user_role FROM usuario WHERE id = ?`, [RODRIGO_ID]);
  const rodrigo = rodrigoRows[0];
  if (!rodrigo) {
    console.error(`Rodrigo id=${RODRIGO_ID} no encontrado. Abortando.`);
    process.exit(1);
  }
  console.log(`[Rodrigo] id=${rodrigo.id} "${rodrigo.nombre}" rol actual=${rodrigo.user_role}`);

  // --- 3) Resolver asesores ---
  console.log('\n[Asesores Vía Pública]');
  const asesoresVpIds = [];
  for (const n of ASESORES_VIA_PUBLICA) {
    const u = await findUserByName(n);
    if (u) { asesoresVpIds.push(u.id); console.log(`  id=${u.id} "${u.nombre}"`); }
    else { console.log(`  NO ENCONTRADO: ${n}`); }
  }
  console.log('\n[Asesores Plazas]');
  const asesoresPzIds = [];
  for (const n of ASESORES_PLAZAS) {
    const u = await findUserByName(n);
    if (u) { asesoresPzIds.push(u.id); console.log(`  id=${u.id} "${u.nombre}"`); }
    else { console.log(`  NO ENCONTRADO: ${n}`); }
  }

  if (!COMMIT) {
    console.log('\n[DRY-RUN] Corre con --commit para aplicar los cambios.');
    console.log('\nCambios que se aplicarían:');
    console.log(`  ${angel ? 'UPDATE' : 'INSERT'} usuario Angel — user_role='Gerente Comercial Vía Pública'`);
    console.log(`  UPDATE usuario id=${RODRIGO_ID} — user_role='Gerente Comercial Plazas'`);
    console.log(`  INSERT equipo "Comercial Vía Pública" y ${asesoresVpIds.length + 1} miembros (Angel + asesores)`);
    console.log(`  INSERT equipo "Comercial Plazas" y ${asesoresPzIds.length + 1} miembros (Rodrigo + asesores)`);
    await conn.end();
    return;
  }

  // --- COMMIT ---
  await conn.beginTransaction();
  try {
    // 1) Angel: crear si no existe
    let angelId;
    if (!angel) {
      const [ins] = await conn.query(
        `INSERT INTO usuario (nombre, correo_electronico, area, puesto, user_role, created_at)
         VALUES (?, ?, 'Comercial', 'Gerente Comercial Vía Pública', 'Gerente Comercial Vía Pública', NOW())`,
        [ANGEL_NOMBRE, ANGEL_EMAIL]
      );
      angelId = ins.insertId;
      console.log(`\nAngel creado id=${angelId}`);
    } else {
      angelId = angel.id;
      await conn.query(`UPDATE usuario SET user_role = ? WHERE id = ?`, ['Gerente Comercial Vía Pública', angelId]);
      console.log(`\nAngel id=${angelId} rol actualizado a Gerente Comercial Vía Pública`);
    }

    // 2) Rodrigo: actualizar rol
    await conn.query(`UPDATE usuario SET user_role = ? WHERE id = ?`, ['Gerente Comercial Plazas', RODRIGO_ID]);
    console.log(`Rodrigo id=${RODRIGO_ID} rol actualizado a Gerente Comercial Plazas`);

    // 3) Equipo Vía Pública
    const [eq1] = await conn.query(
      `INSERT INTO equipo (nombre, descripcion, color, created_at) VALUES (?, ?, ?, NOW())`,
      ['Comercial Vía Pública', 'Gerente Comercial Vía Pública y asesores', '#3B82F6']
    );
    const equipoVpId = eq1.insertId;
    console.log(`Equipo Vía Pública creado id=${equipoVpId}`);
    for (const uid of [angelId, ...asesoresVpIds]) {
      const rol = uid === angelId ? 'Gerente' : 'Asesor';
      await conn.query(
        `INSERT INTO usuario_equipo (usuario_id, equipo_id, rol, created_at) VALUES (?, ?, ?, NOW())`,
        [uid, equipoVpId, rol]
      );
    }
    console.log(`  → ${asesoresVpIds.length + 1} miembros agregados`);

    // 4) Equipo Plazas
    const [eq2] = await conn.query(
      `INSERT INTO equipo (nombre, descripcion, color, created_at) VALUES (?, ?, ?, NOW())`,
      ['Comercial Plazas', 'Gerente Comercial Plazas y asesores', '#10B981']
    );
    const equipoPzId = eq2.insertId;
    console.log(`Equipo Plazas creado id=${equipoPzId}`);
    for (const uid of [RODRIGO_ID, ...asesoresPzIds]) {
      const rol = uid === RODRIGO_ID ? 'Gerente' : 'Asesor';
      await conn.query(
        `INSERT INTO usuario_equipo (usuario_id, equipo_id, rol, created_at) VALUES (?, ?, ?, NOW())`,
        [uid, equipoPzId, rol]
      );
    }
    console.log(`  → ${asesoresPzIds.length + 1} miembros agregados`);

    await conn.commit();
    console.log('\n>>> COMMIT ok');
  } catch (e) {
    await conn.rollback();
    console.error('ROLLBACK:', e.message);
    await conn.end();
    process.exit(1);
  }

  await conn.end();
  console.log('\n=== FIN ===');
  console.log('Ahora al probar: Leonor (asesor de Plazas) manda autorización → Rodrigo (Gerente Plazas) recibe el Filtro DG.');
}

main().catch(e => { console.error(e); process.exit(1); });
