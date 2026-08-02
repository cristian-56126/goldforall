// Rutas de administración. Todas pasan por requireRole('admin'), que relee el
// rol de la base en cada petición: un admin degradado pierde el acceso al
// instante, sin esperar a que caduque su access token.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, enTransaccion, cerrojoDeUsuario, CERROJO } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  contrasenaEsDerivadaDelUsuario,
  esquemaContrasena,
  generarContrasenaTemporal,
  hashearContrasena,
} from '../lib/contrasenas.js';
import { errorConflicto, errorNoEncontrado, errorPeticion } from '../lib/errors.js';
import { revocarTodasLasSesiones } from '../lib/tokens.js';
import { requireRole } from '../middleware/auth.js';
import { validarBody, validarParams, validarQuery } from '../middleware/validate.js';

export const adminRouter = Router();

adminRouter.use(requireRole('admin'));

const esquemaIdUsuario = z.object({ id: z.coerce.number().int().positive() });

const esquemaListado = z
  .object({
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const esquemaEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Correo electrónico inválido');

// La contraseña es opcional: si no viene, el servidor genera una temporal y la
// devuelve UNA sola vez en la respuesta. Nunca se vuelve a poder leer, porque
// lo que se guarda es el hash bcrypt.
const esquemaAltaDeUsuario = z
  .object({
    name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(120),
    email: esquemaEmail,
    role: z.enum(['user', 'admin']).default('user'),
    password: esquemaContrasena.optional(),
  })
  .strict();

const esquemaCambioDeContrasena = z
  .object({ password: esquemaContrasena.optional() })
  .strict();

// Otorgar Premium: por duración (dias) o hasta una fecha concreta (hasta,
// AAAA-MM-DD). "hasta" es inclusiva: caduca al terminar ese día en la zona
// horaria del negocio, porque "caduca el 2 de septiembre" significa que el
// día 2 todavía funciona.
const esquemaPremium = z
  .object({
    dias: z.coerce.number().int().min(1).max(3650).optional(),
    hasta: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato AAAA-MM-DD')
      .optional(),
  })
  .strict()
  .refine((datos) => !(datos.dias !== undefined && datos.hasta !== undefined), {
    message: 'Envía "dias" o "hasta", no ambos',
  });

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria de la cuota. */
function hoyEnZona() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.cuota.zonaHoraria }).format(
    new Date()
  );
}

// ---------------------------------------------------------------------------

/**
 * Diagnóstico de despliegue. Sirve sobre todo para calibrar TRUST_PROXY:
 * detrás del rewrite de Vercel hacia Render hay dos saltos de proxy, y si el
 * número no coincide, "ip" sale como la del proxy en lugar de la del cliente.
 * Cuando eso pasa, todos los usuarios comparten un mismo cubo de rate limit y
 * el freno a la fuerza bruta deja de servir.
 *
 * Comprobación tras desplegar: abrir esta ruta y verificar que "ip" es tu IP
 * pública real. Si no lo es, subir o bajar TRUST_PROXY hasta que cuadre.
 * Solo accesible con rol admin; no expone secretos.
 */
adminRouter.get('/diagnostico', (req, res) => {
  res.json({
    entorno: config.env,
    red: {
      ip_detectada: req.ip,
      ips_de_la_cadena: req.ips,
      x_forwarded_for: req.get('x-forwarded-for') || null,
      x_forwarded_proto: req.get('x-forwarded-proto') || null,
      protocolo_detectado: req.protocol,
      host: req.get('host'),
      trust_proxy_configurado: config.trustProxy,
    },
    cookies: {
      secure: config.cookies.secure,
      same_site: config.cookies.sameSite,
      domain: config.cookies.domain || '(host-only)',
    },
    cors_permitidos: config.corsOrigins,
    base_de_datos: {
      gestionada: config.db.esGestionada,
      tls: config.db.ssl === false ? 'apagado' : config.db.ssl.rejectUnauthorized ? 'verificado' : 'sin verificar CA',
    },
    integraciones: {
      google: config.google.habilitado,
      google_redirect_uri: config.google.redirectUri,
      smtp: config.smtp.habilitado,
    },
    urls: { app: config.appUrl, api: config.apiUrl },
  });
});

adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const resultado = await query(`
      SELECT
        (SELECT count(*)::int FROM users)                                    AS usuarios,
        (SELECT count(*)::int FROM users WHERE role = 'admin')               AS admins,
        (SELECT count(*)::int FROM users WHERE disabled_at IS NOT NULL)      AS desactivados,
        (SELECT count(*)::int FROM users WHERE google_id IS NOT NULL)        AS con_google,
        (SELECT count(DISTINCT user_id)::int FROM user_subscriptions
          WHERE status = 'active' AND expires_at > now())                    AS premium_activos,
        (SELECT count(*)::int FROM conversion_queries)                       AS conversiones_totales,
        (SELECT count(*)::int FROM conversion_queries
          WHERE created_at > now() - interval '24 hours')                    AS conversiones_24h,
        (SELECT count(*)::int FROM refresh_tokens
          WHERE revoked_at IS NULL AND expires_at > now())                   AS sesiones_activas,
        (SELECT count(DISTINCT user_id)::int FROM refresh_tokens
          WHERE revoked_at IS NULL AND expires_at > now()
            AND issued_at > now() - interval '20 minutes')                   AS en_linea
    `);
    res.json({ stats: resultado.rows[0] });
  })
);

adminRouter.get(
  '/users',
  validarQuery(esquemaListado),
  asyncHandler(async (req, res) => {
    const { q, limit, offset } = req.query;
    // El texto de búsqueda va como parámetro, nunca concatenado al SQL.
    const patron = q ? `%${q}%` : null;

    // Actividad por usuario:
    //  - sesiones_activas: refresh tokens vivos (sesión abierta en algún lado).
    //  - ultima_conexion: emisión más reciente de un refresh token. Como el
    //    token rota cada ~15 min mientras la app está abierta, esto aproxima
    //    "última vez activo" con esa granularidad, sin registrar cada request.
    //  - consultas_hoy: conversiones del día en la zona horaria del negocio
    //    (misma ventana que usa la cuota del plan gratis).
    const resultado = await query(
      `SELECT u.id, u.email, u.name, u.role, u.email_verified, u.created_at,
              u.disabled_at, (u.google_id IS NOT NULL) AS usa_google,
              (u.password_hash IS NOT NULL) AS tiene_password,
              s.expires_at AS premium_hasta,
              t.sesiones_activas,
              t.ultima_conexion,
              hoy.consultas_hoy,
              (SELECT count(*)::int FROM conversion_queries c WHERE c.user_id = u.id) AS conversiones
         FROM users u
         LEFT JOIN LATERAL (
           SELECT expires_at FROM user_subscriptions
            WHERE user_id = u.id AND status = 'active' AND expires_at > now()
            ORDER BY expires_at DESC LIMIT 1
         ) s ON true
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE rt.revoked_at IS NULL AND rt.expires_at > now())::int
                    AS sesiones_activas,
                  max(rt.issued_at) AS ultima_conexion
             FROM refresh_tokens rt WHERE rt.user_id = u.id
         ) t ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS consultas_hoy
             FROM conversion_queries c
            WHERE c.user_id = u.id
              AND c.created_at >= (date_trunc('day', now() AT TIME ZONE $4) AT TIME ZONE $4)
         ) hoy ON true
        WHERE $1::text IS NULL OR u.email ILIKE $1 OR u.name ILIKE $1
        ORDER BY u.created_at DESC
        LIMIT $2 OFFSET $3`,
      [patron, limit, offset, config.cuota.zonaHoraria]
    );

    const total = await query(
      `SELECT count(*)::int AS n FROM users
        WHERE $1::text IS NULL OR email ILIKE $1 OR name ILIKE $1`,
      [patron]
    );

    res.json({ users: resultado.rows, total: total.rows[0].n, limit, offset });
  })
);

/**
 * Alta de usuario por un administrador. Es la única vía de creación de
 * cuentas cuando ALLOW_PUBLIC_REGISTRATION está en false.
 */
adminRouter.post(
  '/users',
  validarBody(esquemaAltaDeUsuario),
  asyncHandler(async (req, res) => {
    const { name, email, role } = req.body;

    const generada = !req.body.password;
    const contrasena = req.body.password ?? generarContrasenaTemporal();

    if (contrasenaEsDerivadaDelUsuario(contrasena, { email, name })) {
      throw errorPeticion('La contraseña no puede contener el nombre ni el correo del usuario', {
        codigo: 'contrasena_derivada',
      });
    }

    const hash = await hashearContrasena(contrasena);

    let usuario;
    try {
      const resultado = await query(
        `INSERT INTO users (email, password_hash, name, role, email_verified)
         VALUES ($1, $2, $3, $4, false)
         RETURNING id, email, name, role, created_at`,
        [email, hash, name, role]
      );
      usuario = resultado.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw errorConflicto('Ese correo ya tiene una cuenta', { codigo: 'email_duplicado' });
      }
      throw err;
    }

    res.status(201).json({
      user: usuario,
      // Solo se devuelve si la generó el servidor: si la eligió el admin, ya
      // la conoce y repetirla solo la expone en un log más.
      password_temporal: generada ? contrasena : undefined,
      message: generada
        ? 'Usuario creado. Copia la contraseña temporal: no se vuelve a mostrar.'
        : 'Usuario creado.',
    });
  })
);

/** Fija o regenera la contraseña de un usuario y lo saca de todas sus sesiones. */
adminRouter.post(
  '/users/:id/password',
  validarParams(esquemaIdUsuario),
  validarBody(esquemaCambioDeContrasena),
  asyncHandler(async (req, res) => {
    const objetivo = Number(req.params.id);

    // Cambiarse la propia contraseña por aquí cerraría la sesión en curso y
    // además se saltaría la confirmación de la contraseña actual.
    if (objetivo === req.auth.id) {
      throw errorPeticion('Para tu propia contraseña usa Cuenta → Cambiar contraseña', {
        codigo: 'usa_change_password',
      });
    }

    const datos = await query('SELECT id, email, name FROM users WHERE id = $1', [objetivo]);
    const usuario = datos.rows[0];
    if (!usuario) throw errorNoEncontrado('Usuario no encontrado');

    const generada = !req.body.password;
    const contrasena = req.body.password ?? generarContrasenaTemporal();

    if (contrasenaEsDerivadaDelUsuario(contrasena, usuario)) {
      throw errorPeticion('La contraseña no puede contener el nombre ni el correo del usuario', {
        codigo: 'contrasena_derivada',
      });
    }

    const hash = await hashearContrasena(contrasena);
    await query(
      `UPDATE users
          SET password_hash = $2,
              tokens_valid_from = date_trunc('second', now()),
              updated_at = now()
        WHERE id = $1`,
      [objetivo, hash]
    );
    // Una contraseña cambiada por soporte tiene que invalidar lo anterior:
    // si la cuenta estaba comprometida, dejar sesiones vivas no arregla nada.
    await revocarTodasLasSesiones(objetivo, 'contrasena_fijada_por_admin');

    res.json({
      password_temporal: generada ? contrasena : undefined,
      message: generada
        ? 'Contraseña regenerada. Cópiala: no se vuelve a mostrar. Se cerraron sus sesiones.'
        : 'Contraseña actualizada. Se cerraron sus sesiones.',
    });
  })
);

adminRouter.patch(
  '/users/:id/role',
  validarParams(esquemaIdUsuario),
  validarBody(z.object({ role: z.enum(['user', 'admin']) }).strict()),
  asyncHandler(async (req, res) => {
    const objetivo = Number(req.params.id);
    const { role } = req.body;

    // Un admin no puede quitarse el rol a sí mismo: evita quedarse fuera de la
    // administración por accidente.
    if (objetivo === req.auth.id && role !== 'admin') {
      throw errorPeticion('No puedes quitarte a ti mismo el rol de admin', {
        codigo: 'autodegradacion',
      });
    }

    const actualizado = await enTransaccion(async (cliente) => {
      if (role !== 'admin') {
        // Nunca dejar el sistema sin ningún admin.
        const admins = await cliente.query(
          `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL`
        );
        if (admins.rows[0].n <= 1) {
          throw errorConflicto('No puedes dejar el sistema sin administradores', {
            codigo: 'ultimo_admin',
          });
        }
      }
      const resultado = await cliente.query(
        `UPDATE users SET role = $2, updated_at = now() WHERE id = $1
         RETURNING id, email, name, role`,
        [objetivo, role]
      );
      if (resultado.rowCount === 0) throw errorNoEncontrado('Usuario no encontrado');
      return resultado.rows[0];
    });

    // El rol viaja dentro del access token; forzar el cierre de sesión hace que
    // el siguiente inicio lo emita ya con el rol nuevo.
    await revocarTodasLasSesiones(objetivo, 'rol_cambiado');

    res.json({ user: actualizado, message: 'Rol actualizado. Se cerraron sus sesiones.' });
  })
);

adminRouter.post(
  '/users/:id/disable',
  validarParams(esquemaIdUsuario),
  asyncHandler(async (req, res) => {
    const objetivo = Number(req.params.id);
    if (objetivo === req.auth.id) {
      throw errorPeticion('No puedes desactivar tu propia cuenta', { codigo: 'autodesactivacion' });
    }
    const resultado = await query(
      `UPDATE users SET disabled_at = now(), updated_at = now()
        WHERE id = $1 AND disabled_at IS NULL
        RETURNING id, email, disabled_at`,
      [objetivo]
    );
    if (resultado.rowCount === 0) {
      throw errorNoEncontrado('Usuario no encontrado o ya estaba desactivado');
    }
    await revocarTodasLasSesiones(objetivo, 'cuenta_desactivada');
    res.json({ user: resultado.rows[0], message: 'Cuenta desactivada y sesiones cerradas' });
  })
);

adminRouter.post(
  '/users/:id/enable',
  validarParams(esquemaIdUsuario),
  asyncHandler(async (req, res) => {
    const resultado = await query(
      `UPDATE users SET disabled_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING id, email, disabled_at`,
      [Number(req.params.id)]
    );
    if (resultado.rowCount === 0) throw errorNoEncontrado('Usuario no encontrado');
    res.json({ user: resultado.rows[0], message: 'Cuenta reactivada' });
  })
);

adminRouter.post(
  '/users/:id/revoke-sessions',
  validarParams(esquemaIdUsuario),
  asyncHandler(async (req, res) => {
    await revocarTodasLasSesiones(Number(req.params.id), 'revocado_por_admin');
    res.json({ message: 'Sesiones cerradas' });
  })
);

/**
 * Alta manual de Premium (cortesía, soporte, pago fuera de la pasarela).
 * Dos modos:
 *   { dias: 30 }            extiende desde el vencimiento vigente (o desde hoy)
 *   { hasta: '2026-09-02' } fija la caducidad exacta, inclusive, en la zona
 *                           del negocio — pisa la fecha anterior si la había
 * Sin cuerpo: 30 días.
 */
adminRouter.post(
  '/users/:id/subscription',
  validarParams(esquemaIdUsuario),
  validarBody(esquemaPremium),
  asyncHandler(async (req, res) => {
    const objetivo = Number(req.params.id);
    const { hasta } = req.body;
    const dias = req.body.dias ?? (hasta ? undefined : 30);
    const zona = config.cuota.zonaHoraria;

    if (hasta && hasta < hoyEnZona()) {
      throw errorPeticion('La fecha de caducidad no puede estar en el pasado', {
        codigo: 'fecha_pasada',
      });
    }

    const suscripcion = await enTransaccion(async (cliente) => {
      await cerrojoDeUsuario(cliente, CERROJO.SUSCRIPCION, objetivo);

      const existe = await cliente.query('SELECT 1 FROM users WHERE id = $1', [objetivo]);
      if (existe.rowCount === 0) throw errorNoEncontrado('Usuario no encontrado');

      const plan = await cliente.query(`SELECT id FROM plans WHERE code = 'premium'`);
      if (plan.rowCount === 0) {
        throw errorConflicto('Falta el plan premium. Corre "pnpm migrate".', {
          codigo: 'plan_ausente',
        });
      }

      // Una sola suscripción vigente por usuario: si existe se actualiza, no
      // se apila una segunda fila solapada.
      const vigente = await cliente.query(
        `SELECT id, expires_at FROM user_subscriptions
          WHERE user_id = $1 AND status = 'active' AND expires_at > now()
          ORDER BY expires_at DESC LIMIT 1`,
        [objetivo]
      );

      // Caducidad inclusiva con "hasta": medianoche del día SIGUIENTE en la
      // zona del negocio — "hasta el 2" = el día 2 completo sigue siendo
      // Premium. Con fecha explícita se FIJA (el admin define la caducidad,
      // aunque acorte); con días se extiende desde el vencimiento vigente.
      if (vigente.rows[0]) {
        const actualizada = hasta
          ? await cliente.query(
              `UPDATE user_subscriptions
                  SET expires_at = ((($2)::date + 1)::timestamp AT TIME ZONE $3)
                WHERE id = $1 RETURNING id, expires_at`,
              [vigente.rows[0].id, hasta, zona]
            )
          : await cliente.query(
              `UPDATE user_subscriptions
                  SET expires_at = expires_at + ($2 || ' days')::interval
                WHERE id = $1 RETURNING id, expires_at`,
              [vigente.rows[0].id, String(dias)]
            );
        return actualizada.rows[0];
      }

      const creada = hasta
        ? await cliente.query(
            `INSERT INTO user_subscriptions
               (user_id, plan_id, expires_at, payment_provider, is_simulated, granted_by)
             VALUES ($1, $2, ((($3)::date + 1)::timestamp AT TIME ZONE $4), 'admin', true, $5)
             RETURNING id, expires_at`,
            [objetivo, plan.rows[0].id, hasta, zona, req.auth.id]
          )
        : await cliente.query(
            `INSERT INTO user_subscriptions
               (user_id, plan_id, expires_at, payment_provider, is_simulated, granted_by)
             VALUES ($1, $2, now() + ($3 || ' days')::interval, 'admin', true, $4)
             RETURNING id, expires_at`,
            [objetivo, plan.rows[0].id, String(dias), req.auth.id]
          );
      return creada.rows[0];
    });

    res.status(201).json({
      message: `Premium activo hasta ${new Date(suscripcion.expires_at).toISOString()}`,
      subscription: suscripcion,
    });
  })
);

/** Quita el Premium vigente: el usuario vuelve al plan gratis de inmediato. */
adminRouter.delete(
  '/users/:id/subscription',
  validarParams(esquemaIdUsuario),
  asyncHandler(async (req, res) => {
    const resultado = await query(
      `UPDATE user_subscriptions
          SET status = 'cancelled'
        WHERE user_id = $1 AND status = 'active' AND expires_at > now()
        RETURNING id`,
      [Number(req.params.id)]
    );
    if (resultado.rowCount === 0) {
      throw errorPeticion('Ese usuario no tiene Premium vigente', { codigo: 'sin_premium' });
    }
    res.json({ message: 'Premium retirado. El usuario vuelve al plan gratis.' });
  })
);
