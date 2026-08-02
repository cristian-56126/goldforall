import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, enTransaccion } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  contrasenaEsDerivadaDelUsuario,
  esquemaContrasena,
  gastarTiempoDeVerificacion,
  hashearContrasena,
  verificarContrasena,
} from '../lib/contrasenas.js';
import {
  COOKIE_REFRESH,
  limpiarCookiesDeSesion,
  ponerCookiesDeSesion,
} from '../lib/cookies.js';
import {
  errorConflicto,
  errorDemasiadasPeticiones,
  errorNoAutenticado,
  errorPeticion,
  errorProhibido,
} from '../lib/errors.js';
import { correoDeRecuperacion, enviarCorreo } from '../lib/mailer.js';
import { hashToken, partirTokenCompuesto, tokenAleatorio, uuid, comparacionSegura } from '../lib/seguridad.js';
import {
  emitirRefreshToken,
  firmarAccessToken,
  revocarTodasLasSesiones,
  revocarUnToken,
  rotarRefreshToken,
} from '../lib/tokens.js';
import { requireAuth, requireUsuarioActivo } from '../middleware/auth.js';
import {
  limitadorLogin,
  limitadorRecuperacion,
  limitadorRefresh,
  limitadorRegistro,
} from '../middleware/security.js';
import { validarBody, validarParams } from '../middleware/validate.js';

export const authRouter = Router();

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const esquemaEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Correo electrónico inválido');

const esquemaRegistro = z
  .object({
    name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(120),
    email: esquemaEmail,
    password: esquemaContrasena,
  })
  .strict()
  .refine((datos) => !contrasenaEsDerivadaDelUsuario(datos.password, datos), {
    path: ['password'],
    message: 'La contraseña no puede contener tu nombre ni tu correo',
  });

const esquemaLogin = z
  .object({
    email: esquemaEmail,
    password: z.string().min(1, 'La contraseña es obligatoria').max(200),
  })
  .strict();

const esquemaOlvide = z.object({ email: esquemaEmail }).strict();

const esquemaRestablecer = z
  .object({
    token: z.string().min(10).max(200),
    password: esquemaContrasena,
  })
  .strict();

const esquemaCambio = z
  .object({
    actual: z.string().min(1, 'Tu contraseña actual es obligatoria').max(200),
    nueva: esquemaContrasena,
  })
  .strict();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    email: usuario.email,
    name: usuario.name,
    role: usuario.role,
    avatar_url: usuario.avatar_url ?? null,
    email_verified: usuario.email_verified ?? false,
    created_at: usuario.created_at,
  };
}

/** Firma el access token, emite refresh y deja las tres cookies puestas. */
export async function establecerSesion(res, usuario, req, { familyId } = {}) {
  const accessToken = firmarAccessToken(usuario);
  const refreshToken = await emitirRefreshToken({ userId: usuario.id, familyId, req });
  ponerCookiesDeSesion(res, { accessToken, refreshToken });
  return accessToken;
}

const VENTANA_BLOQUEO_MINUTOS = 15;
const FALLOS_PARA_BLOQUEAR = 10;

async function registrarIntentoDeLogin(email, ip, exito) {
  await query('INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, $3)', [
    email,
    ip ? String(ip).slice(0, 45) : null,
    exito,
  ]);
}

/**
 * Bloqueo por cuenta. El rate limit por IP no protege contra un atacante
 * distribuido que ataca un solo correo desde muchas direcciones; esto sí.
 * Solo cuentan los fallos posteriores al último inicio de sesión correcto.
 */
async function verificarBloqueoDeCuenta(email) {
  const resultado = await query(
    `SELECT count(*)::int AS fallos
       FROM login_attempts
      WHERE email = $1
        AND succeeded = false
        AND created_at > now() - ($2 || ' minutes')::interval
        AND created_at > COALESCE(
          (SELECT max(created_at) FROM login_attempts
            WHERE email = $1 AND succeeded = true),
          'epoch'::timestamptz)`,
    [email, String(VENTANA_BLOQUEO_MINUTOS)]
  );
  if (resultado.rows[0].fallos >= FALLOS_PARA_BLOQUEAR) {
    throw errorDemasiadasPeticiones(
      `Demasiados intentos fallidos. Esta cuenta queda bloqueada ${VENTANA_BLOQUEO_MINUTOS} minutos.`,
      { codigo: 'cuenta_bloqueada' }
    );
  }
}

// ---------------------------------------------------------------------------
// Qué métodos de acceso están disponibles (el cliente oculta lo que no hay)
// ---------------------------------------------------------------------------

authRouter.get('/providers', (_req, res) => {
  res.json({
    password: true,
    google: config.google.habilitado,
    password_reset: true,
    smtp: config.smtp.habilitado,
    // El frontend oculta "Crear cuenta" cuando esto es false.
    registration_open: config.registroPublicoAbierto,
    // Y los botones "Mejorar a Premium" cuando esto es false.
    self_subscribe: config.autoSuscripcionAbierta,
  });
});

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/**
 * Corta el registro público. Se aplica ANTES de validar y de tocar la base:
 * con el alta cerrada, este endpoint no debe ni siquiera revelar si un correo
 * existe por la vía del error de duplicado.
 */
function exigirRegistroAbierto(_req, _res, next) {
  if (!config.registroPublicoAbierto) {
    return next(
      errorProhibido(
        'El registro está cerrado. Pide a un administrador que cree tu cuenta.',
        { codigo: 'registro_cerrado' }
      )
    );
  }
  return next();
}

authRouter.post(
  '/register',
  exigirRegistroAbierto,
  limitadorRegistro,
  validarBody(esquemaRegistro),
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;

    const hash = await hashearContrasena(password);
    // Los correos declarados en ADMIN_EMAILS entran directamente como admin.
    const rol = config.adminEmails.includes(email) ? 'admin' : 'user';

    let usuario;
    try {
      const resultado = await query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role, avatar_url, email_verified, created_at`,
        [email, hash, name, rol]
      );
      usuario = resultado.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw errorConflicto('Ese correo ya está registrado', { codigo: 'email_duplicado' });
      }
      throw err;
    }

    await establecerSesion(res, usuario, req);
    res.status(201).json({ user: usuarioPublico(usuario) });
  })
);

// ---------------------------------------------------------------------------
// Inicio de sesión
// ---------------------------------------------------------------------------

authRouter.post(
  '/login',
  limitadorLogin,
  validarBody(esquemaLogin),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    await verificarBloqueoDeCuenta(email);

    const resultado = await query(
      `SELECT id, email, name, role, avatar_url, email_verified, created_at,
              password_hash, disabled_at, google_id
         FROM users WHERE email = $1`,
      [email]
    );
    const usuario = resultado.rows[0];

    // Mismo coste de CPU exista o no la cuenta: sin esto, la diferencia de
    // latencia permite enumerar qué correos están registrados.
    if (!usuario || !usuario.password_hash) {
      await gastarTiempoDeVerificacion();
      await registrarIntentoDeLogin(email, req.ip, false);
      // Mensaje idéntico en ambos casos, por el mismo motivo.
      throw errorNoAutenticado('Correo o contraseña incorrectos', { codigo: 'credenciales' });
    }

    const coincide = await verificarContrasena(password, usuario.password_hash);
    if (!coincide) {
      await registrarIntentoDeLogin(email, req.ip, false);
      throw errorNoAutenticado('Correo o contraseña incorrectos', { codigo: 'credenciales' });
    }

    if (usuario.disabled_at) {
      await registrarIntentoDeLogin(email, req.ip, false);
      throw errorProhibido('Cuenta desactivada. Contacta al administrador.', {
        codigo: 'cuenta_desactivada',
      });
    }

    await registrarIntentoDeLogin(email, req.ip, true);
    await establecerSesion(res, usuario, req);
    res.json({ user: usuarioPublico(usuario) });
  })
);

// ---------------------------------------------------------------------------
// Renovación de sesión
// ---------------------------------------------------------------------------

authRouter.post(
  '/refresh',
  limitadorRefresh,
  asyncHandler(async (req, res) => {
    const bruto = req.cookies?.[COOKIE_REFRESH];
    if (!bruto) {
      throw errorNoAutenticado('No hay sesión que renovar', { codigo: 'sin_refresh' });
    }

    let rotacion;
    try {
      rotacion = await rotarRefreshToken(bruto, req);
    } catch (err) {
      // Cualquier fallo de refresh deja al cliente sin cookies: así el
      // frontend pasa a la pantalla de login en vez de reintentar en bucle.
      limpiarCookiesDeSesion(res);
      throw err;
    }

    const accessToken = firmarAccessToken(rotacion.usuario);
    ponerCookiesDeSesion(res, { accessToken, refreshToken: rotacion.refreshToken });
    res.json({ user: usuarioPublico(rotacion.usuario) });
  })
);

// ---------------------------------------------------------------------------
// Cierre de sesión
// ---------------------------------------------------------------------------

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const bruto = req.cookies?.[COOKIE_REFRESH];
    if (bruto) await revocarUnToken(bruto, 'logout');
    limpiarCookiesDeSesion(res);
    res.json({ message: 'Sesión cerrada' });
  })
);

/** Cierra la sesión en todos los dispositivos. */
authRouter.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    await revocarTodasLasSesiones(req.auth.id, 'logout_global');
    limpiarCookiesDeSesion(res);
    res.json({ message: 'Se cerraron todas las sesiones' });
  })
);

// ---------------------------------------------------------------------------
// Sesiones activas del usuario
// ---------------------------------------------------------------------------

authRouter.get(
  '/sessions',
  requireUsuarioActivo,
  asyncHandler(async (req, res) => {
    const actual = partirTokenCompuesto(req.cookies?.[COOKIE_REFRESH] || '');
    const resultado = await query(
      `SELECT id, family_id, issued_at, expires_at, user_agent, ip
         FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY issued_at DESC
        LIMIT 50`,
      [req.auth.id]
    );
    res.json({
      sessions: resultado.rows.map((fila) => ({
        id: fila.id,
        iniciada_en: fila.issued_at,
        expira_en: fila.expires_at,
        dispositivo: fila.user_agent,
        ip: fila.ip,
        es_la_actual: Boolean(actual && actual.id === fila.id),
      })),
    });
  })
);

authRouter.delete(
  '/sessions/:id',
  requireUsuarioActivo,
  validarParams(z.object({ id: z.string().uuid('Identificador de sesión inválido') })),
  asyncHandler(async (req, res) => {
    // El WHERE incluye user_id: nadie puede revocar la sesión de otra cuenta.
    const resultado = await query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = 'revocada_por_usuario'
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [req.params.id, req.auth.id]
    );
    if (resultado.rowCount === 0) {
      throw errorPeticion('Esa sesión ya no está activa', { codigo: 'sesion_inexistente' });
    }
    res.json({ message: 'Sesión revocada' });
  })
);

// ---------------------------------------------------------------------------
// Recuperación de contraseña
// ---------------------------------------------------------------------------

const RESPUESTA_GENERICA_OLVIDE = {
  message:
    'Si el correo corresponde a una cuenta, te enviamos un enlace para restablecer la contraseña.',
};

authRouter.post(
  '/forgot-password',
  limitadorRecuperacion,
  validarBody(esquemaOlvide),
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    const resultado = await query(
      'SELECT id, email, name, disabled_at FROM users WHERE email = $1',
      [email]
    );
    const usuario = resultado.rows[0];

    // La respuesta es idéntica exista o no la cuenta: este endpoint no puede
    // servir para averiguar qué correos están registrados.
    if (!usuario || usuario.disabled_at) {
      return res.json(RESPUESTA_GENERICA_OLVIDE);
    }

    const minutos = config.auth.passwordResetTtlMinutes;
    const id = uuid();
    const secreto = tokenAleatorio(32);

    await enTransaccion(async (cliente) => {
      // Un solo enlace válido a la vez: pedir uno nuevo anula el anterior.
      await cliente.query(
        `UPDATE password_resets SET used_at = now()
          WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
        [usuario.id]
      );
      await cliente.query(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, requested_ip)
         VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5)`,
        [id, usuario.id, hashToken(secreto), String(minutos), req.ip?.slice(0, 45) || null]
      );
    });

    const enlace = `${config.appUrl}/restablecer?token=${encodeURIComponent(`${id}.${secreto}`)}`;
    const { asunto, texto, html } = correoDeRecuperacion({
      nombre: usuario.name,
      enlace,
      minutos,
    });

    try {
      await enviarCorreo({ para: usuario.email, asunto, texto, html });
    } catch (err) {
      // Que falle el SMTP no debe filtrar si la cuenta existe: se registra y
      // se responde igual que en el resto de casos.
      console.error('[mailer] no se pudo enviar la recuperación:', err.message);
    }

    return res.json(RESPUESTA_GENERICA_OLVIDE);
  })
);

authRouter.post(
  '/reset-password',
  limitadorRecuperacion,
  validarBody(esquemaRestablecer),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    const partes = partirTokenCompuesto(token);
    const invalido = () =>
      errorPeticion('El enlace no es válido o ya venció. Solicita uno nuevo.', {
        codigo: 'reset_invalido',
      });
    if (!partes) throw invalido();

    const hash = await hashearContrasena(password);

    await enTransaccion(async (cliente) => {
      const resultado = await cliente.query(
        `SELECT r.id, r.user_id, r.token_hash, r.expires_at, r.used_at,
                u.email, u.name
           FROM password_resets r
           JOIN users u ON u.id = r.user_id
          WHERE r.id = $1
            FOR UPDATE OF r`,
        [partes.id]
      );
      const reset = resultado.rows[0];
      if (!reset) throw invalido();
      if (!comparacionSegura(hashToken(partes.secreto), reset.token_hash)) throw invalido();
      if (reset.used_at) throw invalido();
      if (new Date(reset.expires_at) <= new Date()) throw invalido();

      if (contrasenaEsDerivadaDelUsuario(password, { email: reset.email, name: reset.name })) {
        throw errorPeticion('La contraseña no puede contener tu nombre ni tu correo', {
          codigo: 'contrasena_derivada',
        });
      }

      await cliente.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [reset.id]);
      // tokens_valid_from invalida de golpe todo lo emitido antes de ahora.
      await cliente.query(
        `UPDATE users
            SET password_hash = $2,
                tokens_valid_from = date_trunc('second', now()),
                updated_at = now()
          WHERE id = $1`,
        [reset.user_id, hash]
      );
      await cliente.query(
        `UPDATE refresh_tokens
            SET revoked_at = now(), revoked_reason = 'contrasena_restablecida'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [reset.user_id]
      );
    });

    // No se inicia sesión automáticamente: si el enlace llegó a manos ajenas,
    // haber cambiado la contraseña no debe entregar además una sesión activa.
    limpiarCookiesDeSesion(res);
    res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  })
);

// ---------------------------------------------------------------------------
// Cambio de contraseña con la sesión iniciada
// ---------------------------------------------------------------------------

authRouter.post(
  '/change-password',
  requireUsuarioActivo,
  validarBody(esquemaCambio),
  asyncHandler(async (req, res) => {
    const { actual, nueva } = req.body;

    const resultado = await query('SELECT password_hash FROM users WHERE id = $1', [req.auth.id]);
    const hashActual = resultado.rows[0]?.password_hash;

    if (!hashActual) {
      // Cuenta creada con Google: no hay contraseña que confirmar. Se manda
      // por el flujo de recuperación, que verifica la titularidad del correo.
      throw errorPeticion(
        'Tu cuenta entra con Google. Usa "Olvidé mi contraseña" para definir una.',
        { codigo: 'sin_contrasena' }
      );
    }
    if (!(await verificarContrasena(actual, hashActual))) {
      throw errorNoAutenticado('La contraseña actual no es correcta', { codigo: 'credenciales' });
    }
    if (contrasenaEsDerivadaDelUsuario(nueva, req.usuario)) {
      throw errorPeticion('La contraseña no puede contener tu nombre ni tu correo', {
        codigo: 'contrasena_derivada',
      });
    }

    const nuevoHash = await hashearContrasena(nueva);
    await query(
      `UPDATE users
          SET password_hash = $2,
              tokens_valid_from = date_trunc('second', now()),
              updated_at = now()
        WHERE id = $1`,
      [req.auth.id, nuevoHash]
    );
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = 'contrasena_cambiada'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.auth.id]
    );

    // Se cierra todo y se abre una sesión nueva para quien hizo el cambio:
    // los demás dispositivos quedan fuera, este sigue dentro.
    await establecerSesion(res, req.usuario, req);
    res.json({ message: 'Contraseña actualizada. Se cerraron las demás sesiones.' });
  })
);
