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
];

export function hasFullVisibility(rol: string): boolean {
  return FULL_VISIBILITY_ROLES.includes(rol);
}
