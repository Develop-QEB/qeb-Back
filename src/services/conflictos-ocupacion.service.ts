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
  }>>(
    `SELECT
       ei.inventario_id, cat.año AS anio, cat.numero_catorcena,
       COUNT(DISTINCT cm.id)
         + COUNT(DISTINCT CASE WHEN cm.id IS NULL THEN sc.idquote END) AS origenes
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
  const porCelda = new Map(origenes.map(o => [clave(o), Number(o.origenes)]));

  return celdas.map(c => ({
    ...c,
    n: Number(c.n),
    // Si la fase 2 no trajo la celda, es una sola campaña: no inventamos choque.
    origenes: porCelda.get(clave(c)) ?? 1,
  }));
}

export interface ReporteMonitor {
  catorcenas: CatorcenaRef[];
  detectados: number;
  nuevos: number;
  nuevosChoque: number;
  nuevosDuplicado: number;
  resueltos: number;
  notificados: number;
}

/**
 * Corrida del monitor: detecta sobre las catorcenas vigentes, sincroniza contra
 * `conflictos_ocupacion` y notifica UNA sola vez lo que sea nuevo.
 *
 * El digest es deliberado: una notificación por celda enterraría la campanita
 * (el primer barrido puede traer decenas de golpe).
 */
export async function ejecutarMonitorConflictos(
  opts: { catorcenas?: CatorcenaRef[]; notificar?: boolean } = {}
): Promise<ReporteMonitor> {
  const notificar = opts.notificar !== false;
  const catorcenas = opts.catorcenas ?? (await catorcenasVigentes());
  const vacio: ReporteMonitor = {
    catorcenas, detectados: 0, nuevos: 0, nuevosChoque: 0,
    nuevosDuplicado: 0, resueltos: 0, notificados: 0,
  };
  if (catorcenas.length === 0) return vacio;

  const detectados = await detectarConflictos(catorcenas);
  const ahora = new Date();
  const claveDe = (c: { inventario_id: number; anio: number; numero_catorcena: number }) =>
    `${c.inventario_id}|${c.anio}|${c.numero_catorcena}`;
  const vistasAhora = new Set(detectados.map(claveDe));

  // Estado previo, acotado a las catorcenas auditadas: lo de otros periodos no
  // se toca porque esta corrida no lo miró y no puede afirmar que se resolvió.
  const previas = await prisma.conflictos_ocupacion.findMany({
    where: { OR: catorcenas.map(c => ({ anio: c.anio, numero_catorcena: c.numero })) },
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

  const nuevosChoque = nuevos.filter(esChoque).length;
  const nuevosDuplicado = nuevos.length - nuevosChoque;
  let notificados = 0;

  if (notificar && nuevos.length > 0) {
    notificados = await notificarConflictos(nuevos, catorcenas);
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
  };
}

/**
 * Una notificación (fila en `tareas` con tipo='Notificación') por destinatario,
 * con el resumen. El middleware de Prisma sobre `tareas.create` se encarga del
 * popup por socket, así que aquí solo se insertan las filas.
 */
async function notificarConflictos(
  nuevos: CeldaConflicto[],
  catorcenas: CatorcenaRef[]
): Promise<number> {
  const destinatarios = await prisma.usuario.findMany({
    where: { user_role: { in: ROLES_NOTIFICAR_CONFLICTOS }, deleted_at: null },
    select: { id: true },
  });
  if (destinatarios.length === 0) return 0;

  const choques = nuevos.filter(esChoque);
  const duplicados = nuevos.filter(c => !esChoque(c));

  const plural = (n: number, singular: string, plural_: string) => (n === 1 ? singular : plural_);

  const partes: string[] = [];
  if (choques.length > 0) {
    partes.push(
      `${choques.length} ${plural(choques.length, 'choque', 'choques')} de campañas — ` +
      `${plural(choques.length, 'requiere', 'requieren')} liberar una reserva a mano`
    );
  }
  if (duplicados.length > 0) {
    partes.push(
      `${duplicados.length} ${plural(duplicados.length, 'duplicado', 'duplicados')} de una misma campaña — ` +
      `se ${plural(duplicados.length, 'puede', 'pueden')} limpiar con un clic desde la auditoría`
    );
  }

  const ordenadas = [...catorcenas].sort((a, b) => a.anio - b.anio || a.numero - b.numero);
  const primera = ordenadas[0];
  const ultima = ordenadas[ordenadas.length - 1];
  const periodo = ordenadas.length === 1
    ? `C${primera.numero}-${primera.anio}`
    : `C${primera.numero}-${primera.anio} a C${ultima.numero}-${ultima.anio}`;

  const muestra = nuevos
    .slice(0, 5)
    .map(c => `• ${c.codigo_unico || `#${c.inventario_id}`} · C${c.numero_catorcena}-${c.anio} · ${esChoque(c) ? 'choque' : 'duplicado'}`)
    .join('\n');
  const resto = nuevos.length > 5 ? `\n… y ${nuevos.length - 5} más.` : '';

  // El titulo debe contener "conflicto(s) de ocupación" en texto plano: el
  // frontend detecta esta notificación por ahí (isConflictoOcupacionNotification)
  // para pintar el botón que abre la auditoría. Nada de "conflicto(s)" con
  // paréntesis literales, que rompería el match.
  const titulo =
    `${nuevos.length} ${plural(nuevos.length, 'conflicto', 'conflictos')} de ocupación ` +
    `${plural(nuevos.length, 'nuevo', 'nuevos')} (${periodo})`;
  const descripcion =
    `${partes.join('. ')}.\n\n${muestra}${resto}\n\n` +
    `Abre "Ver Auditoría de Conflictos" para revisarlos con estos periodos ya cargados.`;

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
