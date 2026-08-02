// Cookies de sesión.
//
// gfa_at   access token (JWT corto)  — httpOnly: el JavaScript de la página no
//                                      puede leerlo, así que un XSS no lo roba.
// gfa_rt   refresh token (opaco)     — httpOnly y con path acotado a /api/auth,
//                                      así no viaja en cada petición de la app.
// gfa_csrf token anti-CSRF           — legible por JS a propósito: el cliente lo
//                                      copia al header X-CSRF-Token
//                                      (patrón double-submit).
import { config } from '../config.js';
import { firmarHmac, tokenAleatorio } from './seguridad.js';

export const COOKIE_ACCESS = 'gfa_at';
export const COOKIE_REFRESH = 'gfa_rt';
export const COOKIE_CSRF = 'gfa_csrf';

const RUTA_REFRESH = '/api/auth';

function opcionesBase(extra = {}) {
  return {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    domain: config.cookies.domain,
    path: '/',
    ...extra,
  };
}

/** Milisegundos que dura el access token, derivados de ACCESS_TOKEN_TTL. */
function msDelAccessToken() {
  const ttl = config.auth.accessTokenTtl;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 15 * 60 * 1000;
  const cantidad = Number(match[1]);
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return cantidad * factor;
}

export function ponerCookieAccess(res, token) {
  res.cookie(COOKIE_ACCESS, token, opcionesBase({ maxAge: msDelAccessToken() }));
}

export function ponerCookieRefresh(res, token) {
  res.cookie(
    COOKIE_REFRESH,
    token,
    opcionesBase({
      path: RUTA_REFRESH,
      maxAge: config.auth.refreshTokenTtlDays * 86_400_000,
    })
  );
}

/**
 * Token CSRF firmado: "<nonce>.<hmac(nonce)>".
 * La firma impide que un atacante que solo pueda escribir cookies (por ejemplo
 * desde un subdominio) inyecte un valor conocido y pase la validación.
 */
export function ponerCookieCsrf(res) {
  const nonce = tokenAleatorio(16);
  const valor = `${nonce}.${firmarHmac(nonce, config.auth.jwtSecret)}`;
  res.cookie(
    COOKIE_CSRF,
    valor,
    opcionesBase({
      httpOnly: false, // el cliente tiene que leerlo para mandarlo en el header
      maxAge: config.auth.refreshTokenTtlDays * 86_400_000,
    })
  );
  return valor;
}

export function ponerCookiesDeSesion(res, { accessToken, refreshToken }) {
  ponerCookieAccess(res, accessToken);
  if (refreshToken) ponerCookieRefresh(res, refreshToken);
  ponerCookieCsrf(res);
}

export function limpiarCookiesDeSesion(res) {
  const comunes = {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    domain: config.cookies.domain,
  };
  res.clearCookie(COOKIE_ACCESS, { ...comunes, path: '/' });
  res.clearCookie(COOKIE_REFRESH, { ...comunes, path: RUTA_REFRESH });
  res.clearCookie(COOKIE_CSRF, { ...comunes, httpOnly: false, path: '/' });
}
