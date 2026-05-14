import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, JwtPayload } from '../types';
import prisma from '../utils/prisma';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Kill-switch global. Cache en memoria 30s para no pegarle a la BD en cada request.
// Cuando acceso_restringido=1, los rol NO listados en roles_permitidos reciben 503.
type MaintenanceSetting = { acceso_restringido: number; roles_permitidos: string; motivo: string | null };
let cachedMaint: MaintenanceSetting | null = null;
let cachedMaintExpiresAt = 0;
const MAINT_CACHE_TTL_MS = 30_000;

// Para usar desde login/refresh y bloquear desde la puerta.
export async function isRoleBlockedByMaintenance(rol: string): Promise<{ blocked: boolean; motivo: string | null }> {
  const s = await getMaintenanceSetting();
  if (s.acceso_restringido !== 1) return { blocked: false, motivo: null };
  const allowed = (s.roles_permitidos || '').split(',').map(x => x.trim()).filter(Boolean);
  if (allowed.includes(rol)) return { blocked: false, motivo: null };
  return { blocked: true, motivo: s.motivo };
}

async function getMaintenanceSetting(): Promise<MaintenanceSetting> {
  const now = Date.now();
  if (cachedMaint && now < cachedMaintExpiresAt) return cachedMaint;
  try {
    const row = await prisma.system_settings.findFirst({ where: { id: 1 } });
    cachedMaint = row
      ? { acceso_restringido: row.acceso_restringido, roles_permitidos: row.roles_permitidos, motivo: row.motivo }
      : { acceso_restringido: 0, roles_permitidos: '', motivo: null };
  } catch {
    // Si la tabla no existe o falla el query, abrimos paso (fail-open) para no romper la app.
    cachedMaint = { acceso_restringido: 0, roles_permitidos: '', motivo: null };
  }
  cachedMaintExpiresAt = now + MAINT_CACHE_TTL_MS;
  return cachedMaint;
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  // Debug log para el endpoint de evaluar-autorizacion
  if (req.path.includes('evaluar-autorizacion')) {
    console.log('[AUTH] evaluar-autorizacion - Authorization header presente:', !!authHeader);
    console.log('[AUTH] evaluar-autorizacion - Headers:', JSON.stringify(req.headers, null, 2));
  }

  if (!authHeader) {
    res.status(401).json({
      success: false,
      error: 'No se proporcionó token de autenticación',
    });
    return;
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({
      success: false,
      error: 'Formato de token inválido',
    });
    return;
  }

  const token = parts[1];

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error: 'Token expirado',
        code: 'TOKEN_EXPIRED',
      });
      return;
    }
    res.status(401).json({
      success: false,
      error: 'Token inválido',
    });
    return;
  }

  // Kill-switch: si está activo y el rol no está en la whitelist → 503.
  const maint = await getMaintenanceSetting();
  if (maint.acceso_restringido === 1) {
    const allowed = (maint.roles_permitidos || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (!allowed.includes(decoded.rol)) {
      res.status(503).json({
        success: false,
        error: maint.motivo || 'QEB en mantenimiento. Acceso temporalmente restringido.',
        code: 'MAINTENANCE',
      });
      return;
    }
  }

  req.user = decoded;
  next();
};

export const roleMiddleware = (...allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'No autenticado',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.rol)) {
      res.status(403).json({
        success: false,
        error: 'No tienes permisos para realizar esta acción',
      });
      return;
    }

    next();
  };
};
