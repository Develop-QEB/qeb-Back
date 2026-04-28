require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const url = process.env.DATABASE_URL.replace('mysql://', '');
  const [creds, rest] = url.split('@');
  const [user, passEnc] = creds.split(':');
  const pass = decodeURIComponent(passEnc);
  const [hostDb] = rest.split('?');
  const [hostPort, db] = hostDb.split('/');
  const [host, port] = hostPort.split(':');
  const conn = await mysql.createConnection({
    host, port: parseInt(port || '3306'), user, password: pass, database: db,
  });
  console.log(`=== DB: ${db} ===\n`);

  // 1. Propuesta info
  const [props] = await conn.query(`
    SELECT pr.id, pr.solicitud_id, pr.cliente_id, pr.descripcion,
           ct.id AS cotizacion_id, ct.tipo_periodo,
           cm.id AS campania_id, cm.nombre AS campania_nombre,
           cm.fecha_inicio AS cm_fecha_inicio, cm.fecha_fin AS cm_fecha_fin
    FROM propuesta pr
    LEFT JOIN cotizacion ct ON ct.id_propuesta = pr.id
    LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
    WHERE pr.id = 28
  `);
  console.log('PROPUESTA 28:');
  console.table(props);

  if (props.length === 0) { await conn.end(); return; }
  const cotizId = props[0].cotizacion_id;
  const cmId = props[0].campania_id;

  // 2. Caras
  const [caras] = await conn.query(`
    SELECT id, articulo, formato, ciudad, estados, caras, caras_flujo, caras_contraflujo,
           inicio_periodo, fin_periodo, costo, tarifa_publica, grupo_rt_bf
    FROM solicitudCaras
    WHERE idquote = ?
    ORDER BY inicio_periodo, id
  `, [String(28)]);
  console.log('\nCARAS:');
  console.table(caras.map(c => ({
    id: c.id, articulo: c.articulo, formato: c.formato,
    ciudad: c.ciudad ? c.ciudad.substring(0, 18) : '',
    caras: c.caras, flujo: c.caras_flujo, ctra: c.caras_contraflujo,
    inicio: c.inicio_periodo ? c.inicio_periodo.toISOString().split('T')[0] : '',
    fin: c.fin_periodo ? c.fin_periodo.toISOString().split('T')[0] : '',
    grupo: c.grupo_rt_bf,
  })));

  // 3. Reservas
  const caraIds = caras.map(c => c.id);
  if (caraIds.length === 0) { await conn.end(); return; }
  const ph = caraIds.map(() => '?').join(',');
  const [reservas] = await conn.query(`
    SELECT r.id, r.solicitudCaras_id, r.inventario_id, r.calendario_id,
           r.deleted_at, r.estatus, r.APS,
           epIn.inventario_id AS inv_real_id,
           inv.codigo_unico, inv.tipo_de_cara AS inv_tipo, inv.plaza,
           cal.id AS cal_id, cal.fecha_inicio AS cal_inicio, cal.fecha_fin AS cal_fin
    FROM reservas r
    LEFT JOIN espacio_inventario epIn ON epIn.id = r.inventario_id
    LEFT JOIN inventarios inv ON inv.id = epIn.inventario_id
    LEFT JOIN calendario cal ON cal.id = r.calendario_id
    WHERE r.solicitudCaras_id IN (${ph})
    ORDER BY r.solicitudCaras_id, r.id
  `, caraIds);
  console.log(`\nRESERVAS (total: ${reservas.length}):`);
  console.table(reservas.slice(0, 30).map(r => ({
    id: r.id, sc_id: r.solicitudCaras_id,
    codigo: r.codigo_unico ? r.codigo_unico.substring(0, 25) : '',
    tipo: r.inv_tipo, plaza: r.plaza ? r.plaza.substring(0, 15) : '',
    cal_id: r.cal_id, cal_ini: r.cal_inicio ? r.cal_inicio.toISOString().split('T')[0] : '',
    cal_fin: r.cal_fin ? r.cal_fin.toISOString().split('T')[0] : '',
    aps: r.APS, est: r.estatus, del: r.deleted_at ? 'Y' : '',
  })));
  if (reservas.length > 30) console.log(`... (${reservas.length - 30} más)`);

  // 4. Resumen reservas por cara
  const byCara = new Map();
  for (const r of reservas) {
    if (r.deleted_at) continue;
    if (!byCara.has(r.solicitudCaras_id)) byCara.set(r.solicitudCaras_id, []);
    byCara.get(r.solicitudCaras_id).push(r);
  }
  console.log('\nRESUMEN POR CARA (sin deleted):');
  const summary = [];
  for (const c of caras) {
    const rs = byCara.get(c.id) || [];
    const flujoCount = rs.filter(r => r.inv_tipo === 'Flujo').length;
    const ctraCount = rs.filter(r => r.inv_tipo === 'Contraflujo').length;
    const otroCount = rs.filter(r => !['Flujo', 'Contraflujo'].includes(r.inv_tipo)).length;
    const calIds = new Set(rs.map(r => r.cal_id).filter(Boolean));
    summary.push({
      cara_id: c.id,
      articulo: c.articulo,
      esperado: `${c.caras_flujo}F+${c.caras_contraflujo}CF=${c.caras}`,
      real: `${flujoCount}F+${ctraCount}CF+${otroCount}?=${rs.length}`,
      cal_ids: [...calIds].sort().join(','),
      periodo: c.inicio_periodo ? `${c.inicio_periodo.toISOString().split('T')[0]} → ${c.fin_periodo.toISOString().split('T')[0]}` : '',
    });
  }
  console.table(summary);

  // 5. Calendarios usados vs cotizacion fechas
  console.log(`\nFechas globales campaña: ${props[0].cm_fecha_inicio?.toISOString().split('T')[0]} → ${props[0].cm_fecha_fin?.toISOString().split('T')[0]}`);
  console.log(`Tipo periodo: ${props[0].tipo_periodo}`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
