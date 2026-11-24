import { Request, Response, NextFunction } from 'express';

/**
 * Límite de intentos para los endpoints de autenticación.
 *
 * El proyecto no tenía ningún tope: login, forgot-password y reset-password
 * aceptaban intentos ilimitados, así que el código de recuperación de 6
 * dígitos se podía adivinar por fuerza bruta y las contraseñas también.
 *
 * Es un contador en memoria del proceso, a propósito: no agrega dependencias
 * ni Redis. Con un solo proceso por ambiente (pm2) alcanza. Si algún día se
 * escala a varias instancias, hay que moverlo a un almacén compartido o el
 * límite será por instancia.
 */

interface Ventana {
  conteo: number;
  reinicioMs: number;
}

const cubetas = new Map<string, Ventana>();

// Limpieza periódica para que el Map no crezca sin control.
const LIMPIEZA_MS = 10 * 60 * 1000;
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, v] of cubetas) {
    if (v.reinicioMs <= ahora) cubetas.delete(clave);
  }
}, LIMPIEZA_MS).unref();

function ipDe(req: Request): string {
  // Requiere app.set('trust proxy', 1): detrás de nginx, sin eso, req.ip es
  // la IP del proxy y TODOS los usuarios comparten la misma cubeta.
  return req.ip || req.socket.remoteAddress || 'desconocida';
}

export interface OpcionesLimite {
  /** Intentos permitidos por ventana. */
  max: number;
  /** Tamaño de la ventana en milisegundos. */
  ventanaMs: number;
  /** Nombre para separar las cubetas de distintos endpoints. */
  etiqueta: string;
  /**
   * Campo del body que identifica a la cuenta (p. ej. 'email' o 'correo').
   * Si se indica, se limita por IP y además por cuenta, para que repartir el
   * ataque entre muchas IPs no sirva de nada.
   */
  campoIdentidad?: string;
}

function consumir(clave: string, max: number, ventanaMs: number): { permitido: boolean; esperaS: number } {
  const ahora = Date.now();
  const actual = cubetas.get(clave);

  if (!actual || actual.reinicioMs <= ahora) {
    cubetas.set(clave, { conteo: 1, reinicioMs: ahora + ventanaMs });
    return { permitido: true, esperaS: 0 };
  }

  actual.conteo += 1;
  if (actual.conteo > max) {
    return { permitido: false, esperaS: Math.ceil((actual.reinicioMs - ahora) / 1000) };
  }
  return { permitido: true, esperaS: 0 };
}

export function limitarIntentos(opciones: OpcionesLimite) {
  const { max, ventanaMs, etiqueta, campoIdentidad } = opciones;

  return (req: Request, res: Response, next: NextFunction): void => {
    const claves = [`${etiqueta}:ip:${ipDe(req)}`];

    if (campoIdentidad) {
      const bruto = (req.body as Record<string, unknown> | undefined)?.[campoIdentidad];
      if (typeof bruto === 'string' && bruto.trim().length > 0) {
        claves.push(`${etiqueta}:id:${bruto.trim().toLowerCase()}`);
      }
    }

    let esperaS = 0;
    for (const clave of claves) {
      const r = consumir(clave, max, ventanaMs);
      if (!r.permitido) esperaS = Math.max(esperaS, r.esperaS);
    }

    if (esperaS > 0) {
      res.setHeader('Retry-After', String(esperaS));
      res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        error: `Demasiados intentos. Vuelve a intentar en ${Math.ceil(esperaS / 60)} minuto(s).`,
      });
      return;
    }

    next();
  };
}

/** Login: 10 intentos por 15 min, por IP y por correo. */
export const limiteLogin = limitarIntentos({
  etiqueta: 'login',
  max: 10,
  ventanaMs: 15 * 60 * 1000,
  campoIdentidad: 'email',
});

/** Envío de código de recuperación: 5 por hora (evita usarlo para spamear correos). */
export const limiteOlvidePassword = limitarIntentos({
  etiqueta: 'forgot',
  max: 5,
  ventanaMs: 60 * 60 * 1000,
  campoIdentidad: 'correo',
});

/**
 * Canje del código de recuperación: 5 intentos por hora.
 * Es el que de verdad importa: son 6 dígitos, un millón de combinaciones.
 * Con 5 por hora, adivinarlo dentro de los 15 min de vigencia es inviable.
 */
export const limiteResetPassword = limitarIntentos({
  etiqueta: 'reset',
  max: 5,
  ventanaMs: 60 * 60 * 1000,
  campoIdentidad: 'correo',
});

/** Cambio de contraseña con sesión abierta: 10 por hora. */
export const limiteCambioPassword = limitarIntentos({
  etiqueta: 'change-password',
  max: 10,
  ventanaMs: 60 * 60 * 1000,
});
