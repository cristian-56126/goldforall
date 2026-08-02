import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { CERROJO, cerrojoDeUsuario, enTransaccion, query } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  errorDemasiadasPeticiones,
  errorNoDisponible,
  errorPeticion,
  errorProhibido,
} from '../lib/errors.js';
import { requireAuth, requireUsuarioActivo } from '../middleware/auth.js';
import { limitadorConversion, limitadorRefrescoPrecios } from '../middleware/security.js';
import { validarBody, validarQuery } from '../middleware/validate.js';
import { getPrices, goldValue } from '../prices.js';
import { getUserPlanStatus } from '../plan.js';

export const apiRouter = Router();

// ---------------------------------------------------------------------------
// Unidades de peso (público: se muestran antes de iniciar sesión)
// ---------------------------------------------------------------------------

apiRouter.get(
  '/units',
  asyncHandler(async (_req, res) => {
    const resultado = await query(
      'SELECT code, name_es, grams, is_traditional FROM weight_units ORDER BY sort_order'
    );
    res.json({ units: resultado.rows });
  })
);

// ---------------------------------------------------------------------------
// Precio spot del oro + tasas del dólar.
// No consume cuota: la consulta que cuenta es la conversión.
// ?refresh=1 salta el cache (botón de actualización manual del frontend);
// pasa por su propio limitador y aun así respeta el piso de 2 s por fuente.
// ---------------------------------------------------------------------------

const esquemaPrecios = z
  .object({ refresh: z.enum(['1', 'true']).optional() })
  .strict();

apiRouter.get(
  '/prices',
  requireAuth,
  validarQuery(esquemaPrecios),
  (req, res, next) => (req.query.refresh ? limitadorRefrescoPrecios(req, res, next) : next()),
  asyncHandler(async (req, res) => {
    let precios;
    try {
      precios = await getPrices({ forzar: Boolean(req.query.refresh) });
    } catch (err) {
      console.error('[precios]', err.message);
      throw errorNoDisponible('No se pudo obtener el precio del oro. Intenta de nuevo.', {
        codigo: 'precios_no_disponibles',
      });
    }
    res.json({
      gold_usd_oz: precios.goldUsdOz,
      gold_updated_at: precios.goldUpdatedAt,
      gold_stale: precios.goldStale,
      rates: precios.rates,
      rates_updated_at: precios.ratesUpdatedAt,
      rates_stale: precios.ratesStale,
      stale: precios.stale,
      fetched_at: new Date(precios.fetchedAt).toISOString(),
    });
  })
);

// ---------------------------------------------------------------------------
// Perfil + estado de plan y cuota
// ---------------------------------------------------------------------------

apiRouter.get(
  '/me',
  requireUsuarioActivo,
  asyncHandler(async (req, res) => {
    const estado = await getUserPlanStatus(req.auth.id);
    res.json({
      user: {
        id: req.usuario.id,
        email: req.usuario.email,
        name: req.usuario.name,
        role: req.usuario.role,
        avatar_url: req.usuario.avatar_url,
        email_verified: req.usuario.email_verified,
        created_at: req.usuario.created_at,
        tiene_password: req.usuario.tiene_password,
        usa_google: req.usuario.tiene_google,
      },
      plan: estado,
    });
  })
);

// ---------------------------------------------------------------------------
// Conversión: LA consulta que consume cuota (3/día en plan gratis).
// ---------------------------------------------------------------------------

const esquemaConversion = z
  .object({
    // Códigos controlados por la tabla weight_units; el patrón evita gastar
    // una consulta por cada cadena arbitraria que llegue.
    unit_code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z_]{2,32}$/, 'Unidad de peso inválida'),
    // .finite() es lo que corta "1e400": Number lo convierte en Infinity, que
    // pasaba la validación anterior y reventaba al insertar en NUMERIC.
    quantity: z.coerce
      .number()
      .finite('La cantidad debe ser un número')
      .positive('La cantidad debe ser mayor que 0')
      .max(1_000_000_000, 'La cantidad es demasiado grande'),
    percentage: z.coerce
      .number()
      .finite()
      .min(0, 'El porcentaje va de 0 a 100')
      .max(100, 'El porcentaje va de 0 a 100')
      .default(100),
  })
  .strict();

apiRouter.post(
  '/convert',
  requireUsuarioActivo,
  limitadorConversion,
  validarBody(esquemaConversion),
  asyncHandler(async (req, res) => {
    const { unit_code: unitCode, quantity, percentage } = req.body;
    const userId = req.auth.id;

    const unidadResultado = await query(
      'SELECT code, name_es, grams FROM weight_units WHERE code = $1',
      [unitCode]
    );
    const unidad = unidadResultado.rows[0];
    if (!unidad) {
      throw errorPeticion(`Unidad desconocida: ${unitCode}`, { codigo: 'unidad_desconocida' });
    }

    // Chequeo barato antes de pedir precios: evita la llamada externa cuando
    // la cuota ya está agotada. El chequeo que manda es el de dentro del
    // cerrojo, más abajo.
    const estadoPrevio = await getUserPlanStatus(userId);
    if (estadoPrevio.remaining_today !== null && estadoPrevio.remaining_today <= 0) {
      throw errorDemasiadasPeticiones(
        `Alcanzaste el límite de ${estadoPrevio.daily_limit} consultas de hoy. ` +
          'Suscríbete al plan Premium para consultas ilimitadas.',
        { codigo: 'cuota_agotada', detalles: { plan: estadoPrevio } }
      );
    }

    // La llamada a las APIs externas va FUERA de la transacción: mantener una
    // conexión y un cerrojo abiertos durante una petición de red agota el pool.
    let precios;
    try {
      precios = await getPrices();
    } catch (err) {
      console.error('[precios]', err.message);
      throw errorNoDisponible('No se pudo obtener el precio del oro. Intenta de nuevo.', {
        codigo: 'precios_no_disponibles',
      });
    }

    const gramosTotales = quantity * Number(unidad.grams);
    const internacional = goldValue(gramosTotales, precios);
    const factor = percentage / 100;
    const valor = {
      usd_per_gram: internacional.usd_per_gram * factor,
      value_usd: internacional.value_usd * factor,
      value_cop: internacional.value_cop * factor,
      value_gbp: internacional.value_gbp * factor,
      value_eur: internacional.value_eur * factor,
    };

    // Contar-y-luego-insertar tiene que ser atómico: sin el cerrojo, N
    // peticiones simultáneas leen "quedan 1" a la vez y todas insertan,
    // saltándose la cuota del plan gratis.
    const planDespues = await enTransaccion(async (cliente) => {
      await cerrojoDeUsuario(cliente, CERROJO.CUOTA, userId);

      const estado = await getUserPlanStatus(userId, cliente);
      if (estado.remaining_today !== null && estado.remaining_today <= 0) {
        throw errorDemasiadasPeticiones(
          `Alcanzaste el límite de ${estado.daily_limit} consultas de hoy. ` +
            'Suscríbete al plan Premium para consultas ilimitadas.',
          { codigo: 'cuota_agotada', detalles: { plan: estado } }
        );
      }

      await cliente.query(
        `INSERT INTO conversion_queries
           (user_id, unit_code, quantity, grams_total, gold_price_usd_oz,
            value_usd, value_cop, value_gbp, value_eur, percentage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          userId,
          unidad.code,
          quantity,
          gramosTotales,
          precios.goldUsdOz,
          valor.value_usd,
          valor.value_cop,
          valor.value_gbp,
          valor.value_eur,
          percentage,
        ]
      );

      return getUserPlanStatus(userId, cliente);
    });

    res.json({
      unit: { code: unidad.code, name: unidad.name_es, grams: Number(unidad.grams) },
      quantity,
      grams_total: gramosTotales,
      percentage,
      gold_usd_oz: precios.goldUsdOz,
      usd_per_gram: valor.usd_per_gram,
      values: {
        USD: valor.value_usd,
        COP: valor.value_cop,
        GBP: valor.value_gbp,
        EUR: valor.value_eur,
      },
      international: {
        USD: internacional.value_usd,
        COP: internacional.value_cop,
        GBP: internacional.value_gbp,
        EUR: internacional.value_eur,
      },
      rates: precios.rates,
      plan: planDespues,
    });
  })
);

// ---------------------------------------------------------------------------
// Historial reciente del usuario
// ---------------------------------------------------------------------------

apiRouter.get(
  '/history',
  requireAuth,
  validarQuery(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict()),
  asyncHandler(async (req, res) => {
    const resultado = await query(
      `SELECT unit_code, quantity, grams_total, gold_price_usd_oz,
              value_usd, value_cop, value_gbp, value_eur, percentage, created_at
         FROM conversion_queries
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.auth.id, req.query.limit]
    );
    res.json({ history: resultado.rows });
  })
);

// ---------------------------------------------------------------------------
// Suscripción Premium
//
// PAGO SIMULADO. No hay cobro real: este endpoint activa 30 días sin cargo.
// Antes de producción hay que sustituirlo por la confirmación de la pasarela
// (Stripe / Wompi / PayU) validando la firma del webhook; el esquema ya trae
// payment_provider / payment_reference / amount_usd para eso, con índice único
// sobre (provider, reference) que evita acreditar dos veces el mismo pago.
// ---------------------------------------------------------------------------

apiRouter.post(
  '/subscribe',
  requireUsuarioActivo,
  asyncHandler(async (req, res) => {
    // Mientras el pago sea simulado y Premium lo gestione el administrador,
    // la autosuscripción queda cerrada: si no, cualquier usuario se activa
    // Premium gratis y la fecha de caducidad que fija el admin no vale nada.
    if (!config.autoSuscripcionAbierta) {
      throw errorProhibido('El plan Premium lo activa un administrador.', {
        codigo: 'suscripcion_cerrada',
      });
    }

    const userId = req.auth.id;

    const resultado = await enTransaccion(async (cliente) => {
      // Sin cerrojo, dos clics seguidos crean dos suscripciones solapadas.
      await cerrojoDeUsuario(cliente, CERROJO.SUSCRIPCION, userId);

      const vigente = await cliente.query(
        `SELECT id, expires_at FROM user_subscriptions
          WHERE user_id = $1 AND status = 'active' AND expires_at > now()
          ORDER BY expires_at DESC LIMIT 1`,
        [userId]
      );
      if (vigente.rows[0]) {
        return { yaTenia: true, expiresAt: vigente.rows[0].expires_at };
      }

      const plan = await cliente.query(`SELECT id FROM plans WHERE code = 'premium'`);
      if (plan.rowCount === 0) {
        // Antes esto era plan.rows[0].id y reventaba con TypeError -> 500 opaco.
        throw errorNoDisponible('El plan Premium no está configurado. Corre: pnpm migrate', {
          codigo: 'plan_ausente',
        });
      }

      const creada = await cliente.query(
        `INSERT INTO user_subscriptions
           (user_id, plan_id, expires_at, payment_provider, is_simulated)
         VALUES ($1, $2, now() + interval '30 days', 'simulado', true)
         RETURNING id, expires_at`,
        [userId, plan.rows[0].id]
      );
      return { yaTenia: false, expiresAt: creada.rows[0].expires_at };
    });

    const estado = await getUserPlanStatus(userId);

    if (resultado.yaTenia) {
      return res.json({
        message: 'Ya tienes Premium activo.',
        pago_simulado: true,
        plan: estado,
      });
    }

    return res.status(201).json({
      message: 'Suscripción Premium activada por 30 días (pago simulado)',
      pago_simulado: true,
      plan: estado,
    });
  })
);
