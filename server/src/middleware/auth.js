// Middleware de autenticación y autorización.
//
// Dos niveles a propósito:
//   requireAuth          verifica solo la firma del JWT. Cero consultas a la
//                        base: es el camino caliente de la API.
//   requireUsuarioActivo verifica el JWT y además relee el usuario para
//                        comprobar rol vigente, cuenta activa y que el token no
//                        sea anterior a un cambio de credenciales. Cuesta una
//                        consulta, así que se usa donde el dato tiene que estar
//                        fresco: /me, rutas de admin y acciones sensibles.
//
// El access token dura 15 minutos, así que la ventana en la que un rol
// revocado sigue valiendo en las rutas baratas es de 15 minutos como máximo.
import { query } from '../db.js';
import { COOKIE_ACCESS } from '../lib/cookies.js';
import { errorNoAutenticado, errorProhibido } from '../lib/errors.js';
import { verificarAccessToken } from '../lib/tokens.js';
import { asyncHandler } from '../lib/asyncHandler.js';

function extraerToken(req) {
  const desdeCookie = req.cookies?.[COOKIE_ACCESS];
  if (desdeCookie) return { token: desdeCookie, viaCookie: true };

  // Bearer se acepta para clientes que no son navegador (scripts, pruebas).
  // No necesita CSRF: un sitio ajeno no puede poner cabeceras arbitrarias
  // en una petición cross-origin sin que el preflight lo autorice.
  const cabecera = req.headers.authorization || '';
  if (cabecera.startsWith('Bearer ')) {
    const token = cabecera.slice(7).trim();
    if (token) return { token, viaCookie: false };
  }
  return null;
}

export function requireAuth(req, _res, next) {
  const extraido = extraerToken(req);
  if (!extraido) {
    return next(errorNoAutenticado('Necesitas iniciar sesión', { codigo: 'sin_token' }));
  }
  try {
    const payload = verificarAccessToken(extraido.token);
    req.auth = {
      id: Number(payload.sub),
      email: payload.email,
      role: payload.role,
      emitidoEn: payload.iat, // segundos; lo compara requireUsuarioActivo
      viaCookie: extraido.viaCookie,
    };
    return next();
  } catch (err) {
    const expirado = err.name === 'TokenExpiredError';
    return next(
      errorNoAutenticado(expirado ? 'Sesión expirada' : 'Sesión inválida', {
        codigo: expirado ? 'token_expirado' : 'token_invalido',
      })
    );
  }
}

export const requireUsuarioActivo = [
  requireAuth,
  asyncHandler(async (req, _res, next) => {
    const resultado = await query(
      `SELECT id, email, name, role, avatar_url, email_verified, created_at,
              disabled_at, tokens_valid_from, (password_hash IS NOT NULL) AS tiene_password,
              (google_id IS NOT NULL) AS tiene_google
         FROM users WHERE id = $1`,
      [req.auth.id]
    );
    const usuario = resultado.rows[0];
    if (!usuario) {
      return next(errorNoAutenticado('La cuenta ya no existe', { codigo: 'usuario_inexistente' }));
    }
    if (usuario.disabled_at) {
      return next(errorProhibido('Cuenta desactivada', { codigo: 'cuenta_desactivada' }));
    }

    // Un cambio de contraseña o un cierre global mueven tokens_valid_from.
    // Como aquí ya se leyó el usuario, invalidar los access tokens anteriores
    // sale gratis y cierra la ventana de 15 minutos que quedaría si solo se
    // revocaran los refresh tokens.
    // tokens_valid_from se guarda truncado al segundo porque el "iat" del JWT
    // también lo está; si no, el token emitido justo después del cambio se
    // invalidaría a sí mismo por unos milisegundos de diferencia.
    const emitidoEnMs = (req.auth.emitidoEn ?? 0) * 1000;
    if (emitidoEnMs < new Date(usuario.tokens_valid_from).getTime()) {
      return next(
        errorNoAutenticado('Tus credenciales cambiaron. Vuelve a iniciar sesión.', {
          codigo: 'credenciales_cambiadas',
        })
      );
    }

    req.usuario = usuario;
    // El rol del JWT puede estar obsoleto; manda el de la base.
    req.auth.role = usuario.role;
    return next();
  }),
];

/** Exige uno de los roles indicados. Siempre relee el usuario de la base. */
export function requireRole(...rolesPermitidos) {
  return [
    ...requireUsuarioActivo,
    (req, _res, next) => {
      if (!rolesPermitidos.includes(req.usuario.role)) {
        return next(
          errorProhibido('No tienes permiso para esta acción', { codigo: 'rol_insuficiente' })
        );
      }
      return next();
    },
  ];
}

/** No falla si no hay sesión: deja req.auth en null. */
export function authOpcional(req, _res, next) {
  const extraido = extraerToken(req);
  if (!extraido) {
    req.auth = null;
    return next();
  }
  try {
    const payload = verificarAccessToken(extraido.token);
    req.auth = {
      id: Number(payload.sub),
      email: payload.email,
      role: payload.role,
      viaCookie: extraido.viaCookie,
    };
  } catch {
    req.auth = null;
  }
  return next();
}
