// Rutas de administración. Todas pasan por requireRole('admin'), que relee el
// rol de la base en cada petición: un admin degradado pierde el acceso al
// instante, sin esperar a que caduque su access token.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, enTransaccion, cerrojoDeUsuario, CERROJO } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
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
          WHERE revoked_at IS NULL AND expires_at > now())                   AS sesiones_activas
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

    const resultado = await query(
      `SELECT u.id, u.email, u.name, u.role, u.email_verified, u.created_at,
              u.disabled_at, (u.google_id IS NOT NULL) AS usa_google,
              (u.password_hash IS NOT NULL) AS tiene_password,
              s.expires_at AS premium_hasta,
              (SELECT count(*)::int FROM conversion_queries c WHERE c.user_id = u.id) AS conversiones
         FROM users u
         LEFT JOIN LATERAL (
           SELECT expires_at FROM user_subscriptions
            WHERE user_id = u.id AND status = 'active' AND expires_at > now()
            ORDER BY expires_at DESC LIMIT 1
         ) s ON true
        WHERE $1::text IS NULL OR u.email ILIKE $1 OR u.name ILIKE $1
        ORDER BY u.created_at DESC
        LIMIT $2 OFFSET $3`,
      [patron, limit, offset]
    );

    const total = await query(
      `SELECT count(*)::int AS n FROM users
        WHERE $1::text IS NULL OR email ILIKE $1 OR name ILIKE $1`,
      [patron]
    );

    res.json({ users: resultado.rows, total: total.rows[0].n, limit, offset });
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

/** Alta manual de Premium (cortesía, soporte, pago fuera de la pasarela). */
adminRouter.post(
  '/users/:id/subscription',
  validarParams(esquemaIdUsuario),
  validarBody(z.object({ dias: z.coerce.number().int().min(1).max(3650).default(30) }).strict()),
  asyncHandler(async (req, res) => {
    const objetivo = Number(req.params.id);
    const { dias } = req.body;

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

      // Si ya tiene Premium vigente, se extiende desde su vencimiento en lugar
      // de crear una segunda suscripción solapada.
      const vigente = await cliente.query(
        `SELECT id, expires_at FROM user_subscriptions
          WHERE user_id = $1 AND status = 'active' AND expires_at > now()
          ORDER BY expires_at DESC LIMIT 1`,
        [objetivo]
      );

      if (vigente.rows[0]) {
        const extendida = await cliente.query(
          `UPDATE user_subscriptions
              SET expires_at = expires_at + ($2 || ' days')::interval
            WHERE id = $1
            RETURNING id, expires_at`,
          [vigente.rows[0].id, String(dias)]
        );
        return extendida.rows[0];
      }

      const creada = await cliente.query(
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
