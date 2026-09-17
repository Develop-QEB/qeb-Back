// Inventario reservado de una propuesta para la Vista Compartir (interna,
// publica y KML). Antes el mismo SQL vivia copiado en tres endpoints; ahora hay
// una sola fuente y encima se aplica el versionado de circuitos completados:
//
//   - Circuito CON version completada -> se muestran las piezas de su ULTIMA
//     version. Las que siguen reservadas salen 'vigente'; las que se
//     desplazaron (multireservas) o se quitaron a mano salen 'no_vigente' (gris).
//     Piezas agregadas DESPUES de esa version no se muestran hasta que el
//     circuito vuelva a completarse (y genere version nueva).
//   - Circuito SIN version (nunca ha estado completo) -> se muestra lo que hay
//     reservado hoy, como siempre ('sin_version').
import prisma from '../utils/prisma';
import { tablasCompletadoDisponibles } from './circuito-completado.service';
import { getReservasDePropuesta, OrigenReserva } from './pase-ventas.service';

export type EstadoVersion = 'vigente' | 'no_vigente' | 'sin_version';

export interface FilaInventarioPropuesta {
  rsv_ids: string;
  id: number;
  codigo_unico: string | null;
  solicitud_caras_id: number | null;
  mueble: string | null;
  estado: string | null;
  municipio: string | null;
  ubicacion: string | null;
  tipo_de_cara: string | null;
  caras_totales: number;
  caras_bonificadas: number;
  caras_renta: number;
  latitud: number | null;
  longitud: number | null;
  plaza: string | null;
  estatus_reserva: string | null;
  articulo: string | null;
  tipo_medio: string | null;
  inicio_periodo: Date | string | null;
  fin_periodo: Date | string | null;
  tradicional_digital: string | null;
  tipo_de_mueble: string | null;
  ancho: number | null;
  alto: number | null;
  nivel_socioeconomico: string | null;
  tarifa_publica: number | null;
  tarifa_bruta_sc: number | null;
  grupo_completo_id: number | null;
  numero_catorcena: number | null;
  anio_catorcena: number | null;
  formato: string | null;
  // Versionado
  estado_version: EstadoVersion;
  version_completado: number | null;
  fecha_completado: Date | null;
  motivo_no_vigente: string | null;
  // Origen (solo campañas): 'propuesta' = cruzo en el pase a ventas,
  // 'campana' = se agrego despues dentro de la campaña, null = sin foto de
  // pase a ventas (no se puede saber) -> el front no colorea.
  origen_reserva: OrigenReserva | null;
}

// Una fila por reserva (o grupo completo legado) y catorcena.
const SQL_INVENTARIO_ACTUAL = `
  SELECT
    GROUP_CONCAT(DISTINCT rsv.id ORDER BY rsv.id SEPARATOR ',') as rsv_ids,
    MIN(i.id) as id,
    CASE
      WHEN rsv.grupo_completo_id IS NOT NULL
      THEN CONCAT(SUBSTRING_INDEX(MIN(i.codigo_unico), '_', 1), '_completo_', SUBSTRING_INDEX(MIN(i.codigo_unico), '_', -1))
      ELSE MIN(i.codigo_unico)
    END as codigo_unico,
    MAX(sc.id) AS solicitud_caras_id,
    MIN(i.mueble) as mueble,
    MIN(i.estado) as estado,
    MIN(i.municipio) as municipio,
    MIN(i.ubicacion) as ubicacion,
    CASE
      WHEN rsv.grupo_completo_id IS NOT NULL THEN 'Completo'
      ELSE MIN(i.tipo_de_cara)
    END as tipo_de_cara,
    CAST(COUNT(DISTINCT rsv.id) AS UNSIGNED) AS caras_totales,
    CAST(SUM(CASE WHEN rsv.estatus IN ('Bonificado', 'Vendido bonificado') OR sc.articulo LIKE 'BF%' OR sc.articulo LIKE 'CF%' THEN 1 ELSE 0 END) AS UNSIGNED) AS caras_bonificadas,
    CAST(SUM(CASE WHEN rsv.estatus NOT IN ('Bonificado', 'Vendido bonificado') AND sc.articulo NOT LIKE 'BF%' AND sc.articulo NOT LIKE 'CF%' THEN 1 ELSE 0 END) AS UNSIGNED) AS caras_renta,
    MIN(i.latitud) as latitud,
    MIN(i.longitud) as longitud,
    MIN(i.plaza) as plaza,
    MAX(rsv.estatus) as estatus_reserva,
    MAX(sc.articulo) as articulo,
    MAX(sc.tipo) as tipo_medio,
    MAX(sc.inicio_periodo) as inicio_periodo,
    MAX(sc.fin_periodo) as fin_periodo,
    MIN(i.tradicional_digital) as tradicional_digital,
    MIN(i.mueble) as tipo_de_mueble,
    MIN(i.ancho) as ancho,
    MIN(i.alto) as alto,
    MIN(i.nivel_socioeconomico) as nivel_socioeconomico,
    COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) as tarifa_publica,
    COALESCE(MAX(sc.costo / NULLIF(sc.caras, 0)), 0) as tarifa_bruta_sc,
    COALESCE(rsv.grupo_completo_id, rsv.id) as grupo_completo_id,
    cat.numero_catorcena,
    cat.año as anio_catorcena,
    MAX(sc.formato) as formato
  FROM inventarios i
    INNER JOIN espacio_inventario epIn ON i.id = epIn.inventario_id
    INNER JOIN reservas rsv ON epIn.id = rsv.inventario_id AND rsv.deleted_at IS NULL
    INNER JOIN solicitudCaras sc ON sc.id = rsv.solicitudCaras_id
    LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
  WHERE sc.idquote = ?
  GROUP BY COALESCE(rsv.grupo_completo_id, rsv.id), cat.numero_catorcena, cat.año
  ORDER BY cat.año DESC, cat.numero_catorcena DESC, MIN(rsv.id) DESC
`;

// Piezas de una version que ya NO estan reservadas para ese circuito: se
// reconstruyen desde la foto + inventarios (no dependen de que la reserva siga
// viva ni de que conserve su solicitudCaras_id).
const SQL_NO_VIGENTES = (phReservas: string, phVersiones: string) => `
  SELECT
    ccr.reserva_id, ccr.completado_id, ccr.estatus AS estatus_reserva,
    cc.solicitud_caras_id, cc.version, cc.fecha_completado,
    i.id AS id, i.codigo_unico, i.mueble, i.estado, i.municipio, i.ubicacion, i.tipo_de_cara,
    i.latitud, i.longitud, i.plaza, i.tradicional_digital, i.ancho, i.alto, i.nivel_socioeconomico,
    i.tarifa_publica AS inv_tarifa,
    sc.articulo, sc.tipo AS tipo_medio, sc.inicio_periodo, sc.fin_periodo, sc.formato,
    sc.tarifa_publica AS sc_tarifa, sc.costo, sc.caras,
    cat.numero_catorcena, cat.año AS anio_catorcena,
    r.id AS reserva_viva_id, r.deleted_at AS reserva_deleted_at, r.solicitudCaras_id AS reserva_sc_actual
  FROM circuito_completado_reserva ccr
    INNER JOIN circuito_completado cc ON cc.id = ccr.completado_id
    INNER JOIN solicitudCaras sc ON sc.id = cc.solicitud_caras_id
    LEFT JOIN inventarios i ON i.id = ccr.inventario_id
    LEFT JOIN reservas r ON r.id = ccr.reserva_id
    LEFT JOIN catorcenas cat ON sc.inicio_periodo BETWEEN cat.fecha_inicio AND cat.fecha_fin
  WHERE ccr.reserva_id IN (${phReservas}) AND ccr.completado_id IN (${phVersiones})
`;

interface VersionRow { id: number; solicitud_caras_id: number; version: number; fecha_completado: Date }
interface DetalleRow { completado_id: number; reserva_id: number }

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function esBonificada(estatus: string | null, articulo: string | null): boolean {
  if (estatus === 'Bonificado' || estatus === 'Vendido bonificado') return true;
  const a = (articulo || '').toUpperCase();
  return a.startsWith('BF') || a.startsWith('CF');
}

/** Inventario reservado HOY (sin versionado). Misma forma que siempre. */
export async function getInventarioActualPropuesta(propuestaId: number): Promise<FilaInventarioPropuesta[]> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(SQL_INVENTARIO_ACTUAL, String(propuestaId));
  return rows.map(r => ({
    ...(r as unknown as FilaInventarioPropuesta),
    caras_totales: num(r.caras_totales),
    caras_bonificadas: num(r.caras_bonificadas),
    caras_renta: num(r.caras_renta),
    estado_version: 'sin_version' as EstadoVersion,
    version_completado: null,
    fecha_completado: null,
    motivo_no_vigente: null,
    origen_reserva: null,
  }));
}

/**
 * Clasificador de origen. `origenIds` = reservas que cruzaron en el pase a
 * ventas; `null` significa que esta propuesta no tiene foto y NO se clasifica.
 * Una fila puede agrupar varias reservas (muebles completos legado): basta que
 * una venga de la propuesta para considerarla de propuesta.
 */
function clasificadorOrigen(origenIds: Set<number> | null) {
  return (rsvIds: string | number | null | undefined): OrigenReserva | null => {
    if (!origenIds) return null;
    const ids = String(rsvIds ?? '').split(',').map(Number).filter(n => n > 0);
    if (ids.length === 0) return null;
    return ids.some(id => origenIds.has(id)) ? 'propuesta' : 'campana';
  };
}

/**
 * Inventario para la Vista Compartir: ultima version completada de cada
 * circuito (con 'no_vigente' en gris) + lo actual de los circuitos sin version.
 */
export async function getInventarioPropuestaConVersion(propuestaId: number): Promise<FilaInventarioPropuesta[]> {
  // Las tres lecturas son independientes: van en paralelo para no encadenar
  // round-trips contra una BD remota (cada uno cuesta ~85 ms).
  // Ultima version por circuito: el INNER JOIN a solicitudCaras descarta
  // versiones de circuitos que ya se eliminaron de la propuesta.
  const [actuales, origenIds, versiones, yaEsCampania] = await Promise.all([
    getInventarioActualPropuesta(propuestaId),
    getReservasDePropuesta(propuestaId),
    (async (): Promise<VersionRow[]> => {
      if (!(await tablasCompletadoDisponibles())) return [];
      return prisma.$queryRawUnsafe<VersionRow[]>(
        `SELECT cc.id, cc.solicitud_caras_id, cc.version, cc.fecha_completado
           FROM circuito_completado cc
           INNER JOIN (
             SELECT solicitud_caras_id, MAX(version) AS v
               FROM circuito_completado WHERE idquote = ? GROUP BY solicitud_caras_id
           ) m ON m.solicitud_caras_id = cc.solicitud_caras_id AND m.v = cc.version
           INNER JOIN solicitudCaras sc ON sc.id = cc.solicitud_caras_id`,
        String(propuestaId),
      );
    })(),
    // ¿Ya hubo pase a ventas? Mismo criterio que los guards del desalojo: la
    // sola existencia de la fila en campania NO sirve (se crea junto con la
    // cotización, así que la tienen todas desde que nacen).
    (async (): Promise<boolean> => {
      const rows = await prisma.$queryRawUnsafe<{ c: bigint | number }[]>(
        `SELECT COUNT(*) c FROM campania cam
           INNER JOIN cotizacion cot ON cot.id = cam.cotizacion_id
           INNER JOIN propuesta p ON p.id = cot.id_propuesta
          WHERE cot.id_propuesta = ?
            AND (cam.fecha_aprobacion IS NOT NULL OR p.status IN ('Aprobada', 'Pase a ventas'))`,
        propuestaId,
      );
      return Number(rows[0]?.c ?? 0) > 0;
    })(),
  ]);

  // Origen (pase a ventas) es independiente del versionado: se aplica aunque
  // las tablas de circuito_completado no existan.
  const origenDe = clasificadorOrigen(origenIds);
  for (const row of actuales) row.origen_reserva = origenDe(row.rsv_ids);

  if (versiones.length === 0) return actuales;

  const verIds = versiones.map(v => Number(v.id));
  const detalle = await prisma.$queryRawUnsafe<DetalleRow[]>(
    `SELECT completado_id, reserva_id FROM circuito_completado_reserva
      WHERE completado_id IN (${verIds.map(() => '?').join(',')})`,
    ...verIds,
  );

  const verBySc = new Map<number, { id: number; version: number; fecha: Date; reservas: Set<number> }>();
  for (const v of versiones) {
    verBySc.set(Number(v.solicitud_caras_id), { id: Number(v.id), version: Number(v.version), fecha: v.fecha_completado, reservas: new Set() });
  }
  const verById = new Map<number, { sc: number; reservas: Set<number> }>();
  for (const [sc, v] of verBySc) verById.set(v.id, { sc, reservas: v.reservas });
  for (const d of detalle) verById.get(Number(d.completado_id))?.reservas.add(Number(d.reserva_id));

  const cubiertas = new Set<number>();
  const salida: FilaInventarioPropuesta[] = [];
  for (const row of actuales) {
    const ver = verBySc.get(Number(row.solicitud_caras_id));
    if (!ver) { salida.push(row); continue; }
    const rsvIds = String(row.rsv_ids || '').split(',').map(Number).filter(n => n > 0);
    const enVersion = rsvIds.filter(id => ver.reservas.has(id));
    // Reservada despues de la ultima version completada: no forma parte de lo
    // que se comparte hasta que el circuito vuelva a completarse.
    if (enVersion.length === 0) continue;
    enVersion.forEach(id => cubiertas.add(id));
    salida.push({ ...row, estado_version: 'vigente', version_completado: ver.version, fecha_completado: ver.fecha });
  }

  // Reservas de la foto que ya no estan: desplazadas, quitadas o reasignadas.
  //
  // EN CAMPAÑA NO HAY GRIS: una vez hecho el pase a ventas, lo que se perdió en
  // ese corte (piezas desplazadas, o quitadas por estar ya vendidas en otra
  // campaña) deja de ser parte de lo que se le comparte al cliente. La campaña
  // muestra únicamente el inventario que sí cruzó. Mientras la propuesta NO es
  // campaña el gris sí se muestra: ahí todavía es información útil para el
  // asesor, que puede reponer esas piezas antes de vender.
  const faltantes: number[] = [];
  if (!yaEsCampania) {
    for (const v of verBySc.values()) for (const id of v.reservas) if (!cubiertas.has(id)) faltantes.push(id);
  }

  if (faltantes.length > 0) {
    const CHUNK = 800;
    for (let i = 0; i < faltantes.length; i += CHUNK) {
      const parte = faltantes.slice(i, i + CHUNK);
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        SQL_NO_VIGENTES(parte.map(() => '?').join(','), verIds.map(() => '?').join(',')),
        ...parte, ...verIds,
      );
      for (const r of rows) {
        if (r.id === null || r.id === undefined) continue; // sin pieza fisica resoluble
        const estatus = (r.estatus_reserva as string | null) ?? null;
        const articulo = (r.articulo as string | null) ?? null;
        const bonif = esBonificada(estatus, articulo);
        let motivo = 'Quitada del circuito';
        if (r.reserva_viva_id === null || r.reserva_viva_id === undefined) motivo = 'Reserva eliminada';
        else if (r.reserva_deleted_at) motivo = 'Desplazada o quitada';
        else if (Number(r.reserva_sc_actual) !== Number(r.solicitud_caras_id)) motivo = 'Reasignada a otro circuito';
        const caras = num(r.caras);
        const costo = num(r.costo);
        salida.push({
          rsv_ids: String(r.reserva_id),
          id: Number(r.id),
          codigo_unico: (r.codigo_unico as string | null) ?? null,
          solicitud_caras_id: Number(r.solicitud_caras_id),
          mueble: (r.mueble as string | null) ?? null,
          estado: (r.estado as string | null) ?? null,
          municipio: (r.municipio as string | null) ?? null,
          ubicacion: (r.ubicacion as string | null) ?? null,
          tipo_de_cara: (r.tipo_de_cara as string | null) ?? null,
          caras_totales: 1,
          caras_bonificadas: bonif ? 1 : 0,
          caras_renta: bonif ? 0 : 1,
          latitud: numOrNull(r.latitud),
          longitud: numOrNull(r.longitud),
          plaza: (r.plaza as string | null) ?? null,
          estatus_reserva: estatus,
          articulo,
          tipo_medio: (r.tipo_medio as string | null) ?? null,
          inicio_periodo: (r.inicio_periodo as Date | null) ?? null,
          fin_periodo: (r.fin_periodo as Date | null) ?? null,
          tradicional_digital: (r.tradicional_digital as string | null) ?? null,
          tipo_de_mueble: (r.mueble as string | null) ?? null,
          ancho: numOrNull(r.ancho),
          alto: numOrNull(r.alto),
          nivel_socioeconomico: (r.nivel_socioeconomico as string | null) ?? null,
          tarifa_publica: num(r.sc_tarifa) || num(r.inv_tarifa) || 0,
          tarifa_bruta_sc: caras > 0 ? costo / caras : 0,
          grupo_completo_id: Number(r.reserva_id),
          numero_catorcena: numOrNull(r.numero_catorcena),
          anio_catorcena: numOrNull(r.anio_catorcena),
          formato: (r.formato as string | null) ?? null,
          estado_version: 'no_vigente',
          version_completado: Number(r.version),
          fecha_completado: (r.fecha_completado as Date) ?? null,
          motivo_no_vigente: motivo,
          origen_reserva: origenDe(Number(r.reserva_id)),
        });
      }
    }
  }

  // Mismo orden que el SQL original: anio/catorcena desc, id desc.
  salida.sort((a, b) =>
    (num(b.anio_catorcena) - num(a.anio_catorcena)) ||
    (num(b.numero_catorcena) - num(a.numero_catorcena)) ||
    (num(b.id) - num(a.id)),
  );
  return salida;
}

/** Fecha de la version completada mas reciente entre las filas (o null). */
export function ultimaFechaCompletado(filas: FilaInventarioPropuesta[]): Date | null {
  let max: Date | null = null;
  for (const f of filas) {
    if (!f.fecha_completado) continue;
    const d = new Date(f.fecha_completado);
    if (!max || d > max) max = d;
  }
  return max;
}
