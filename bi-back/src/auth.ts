import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from './env.js';
import { porCorreoConHash, type Permisos } from './services/usuarios.service.js';

/**
 * Login contra los usuarios EXCLUSIVOS de QEBI (tabla `qebi_usuario` en Hostinger,
 * separada de QEB): correo + bcrypt. bi-back firma su propio JWT (HS256) con los
 * permisos por pestaña, para proteger sus endpoints y que el front oculte tabs.
 */

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
  const token = jwt.sign(payload, env.jwtSecret, { expiresIn: EXPIRY });
  return { token, user: payload };
}

export function verificarToken(token: string): Payload {
  return jwt.verify(token, env.jwtSecret) as Payload;
}
