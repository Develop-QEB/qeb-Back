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

  // 1. Solicitud + propuesta
  const [sol] = await conn.query(`
    SELECT s.id AS solicitud_id, s.nombre_usuario, p.id AS propuesta_id, p.descripcion
    FROM solicitud s
    LEFT JOIN propuesta p ON p.solicitud_id = s.id
    WHERE s.id = 35
  `);
  console.log('SOLICITUD 35:');
  console.table(sol);
  if (!sol[0]?.propuesta_id) { await conn.end(); return; }
  const propId = sol[0].propuesta_id;

  // 2. Todas las caras del propuesta
  const [caras] = await conn.query(`
    SELECT id, articulo, formato, ciudad, caras, bonificacion, caras_flujo, caras_contraflujo,
           inicio_periodo, fin_periodo, grupo_rt_bf
    FROM solicitudCaras
    WHERE idquote = ?
    ORDER BY inicio_periodo, articulo, id
  `, [String(propId)]);
  console.log(`\nCARAS de propuesta ${propId}:`);
  console.table(caras.map(c => ({
    id: c.id, articulo: c.articulo, formato: c.formato,
    caras: c.caras, bonif: Number(c.bonificacion), flujo: c.caras_flujo, ctra: c.caras_contraflujo,
    inicio: c.inicio_periodo?.toISOString().split('T')[0],
    fin: c.fin_periodo?.toISOString().split('T')[0],
    grupo: c.grupo_rt_bf,
  })));

  // 3. Filtrar solo circuitos digitales
  const circuitos = caras.filter(c => /^(RT|BF|CT|CF)-DIG-\d+-/i.test(c.articulo || ''));
  if (circuitos.length === 0) {
    console.log('\nNo hay caras de circuito digital.');
    await conn.end();
    return;
  }

  // 4. Reservas por cada cara
  console.log('\n=== ANÁLISIS DE RESERVAS POR CARA DE CIRCUITO ===');
  const ids = circuitos.map(c => c.id);
  const ph = ids.map(() => '?').join(',');
  const [reservas] = await conn.query(`
    SELECT r.id, r.solicitudCaras_id, r.estatus, r.deleted_at,
           inv.id AS inv_id, inv.codigo_unico, inv.tipo_de_cara, inv.plaza, inv.cto
    FROM reservas r
    LEFT JOIN espacio_inventario epIn ON epIn.id = r.inventario_id
    LEFT JOIN inventarios inv ON inv.id = epIn.inventario_id
    WHERE r.solicitudCaras_id IN (${ph}) AND r.deleted_at IS NULL
    ORDER BY r.solicitudCaras_id, inv.tipo_de_cara, r.id
  `, ids);

  // Resumen por cara
  const summary = [];
  const seenInv = new Map(); // inv_id → [cara_ids que lo reservaron]
  for (const c of circuitos) {
    const rs = reservas.filter(r => r.solicitudCaras_id === c.id);
    const flujo = rs.filter(r => r.tipo_de_cara === 'Flujo').length;
    const contraflujo = rs.filter(r => r.tipo_de_cara === 'Contraflujo').length;
    const otroTipo = rs.filter(r => !['Flujo', 'Contraflujo'].includes(r.tipo_de_cara)).length;
    const estatus = [...new Set(rs.map(r => r.estatus))].join(',');

    const isBfRow = (c.articulo || '').toUpperCase().startsWith('BF') || (c.articulo || '').toUpperCase().startsWith('CF');
    const cantidadEsperada = isBfRow ? Number(c.bonificacion || 0) : c.caras;

    summary.push({
      cara_id: c.id,
      articulo: c.articulo,
      tipo: isBfRow ? 'BF' : 'RT',
      esperado: cantidadEsperada,
      flujo_esp: c.caras_flujo,
      ctra_esp: c.caras_contraflujo,
      reservas: rs.length,
      flujo_real: flujo,
      ctra_real: contraflujo,
      otro: otroTipo,
      estatus,
      OK: rs.length === cantidadEsperada ? '✅' : '❌',
    });

    for (const r of rs) {
      if (r.inv_id) {
        if (!seenInv.has(r.inv_id)) seenInv.set(r.inv_id, []);
        seenInv.get(r.inv_id).push({ caraId: c.id, articulo: c.articulo, codigo: r.codigo_unico, estatus: r.estatus });
      }
    }
  }
  console.log('\nResumen por cara:');
  console.table(summary);

  // 5. ¿Hay inventarios reservados por más de una cara del MISMO grupo? (no debe pasar)
  const dups = [...seenInv.entries()].filter(([, arr]) => arr.length > 1);
  if (dups.length > 0) {
    console.log('\n⚠️ INVENTARIOS DUPLICADOS (mismo inv reservado en >1 cara):');
    for (const [invId, arr] of dups) {
      console.log(`  inv ${invId} (${arr[0].codigo}):`);
      arr.forEach(a => console.log(`    cara ${a.caraId} (${a.articulo}) → ${a.estatus}`));
    }
  } else {
    console.log('\n✅ No hay inventarios duplicados entre caras (RT vs BF cada uno toma distintos)');
  }

  // 6. Verificar cobertura del CTO: por cada (CTO, plaza, periodo), suma de reservas RT+BF
  //    debería ser ≤ tamaño total del CTO
  console.log('\n=== COBERTURA POR CTO + PERIODO ===');
  const grupos = new Map(); // key: cto|plazaCode|inicio|fin → { caras: [], total: 0 }
  for (const c of circuitos) {
    const m = (c.articulo || '').match(/^(RT|BF|CT|CF)-DIG-(\d+)-([A-Z]+)$/i);
    if (!m) continue;
    const cto = parseInt(m[2]);
    const plaza = m[3].toUpperCase();
    const ini = c.inicio_periodo?.toISOString().split('T')[0] || '';
    const fin = c.fin_periodo?.toISOString().split('T')[0] || '';
    const key = `CTO${cto}|${plaza}|${ini}|${fin}`;
    if (!grupos.has(key)) grupos.set(key, { cto, plaza, ini, fin, caras: [], reservas: 0 });
    const rs = reservas.filter(r => r.solicitudCaras_id === c.id);
    grupos.get(key).caras.push({ id: c.id, articulo: c.articulo, count: rs.length });
    grupos.get(key).reservas += rs.length;
  }

  // Para cada grupo, traer total de inventarios del CTO en esa plaza
  const PLAZA_LIKE = { MX: 'CIUDAD DE M%', MTY: 'MONTERREY%' };
  const grupoSummary = [];
  for (const g of grupos.values()) {
    const like = PLAZA_LIKE[g.plaza] || `${g.plaza}%`;
    const [totRow] = await conn.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN tipo_de_cara='Flujo' THEN 1 ELSE 0 END) AS flujo,
              SUM(CASE WHEN tipo_de_cara='Contraflujo' THEN 1 ELSE 0 END) AS ctra
         FROM inventarios WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)`,
      [String(g.cto), like]
    );
    const tot = Number(totRow[0]?.total || 0);
    grupoSummary.push({
      grupo: `CTO${g.cto} ${g.plaza}`,
      periodo: `${g.ini} → ${g.fin}`,
      total_inv_cto: tot,
      flujo_cto: Number(totRow[0]?.flujo || 0),
      ctra_cto: Number(totRow[0]?.ctra || 0),
      reservas: g.reservas,
      OK: g.reservas <= tot ? '✅' : '⚠️ sobrereserva',
      caras: g.caras.map(c => `${c.articulo}#${c.id}=${c.count}`).join(', '),
    });
  }
  console.log('\nResumen por grupo (CTO+plaza+periodo):');
  console.table(grupoSummary);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
