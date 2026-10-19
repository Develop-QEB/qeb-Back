// Tablero CRM de "Actividad Comercial" (Historial de Acciones).
//
// Una Actividad Comercial es una fila de `tareas` con tipo='Actividad
// Comercial' (la crea el asesor en Notificaciones y Tareas). El tablero la
// muestra en 3 columnas segun `tareas.estatus`:
//
//   Abierto    -> 'Abierto'                      (default al crear)
//   Activo     -> 'Activo' | 'Pendiente' | 'Urgente' | null (legado)
//   Finalizado -> 'Atendido' | 'Finalizada' | 'Finalizado' | 'Completado' | 'Cerrado' | 'Cancelado'
//
// Al MOVER una tarjeta se escribe el valor canonico de la columna. Para
// "Finalizado" se guarda 'Atendido' a proposito: es el valor que todo el
// modulo de Notificaciones ya trata como resuelto (ESTATUS_RESUELTOS, badge
// de la campanita, filtro "sin finalizar", kanban "Completado"). Guardar un
// 'Finalizado' literal dejaria la tarea como pendiente en todos esos lugares.
//
// OJO: `contenido.estatus_actividad` ('Abierto'|'Cerrado') es OTRO campo, del
// formulario del asesor. No se toca aqui.
import prisma from '../utils/prisma';
import { logHistorial } from '../utils/historial';

export const TIPO_ACTIVIDAD_COMERCIAL = 'Actividad Comercial';

export const COLUMNAS_AC = ['Abierto', 'Activo', 'Finalizado'] as const;
export type ColumnaAC = (typeof COLUMNAS_AC)[number];

/** Valor que se escribe en `tareas.estatus` al soltar en cada columna. */
export const ESTATUS_DE_COLUMNA: Record<ColumnaAC, string> = {
  Abierto: 'Abierto',
  Activo: 'Activo',
  Finalizado: 'Atendido',
};

const ESTATUS_FINALIZADOS = new Set(['Atendido', 'Finalizada', 'Finalizado', 'Completado', 'Cerrado', 'Cancelado']);

export function columnaDeEstatus(estatus: string | null | undefined): ColumnaAC {
  if (estatus === 'Abierto') return 'Abierto';
  if (estatus && ESTATUS_FINALIZADOS.has(estatus)) return 'Finalizado';
  return 'Activo';
}

export function esColumnaAC(v: unknown): v is ColumnaAC {
  return typeof v === 'string' && (COLUMNAS_AC as readonly string[]).includes(v);
}

// Tope defensivo: las actividades son manuales (decenas/cientos), no miles.
const MAX_FILAS = 2000;

/** Datos de la cuenta vinculada (campaña o propuesta) para filtrar en el tablero. */
interface CuentaVinculada {
  cuic: string | null;
  asesor: string | null;
  cliente: string | null;
}

const SELECT_CUENTA = `
  COALESCE(NULLIF(s.cuic, ''), cl.CUIC) AS cuic,
  COALESCE(NULLIF(cl.T0_U_Asesor, ''), NULLIF(s.asesor, '')) AS asesor,
  COALESCE(NULLIF(cl.T0_U_Cliente, 'Cliente'), NULLIF(cl.T0_U_RazonSocial, ''), s.razon_social) AS cliente`;

const normCuenta = (r: { cuic: unknown; asesor: unknown; cliente: unknown }): CuentaVinculada => ({
  cuic: r.cuic === null || r.cuic === undefined || r.cuic === '' ? null : String(r.cuic),
  asesor: r.asesor ? String(r.asesor) : null,
  cliente: r.cliente ? String(r.cliente) : null,
});

/**
 * Todas las actividades + CUIC / asesor / cliente de la cuenta vinculada
 * (misma derivacion que usa crearActividadComercial). Una actividad sobre un
 * lead sin campaña ni propuesta trae esos campos en null.
 */
export async function listarActividadesComerciales() {
  const filas = await prisma.tareas.findMany({
    where: { tipo: TIPO_ACTIVIDAD_COMERCIAL },
    orderBy: [{ fecha_fin: 'asc' }, { id: 'desc' }],
    take: MAX_FILAS,
    select: {
      id: true, titulo: true, descripcion: true, tipo: true, estatus: true,
      fecha_inicio: true, fecha_fin: true, responsable: true, id_responsable: true,
      asignado: true, campania_id: true, id_propuesta: true, contenido: true, created_at: true,
    },
  });

  const campIds = [...new Set(filas.map(f => f.campania_id).filter((n): n is number => !!n))];
  const propIds = [...new Set(filas.map(f => Number(f.id_propuesta)).filter(n => Number.isFinite(n) && n > 0))];

  const porCampania = new Map<number, CuentaVinculada>();
  const porPropuesta = new Map<number, CuentaVinculada>();

  if (campIds.length) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number | bigint; cuic: unknown; asesor: unknown; cliente: unknown }>>(
      `SELECT c.id, ${SELECT_CUENTA}
         FROM campania c
         LEFT JOIN cotizacion ct ON ct.id = c.cotizacion_id
         LEFT JOIN propuesta p ON p.id = ct.id_propuesta
         LEFT JOIN solicitud s ON s.id = p.solicitud_id
         LEFT JOIN cliente cl ON cl.id = c.cliente_id
        WHERE c.id IN (${campIds.map(() => '?').join(',')})`,
      ...campIds,
    );
    rows.forEach(r => porCampania.set(Number(r.id), normCuenta(r)));
  }
  if (propIds.length) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number | bigint; cuic: unknown; asesor: unknown; cliente: unknown }>>(
      `SELECT p.id, ${SELECT_CUENTA}
         FROM propuesta p
         LEFT JOIN solicitud s ON s.id = p.solicitud_id
         LEFT JOIN cliente cl ON cl.id = p.cliente_id
        WHERE p.id IN (${propIds.map(() => '?').join(',')})`,
      ...propIds,
    );
    rows.forEach(r => porPropuesta.set(Number(r.id), normCuenta(r)));
  }

  return filas.map(f => {
    const cuenta = (f.campania_id && porCampania.get(f.campania_id))
      || porPropuesta.get(Number(f.id_propuesta))
      || null;
    return {
      ...f,
      cuic: cuenta?.cuic ?? null,
      asesor: cuenta?.asesor ?? null,
      cliente_nombre: cuenta?.cliente ?? null,
    };
  });
}

export interface CambioEstatusCtx {
  usuarioId?: number;
  usuarioNombre?: string;
  usuarioRol?: string;
}

/**
 * Mueve la actividad a una columna. Devuelve la tarea actualizada y el
 * estatus anterior; null si no existe o no es Actividad Comercial. Deja
 * registro en historial (tipo 'Tarea') + espejo en la campaña/propuesta
 * vinculada, igual que el hook de updateTarea en campanas.controller.
 */
export async function moverActividadComercial(id: number, columna: ColumnaAC, ctx: CambioEstatusCtx) {
  const previa = await prisma.tareas.findUnique({
    where: { id },
    select: { id: true, tipo: true, estatus: true, contenido: true, campania_id: true, id_propuesta: true },
  });
  if (!previa || previa.tipo !== TIPO_ACTIVIDAD_COMERCIAL) return null;

  const despues = ESTATUS_DE_COLUMNA[columna];
  const antes = previa.estatus ?? null;
  // Ya esta en esa columna con el valor canonico: no hay nada que escribir.
  if (antes === despues) {
    const tarea = await prisma.tareas.findUnique({ where: { id } });
    return { tarea, antes, despues, cambio: false };
  }

  const tarea = await prisma.tareas.update({ where: { id }, data: { estatus: despues } });

  const usuario = ctx.usuarioNombre || 'Sistema';
  let detalle = '';
  try {
    const c = previa.contenido ? JSON.parse(previa.contenido) : null;
    if (c) detalle = [c.subtipo, c.ref_id ? `#${c.ref_id}` : null].filter(Boolean).join(' ');
  } catch { /* contenido corrupto: sin detalle */ }

  const esFinalizacion = columna === 'Finalizado';
  const verbo = esFinalizacion ? 'Finalizó' : columna === 'Abierto' ? 'Reabrió' : 'Activó';
  const accion = `${verbo} actividad comercial${detalle ? ` (${detalle})` : ''}`;

  await logHistorial({
    tipo: 'Tarea',
    refId: id,
    accion,
    usuario,
    usuarioId: ctx.usuarioId,
    usuarioRol: ctx.usuarioRol,
    origen: 'historial_tablero_actividad_comercial',
    cambios: [{ campo: 'estatus', label: 'Estatus', antes, despues }],
    extras: { columna },
  });

  // Espejo en el ID vinculado para que desde la campaña/propuesta se vea.
  const accionEspejo = `Actividad comercial #${id} ${esFinalizacion ? 'finalizada' : columna === 'Abierto' ? 'reabierta' : 'activada'}${detalle ? ` (${detalle})` : ''}`;
  if (previa.campania_id) {
    await logHistorial({
      tipo: 'Campaña', refId: previa.campania_id, accion: accionEspejo, usuario,
      usuarioId: ctx.usuarioId, usuarioRol: ctx.usuarioRol,
      origen: 'historial_tablero_actividad_comercial',
      extras: { tareaId: id, estatus: despues },
    });
  } else if (previa.id_propuesta) {
    const propuestaId = Number(previa.id_propuesta);
    if (Number.isFinite(propuestaId) && propuestaId > 0) {
      await logHistorial({
        tipo: 'Propuesta', refId: propuestaId, accion: accionEspejo, usuario,
        usuarioId: ctx.usuarioId, usuarioRol: ctx.usuarioRol,
        origen: 'historial_tablero_actividad_comercial',
        extras: { tareaId: id, estatus: despues },
      });
    }
  }

  return { tarea, antes, despues, cambio: true };
}
