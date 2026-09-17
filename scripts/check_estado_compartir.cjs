// Inspecciona el estado de la Vista Compartir de una propuesta/campaña:
//   1. Versiones completadas de cada circuito (fecha de "completado")
//   2. Piezas de la ultima version que ya NO estan reservadas -> se pintan GRIS
//   3. Foto del pase a ventas -> que se vino de la propuesta (AZUL) y que se
//      agrego dentro de la campaña (VERDE)
//
// Sirve para verificar a mano lo que muestra la pantalla, despues de cada paso
// de la prueba (completar circuito, quitar una cara, aprobar, agregar en campaña).
//
// Por default lee DESARROLLO/PRUEBAS. Con --prod usa DATABASE_URL del .env.
// Correr: node scripts/check_estado_compartir.cjs <propuestaId> [--prod]
const mysql = require('mysql2/promise');

const DEV = {
  label: 'DEV/PRUEBAS u658050396_QEB_PRUEBAS',
  host: 'srv1978.hstgr.io',
  port: 3306,
  user: 'u658050396_QEB_PRUEBAS',
  password: '/uQ3FCrLG5:6',
  database: 'u658050396_QEB_PRUEBAS',
  ssl: undefined,
};

function target() {
  if (!process.argv.includes('--prod')) return DEV;
  require('dotenv').config();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('--prod requiere DATABASE_URL en el .env');
  const p = new URL(url);
  return {
    label: `PROD (${p.hostname})`,
    host: p.hostname, port: Number(p.port || 3306),
    user: decodeURIComponent(p.username), password: decodeURIComponent(p.password),
    database: p.pathname.replace(/^\//, ''), ssl: { rejectUnauthorized: false },
  };
}

async function tablaExiste(conn, db, tabla) {
  const [r] = await conn.query(
    `SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [db, tabla]);
  return Number(r[0].n) > 0;
}

async function run() {
  const id = parseInt(process.argv[2], 10);
  if (!Number.isFinite(id)) {
    console.error('Uso: node scripts/check_estado_compartir.cjs <propuestaId> [--prod]');
    process.exit(1);
  }
  const T = target();
  const conn = await mysql.createConnection({
    host: T.host, port: T.port, user: T.user, password: T.password, database: T.database, ssl: T.ssl,
  });
  try {
    console.log(`\n========== propuesta ${id} — ${T.label} ==========`);

    const [prop] = await conn.query(
      `SELECT p.id, p.status, cam.id AS campania_id, cam.fecha_aprobacion
         FROM propuesta p
         LEFT JOIN cotizacion cot ON cot.id_propuesta = p.id
         LEFT JOIN campania cam ON cam.cotizacion_id = cot.id
        WHERE p.id = ?`, [id]);
    if (!prop.length) { console.log('No existe esa propuesta.'); return; }
    console.log(`status: ${prop[0].status} | campaña: ${prop[0].campania_id ?? '(ninguna)'} | aprobada: ${prop[0].fecha_aprobacion ?? '(sin fecha)'}`);

    const hayVersion = await tablaExiste(conn, T.database, 'circuito_completado');
    const hayPase = await tablaExiste(conn, T.database, 'pase_ventas_reserva');
    if (!hayVersion) console.log('⚠ Falta circuito_completado -> correr scripts/add_tabla_circuito_completado.cjs');
    if (!hayPase) console.log('⚠ Falta pase_ventas_reserva -> correr scripts/add_tabla_pase_ventas_reserva.cjs');

    console.log('\n--- 1) Circuitos: esperadas vs reservas activas (N/N = completo)');
    const [circ] = await conn.query(
      `SELECT sc.id AS circuito, sc.articulo,
              (sc.caras + COALESCE(ROUND(sc.bonificacion),0)) AS esperadas,
              COUNT(r.id) AS activas
         FROM solicitudCaras sc
         LEFT JOIN reservas r ON r.solicitudCaras_id = sc.id AND r.deleted_at IS NULL
        WHERE sc.idquote = ?
        GROUP BY sc.id, sc.articulo, sc.caras, sc.bonificacion
        ORDER BY sc.id`, [String(id)]);
    console.table(circ.map(x => ({ ...x, completo: Number(x.activas) >= Number(x.esperadas) ? 'SI' : 'no' })));

    if (hayVersion) {
      console.log('\n--- 2) Versiones completadas (la Vista Compartir muestra la ULTIMA de cada circuito)');
      const [vers] = await conn.query(
        `SELECT cc.solicitud_caras_id AS circuito, cc.version, cc.fecha_completado, cc.total_reservas, cc.origen
           FROM circuito_completado cc WHERE cc.idquote = ?
          ORDER BY cc.solicitud_caras_id, cc.version`, [String(id)]);
      console.table(vers.length ? vers : [{ nota: 'sin versiones: ningun circuito ha estado completo (o falta abrir la Vista Compartir)' }]);

      console.log('\n--- 3) Piezas de la ULTIMA version que ya no estan reservadas -> GRIS "No vigente"');
      const [gris] = await conn.query(
        `SELECT cc.solicitud_caras_id AS circuito, ccr.reserva_id, i.codigo_unico,
                CASE WHEN r.id IS NULL THEN 'Reserva eliminada'
                     WHEN r.deleted_at IS NOT NULL THEN 'Desplazada o quitada'
                     WHEN r.solicitudCaras_id <> cc.solicitud_caras_id THEN 'Reasignada a otro circuito'
                END AS motivo
           FROM circuito_completado cc
           INNER JOIN (SELECT solicitud_caras_id, MAX(version) v FROM circuito_completado
                        WHERE idquote = ? GROUP BY solicitud_caras_id) m
                   ON m.solicitud_caras_id = cc.solicitud_caras_id AND m.v = cc.version
           INNER JOIN circuito_completado_reserva ccr ON ccr.completado_id = cc.id
           LEFT JOIN reservas r ON r.id = ccr.reserva_id
           LEFT JOIN inventarios i ON i.id = ccr.inventario_id
          WHERE cc.idquote = ?
            AND (r.id IS NULL OR r.deleted_at IS NOT NULL OR r.solicitudCaras_id <> cc.solicitud_caras_id)`,
        [String(id), String(id)]);
      console.table(gris.length ? gris : [{ nota: 'ninguna: todo lo de la ultima version sigue reservado' }]);
    }

    if (hayPase) {
      console.log('\n--- 4) Origen (campañas): AZUL = vino de la propuesta, VERDE = agregado en campaña');
      const [foto] = await conn.query(
        `SELECT COUNT(*) n, MIN(origen) origen, MIN(fecha_pase) fecha FROM pase_ventas_reserva WHERE propuesta_id = ?`, [id]);
      if (!Number(foto[0].n)) {
        console.log('Sin foto de pase a ventas -> la pantalla NO colorea por origen (se ve como antes).');
      } else {
        console.log(`Foto: ${foto[0].n} reserva(s) cruzaron en el pase (origen='${foto[0].origen}', ${foto[0].fecha}).`);
        const [nuevas] = await conn.query(
          `SELECT r.id AS reserva, i.codigo_unico, sc.articulo, r.estatus
             FROM solicitudCaras sc
             INNER JOIN reservas r ON r.solicitudCaras_id = sc.id AND r.deleted_at IS NULL
             LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
             LEFT JOIN inventarios i ON i.id = ei.inventario_id
            WHERE sc.idquote = ?
              AND r.id NOT IN (SELECT reserva_id FROM pase_ventas_reserva WHERE propuesta_id = ?)
            LIMIT 30`, [String(id), id]);
        console.log(`Agregadas dentro de la campaña (VERDE): ${nuevas.length}`);
        if (nuevas.length) console.table(nuevas);
      }
    }
    console.log('');
  } finally {
    await conn.end();
  }
}

run().catch(err => { console.error('✖ Error:', err.message); process.exit(1); });
