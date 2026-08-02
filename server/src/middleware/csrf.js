// Protección CSRF por double-submit con token firmado.
//
// Por qué hace falta: con el access token en cookie, el navegador lo adjunta
// solo por estar autenticado. SameSite=Lax ya bloquea los POST cross-site, y
// esto es la segunda capa: el cliente tiene que copiar el valor de la cookie
// gfa_csrf al header X-CSRF-Token, algo que un sitio ajeno no puede hacer
// porque no puede leer la cookie de otro origen.
//
// La firma HMAC evita que valga cualquier valor: un atacante con capacidad de
// escribir cookies (por ejemplo desde un subdominio comprometido) no puede
// fabricar un par cookie/header válido sin el secreto del servidor.
import { config } from '../config.js';
import { COOKIE_ACCESS, COOKIE_CSRF, COOKIE_REFRESH } from '../lib/cookies.js';
import { errorProhibido } from '../lib/errors.js';
import { comparacionSegura, firmarHmac } from '../lib/seguridad.js';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

function firmaValida(valor) {
  if (typeof valor !== 'string') return false;
  const separador = valor.lastIndexOf('.');
  if (separador <= 0) return false;
  const nonce = valor.slice(0, separador);
  const firma = valor.slice(separador + 1);
  return comparacionSegura(firma, firmarHmac(nonce, config.auth.jwtSecret));
}

export function verificarCsrf(req, _res, next) {
  if (METODOS_SEGUROS.has(req.method)) return next();

  // Autenticación por cabecera Bearer: inmune a CSRF por construcción.
  const cabeceraAuth = req.headers.authorization || '';
  if (cabeceraAuth.startsWith('Bearer ')) return next();

  // El disparador es traer cookie de sesión, no traer cookie CSRF: si se
  // condicionara a esta última, borrarla bastaría para saltarse el control.
  const traeSesion = Boolean(req.cookies?.[COOKIE_ACCESS] || req.cookies?.[COOKIE_REFRESH]);
  if (!traeSesion) return next();

  const cookie = req.cookies?.[COOKIE_CSRF];
  const header = req.get('x-csrf-token');

  if (!cookie || !header) {
    return next(errorProhibido('Falta el token CSRF', { codigo: 'csrf_ausente' }));
  }
  if (!firmaValida(cookie) || !comparacionSegura(cookie, header)) {
    return next(errorProhibido('Token CSRF inválido', { codigo: 'csrf_invalido' }));
  }
  return next();
}
