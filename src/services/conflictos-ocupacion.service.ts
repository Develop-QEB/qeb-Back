// Detector de conflictos de ocupación (celda = inventario × catorcena).
//
// Un inventario Tradicional solo admite una campaña por catorcena. Dos o más
// reservas vivas en la misma celda son un error de operación, de dos clases muy
// distintas:
//
//   CHOQUE     → campañas distintas peleando la misma cara. Decisión comercial:
//                alguien tiene que liberar. NUNCA se resuelve automáticamente.
//   DUPLICADO  → una sola campaña con varias reservas sobre la misma cara. Error
//                de armado; se puede limpiar dejando una.
//
// Los Digitales se excluyen: tienen varios espacios y varias reservas
// simultáneas son su comportamiento normal, no un conflicto.

import prisma from '../utils/prisma';
import { logHistorial } from '../utils/historial';

export interface CatorcenaRef {
  numero: number;
  anio: number;
}

export interface CeldaConflicto {
  inventario_id: number;
  codigo_unico: string | null;
  plaza: string | null;
  mueble: string | null;
  ubicacion: string | null;
  tradicional_digital: string | null;
  anio: number;
  numero_catorcena: number;
  /** Reservas vivas en la celda. */
  n: number;
  /** Campañas (o propuestas) distintas que la ocupan. */
  origenes: number;
  /** Campañas que ocupan la celda, para enlazar desde la UI. */
  campanas: { id: number; nombre: string }[];
  /** Propuestas (idquote) con reservas sin campaña en la celda. */
  propuestas: number[];
}

/** Roles que reciben el aviso. Lista corta a propósito: el módulo de
 *  notificaciones ya carga un backlog grande y esto no debe engordarlo. */
export const ROLES_NOTIFICAR_CONFLICTOS = [
  'DEV',
  'Gerente de Trafico',
  'Coordinador de trafico',
];

export const esChoque = (c: { origenes: number }) => c.origenes >= 2;

/**
 * Ventana de fechas que cubren las catorcenas pedidas. Acota solicitudCaras por
 * `inicio_periodo` para entrar por idx_periodos; sin esto el join por rango
 * contra catorcenas obliga a recorrer todas las caras.
 */
export async function rangoFechasDeCatorcenas(
  cats: CatorcenaRef[]
): Promise<{ inicio: Date; fin: Date } | null> {
  if (cats.length === 0) return null;
  const ph = cats.map(() => '(?,?)').join(',');
  const params = cats.flatMap(c => [c.anio, c.numero]);
  const rows = await prisma.$queryRawUnsafe<Array<{ inicio: Date | null; fin: Date | null }>>(
    `SELECT MIN(fecha_inicio) AS inicio, MAX(fecha_fin) AS fin
       FROM catorcenas
      WHERE (año, numero_catorcena) IN (${ph})`,
    ...params
  );
  const row = rows[0];
  if (!row?.inicio || !row?.fin) return null;
  return { inicio: row.inicio, fin: row.fin };
}

/**
 * Catorcena vigente y las siguientes. La tabla `catorcenas` va corrida un día
 * respecto a la realidad operativa, así que la vigente es la que contiene
 * MAÑANA, no hoy.
 */
export async function catorcenasVigentes(cantidad = 8): Promise<CatorcenaRef[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ anio: number; numero: number }>>(
    `SELECT año AS anio, numero_catorcena AS numero
       FROM catorcenas
      WHERE fecha_fin >= (CURDATE() + INTERVAL 1 DAY)
      ORDER BY fecha_inicio
      LIMIT ${Math.max(1, Math.min(30, Math.trunc(cantidad)))}`
  );
  return rows.map(r => ({ anio: Number(r.anio), numero: Number(r.numero) }));
}

/**
 * Celdas con 2+ reservas vivas en las catorcenas pedidas.
 *
 * Va en dos fases a propósito: el join a `cotizacion` lleva un
 * `CAST(id_propuesta AS CHAR)` que impide usar índice, y metido en la consulta
 * que barre el inventario completo la tumba por costo. La fase 1 identifica las
 * celdas (barata) y la fase 2 resuelve los orígenes solo sobre esos sitios.
 *
 * `ids` opcional: sin él audita TODO el inventario.
 */
export async function detectarConflictos(
  catorcenas: CatorcenaRef[],
  ids?: number[] | null
): Promise<CeldaConflicto[]> {
  if (catorcenas.length === 0) return [];
  if (ids && ids.length === 0) return [];

  const rango = await rangoFechasDeCatorcenas(catorcenas);
  if (!rango) return [];

  const phCat = catorcenas.map(() => '(?,?)').join(',');
  const filtroIds = ids ? `AND ei.inventario_id IN (${ids.map(() => '?').join(',')})` : '';
  const params: unknown[] = [
    rango.inicio,
    rango.fin,
    ...catorcenas.flatMap(c => [c.anio, c.numero]),
    ...(ids ?? []),
  ];

  // FASE 1 — celdas con 2+ reservas.
  // `tradicional_digital` puede venir NULL y el frontend trata esos sitios como
  // Tradicional. Un `<> 'Digital'` a secas evalúa NULL y los descartaría.
  const celdas = await prisma.$queryRawUnsafe<Array<{
    inventario_id: number;
    codigo_unico: string | null;
    plaza: string | null;
    mueble: string | null;
    ubicacion: string | null;
    tradicional_digital: string | null;
    anio: number;
    numero_catorcena: number;
    n: bigint | number;
  }>>(
    `SELECT
       ei.inventario_id, i.codigo_unico, i.plaza, i.mueble, i.ubicacion,
       i.tradicional_digital, cat.año AS anio, cat.numero_catorcena,
       COUNT(DISTINCT rsv.id) AS n
     FROM espacio_inventario ei
       INNER JOIN reservas rsv      ON ei.id = rsv.inventario_id
       INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
       INNER JOIN catorcenas cat    ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
       INNER JOIN inventarios i     ON i.id = ei.inventario_id
     WHERE rsv.deleted_at IS NULL
       AND rsv.estatus <> 'eliminada'
       AND (i.tradicional_digital IS NULL OR i.tradicional_digital <> 'Digital')
       AND sc.inicio_periodo BETWEEN ? AND ?
       AND (cat.año, cat.numero_catorcena) IN (${phCat})
       ${filtroIds}
     GROUP BY ei.inventario_id, i.codigo_unico, i.plaza, i.mueble, i.ubicacion,
              i.tradicional_digital, cat.año, cat.numero_catorcena
     HAVING COUNT(DISTINCT rsv.id) >= 2
     ORDER BY i.codigo_unico, cat.año, cat.numero_catorcena`,
    ...params
  );

  if (celdas.length === 0) return [];

  // FASE 2 — orígenes distintos por celda, acotado a los sitios ya detectados.
  // Una reserva sin campaña pertenece a una propuesta: se cuenta por idquote.
  const idsConflicto = [...new Set(celdas.map(c => c.inventario_id))];
  const phConf = idsConflicto.map(() => '?').join(',');
  const origenes = await prisma.$queryRawUnsafe<Array<{
    inventario_id: number;
    anio: number;
    numero_catorcena: number;
    origenes: bigint | number;
    campanas_raw: string | null;
    propuestas_raw: string | null;
  }>>(
    `SELECT
       ei.inventario_id, cat.año AS anio, cat.numero_catorcena,
       COUNT(DISTINCT cm.id)
         + COUNT(DISTINCT CASE WHEN cm.id IS NULL THEN sc.idquote END) AS origenes,
       -- Quien ocupa la celda, para que la UI pueda enlazar a la campaña o
       -- propuesta sin otra vuelta al servidor. Separador '||' porque los
       -- nombres de campaña pueden traer comas; el id va antes del primer ':'.
       GROUP_CONCAT(DISTINCT CASE WHEN cm.id IS NOT NULL
         THEN CONCAT(cm.id, ':', cm.nombre) END SEPARATOR '||') AS campanas_raw,
       GROUP_CONCAT(DISTINCT CASE WHEN cm.id IS NULL
         THEN sc.idquote END SEPARATOR '||') AS propuestas_raw
     FROM espacio_inventario ei
       INNER JOIN reservas rsv      ON ei.id = rsv.inventario_id
       INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
       INNER JOIN catorcenas cat    ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
       LEFT JOIN cotizacion ct ON sc.idquote = CAST(ct.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
       LEFT JOIN campania cm ON cm.cotizacion_id = ct.id
     WHERE rsv.deleted_at IS NULL
       AND rsv.estatus <> 'eliminada'
       AND ei.inventario_id IN (${phConf})
       AND sc.inicio_periodo BETWEEN ? AND ?
       AND (cat.año, cat.numero_catorcena) IN (${phCat})
     GROUP BY ei.inventario_id, cat.año, cat.numero_catorcena`,
    ...idsConflicto,
    rango.inicio,
    rango.fin,
    ...catorcenas.flatMap(c => [c.anio, c.numero])
  );

  const clave = (r: { inventario_id: number; anio: number; numero_catorcena: number }) =>
    `${r.inventario_id}|${r.anio}|${r.numero_catorcena}`;
  const porCelda = new Map(origenes.map(o => [clave(o), {
    origenes: Number(o.origenes),
    // 'id:nombre||id:nombre' → [{id, nombre}]. Solo el primer ':' separa, por
    // si el nombre de la campaña trae dos puntos.
    campanas: (o.campanas_raw || '')
      .split('||')
      .filter(Boolean)
      .map(s => {
        const i = s.indexOf(':');
        return { id: Number(s.slice(0, i)), nombre: s.slice(i + 1) };
      })
      .filter(c => Number.isInteger(c.id)),
    propuestas: (o.propuestas_raw || '')
      .split('||')
      .filter(Boolean) // sin esto, '' -> Number('') = 0 y salia "Propuesta #0"
      .map(Number)
      .filter(n2 => Number.isInteger(n2) && n2 > 0),
  }]));

  return celdas.map(c => {
    const extra = porCelda.get(clave(c));
    return {
      ...c,
      n: Number(c.n),
      // Si la fase 2 no trajo la celda, es una sola campaña: no inventamos choque.
      origenes: extra?.origenes ?? 1,
      campanas: extra?.campanas ?? [],
      propuestas: extra?.propuestas ?? [],
    };
  });
}

export interface ActorLimpieza {
  /** 'Automático' para el monitor; nombre del usuario para el botón. */
  nombre: string;
  usuarioId?: number;
  rol?: string;
  origen: string;
}

export interface ResultadoLimpieza {
  celdas_limpiadas: number;
  reservas_liberadas: number;
  omitidas: { inventario_id: number; anio: number; numero_catorcena: number; motivo: string }[];
  detalle: {
    inventario_id: number;
    codigo_unico: string | null;
    anio: number;
    numero_catorcena: number;
    conservada: number;
    liberadas: number[];
  }[];
}

/**
 * Limpia celdas DUPLICADAS: conserva una reserva por celda y soft-deletea las
 * sobrantes. La usan el botón de la auditoría y el monitor (auto-limpieza), así
 * que las reglas viven en un solo lugar:
 *  - re-verifica cada celda contra la BD (nunca confía en la lista recibida);
 *  - los choques jamás entran (se filtran aquí aunque el caller los mande);
 *  - nunca borra una reserva con APS; con 2+ APS omite la celda entera;
 *  - conserva la que tiene APS o, si ninguna tiene, la más antigua;
 *  - borrado suave + historial + registro en conflictos_ocupacion (bitácora
 *    consultable de qué se limpió, cuándo y por quién).
 */
export async function limpiarCeldasDuplicadas(
  celdas: CeldaConflicto[],
  actor: ActorLimpieza
): Promise<ResultadoLimpieza> {
  const ahora = new Date();
  const resultado: ResultadoLimpieza = {
    celdas_limpiadas: 0,
    reservas_liberadas: 0,
    omitidas: [],
    detalle: [],
  };

  for (const celda of celdas.filter(c => !esChoque(c))) {
    const reservas = await prisma.$queryRawUnsafe<Array<{ id: number; APS: number | null }>>(
      `SELECT rsv.id, rsv.APS
         FROM espacio_inventario ei
         INNER JOIN reservas rsv      ON ei.id = rsv.inventario_id
         INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
         INNER JOIN catorcenas cat    ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
        WHERE ei.inventario_id = ?
          AND rsv.deleted_at IS NULL
          AND rsv.estatus <> 'eliminada'
          AND cat.año = ? AND cat.numero_catorcena = ?
        ORDER BY rsv.id`,
      celda.inventario_id, celda.anio, celda.numero_catorcena
    );

    if (reservas.length < 2) {
      resultado.omitidas.push({
        inventario_id: celda.inventario_id, anio: celda.anio,
        numero_catorcena: celda.numero_catorcena, motivo: 'Ya no hay reservas duplicadas',
      });
      continue;
    }

    const conAps = reservas.filter(r => r.APS != null && r.APS > 0);
    if (conAps.length > 1) {
      resultado.omitidas.push({
        inventario_id: celda.inventario_id, anio: celda.anio,
        numero_catorcena: celda.numero_catorcena,
        motivo: `${conAps.length} reservas con APS: requiere revisión manual con SAP`,
      });
      continue;
    }

    // Conservar: la que tiene APS si existe; si no, la más antigua.
    const conservada = conAps.length === 1 ? conAps[0] : reservas[0];
    const aLiberar = reservas.filter(r => r.id !== conservada.id && !(r.APS != null && r.APS > 0));
    if (aLiberar.length === 0) {
      resultado.omitidas.push({
        inventario_id: celda.inventario_id, anio: celda.anio,
        numero_catorcena: celda.numero_catorcena, motivo: 'Todas las sobrantes tienen APS',
      });
      continue;
    }

    await prisma.reservas.updateMany({
      where: { id: { in: aLiberar.map(r => r.id) } },
      data: { deleted_at: ahora },
    });

    await logHistorial({
      tipo: 'Inventario',
      refId: celda.inventario_id,
      accion: 'Limpieza de reservas duplicadas',
      usuario: actor.nombre,
      usuarioId: actor.usuarioId,
      usuarioRol: actor.rol,
      origen: actor.origen,
      extras: {
        catorcena: `C${celda.numero_catorcena}-${celda.anio}`,
        codigo_unico: celda.codigo_unico,
        reserva_conservada: conservada.id,
        reservas_liberadas: aLiberar.map(r => r.id),
      },
    });

    // Bitácora en la tabla de estado. Upsert porque el botón puede limpiar
    // celdas que el monitor aún no había registrado. Limpiar implica resuelto.
    await prisma.conflictos_ocupacion.upsert({
      where: {
        inventario_id_anio_numero_catorcena: {
          inventario_id: celda.inventario_id,
          anio: celda.anio,
          numero_catorcena: celda.numero_catorcena,
        },
      },
      create: {
        inventario_id: celda.inventario_id,
        anio: celda.anio,
        numero_catorcena: celda.numero_catorcena,
        tipo: 'duplicado',
        reservas: celda.n,
        origenes: celda.origenes,
        detectado_at: ahora,
        visto_at: ahora,
        resuelto_at: ahora,
        limpiado_at: ahora,
        limpiado_por: actor.nombre,
        reserva_conservada: conservada.id,
        reservas_liberadas: aLiberar.map(r => r.id).join(','),
      },
      update: {
        resuelto_at: ahora,
        limpiado_at: ahora,
        limpiado_por: actor.nombre,
        reserva_conservada: conservada.id,
        reservas_liberadas: aLiberar.map(r => r.id).join(','),
      },
    });

    resultado.celdas_limpiadas += 1;
    resultado.reservas_liberadas += aLiberar.length;
    resultado.detalle.push({
      inventario_id: celda.inventario_id,
      codigo_unico: celda.codigo_unico,
      anio: celda.anio,
      numero_catorcena: celda.numero_catorcena,
      conservada: conservada.id,
      liberadas: aLiberar.map(r => r.id),
    });
  }

  return resultado;
}

export interface ReporteMonitor {
  catorcenas: CatorcenaRef[];
  detectados: number;
  nuevos: number;
  nuevosChoque: number;
  nuevosDuplicado: number;
  resueltos: number;
  notificados: number;
  /** Auto-limpieza de duplicados nuevos (null si no corrió). */
  limpieza: ResultadoLimpieza | null;
}

/**
 * Corrida del monitor: detecta sobre las catorcenas vigentes, sincroniza contra
 * `conflictos_ocupacion` y notifica UNA sola vez lo que sea nuevo.
 *
 * El digest es deliberado: una notificación por celda enterraría la campanita
 * (el primer barrido puede traer decenas de golpe).
 */
export async function ejecutarMonitorConflictos(
  opts: { catorcenas?: CatorcenaRef[]; notificar?: boolean; ids?: number[]; autoLimpiar?: boolean } = {}
): Promise<ReporteMonitor> {
  const notificar = opts.notificar !== false;
  const catorcenas = opts.catorcenas ?? (await catorcenasVigentes());
  const vacio: ReporteMonitor = {
    catorcenas, detectados: 0, nuevos: 0, nuevosChoque: 0,
    nuevosDuplicado: 0, resueltos: 0, notificados: 0, limpieza: null,
  };
  if (catorcenas.length === 0) return vacio;

  const detectados = await detectarConflictos(catorcenas, opts.ids ?? null);
  const ahora = new Date();
  const claveDe = (c: { inventario_id: number; anio: number; numero_catorcena: number }) =>
    `${c.inventario_id}|${c.anio}|${c.numero_catorcena}`;
  const vistasAhora = new Set(detectados.map(claveDe));

  // Estado previo, acotado a las catorcenas auditadas: lo de otros periodos no
  // se toca porque esta corrida no lo miró y no puede afirmar que se resolvió.
  const previas = await prisma.conflictos_ocupacion.findMany({
    where: {
      OR: catorcenas.map(c => ({ anio: c.anio, numero_catorcena: c.numero })),
      // Corrida acotada por ids (gancho de reservas): solo puede resolver lo
      // que efectivamente miro. Sin esto marcaria "resuelto" todo lo demas.
      ...(opts.ids ? { inventario_id: { in: opts.ids } } : {}),
    },
  });
  const previasPorClave = new Map(previas.map(p => [claveDe(p), p]));

  const nuevos: CeldaConflicto[] = [];

  for (const celda of detectados) {
    const tipo = esChoque(celda) ? 'choque' : 'duplicado';
    const previa = previasPorClave.get(claveDe(celda));

    if (!previa) {
      await prisma.conflictos_ocupacion.create({
        data: {
          inventario_id: celda.inventario_id,
          anio: celda.anio,
          numero_catorcena: celda.numero_catorcena,
          tipo,
          reservas: celda.n,
          origenes: celda.origenes,
          detectado_at: ahora,
          visto_at: ahora,
        },
      });
      nuevos.push(celda);
      continue;
    }

    // Reapareció después de haberse resuelto, o cambió de duplicado a choque:
    // en ambos casos amerita un aviso nuevo.
    const reabre = previa.resuelto_at !== null;
    const cambioTipo = previa.tipo !== tipo;
    await prisma.conflictos_ocupacion.update({
      where: { id: previa.id },
      data: {
        tipo,
        reservas: celda.n,
        origenes: celda.origenes,
        visto_at: ahora,
        resuelto_at: null,
        ...(reabre ? { detectado_at: ahora, notificado_at: null } : {}),
      },
    });
    if (reabre || cambioTipo || previa.notificado_at === null) nuevos.push(celda);
  }

  // Lo que el estado tenía vivo y esta corrida ya no encontró: resuelto.
  const aResolver = previas.filter(p => p.resuelto_at === null && !vistasAhora.has(claveDe(p)));
  if (aResolver.length > 0) {
    await prisma.conflictos_ocupacion.updateMany({
      where: { id: { in: aResolver.map(p => p.id) } },
      data: { resuelto_at: ahora },
    });
  }

  const choquesNuevos = nuevos.filter(esChoque);
  const duplicadosNuevos = nuevos.filter(c => !esChoque(c));
  const nuevosChoque = choquesNuevos.length;
  const nuevosDuplicado = duplicadosNuevos.length;
  let notificados = 0;
  let limpieza: ResultadoLimpieza | null = null;

  // Auto-limpieza de duplicados NUEVOS. Solo en corridas que notifican: la
  // siembra silenciosa del arranque no limpia nada — el primer barrido real
  // limpia el backlog Y lo avisa, para que siempre quede constancia.
  const autoLimpiar = (opts.autoLimpiar ?? true) && notificar;
  if (autoLimpiar && duplicadosNuevos.length > 0) {
    limpieza = await limpiarCeldasDuplicadas(duplicadosNuevos, {
      nombre: 'Automático',
      origen: 'Monitor de conflictos',
    });
  }

  if (notificar && nuevos.length > 0) {
    notificados = await notificarConflictos(choquesNuevos, duplicadosNuevos, limpieza, catorcenas);
    await prisma.conflictos_ocupacion.updateMany({
      where: {
        OR: nuevos.map(c => ({
          inventario_id: c.inventario_id,
          anio: c.anio,
          numero_catorcena: c.numero_catorcena,
        })),
      },
      data: { notificado_at: ahora },
    });
  }

  return {
    catorcenas,
    detectados: detectados.length,
    nuevos: nuevos.length,
    nuevosChoque,
    nuevosDuplicado,
    resueltos: aResolver.length,
    notificados,
    limpieza,
  };
}

/**
 * Digest de la corrida: una notificación (fila en `tareas`) por destinatario.
 * El middleware de Prisma sobre `tareas.create` emite el popup por socket.
 *
 * El título SIEMPRE contiene "Conflictos de ocupación": el frontend detecta
 * esta notificación por esa frase (isConflictoOcupacionNotification) para
 * pintar el botón que abre la auditoría.
 */
async function notificarConflictos(
  choques: CeldaConflicto[],
  duplicados: CeldaConflicto[],
  limpieza: ResultadoLimpieza | null,
  catorcenas: CatorcenaRef[]
): Promise<number> {
  const destinatarios = await prisma.usuario.findMany({
    where: { user_role: { in: ROLES_NOTIFICAR_CONFLICTOS }, deleted_at: null },
    select: { id: true },
  });
  if (destinatarios.length === 0) return 0;

  const plural = (n: number, singular: string, plural_: string) => (n === 1 ? singular : plural_);

  const ordenadas = [...catorcenas].sort((a, b) => a.anio - b.anio || a.numero - b.numero);
  const primera = ordenadas[0];
  const ultima = ordenadas[ordenadas.length - 1];
  const periodo = ordenadas.length === 1
    ? `C${primera.numero}-${primera.anio}`
    : `C${primera.numero}-${primera.anio} a C${ultima.numero}-${ultima.anio}`;

  const limpiadas = limpieza?.celdas_limpiadas ?? 0;
  const liberadas = limpieza?.reservas_liberadas ?? 0;
  const omitidas = limpieza?.omitidas ?? [];
  // Sin auto-limpieza (p.ej. desactivada): los duplicados quedan pendientes.
  const dupsPendientes = limpieza ? omitidas.length : duplicados.length;

  const secciones: string[] = [];
  if (limpiadas > 0) {
    const lineas = (limpieza?.detalle ?? []).slice(0, 5).map(d =>
      `• ${d.codigo_unico || `#${d.inventario_id}`} · C${d.numero_catorcena}-${d.anio} — se conservó la reserva #${d.conservada}, ${plural(d.liberadas.length, 'liberada la', 'liberadas las')} #${d.liberadas.join(', #')}`
    );
    const resto = (limpieza?.detalle.length ?? 0) > 5 ? `\n… y ${limpieza!.detalle.length - 5} más.` : '';
    secciones.push(
      `LIMPIEZA AUTOMÁTICA: se ${plural(limpiadas, 'limpió', 'limpiaron')} ${limpiadas} ${plural(limpiadas, 'duplicado', 'duplicados')} ` +
      `(${liberadas} ${plural(liberadas, 'reserva liberada', 'reservas liberadas')}). El registro completo está en la auditoría.\n` +
      lineas.join('\n') + resto
    );
  }
  if (omitidas.length > 0) {
    const lineas = omitidas.slice(0, 5).map(o =>
      `• #${o.inventario_id} · C${o.numero_catorcena}-${o.anio} — ${o.motivo}`
    );
    const resto = omitidas.length > 5 ? `\n… y ${omitidas.length - 5} más.` : '';
    secciones.push(
      `NO SE PUDIERON LIMPIAR ${omitidas.length} ${plural(omitidas.length, 'duplicado', 'duplicados')} — revisar manualmente en la auditoría:\n` +
      lineas.join('\n') + resto
    );
  } else if (!limpieza && duplicados.length > 0) {
    secciones.push(
      `${duplicados.length} ${plural(duplicados.length, 'duplicado', 'duplicados')} pendientes de limpieza en la auditoría.`
    );
  }
  if (choques.length > 0) {
    const lineas = choques.slice(0, 5).map(c =>
      `• ${c.codigo_unico || `#${c.inventario_id}`} · C${c.numero_catorcena}-${c.anio}` +
      (c.campanas.length > 0 ? ` — ${c.campanas.map(x => x.nombre).join(' vs ')}` : '')
    );
    const resto = choques.length > 5 ? `\n… y ${choques.length - 5} más.` : '';
    secciones.push(
      `${choques.length} ${plural(choques.length, 'CHOQUE', 'CHOQUES')} de campañas — ${plural(choques.length, 'requiere', 'requieren')} decisión manual (nunca se limpian solos):\n` +
      lineas.join('\n') + resto
    );
  }

  // Resumen corto para el título, priorizando lo más accionable.
  const resumen: string[] = [];
  if (limpiadas > 0) resumen.push(`${limpiadas} ${plural(limpiadas, 'duplicado limpiado', 'duplicados limpiados')} automáticamente`);
  if (dupsPendientes > 0) resumen.push(`${dupsPendientes} ${plural(dupsPendientes, 'duplicado requiere', 'duplicados requieren')} revisión`);
  if (choques.length > 0) resumen.push(`${choques.length} ${plural(choques.length, 'choque', 'choques')}`);

  const titulo = `Conflictos de ocupación (${periodo}): ${resumen.join(', ')}`;
  const descripcion =
    `${secciones.join('\n\n')}\n\n` +
    `Abre "Ver Auditoría de Conflictos" para el detalle y el registro de limpiezas.`;

  const ahora = new Date();
  const fechaFin = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);

  for (const u of destinatarios) {
    await prisma.tareas.create({
      data: {
        titulo,
        descripcion,
        tipo: 'Notificación',
        categoria: 'conflicto_ocupacion',
        estatus: 'Pendiente',
        id_responsable: u.id,
        responsable: '',
        id_solicitud: '',
        fecha_inicio: ahora,
        fecha_fin: fechaFin,
        asignado: 'Sistema',
        id_asignado: '',
      },
    });
  }

  return destinatarios.length;
}
