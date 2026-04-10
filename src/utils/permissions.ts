import { PrismaClient } from '@prisma/client';
import { cache } from './cache';

/**
 * Roles con visibilidad total: ven TODOS los registros en Solicitudes, Propuestas y Campañas.
 * Los demás roles solo ven registros donde participan (creador o asignado).
 */
const FULL_VISIBILITY_ROLES = [
  'Administrador',
  'Director General',
  'Director Comercial',
  'Director de Desarrollo Digital',
  'Director Comercial Aeropuerto',
  'Director de Operaciones',
  'Gerente de Trafico',
  'Coordinador de trafico',
  'Especialista de trafico',
  'Auxiliar de trafico',
  'DEV',
];

export function hasFullVisibility(rol: string): boolean {
  return FULL_VISIBILITY_ROLES.includes(rol);
}

/**
 * Roles con visibilidad expandida por equipo: ven sus registros + los de miembros de su red de trabajo.
 */
const TEAM_VISIBILITY_ROLES = [
  'Asesor Analista',
];

export function hasTeamVisibility(rol: string): boolean {
  return TEAM_VISIBILITY_ROLES.includes(rol);
}

/**
 * Obtiene los IDs de todos los miembros de los equipos a los que pertenece el usuario.
 * Incluye al propio usuario.
 */
export async function getTeamMemberIds(prisma: PrismaClient, userId: number): Promise<number[]> {
  const rows = await prisma.$queryRawUnsafe<{ usuario_id: number }[]>(
    `SELECT DISTINCT ue2.usuario_id
     FROM usuario_equipo ue1
     INNER JOIN usuario_equipo ue2 ON ue2.equipo_id = ue1.equipo_id
     INNER JOIN equipo e ON e.id = ue1.equipo_id AND e.deleted_at IS NULL
     WHERE ue1.usuario_id = ?`,
    userId
  );
  const ids = rows.map(r => r.usuario_id);
  // Asegurar que el propio usuario esté incluido
  if (!ids.includes(userId)) {
    ids.push(userId);
  }
  return ids;
}

/**
 * Pre-computa los IDs de campañas visibles para un usuario (cacheado 2 min).
 * Reemplaza FIND_IN_SET en WHERE con IN(ids) que sí usa índices.
 */
export async function getVisibleCampanaIds(
  prisma: PrismaClient,
  userId: number,
  teamIds?: number[]
): Promise<number[]> {
  const cacheKey = `visible_campanas:${userId}`;
  const cached = cache.get<number[]>(cacheKey);
  if (cached) return cached;

  const userIdStr = String(userId);
  const allUserIds = teamIds || [userId];
  const placeholders = allUserIds.map(() => '?').join(',');

  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(`
    SELECT DISTINCT cm.id FROM campania cm
    LEFT JOIN cotizacion ct ON ct.id = cm.cotizacion_id
    LEFT JOIN propuesta pr ON pr.id = ct.id_propuesta
    LEFT JOIN solicitud s ON s.id = pr.solicitud_id
    WHERE cm.id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM tareas t
        WHERE t.campania_id = cm.id
          AND (t.id_responsable IN (${placeholders}) OR FIND_IN_SET(?, REPLACE(IFNULL(t.id_asignado, ''), ' ', '')) > 0)
      )
      OR FIND_IN_SET(?, REPLACE(IFNULL(pr.id_asignado, ''), ' ', '')) > 0
      OR s.usuario_id IN (${placeholders})
    )
  `, ...allUserIds, userIdStr, userIdStr, ...allUserIds);

  const ids = rows.map(r => Number(r.id));
  cache.set(cacheKey, ids, 2 * 60 * 1000); // 2 min
  return ids;
}

/**
 * Pre-computa los IDs de propuestas visibles para un usuario (cacheado 2 min).
 */
export async function getVisiblePropuestaIds(
  prisma: PrismaClient,
  userId: number,
  teamIds?: number[]
): Promise<number[]> {
  const cacheKey = `visible_propuestas:${userId}`;
  const cached = cache.get<number[]>(cacheKey);
  if (cached) return cached;

  const userIdStr = String(userId);
  const allUserIds = teamIds || [userId];
  const placeholders = allUserIds.map(() => '?').join(',');

  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(`
    SELECT DISTINCT pr.id FROM propuesta pr
    LEFT JOIN solicitud sl ON sl.id = pr.solicitud_id
    WHERE pr.deleted_at IS NULL AND (
      FIND_IN_SET(?, REPLACE(IFNULL(pr.id_asignado, ''), ' ', '')) > 0
      OR sl.usuario_id IN (${placeholders})
      OR FIND_IN_SET(?, REPLACE(IFNULL(sl.id_asignado, ''), ' ', '')) > 0
    )
  `, userIdStr, ...allUserIds, userIdStr);

  const ids = rows.map(r => Number(r.id));
  cache.set(cacheKey, ids, 2 * 60 * 1000);
  return ids;
}
