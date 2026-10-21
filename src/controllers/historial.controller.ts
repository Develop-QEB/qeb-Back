import { Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types';
import { serializeBigInt } from '../utils/serialization';
import { emitToHistorial, emitToAll, SOCKET_EVENTS } from '../config/socket';
import {
  listarActividadesComerciales, moverActividadComercial, esColumnaAC, COLUMNAS_AC,
} from '../services/actividad-comercial.service';
import {
  clasificar, whereModulos, whereCategorias, whereEtapas,
  opcionesModulos, opcionesCategorias, opcionesEtapas,
} from '../utils/historialTaxonomia';
import {
  tieneHistorialCompleto, getTeamMemberIds, hasTeamVisibility,
  getVisibleCampanaIds, getVisiblePropuestaIds, getVisibleSolicitudIds,
} from '../utils/permissions';

/**
 * Normaliza un query param que puede venir ausente, suelto o repetido
 * (?tipo=a&tipo=b) a una lista de strings no vacios.
 */
function asList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0);
}

/**
 * Condicion para los roles que NO ven el historial completo: solo lo que
 * hicieron o aquello en lo que participan.
 *
 * Son dos cosas distintas unidas por OR:
 *
 *   a) LO QUE HIZO — por `usuario_id` cuando existe, y si no por el nombre
 *      dentro de `accion` / `detalles`. Lo segundo es un LIKE sobre texto y
 *      es fragil (colisiona entre nombres que se contienen), pero es lo unico
 *      disponible: la tabla casi nunca puebla `usuario_id`, la autoria vive
 *      redactada dentro del texto.
 *
 *   b) EN LO QUE PARTICIPA — las campañas / propuestas / solicitudes donde es
 *      creador o asignado, reutilizando los helpers ya cacheados (2 min) que
 *      usan Solicitudes, Propuestas y Campañas. Cada conjunto se cruza con su
 *      etapa para no mezclar espacios de numeracion: la campaña 42 y la
 *      propuesta 42 son registros distintos.
 *
 * Precision conocida y limitada a proposito: dentro de la etapa Campaña el
 * `ref_id` es inconsistente en el dato crudo (unas filas guardan campania_id
 * y otras id_propuesta — ver historialTaxonomia.ts), asi que esa etapa se
 * compara contra la union de ambos conjuntos. Puede colarse alguna fila de
 * una propuesta ajena cuyo id coincida con el de una campaña propia. Se
 * prefiere eso a esconderle al usuario la mitad de su propio trabajo;
 * arreglarlo de raiz pide normalizar `ref_id` en los ~60 puntos que escriben
 * historial.
 */
async function condicionVisibilidad(
  userId: number | undefined,
  userName: string | undefined,
  userRole: string | undefined,
): Promise<Record<string, unknown>> {
  const ors: Record<string, unknown>[] = [];

  // (a) lo que hizo
  if (userId) ors.push({ usuario_id: userId });
  if (userName) {
    ors.push({ accion: { contains: userName } });
    ors.push({ detalles: { contains: userName } });
  }

  // (b) en lo que participa
  if (userId) {
    try {
      // Los roles con visibilidad por equipo ven tambien lo de su red de
      // trabajo, igual que en el resto del sistema.
      const teamIds = hasTeamVisibility(String(userRole ?? ''))
        ? await getTeamMemberIds(prisma, userId)
        : undefined;

      const [campanaIds, propuestaIds, solicitudIds] = await Promise.all([
        getVisibleCampanaIds(prisma, userId, teamIds),
        getVisiblePropuestaIds(prisma, userId, teamIds),
        getVisibleSolicitudIds(prisma, userId, teamIds),
      ]);

      const porEtapa = (etapa: string, ids: number[]) => {
        if (ids.length === 0) return;
        const cond = whereEtapas([etapa]);
        if (cond) ors.push({ AND: [cond, { ref_id: { in: ids } }] });
      };

      // La etapa Campaña abarca artes, APS, posteo, instalacion y desposteo,
      // cuyo ref_id apunta unas veces a la campaña y otras a la propuesta.
      porEtapa('campana', [...new Set([...campanaIds, ...propuestaIds])]);
      porEtapa('propuesta', propuestaIds);
      porEtapa('solicitud', solicitudIds);
    } catch (err) {
      // Si falla el calculo de participacion no se abre el historial: se cae
      // a "solo lo que hizo", que es el criterio mas restrictivo.
      console.error('historial: no se pudo resolver la visibilidad por participacion:', err);
    }
  }

  // Sin nada que mostrar, no devolver un OR vacio (Prisma lo ignoraria y
  // dejaria ver TODO). Una condicion imposible es lo correcto aqui.
  if (ors.length === 0) return { id: { in: [] } };
  return { OR: ors };
}

export class HistorialController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      // Todos los filtros son multiselect: llegan como parametro repetido
      // (?modulo=a&modulo=b). Tambien se acepta el string suelto.
      const usuarios = asList(req.query.usuario);
      // Los dos ejes de la taxonomia (ver utils/historialTaxonomia.ts); son
      // los que usa el screen hoy.
      const etapas = asList(req.query.etapa);
      const modulos = asList(req.query.modulo);
      const categorias = asList(req.query.categoria);
      // LEGACY: filtrado crudo por `tipo` y texto de `accion`. El screen ya
      // no los manda (los reemplazo la taxonomia), pero se mantienen para no
      // romper enlaces guardados ni integraciones externas.
      const tipos = asList(req.query.tipo);
      const acciones = asList(req.query.accion);
      const search = req.query.search as string;
      const fechaDesde = req.query.fechaDesde as string;
      const fechaHasta = req.query.fechaHasta as string;
      const auditAdmin = req.query.audit_admin === 'true' || req.query.audit_admin === '1';

      const userRole = req.user?.rol;
      const userName = req.user?.nombre;
      const userId = req.user?.userId;
      const isDev = userRole === 'DEV';
      // Quien ve el historial completo lo define la lista de roles en
      // utils/permissions.ts. Antes esto era `rol === 'Administrador' || 'DEV'`
      // y por eso las direcciones veian solo lo suyo pese a que el front les
      // marcaba canSeeAllHistorial.
      const verTodo = tieneHistorialCompleto(userRole);

      const where: Record<string, unknown> = {};
      const andConditions: Record<string, unknown>[] = [];

      if (tipos.length > 0) {
        // '*' y '_' finales marcan prefijo, para agrupar familias enteras
        // ('autorizacion_*', 'Arte*') en un solo valor.
        const porTipo = tipos.map(t => (
          t.endsWith('*') ? { tipo: { startsWith: t.slice(0, -1) } }
            : t.endsWith('_') ? { tipo: { startsWith: t } }
              : { tipo: t }
        ));
        andConditions.push({ OR: porTipo });
      }

      if (acciones.length > 0) {
        const accionPatterns: Record<string, unknown> = {
          '~aprobacion_dcm_dg': { OR: [{ accion: { startsWith: 'Aprobación DCM por' } }, { accion: { startsWith: 'Aprobación DG por' } }] },
          '~rechazo_dcm_dg': { OR: [{ accion: { startsWith: 'Rechazo DCM por' } }, { accion: { startsWith: 'Rechazo DG por' } }] },
          '~cambio_autorizacion': { OR: [{ accion: { contains: 'cambió Autorización DCM' } }, { accion: { contains: 'cambió Autorización DG' } }] },
          '~cambio_valor': { accion: { contains: '→' } },
        };
        const porAccion = acciones.map(a => (
          (accionPatterns[a] as Record<string, unknown>) ?? { accion: { contains: a } }
        ));
        andConditions.push({ OR: porAccion });
      }

      if (fechaDesde || fechaHasta) {
        const fechaFilter: Record<string, Date> = {};
        if (fechaDesde) fechaFilter.gte = new Date(fechaDesde);
        if (fechaHasta) {
          const hasta = new Date(fechaHasta);
          hasta.setHours(23, 59, 59, 999);
          fechaFilter.lte = hasta;
        }
        where.fecha_hora = fechaFilter;
      }

      if (search) {
        andConditions.push({
          OR: [
            { accion: { contains: search } },
            { detalles: { contains: search } },
            { tipo: { contains: search } },
          ],
        });
      }

      if (usuarios.length > 0) {
        // No hay FK de autor: la autoria vive dentro del texto de `detalles`
        // (JSON) o del propio `accion`, asi que se busca por nombre.
        andConditions.push({
          OR: usuarios.flatMap(u => [
            { detalles: { contains: u } },
            { accion: { contains: u } },
          ]),
        });
      }

      if (!verTodo) {
        andConditions.push(await condicionVisibilidad(userId, userName, userRole));
      }

      // Taxonomia: modulo (sobre que) y categoria (que se hizo). Ambos se
      // traducen desde la MISMA declaracion de patrones que etiqueta las
      // filas mas abajo, asi que filtro y etiqueta no pueden divergir.
      const condModulo = whereModulos(modulos);
      if (condModulo) andConditions.push(condModulo);
      const condCategoria = whereCategorias(categorias);
      if (condCategoria) andConditions.push(condCategoria);
      const condEtapa = whereEtapas(etapas);
      if (condEtapa) andConditions.push(condEtapa);

      // Filtro "Auditoria Admin" — solo visible para DEV. Filtra entradas
      // donde el actor es Administrador o DEV (segun usuarioRol en detalles).
      // El helper logHistorial guarda usuarioRol con ese formato literal.
      if (auditAdmin && isDev) {
        andConditions.push({
          OR: [
            { detalles: { contains: '"usuarioRol":"Administrador"' } },
            { detalles: { contains: '"usuarioRol":"DEV"' } },
          ],
        });
      }

      if (andConditions.length > 0) {
        where.AND = andConditions;
      }

      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        prisma.historial.findMany({
          where,
          orderBy: { fecha_hora: 'desc' },
          skip,
          take: limit,
        }),
        prisma.historial.count({ where }),
      ]);

      // Etiqueta cada fila con sus dos ejes para que el front solo pinte
      // (no duplica la taxonomia del back).
      const dataClasificada = data.map(row => ({
        ...row,
        ...clasificar(row.tipo, row.accion),
      }));

      res.json(serializeBigInt({
        success: true,
        data: dataClasificada,
        // El front avisa al usuario cuando esta viendo una vista recortada.
        // Se manda desde aqui para no duplicar la lista de roles en el front.
        visibilidad: { verTodo },
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      }));
    } catch (error) {
      console.error('Error en historial getAll:', error);
      const message = error instanceof Error ? error.message : 'Error al obtener historial';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Listas de los dos dropdowns de clasificacion. Son ESTATICAS: salen de la
  // taxonomia en codigo, no de la base. Los endpoints que reemplazan
  // (getTipos / getAcciones) hacian un `distinct` sobre la tabla entera en
  // cada carga de la pagina — uno de los full scans mas caros del modulo — y
  // ademas getAcciones devolvia cientos de frases con IDs interpolados
  // ("135 circuito(s) DCM escalado(s) a DG...") en vez de categorias.
  async getEtapas(_req: AuthRequest, res: Response): Promise<void> {
    res.json({ success: true, data: opcionesEtapas() });
  }

  async getModulos(_req: AuthRequest, res: Response): Promise<void> {
    res.json({ success: true, data: opcionesModulos() });
  }

  async getCategorias(_req: AuthRequest, res: Response): Promise<void> {
    res.json({ success: true, data: opcionesCategorias() });
  }

  async getUsuarios(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const usuarios = await prisma.usuario.findMany({
        where: { deleted_at: null },
        select: { id: true, nombre: true },
        orderBy: { nombre: 'asc' },
      });
      res.json({ success: true, data: usuarios });
    } catch (error) {
      console.error('Error en historial getUsuarios:', error);
      res.status(500).json({ success: false, error: 'Error al obtener usuarios' });
    }
  }

  async addNota(req: AuthRequest, res: Response): Promise<void> {
    try {
      const {
        ref_id,
        tipo,
        nota,
        fecha_entrega,
        recordar_dias_antes,
      } = req.body as {
        ref_id?: number;
        tipo: string;
        nota: string;
        fecha_entrega?: string | null;
        recordar_dias_antes?: number | null;
      };
      const userId = req.user?.userId;
      const userName = req.user?.nombre || 'Usuario';

      if (!nota || !tipo) {
        res.status(400).json({ success: false, error: 'nota y tipo son requeridos' });
        return;
      }

      // Validacion del recordatorio
      let fechaEntregaDate: Date | null = null;
      let recordarDiasAntes: number | null = null;
      if (fecha_entrega) {
        fechaEntregaDate = new Date(fecha_entrega);
        if (isNaN(fechaEntregaDate.getTime())) {
          res.status(400).json({ success: false, error: 'fecha_entrega invalida' });
          return;
        }
        if (recordar_dias_antes != null) {
          const dias = Number(recordar_dias_antes);
          if (!Number.isInteger(dias) || dias < 0 || dias > 365) {
            res.status(400).json({ success: false, error: 'recordar_dias_antes debe ser entre 0 y 365' });
            return;
          }
          recordarDiasAntes = dias;
        }
      }

      const entry = await prisma.historial.create({
        data: {
          tipo,
          ref_id: ref_id || 0,
          accion: 'Acción registrada',
          detalles: `${userName}: ${nota}`,
          usuario_id: userId || null,
          fecha_entrega: fechaEntregaDate,
          recordar_dias_antes: recordarDiasAntes,
        },
      });

      const serialized = serializeBigInt(entry) as { id: unknown };
      // Solo el id: la room `historial` la escucha cualquier rol desde que el
      // modulo se abrio a todos, y el front unicamente invalida la query (la
      // lista que reciba ya viene recortada por visibilidad). Mandar la nota
      // completa seria filtrar su texto a quien no deberia verla.
      emitToHistorial(SOCKET_EVENTS.HISTORIAL_NUEVA, { id: serialized.id });
      res.json({ success: true, data: serialized });
    } catch (error) {
      console.error('Error en historial addNota:', error);
      const message = error instanceof Error ? error.message : 'Error al agregar nota';
      res.status(500).json({ success: false, error: message });
    }
  }

  // ---------- Tablero CRM de Actividad Comercial (tab en Historial de Acciones) ----------
  // Misma regla de visibilidad que el historial: los roles de la lista ven
  // todas las actividades; el resto solo las suyas. Antes listaba siempre
  // todas, lo cual era seguro mientras el modulo estaba limitado a direccion,
  // pero ya no: ahora entra cualquier rol.
  async getActividadComercial(req: AuthRequest, res: Response): Promise<void> {
    try {
      const verTodo = tieneHistorialCompleto(req.user?.rol);
      const data = await listarActividadesComerciales(verTodo ? undefined : req.user?.userId);
      res.json(serializeBigInt({ success: true, data }));
    } catch (error) {
      console.error('Error en historial getActividadComercial:', error);
      res.status(500).json({ success: false, error: 'Error al obtener actividades comerciales' });
    }
  }

  async moverActividadComercial(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { columna } = (req.body ?? {}) as { columna?: unknown };
      if (!Number.isFinite(id) || !esColumnaAC(columna)) {
        res.status(400).json({ success: false, error: `columna debe ser una de: ${COLUMNAS_AC.join(', ')}` });
        return;
      }
      const r = await moverActividadComercial(id, columna, {
        usuarioId: req.user?.userId,
        usuarioNombre: req.user?.nombre,
        usuarioRol: req.user?.rol,
        soloPropias: !tieneHistorialCompleto(req.user?.rol),
      });
      if (r === 'prohibido') {
        res.status(403).json({ success: false, error: 'Solo puedes mover tus propias actividades' });
        return;
      }
      if (!r) {
        res.status(404).json({ success: false, error: 'Actividad comercial no encontrada' });
        return;
      }
      if (r.cambio) {
        // Refresca el tablero (room historial) y los badges/listas de
        // Notificaciones del responsable (mismo evento que usa bulk-estatus).
        emitToHistorial(SOCKET_EVENTS.HISTORIAL_NUEVA, { tareaId: id, estatus: r.despues });
        emitToAll(SOCKET_EVENTS.NOTIFICACION_LEIDA, { ids: [id], estatus: r.despues });
      }
      res.json(serializeBigInt({ success: true, data: r.tarea }));
    } catch (error) {
      console.error('Error en historial moverActividadComercial:', error);
      res.status(500).json({ success: false, error: 'Error al mover la actividad' });
    }
  }
}

export const historialController = new HistorialController();
