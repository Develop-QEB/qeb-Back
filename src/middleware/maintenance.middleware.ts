import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, JwtPayload } from '../types';
import { MAINTENANCE_MODE, isRolAllowedDuringMaintenance } from '../config/maintenance';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

export const maintenanceGuard = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!MAINTENANCE_MODE) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    next();
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    next();
    return;
  }

  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET) as JwtPayload;
    if (!isRolAllowedDuringMaintenance(decoded.rol)) {
      res.status(503).json({
        success: false,
        code: 'MAINTENANCE',
        error: 'El sistema esta en mantenimiento programado. Disponible nuevamente a partir de las 12:00 a.m.',
      });
      return;
    }
  } catch {
    // Token invalido o expirado: dejar que el authMiddleware reporte el 401.
  }

  next();
};
