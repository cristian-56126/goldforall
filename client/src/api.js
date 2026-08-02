// Cliente HTTP.
//
// No hay token en localStorage: la sesión vive en cookies httpOnly que el
// JavaScript de la página no puede leer, así que un XSS no puede robarla.
// A cambio hacen falta dos cosas:
//   1. credentials: 'include' en cada petición, para que el navegador las mande.
//   2. El header X-CSRF-Token copiado de la cookie gfa_csrf (la única legible)
//      en toda petición que modifique datos.
//
// El access token dura 15 minutos. Cuando caduca, la API responde 401 y este
// módulo pide /auth/refresh una sola vez y reintenta la petición original, de
// forma transparente para las vistas.

const COOKIE_CSRF = 'gfa_csrf';
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Se dispara cuando la sesión ya no se puede recuperar: App vuelve al login. */
export const eventos = new EventTarget();

function leerCookie(nombre) {
  const encontrada = document.cookie
    .split('; ')
    .find((parte) => parte.startsWith(`${nombre}=`));
  return encontrada ? decodeURIComponent(encontrada.slice(nombre.length + 1)) : null;
}

export function haySesionProbable() {
  // La cookie CSRF no es la sesión, pero se pone y se borra junto a ella:
  // sirve para no pedir /me en el primer arranque cuando nadie ha entrado.
  return Boolean(leerCookie(COOKIE_CSRF));
}

class ErrorApi extends Error {
  constructor(mensaje, { status, codigo, detalles } = {}) {
    super(mensaje);
    this.name = 'ErrorApi';
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

// Un solo /refresh en vuelo aunque caduquen a la vez cinco peticiones: sin
// esto, cada una rotaría el refresh token y las demás verían un token ya
// rotado, que el servidor interpreta como robo y cierra la sesión entera.
let refrescoEnCurso = null;

async function refrescarSesion() {
  if (!refrescoEnCurso) {
    refrescoEnCurso = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': leerCookie(COOKIE_CSRF) || '' },
    })
      .then((respuesta) => respuesta.ok)
      .catch(() => false)
      .finally(() => {
        refrescoEnCurso = null;
      });
  }
  return refrescoEnCurso;
}

async function peticion(ruta, { method = 'GET', body, _reintento = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!METODOS_SEGUROS.has(method)) {
    const csrf = leerCookie(COOKIE_CSRF);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const respuesta = await fetch(ruta, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const datos = await respuesta.json().catch(() => ({}));

  if (respuesta.ok) return datos;

  const esRutaDeSesion = ruta.startsWith('/api/auth/refresh') || ruta.startsWith('/api/auth/login');
  const tokenCaducado =
    respuesta.status === 401 && ['token_expirado', 'sin_token'].includes(datos.codigo);

  if (tokenCaducado && !_reintento && !esRutaDeSesion) {
    if (await refrescarSesion()) {
      return peticion(ruta, { method, body, _reintento: true });
    }
    eventos.dispatchEvent(new CustomEvent('sesion-terminada'));
  }

  if (respuesta.status === 401 && !tokenCaducado && !esRutaDeSesion) {
    eventos.dispatchEvent(new CustomEvent('sesion-terminada'));
  }

  throw new ErrorApi(datos.error || `Error ${respuesta.status}`, {
    status: respuesta.status,
    codigo: datos.codigo,
    detalles: datos.detalles,
  });
}

const get = (ruta) => peticion(ruta);
const post = (ruta, body) => peticion(ruta, { method: 'POST', body });

export const api = {
  // Sesión
  providers: () => get('/api/auth/providers'),
  register: (datos) => post('/api/auth/register', datos),
  login: (datos) => post('/api/auth/login', datos),
  logout: () => post('/api/auth/logout'),
  logoutAll: () => post('/api/auth/logout-all'),
  sessions: () => get('/api/auth/sessions'),
  revokeSession: (id) => peticion(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  forgotPassword: (email) => post('/api/auth/forgot-password', { email }),
  resetPassword: (token, password) => post('/api/auth/reset-password', { token, password }),
  changePassword: (actual, nueva) => post('/api/auth/change-password', { actual, nueva }),

  // Datos
  me: () => get('/api/me'),
  units: () => get('/api/units'),
  prices: () => get('/api/prices'),
  convert: (datos) => post('/api/convert', datos),
  history: () => get('/api/history'),
  priceHistory: () => get('/api/price-history'),
  subscribe: () => post('/api/subscribe'),

  // Administración
  adminStats: () => get('/api/admin/stats'),
  adminUsers: (parametros = {}) => {
    const query = new URLSearchParams(
      Object.entries(parametros).filter(([, valor]) => valor !== '' && valor != null)
    ).toString();
    return get(`/api/admin/users${query ? `?${query}` : ''}`);
  },
  adminCreateUser: (datos) => post('/api/admin/users', datos),
  // password ausente = el servidor genera una temporal y la devuelve una vez
  adminSetPassword: (id, password) => post(`/api/admin/users/${id}/password`, password ? { password } : {}),
  adminSetRole: (id, role) => peticion(`/api/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),
  adminDisable: (id) => post(`/api/admin/users/${id}/disable`),
  adminEnable: (id) => post(`/api/admin/users/${id}/enable`),
  adminRevokeSessions: (id) => post(`/api/admin/users/${id}/revoke-sessions`),
  // datos: { dias: 30 } para extender, o { hasta: 'AAAA-MM-DD' } para fijar
  // la caducidad exacta (inclusiva, zona horaria del negocio)
  adminGrantPremium: (id, datos = {}) => post(`/api/admin/users/${id}/subscription`, datos),
  adminRevokePremium: (id) => peticion(`/api/admin/users/${id}/subscription`, { method: 'DELETE' }),
};

export const URL_LOGIN_GOOGLE = '/api/auth/google';
