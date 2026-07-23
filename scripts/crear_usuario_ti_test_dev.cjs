// Crea usuario TI de prueba en DEV para que Jos valide el filtro de tickets.
// SEGURO: solo dev (Hostinger), aborta si apunta a prod (DigitalOcean).
// Password hasheado con bcryptjs (mismo salt round que el back).
//
// Uso:
//   node scripts/crear_usuario_ti_test_dev.cjs           # dry-run
//   node scripts/crear_usuario_ti_test_dev.cjs --commit  # aplica

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const COMMIT = process.argv.includes('--commit');

const USUARIO = {
  nombre: 'Antonio TI (Test)',
  correo_electronico: 'ti.test@qeb.mx',
  password_plain: 'TIQeb2026!',
  area: 'TI',
  puesto: 'Especialista de TI',
  user_role: 'Especialista de TI',
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  const [, user, password, host, port, database] = m;
  if (host.includes('ondigitalocean')) {
    console.error('SEGURIDAD: este script es solo para dev.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host, port: parseInt(port), user, password: decodeURIComponent(password),
    database,
  });
  console.log(`Conectado a ${host} db=${database} (dev)`);
  console.log('Modo:', COMMIT ? 'COMMIT (aplica)' : 'DRY-RUN');

  const [existentes] = await conn.query(
    'SELECT id, nombre, user_role, deleted_at FROM usuario WHERE correo_electronico = ?',
    [USUARIO.correo_electronico]
  );
  if (existentes.length) {
    console.log('\nYa existe usuario con ese correo:');
    console.table(existentes);
    if (!COMMIT) {
      console.log('\n[DRY-RUN] Si corres --commit se actualizara el rol/puesto a Especialista de TI y deleted_at=NULL.');
      await conn.end();
      return;
    }
    const [ret] = await conn.query(
      'UPDATE usuario SET nombre=?, area=?, puesto=?, user_role=?, deleted_at=NULL WHERE correo_electronico=?',
      [USUARIO.nombre, USUARIO.area, USUARIO.puesto, USUARIO.user_role, USUARIO.correo_electronico]
    );
    console.log('>>> UPDATE ok, filas afectadas:', ret.affectedRows);
  } else {
    console.log('\nUsuario NO existe. Se insertara:');
    console.log(`  correo: ${USUARIO.correo_electronico}`);
    console.log(`  nombre: ${USUARIO.nombre}`);
    console.log(`  rol:    ${USUARIO.user_role}`);
    console.log(`  puesto: ${USUARIO.puesto}`);
    console.log(`  area:   ${USUARIO.area}`);
    if (!COMMIT) {
      console.log('\n[DRY-RUN] Corre con --commit para crear.');
      await conn.end();
      return;
    }
    const hash = await bcrypt.hash(USUARIO.password_plain, 10);
    const [ret] = await conn.query(
      `INSERT INTO usuario (nombre, correo_electronico, user_password, area, puesto, user_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [USUARIO.nombre, USUARIO.correo_electronico, hash, USUARIO.area, USUARIO.puesto, USUARIO.user_role]
    );
    console.log('>>> INSERT ok, id:', ret.insertId);
  }

  const [after] = await conn.query(
    'SELECT id, nombre, correo_electronico, user_role, puesto, area, deleted_at FROM usuario WHERE correo_electronico = ?',
    [USUARIO.correo_electronico]
  );
  console.log('\nVerificación:');
  console.table(after);

  await conn.end();
  console.log('\n=== FIN ===');
  console.log(`Credenciales de prueba:`);
  console.log(`  Correo:   ${USUARIO.correo_electronico}`);
  console.log(`  Password: ${USUARIO.password_plain}`);
  console.log(`Jos puede iniciar sesion con esas credenciales o usar la "puertita" para impersonarlo.`);
}

main().catch(e => { console.error(e); process.exit(1); });
