// Cabeceras de seguridad, CORS restringido y limitadores de tasa.
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { errorDemasiadasPeticiones } from '../lib/errors.js';

/**
 * CORS con lista blanca y credenciales.
 * `credentials: true` es obligatorio para que el navegador mande las cookies
 * de sesión, y por eso el origen NO puede ser "*": el navegador rechaza la
 * combinación comodín + credenciales.
 */
export const corsRestringido = cors({
  origin(origen, callback) {
    // Sin cabecera Origin: peticiones del mismo sitio, curl, health checks.
    if (!origen) return callback(null, true);
    if (config.corsOrigins.includes(origen)) return callback(null, true);
    return callback(new Error(`Origen no permitido por CORS: ${origen}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  maxAge: 600,
});

export const cabecerasSeguras = helmet({
  // La API no sirve HTML; la CSP restrictiva evita que una respuesta
  // interpretada como documento pueda ejecutar nada.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.esProduccion
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
    : false,
});

function crearLimitador({ ventanaMs, maximo, mensaje }) {
  return rateLimit({
    windowMs: ventanaMs,
    limit: maximo,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Las respuestas 4xx/5xx también cuentan: si no, un atacante puede probar
    // contraseñas indefinidamente porque los fallos no consumirían cupo.
    skipFailedRequests: false,
    handler(_req, _res, next) {
      next(errorDemasiadasPeticiones(mensaje, { codigo: 'rate_limit' }));
    },
  });
}

/** Techo general por IP para toda la API. */
export const limitadorGlobal = crearLimitador({
  ventanaMs: 15 * 60 * 1000,
  maximo: 600,
  mensaje: 'Demasiadas peticiones. Espera unos minutos.',
});

/** Login: freno al ataque de fuerza bruta desde una misma IP. */
export const limitadorLogin = crearLimitador({
  ventanaMs: 15 * 60 * 1000,
  maximo: 10,
  mensaje: 'Demasiados intentos de inicio de sesión. Espera 15 minutos.',
});

/** Registro: evita la creación masiva de cuentas. */
export const limitadorRegistro = crearLimitador({
  ventanaMs: 60 * 60 * 1000,
  maximo: 5,
  mensaje: 'Demasiadas cuentas creadas desde esta conexión. Intenta más tarde.',
});

/** Recuperación de contraseña: también evita usarla para spamear correos. */
export const limitadorRecuperacion = crearLimitador({
  ventanaMs: 60 * 60 * 1000,
  maximo: 5,
  mensaje: 'Demasiadas solicitudes de recuperación. Intenta en una hora.',
});

/** Refresh: el uso normal es 1 cada 15 minutos por pestaña. */
export const limitadorRefresh = crearLimitador({
  ventanaMs: 15 * 60 * 1000,
  maximo: 60,
  mensaje: 'Demasiadas renovaciones de sesión.',
});

/** Conversión: la cuota de negocio la aplica el plan; esto frena el abuso. */
export const limitadorConversion = crearLimitador({
  ventanaMs: 60 * 1000,
  maximo: 30,
  mensaje: 'Demasiadas conversiones seguidas. Espera un momento.',
});
