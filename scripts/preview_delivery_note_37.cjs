// Construye y postea el delivery note de campaña 37 a SAP TEST con CardCode INVENTADO
// para forzar error. Imprime payload + respuesta SAP. NO modifica nada en QEB.
require('dotenv').config();
const mysql = require('mysql2/promise');

const SAP_BASE_URL = 'https://binding-convinced-ride-foto.trycloudflare.com';
const ENDPOINTS = {
  CIMU:  { url: `${SAP_BASE_URL}/delivery-notes`,       series: 164 },
  TEST:  { url: `${SAP_BASE_URL}/delivery-notes-test`,  series: 4   },
  TRADE: { url: `${SAP_BASE_URL}/delivery-notes-trade`, series: 95  },
};

const FAKE_CARDCODE = 'XXX-9999'; // intencional para forzar "Invalid BP code" de SAP

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

  // 1. Datos de campaña 37
  const [camp] = await conn.query(`
    SELECT cm.id, cm.nombre, cm.cliente_id, cm.fecha_inicio, cm.fecha_fin, cm.cotizacion_id,
           cl.CUIC, cl.T0_U_Asesor, cl.T0_U_Cliente, cl.T0_U_RazonSocial, cl.T0_U_Agencia,
           cl.T2_U_Marca, cl.T2_U_Producto, cl.T2_U_Categoria,
           sl.card_code, sl.salesperson_code, sl.sap_database,
           ct.id_propuesta, ct.tipo_periodo
    FROM campania cm
    LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
    LEFT JOIN propuesta pr ON pr.id = ct.id_propuesta
    LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
    LEFT JOIN cliente cl ON cl.CUIC = sl.cuic
    WHERE cm.id = 37
  `);
  if (!camp[0]) { console.log('Campaña 37 no encontrada'); await conn.end(); return; }
  const c = camp[0];
  console.log('CAMPAÑA 37:');
  console.table([{
    id: c.id, nombre: c.nombre, cuic: c.CUIC, cliente: c.T0_U_Cliente,
    sap_db: c.sap_database, card_code: c.card_code, propuesta_id: c.id_propuesta,
  }]);

  // 2. Inventario + APS de la campaña
  const [inv] = await conn.query(`
    SELECT inv.id AS inventario_id, inv.codigo_unico, inv.plaza, inv.estado,
           sc.articulo, sc.tarifa_publica AS tarifa_publica_sc, sc.inicio_periodo, sc.fin_periodo,
           rsv.estatus AS estatus_reserva, rsv.APS,
           cat.numero_catorcena, cat.año AS anio_catorcena,
           CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales
    FROM reservas rsv
    INNER JOIN espacio_inventario epIn ON epIn.id = rsv.inventario_id
    INNER JOIN inventarios inv ON inv.id = epIn.inventario_id
    INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
    INNER JOIN cotizacion ct ON ct.id_propuesta = sc.idquote
    LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
    WHERE ct.id = ? AND rsv.deleted_at IS NULL AND rsv.APS IS NOT NULL AND rsv.APS > 0
    GROUP BY inv.id, inv.codigo_unico, inv.plaza, inv.estado, sc.articulo,
             sc.tarifa_publica, sc.inicio_periodo, sc.fin_periodo,
             rsv.estatus, rsv.APS, cat.numero_catorcena, cat.año
    ORDER BY rsv.APS, sc.articulo
  `, [c.cotizacion_id]);
  console.log(`\nInventario con APS: ${inv.length}`);
  if (inv.length === 0) {
    console.log('⚠️ Sin APS asignados — no hay nada que postear. Asígnalos en QEB primero.');
    await conn.end();
    return;
  }
  console.table(inv.slice(0, 5).map(i => ({
    inv: i.inventario_id, art: i.articulo, plaza: i.plaza,
    aps: Number(i.APS), estatus: i.estatus_reserva,
  })));
  if (inv.length > 5) console.log(`  ... ${inv.length - 5} más`);

  // 3. Construir delivery notes (uno por APS)
  const sapDb = c.sap_database || 'TEST';
  const series = ENDPOINTS[sapDb]?.series || 4;
  const uniqueAPS = [...new Set(inv.map(i => Number(i.APS)))];

  const deliveryNotes = uniqueAPS.map(aps => {
    const items = inv.filter(i => Number(i.APS) === aps);
    const articulos = [...new Set(items.map(i => i.articulo))];
    const documentLines = articulos.map((articulo, idx) => {
      const itemsArt = items.filter(i => i.articulo === articulo);
      const first = itemsArt[0];
      const isIM = String(first.articulo || '').toUpperCase().startsWith('IM');
      const quantity = isIM
        ? itemsArt.reduce((s, i) => s + (Number(i.caras_totales) || 1), 0)
        : itemsArt.length;
      const totalPrice = Number(first.tarifa_publica_sc) || 0;
      const dscPeriod = first.numero_catorcena && first.anio_catorcena
        ? `CATORCENA ${first.numero_catorcena}-${first.anio_catorcena}` : 'CATORCENA —-—';
      return {
        LineNum: String(idx),
        ItemCode: first.articulo || '',
        Quantity: String(quantity),
        TaxCode: 'A4',
        UnitPrice: String(totalPrice || 0),
        CostingCode: '02-03-04',
        CostingCode2: '1',
        U_Cod_Sitio: 11,
        U_dscSitio: first.plaza || first.estado || '',
        U_CodTAsig: (first.estatus_reserva === 'Bonificado' || first.estatus_reserva === 'Vendido bonificado') ? 204 : 200,
        U_dscTAsig: first.estatus_reserva === 'Vendido' ? 'Venta' : (first.estatus_reserva || ''),
        U_CodPer: 1746,
        U_dscPeriod: dscPeriod,
        U_FechInPer: first.inicio_periodo?.toISOString().split('T')[0] || '',
        U_FechFinPer: first.fin_periodo?.toISOString().split('T')[0] || '',
      };
    });

    return {
      Series: series,
      CardCode: FAKE_CARDCODE, // <-- INTENCIONAL
      NumAtCard: String(c.id),
      Comments: '',
      DocDueDate: (c.fecha_fin || new Date()).toISOString().split('T')[0],
      SalesPersonCode: sapDb === 'TRADE' ? -1 : (c.salesperson_code || -1),
      U_CIC: String(c.CUIC || ''),
      U_CRM_Asesor: c.T0_U_Asesor || '',
      U_CRM_Producto: c.T2_U_Producto || '',
      U_CRM_Marca: c.T2_U_Marca || '',
      U_CRM_Categoria: c.T2_U_Categoria || '',
      U_CRM_Cliente: c.T0_U_Cliente || '',
      U_CRM_Agencia: c.T0_U_Agencia || '',
      U_CRM_SAP: FAKE_CARDCODE,
      U_CRM_R_S: c.T0_U_RazonSocial || '',
      U_CRM_Camp: c.nombre || '',
      U_TIPO_VENTA: 'Comercial',
      U_IMU_ART_APS: String(c.id_propuesta || c.id),
      U_IMU_CotNum: String(aps),
      DocumentLines: documentLines,
    };
  });

  console.log(`\n=== ${deliveryNotes.length} delivery note(s) a postear (CardCode=${FAKE_CARDCODE} para forzar error) ===\n`);

  // 4. Postear cada uno
  const endpoint = ENDPOINTS[sapDb]?.url || ENDPOINTS.TEST.url;
  for (const [i, dn] of deliveryNotes.entries()) {
    console.log(`\n--- DELIVERY NOTE #${i + 1} (APS ${dn.U_IMU_CotNum}) ---`);
    console.log('PAYLOAD:');
    console.log(JSON.stringify(dn, null, 2));
    console.log(`\nPOST → ${endpoint}`);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dn),
      });
      const data = await r.json().catch(() => ({}));
      console.log(`STATUS: ${r.status}`);
      console.log('RESPONSE:');
      console.log(JSON.stringify(data, null, 2));
    } catch (e) {
      console.log(`ERROR fetch: ${e?.message || e}`);
    }
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
