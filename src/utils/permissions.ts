import { PrismaClient } from '@prisma/client';

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
