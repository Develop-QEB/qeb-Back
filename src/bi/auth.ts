import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getBiConfig } from './config';
import { porCorreoConHash, type Permisos } from './services/usuarios.service';

/**
 * Login contra los usuarios EXCLUSIVOS de QEBI (tabla `qebi_usuario` en Hostinger,
 * separada de QEB): correo + bcrypt. El BI firma su propio JWT (HS256) con los
 * permisos por pestaña, para proteger sus endpoints y que el front oculte tabs.
 *
 * Usa BI_JWT_SECRET (nunca el JWT_SECRET de qeb-Back) y marca sus tokens con
 * audience/issuer propios: un token de QEB no sirve aquí aunque se parezca.
 */
const JWT_OPTS = { audience: 'qebi', issuer: 'qebi-bi' } as const;

export interface Payload {
  userId: number;
  email: string;
  nombre: string;
  esAdmin: boolean;
  permisos: Permisos;
}

const EXPIRY = '12h';

export async function login(correo: string, password: string): Promise<{ token: string; user: Payload }> {
  const email = String(correo || '').trim();
  if (!email || !password) throw new Error('Credenciales inválidas');

  const u = await porCorreoConHash(email);
  if (!u) throw new Error('Credenciales inválidas');

  const ok = await bcrypt.compare(password, u.hash);
  if (!ok) throw new Error('Credenciales inválidas');

  const payload: Payload = {
    userId: u.id,
    email: u.correo,
    nombre: u.nombre,
    esAdmin: u.esAdmin,
    permisos: u.permisos,
  };
  const token = jwt.sign(payload, getBiConfig().jwtSecret, { expiresIn: EXPIRY, algorithm: 'HS256', ...JWT_OPTS });
  return { token, user: payload };
}

export function verificarToken(token: string): Payload {
  return jwt.verify(token, getBiConfig().jwtSecret, { algorithms: ['HS256'], ...JWT_OPTS }) as Payload;
}
