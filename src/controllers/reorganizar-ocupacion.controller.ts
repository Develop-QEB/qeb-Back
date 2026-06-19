// =============================================================================
// REORGANIZAR OCUPACIÓN — endpoints solo-DEV
// =============================================================================
// Soporta el flujo "Revisar por campaña" desde InventariosPage:
// - Listar catorcenas disponibles de una campaña
// - Listar circuitos-formato (solicitudCaras) de una campaña + catorcena
// - Comparar un CSV de códigos contra un circuito-formato
// - Aplicar la reorganización transaccional (sustituir reservas)
//
// La operación de aplicar mueve reservas entre campañas. Se ejecuta con
// `createReservaConLock` por cada reserva nueva (lock fino sobre el espacio)
// y soft-delete por las sustituidas / liberadas. La auditoría registra todo
// en `auditoria_reorganizacion_ocupacion`.
// =============================================================================

import { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { createReservaConLock } from '../services/inventario-bloqueo.service';
import { serializeBigInt } from '../utils/serialization';

function isDev(req: AuthRequest): boolean {
  return req.user?.rol === 'DEV';
}

async function lookupCatorcena(numero: number, anio: number) {
  return prisma.catorcenas.findFirst({
    where: { numero_catorcena: numero, a_o: anio },
    select: { fecha_inicio: true, fecha_fin: true },
  });
}

async function catorcenaDeFecha(fecha: Date): Promise<{ numero: number; anio: number } | null> {
  const row = await prisma.catorcenas.findFirst({
    where: {
      fecha_inicio: { lte: fecha },
      fecha_fin: { gte: fecha },
    },
    select: { numero_catorcena: true, a_o: true },
  });
  if (!row) return null;
  return { numero: row.numero_catorcena, anio: row.a_o };
}

// ---------------------------------------------------------------------------
// GET /reorganizar-ocupacion/campanas/:id/catorcenas
// ---------------------------------------------------------------------------
export const getCatorcenasDeCampana = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      res.status(403).json({ success: false, error: 'Acceso denegado' });
      return;
    }

    const campanaId = parseInt(req.params.id);
    if (!Number.isFinite(campanaId)) {
      res.status(400).json({ success: false, error: 'id de campaña inválido' });
      return;
    }

    const campana = await prisma.campania.findUnique({
      where: { id: campanaId },
      select: { id: true, nombre: true, cotizacion_id: true },
    });
    if (!campana) {
      res.status(404).json({ success: false, error: 'Campaña no encontrada' });
      return;
    }
    if (!campana.cotizacion_id) {
      res.json({ success: true, data: { campana, catorcenas: [] } });
      return;
    }

    const cotizacion = await prisma.cotizacion.findUnique({
      where: { id: campana.cotizacion_id },
      select: { id_propuesta: true },
    });
    if (!cotizacion?.id_propuesta) {
      res.json({ success: true, data: { campana, catorcenas: [] } });
      return;
    }

    const caras = await prisma.solicitudCaras.findMany({
      where: { idquote: String(cotizacion.id_propuesta) },
      select: { inicio_periodo: true, fin_periodo: true },
    });

    const catorcenasSet = new Map<string, { numero: number; anio: number }>();
    for (const c of caras) {
      if (!c.inicio_periodo) continue;
      const cat = await catorcenaDeFecha(c.inicio_periodo);
      if (cat) catorcenasSet.set(`${cat.anio}-${cat.numero}`, cat);
    }

    const catorcenas = Array.from(catorcenasSet.values()).sort(
      (a, b) => a.anio - b.anio || a.numero - b.numero,
    );

    res.json({ success: true, data: { campana, catorcenas } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al listar catorcenas';
    console.error('[reorganizar-ocupacion getCatorcenasDeCampana]', error);
    res.status(500).json({ success: false, error: message });
  }
};

// ---------------------------------------------------------------------------
// GET /reorganizar-ocupacion/campanas/:id/circuitos?numero=N&anio=Y
// ---------------------------------------------------------------------------
export const getCircuitosPorCatorcena = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      res.status(403).json({ success: false, error: 'Acceso denegado' });
      return;
    }

    const campanaId = parseInt(req.params.id);
    const numero = parseInt(req.query.numero as string);
    const anio = parseInt(req.query.anio as string);

    if (!Number.isFinite(campanaId) || !Number.isFinite(numero) || !Number.isFinite(anio)) {
      res.status(400).json({ success: false, error: 'Parámetros inválidos' });
      return;
    }

    const cat = await lookupCatorcena(numero, anio);
    if (!cat) {
      res.status(404).json({ success: false, error: 'Catorcena no encontrada' });
      return;
    }

    const campana = await prisma.campania.findUnique({
      where: { id: campanaId },
      select: { id: true, nombre: true, cotizacion_id: true, cliente_id: true },
    });
    if (!campana?.cotizacion_id) {
      res.json({ success: true, data: { campana, circuitos: [] } });
      return;
    }

    const cotizacion = await prisma.cotizacion.findUnique({
      where: { id: campana.cotizacion_id },
      select: { id_propuesta: true },
    });
    if (!cotizacion?.id_propuesta) {
      res.json({ success: true, data: { campana, circuitos: [] } });
      return;
    }

    const caras = await prisma.solicitudCaras.findMany({
      where: {
        idquote: String(cotizacion.id_propuesta),
        inicio_periodo: { gte: cat.fecha_inicio, lte: cat.fecha_fin },
      },
      orderBy: { id: 'asc' },
    });

    const result = [];
    for (const c of caras) {
      const inventarios = await prisma.$queryRawUnsafe<
        {
          reserva_id: number;
          espacio_id: number;
          inventario_id: number;
          codigo_unico: string | null;
          mueble: string | null;
          plaza: string | null;
          tipo_de_cara: string | null;
          tradicional_digital: string | null;
          ubicacion: string | null;
          estatus: string | null;
        }[]
      >(
        `SELECT rsv.id AS reserva_id, rsv.inventario_id AS espacio_id,
                i.id AS inventario_id, i.codigo_unico, i.mueble, i.plaza,
                i.tipo_de_cara, i.tradicional_digital, i.ubicacion, rsv.estatus
         FROM reservas rsv
         INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
         INNER JOIN inventarios i ON i.id = ei.inventario_id
         WHERE rsv.solicitudCaras_id = ?
           AND rsv.deleted_at IS NULL
         ORDER BY i.codigo_unico`,
        c.id,
      );

      result.push({
        solicitud_caras_id: c.id,
        articulo: c.articulo,
        formato: c.formato,
        tipo: c.tipo,
        caras_totales: c.caras,
        inicio_periodo: c.inicio_periodo,
        fin_periodo: c.fin_periodo,
        inventarios_actuales: inventarios.length,
        inventarios,
      });
    }

    res.json({
      success: true,
      data: {
        campana,
        catorcena: { numero, anio, fecha_inicio: cat.fecha_inicio, fecha_fin: cat.fecha_fin },
        circuitos: serializeBigInt(result),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al listar circuitos';
    console.error('[reorganizar-ocupacion getCircuitosPorCatorcena]', error);
    res.status(500).json({ success: false, error: message });
  }
};

// ---------------------------------------------------------------------------
// POST /reorganizar-ocupacion/comparar
// body: { solicitudCarasId, codigos: string[] }
// ---------------------------------------------------------------------------
export const compararCsv = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      res.status(403).json({ success: false, error: 'Acceso denegado' });
      return;
    }

    const { solicitudCarasId, codigos } = req.body as {
      solicitudCarasId?: number;
      codigos?: string[];
    };

    if (!solicitudCarasId || !Array.isArray(codigos) || codigos.length === 0) {
      res.status(400).json({ success: false, error: 'Faltan parámetros' });
      return;
    }

    const sc = await prisma.solicitudCaras.findUnique({
      where: { id: solicitudCarasId },
      select: { id: true, inicio_periodo: true, fin_periodo: true, caras: true, articulo: true, formato: true, idquote: true },
    });
    if (!sc) {
      res.status(404).json({ success: false, error: 'Circuito-formato no encontrado' });
      return;
    }

    const codigosNorm = Array.from(new Set(codigos.map(c => String(c).trim()).filter(Boolean)));

    const ph = codigosNorm.map(() => '?').join(',');
    const inventarios = await prisma.$queryRawUnsafe<
      {
        id: number;
        codigo_unico: string;
        plaza: string | null;
        mueble: string | null;
        tipo_de_cara: string | null;
        tradicional_digital: string | null;
        ubicacion: string | null;
      }[]
    >(
      `SELECT id, codigo_unico, plaza, mueble, tipo_de_cara, tradicional_digital, ubicacion
       FROM inventarios
       WHERE codigo_unico IN (${ph})`,
      ...codigosNorm,
    );

    const invByCodigo = new Map(inventarios.map(i => [i.codigo_unico, i]));
    const codigosNoEncontrados = codigosNorm.filter(c => !invByCodigo.has(c));

    const invIds = inventarios.map(i => i.id);
    let enEsteCircuito = new Set<number>();
    if (invIds.length > 0) {
      const phInv = invIds.map(() => '?').join(',');
      const enCircRows = await prisma.$queryRawUnsafe<{ inventario_id: number }[]>(
        `SELECT DISTINCT i.id AS inventario_id
         FROM reservas rsv
         INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
         INNER JOIN inventarios i ON i.id = ei.inventario_id
         WHERE rsv.solicitudCaras_id = ?
           AND rsv.deleted_at IS NULL
           AND i.id IN (${phInv})`,
        sc.id, ...invIds,
      );
      enEsteCircuito = new Set(enCircRows.map(r => Number(r.inventario_id)));
    }

    type OcupadoRow = {
      inventario_id: number;
      reserva_id: number;
      solicitudCaras_id: number;
      sc_articulo: string | null;
      sc_formato: string | null;
      sc_inicio: Date;
      sc_fin: Date;
      campana_id: number | null;
      campana_nombre: string | null;
      cliente_id: number | null;
      cliente_nombre: string | null;
      propuesta_id: number | null;
    };
    let ocupadosOtros: OcupadoRow[] = [];
    if (invIds.length > 0) {
      const phInv2 = invIds.map(() => '?').join(',');
      ocupadosOtros = await prisma.$queryRawUnsafe<OcupadoRow[]>(
        `SELECT i.id AS inventario_id,
                rsv.id AS reserva_id,
                rsv.solicitudCaras_id,
                sc.articulo AS sc_articulo,
                sc.formato AS sc_formato,
                sc.inicio_periodo AS sc_inicio,
                sc.fin_periodo AS sc_fin,
                cm.id AS campana_id,
                cm.nombre AS campana_nombre,
                cl.id AS cliente_id,
                COALESCE(cl.T0_U_RazonSocial, cl.T2_U_Marca, cl.T1_U_Cliente, '') AS cliente_nombre,
                CAST(sc.idquote AS UNSIGNED) AS propuesta_id
         FROM reservas rsv
         INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
         INNER JOIN inventarios i ON i.id = ei.inventario_id
         INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
         LEFT JOIN cotizacion ct ON ct.id_propuesta = CAST(sc.idquote AS UNSIGNED)
         LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
         LEFT JOIN cliente cl ON cl.id = cm.cliente_id
         WHERE i.id IN (${phInv2})
           AND rsv.deleted_at IS NULL
           AND rsv.estatus IN ('Reservado','Bonificado','Vendido','Vendido bonificado','Con Arte','Sin Arte')
           AND rsv.solicitudCaras_id <> ?
           AND NOT (sc.fin_periodo < ? OR sc.inicio_periodo > ?)`,
        ...invIds, sc.id, sc.inicio_periodo, sc.fin_periodo,
      );
    }

    const ocupadosPorInv = new Map<number, OcupadoRow[]>();
    for (const o of ocupadosOtros) {
      const list = ocupadosPorInv.get(Number(o.inventario_id)) || [];
      list.push(o);
      ocupadosPorInv.set(Number(o.inventario_id), list);
    }

    const items = codigosNorm.map(codigo => {
      const inv = invByCodigo.get(codigo);
      if (!inv) {
        return { codigo_unico: codigo, existe: false };
      }
      const enCirc = enEsteCircuito.has(inv.id);
      const ocupaciones = (ocupadosPorInv.get(inv.id) || []).map(o => ({
        reserva_id: Number(o.reserva_id),
        solicitud_caras_id: Number(o.solicitudCaras_id),
        articulo: o.sc_articulo,
        formato: o.sc_formato,
        inicio_periodo: o.sc_inicio,
        fin_periodo: o.sc_fin,
        campana_id: o.campana_id ? Number(o.campana_id) : null,
        campana_nombre: o.campana_nombre,
        cliente_id: o.cliente_id ? Number(o.cliente_id) : null,
        cliente_nombre: o.cliente_nombre,
        propuesta_id: o.propuesta_id ? Number(o.propuesta_id) : null,
      }));

      let estado: 'en_circuito' | 'disponible' | 'ocupado_en_otra' = 'disponible';
      if (enCirc) estado = 'en_circuito';
      else if (ocupaciones.length > 0) estado = 'ocupado_en_otra';

      return {
        codigo_unico: codigo,
        existe: true,
        inventario: {
          id: inv.id,
          codigo_unico: inv.codigo_unico,
          plaza: inv.plaza,
          mueble: inv.mueble,
          tipo_de_cara: inv.tipo_de_cara,
          tradicional_digital: inv.tradicional_digital,
          ubicacion: inv.ubicacion,
        },
        estado,
        ocupaciones,
      };
    });

    const circuitoActualRows = await prisma.$queryRawUnsafe<
      { reserva_id: number; espacio_id: number; inventario_id: number; codigo_unico: string | null; plaza: string | null; mueble: string | null; tipo_de_cara: string | null; ubicacion: string | null }[]
    >(
      `SELECT rsv.id AS reserva_id, rsv.inventario_id AS espacio_id,
              i.id AS inventario_id, i.codigo_unico, i.plaza, i.mueble, i.tipo_de_cara, i.ubicacion
       FROM reservas rsv
       INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
       INNER JOIN inventarios i ON i.id = ei.inventario_id
       WHERE rsv.solicitudCaras_id = ?
         AND rsv.deleted_at IS NULL
       ORDER BY i.codigo_unico`,
      sc.id,
    );
    const codigosEnCsv = new Set(codigosNorm);
    const enCircuitoSinCsv = circuitoActualRows.filter(r => r.codigo_unico && !codigosEnCsv.has(r.codigo_unico));

    res.json({
      success: true,
      data: {
        circuito: {
          solicitud_caras_id: sc.id,
          articulo: sc.articulo,
          formato: sc.formato,
          caras_totales: sc.caras,
          inicio_periodo: sc.inicio_periodo,
          fin_periodo: sc.fin_periodo,
        },
        csv: {
          total: codigosNorm.length,
          no_encontrados: codigosNoEncontrados,
        },
        items: serializeBigInt(items),
        en_circuito_sin_csv: serializeBigInt(enCircuitoSinCsv),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al comparar CSV';
    console.error('[reorganizar-ocupacion compararCsv]', error);
    res.status(500).json({ success: false, error: message });
  }
};

// ---------------------------------------------------------------------------
// POST /reorganizar-ocupacion/aplicar
// ---------------------------------------------------------------------------
export const aplicarReorganizacion = async (req: AuthRequest, res: Response) => {
  try {
    if (!isDev(req)) {
      res.status(403).json({ success: false, error: 'Acceso denegado' });
      return;
    }

    const { solicitudCarasId, agregar } = req.body as {
      solicitudCarasId?: number;
      agregar?: {
        inventario_id: number;
        reserva_origen_id: number | null;
        sustituye_reserva_id: number;
      }[];
    };

    if (!solicitudCarasId || !Array.isArray(agregar) || agregar.length === 0) {
      res.status(400).json({ success: false, error: 'Faltan parámetros' });
      return;
    }

    const sc = await prisma.solicitudCaras.findUnique({
      where: { id: solicitudCarasId },
      select: {
        id: true, inicio_periodo: true, fin_periodo: true, caras: true,
        articulo: true, formato: true, idquote: true,
      },
    });
    if (!sc) {
      res.status(404).json({ success: false, error: 'Circuito-formato no encontrado' });
      return;
    }

    let campanaDestino: { id: number; nombre: string; cliente_id: number } | null = null;
    if (sc.idquote) {
      const propuestaIdNum = Number(sc.idquote);
      if (Number.isFinite(propuestaIdNum)) {
        const camp = await prisma.$queryRawUnsafe<{ id: number; nombre: string; cliente_id: number }[]>(
          `SELECT cm.id, cm.nombre, cm.cliente_id
           FROM cotizacion ct
           INNER JOIN campania cm ON cm.cotizacion_id = ct.id
           WHERE ct.id_propuesta = ? LIMIT 1`,
          propuestaIdNum,
        );
        if (camp[0]) campanaDestino = camp[0];
      }
    }

    const invIdsInput = agregar.map(a => a.inventario_id);
    const invIdsUnicos = new Set(invIdsInput);
    if (invIdsUnicos.size !== invIdsInput.length) {
      res.status(400).json({ success: false, error: 'El payload contiene inventarios duplicados' });
      return;
    }

    const reservasActivas = await prisma.reservas.count({
      where: { solicitudCaras_id: sc.id, deleted_at: null },
    });
    const sustituyeIds = agregar.map(a => a.sustituye_reserva_id);
    const sustituyeUnicos = new Set(sustituyeIds);
    if (sustituyeUnicos.size !== sustituyeIds.length) {
      res.status(400).json({ success: false, error: 'No puedes sustituir dos veces la misma reserva' });
      return;
    }
    // Sustitución 1-a-1: el total final no debe exceder caras_totales.
    if (reservasActivas > sc.caras) {
      res.status(400).json({
        success: false,
        error: `El circuito ya excede ${sc.caras} caras (${reservasActivas} activas)`,
      });
      return;
    }

    const espaciosPorInv = await prisma.espacio_inventario.findMany({
      where: { inventario_id: { in: Array.from(invIdsUnicos) } },
      orderBy: { numero_espacio: 'asc' },
    });
    const espacioByInv = new Map<number, number>();
    for (const e of espaciosPorInv) {
      if (!espacioByInv.has(e.inventario_id)) espacioByInv.set(e.inventario_id, e.id);
    }

    const sinEspacio = Array.from(invIdsUnicos).filter(id => !espacioByInv.has(id));
    if (sinEspacio.length > 0) {
      res.status(400).json({
        success: false,
        error: `Los siguientes inventario_id no tienen espacio_inventario: ${sinEspacio.join(', ')}`,
      });
      return;
    }

    const userId = req.user?.userId || 0;
    const userName = req.user?.nombre || 'DEV';

    const reservaOrigenIds = agregar.map(a => a.reserva_origen_id).filter((x): x is number => x !== null);
    type OrigenMeta = {
      reserva_id: number;
      solicitud_caras_id: number;
      campana_id: number | null;
      campana_nombre: string | null;
      cliente_nombre: string | null;
      propuesta_id: number | null;
      articulo: string | null;
      formato: string | null;
    };
    const origenMetaMap = new Map<number, OrigenMeta>();
    if (reservaOrigenIds.length > 0) {
      const phO = reservaOrigenIds.map(() => '?').join(',');
      const rows = await prisma.$queryRawUnsafe<OrigenMeta[]>(
        `SELECT rsv.id AS reserva_id, rsv.solicitudCaras_id AS solicitud_caras_id,
                cm.id AS campana_id, cm.nombre AS campana_nombre,
                COALESCE(cl.T0_U_RazonSocial, cl.T2_U_Marca, cl.T1_U_Cliente, '') AS cliente_nombre,
                CAST(sc.idquote AS UNSIGNED) AS propuesta_id,
                sc.articulo, sc.formato
         FROM reservas rsv
         INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
         LEFT JOIN cotizacion ct ON ct.id_propuesta = CAST(sc.idquote AS UNSIGNED)
         LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
         LEFT JOIN cliente cl ON cl.id = cm.cliente_id
         WHERE rsv.id IN (${phO})`,
        ...reservaOrigenIds,
      );
      for (const r of rows) origenMetaMap.set(Number(r.reserva_id), r);
    }

    const codigosByInv = new Map<number, string>();
    const invRows = await prisma.inventarios.findMany({
      where: { id: { in: Array.from(invIdsUnicos) } },
      select: { id: true, codigo_unico: true },
    });
    for (const i of invRows) codigosByInv.set(i.id, i.codigo_unico || '');

    const auditAgregados: Record<string, unknown>[] = [];
    let creadas = 0;
    let sustituidas = 0;
    let liberadas = 0;

    for (const a of agregar) {
      const espacioId = espacioByInv.get(a.inventario_id)!;
      const codigoUnico = codigosByInv.get(a.inventario_id) || null;
      const origen = a.reserva_origen_id ? origenMetaMap.get(a.reserva_origen_id) : null;

      try {
        await prisma.$transaction(async tx => {
          const reservaSustituida = await tx.reservas.findFirst({
            where: { id: a.sustituye_reserva_id, deleted_at: null, solicitudCaras_id: sc.id },
            select: { id: true },
          });
          if (!reservaSustituida) {
            throw new Error(`Reserva a sustituir ${a.sustituye_reserva_id} no encontrada o ya inactiva`);
          }
          await tx.reservas.update({
            where: { id: reservaSustituida.id },
            data: { deleted_at: new Date() },
          });
          sustituidas++;

          if (a.reserva_origen_id) {
            const reservaOrigen = await tx.reservas.findFirst({
              where: { id: a.reserva_origen_id, deleted_at: null },
              select: { id: true, solicitudCaras_id: true },
            });
            if (!reservaOrigen) {
              throw new Error(`Reserva origen ${a.reserva_origen_id} no encontrada o ya inactiva`);
            }
            if (reservaOrigen.solicitudCaras_id === sc.id) {
              throw new Error(`Reserva origen ${a.reserva_origen_id} pertenece al mismo circuito destino`);
            }
            await tx.reservas.update({
              where: { id: reservaOrigen.id },
              data: { deleted_at: new Date() },
            });
            liberadas++;
          }
        }, { timeout: 15000 });
      } catch (errTx) {
        const m = errTx instanceof Error ? errTx.message : String(errTx);
        res.status(409).json({
          success: false,
          error: `Falla en sustitución (inventario_id=${a.inventario_id}): ${m}`,
        });
        return;
      }

      const cal = await prisma.calendario.create({
        data: { fecha_inicio: sc.inicio_periodo, fecha_fin: sc.fin_periodo },
      });

      const lockResult = await createReservaConLock(
        {
          inventario_id: espacioId,
          calendario_id: cal.id,
          cliente_id: campanaDestino?.cliente_id || 0,
          solicitudCaras_id: sc.id,
          estatus: 'Vendido',
          arte_aprobado: '',
          comentario_rechazo: '',
          estatus_original: '',
          fecha_testigo: new Date(),
          imagen_testigo: '',
          instalado: false,
          tarea: '',
        } as Prisma.reservasUncheckedCreateInput,
        sc.inicio_periodo,
        sc.fin_periodo,
      );

      if (!lockResult.ok) {
        res.status(409).json({
          success: false,
          error: `No se pudo crear reserva para inventario_id=${a.inventario_id}: espacio ya ocupado tras el lock`,
        });
        return;
      }

      creadas++;
      auditAgregados.push({
        inventario_id: a.inventario_id,
        codigo_unico: codigoUnico,
        reserva_creada_id: lockResult.reserva.id,
        sustituye_reserva_id: a.sustituye_reserva_id,
        reserva_origen_id: a.reserva_origen_id,
        origen: origen
          ? {
              campana_id: origen.campana_id,
              campana_nombre: origen.campana_nombre,
              cliente_nombre: origen.cliente_nombre,
              propuesta_id: origen.propuesta_id,
              solicitud_caras_id: origen.solicitud_caras_id,
              articulo: origen.articulo,
              formato: origen.formato,
            }
          : null,
      });
    }

    const catorcena = await catorcenaDeFecha(sc.inicio_periodo);
    await prisma.auditoria_reorganizacion_ocupacion.create({
      data: {
        usuario_id: userId,
        usuario_nombre: userName,
        campana_id: campanaDestino?.id || 0,
        solicitud_caras_id: sc.id,
        catorcena_numero: catorcena?.numero || 0,
        catorcena_anio: catorcena?.anio || 0,
        reservas_creadas: creadas,
        reservas_sustituidas: sustituidas,
        reservas_liberadas: liberadas,
        payload_json: JSON.stringify({
          agregados: auditAgregados,
          circuito_destino: {
            solicitud_caras_id: sc.id,
            articulo: sc.articulo,
            formato: sc.formato,
            campana_id: campanaDestino?.id,
            campana_nombre: campanaDestino?.nombre,
            inicio_periodo: sc.inicio_periodo,
            fin_periodo: sc.fin_periodo,
          },
        }),
      },
    });

    res.json({
      success: true,
      data: {
        reservas_creadas: creadas,
        reservas_sustituidas: sustituidas,
        reservas_liberadas: liberadas,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error aplicando reorganización';
    console.error('[reorganizar-ocupacion aplicarReorganizacion]', error);
    res.status(500).json({ success: false, error: message });
  }
};
