// Modo mantenimiento programado.
// true  -> el middleware bloquea el acceso a la API a roles que no sean
//          Administrador, DEV o de Trafico (devuelve 503 con code MAINTENANCE).
// false -> comportamiento normal, el middleware es transparente.
export const MAINTENANCE_MODE = true;

export const isRolAllowedDuringMaintenance = (rol: string | undefined | null): boolean => {
  const cleaned = (rol ?? '').trim();
  if (!cleaned) return false;
  if (cleaned === 'Administrador') return true;
  if (cleaned === 'DEV') return true;
  return cleaned.toLowerCase().includes('rafico');
};
