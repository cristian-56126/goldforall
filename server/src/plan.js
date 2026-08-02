import { config } from './config.js';
import { query } from './db.js';

// El día de la cuota se calcula en la zona horaria del negocio y se expresa
// como rango de timestamptz. Se usa un rango y no
// "created_at::date = CURRENT_DATE" porque la comparación por fecha no puede
// aprovechar el índice (user_id, created_at) y obliga a recorrer todo el
// historial del usuario en cada consulta.
const SQL_CUOTA_DEL_DIA = `
  WITH dia AS (
    SELECT (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS inicio
  )
  SELECT
    (SELECT count(*)::int
       FROM conversion_queries c, dia
      WHERE c.user_id = $1
        AND c.created_at >= dia.inicio
        AND c.created_at <  dia.inicio + interval '1 day')  AS usadas,
    (SELECT inicio + interval '1 day' FROM dia)             AS reinicio
`;

/**
 * Plan efectivo del usuario y consumo del día.
 * Sin suscripción vigente => 'free'. Con suscripción vigente => 'premium'.
 * Acepta un cliente de transacción para poder contar dentro del mismo cerrojo
 * que ejecuta el INSERT de la conversión.
 */
export async function getUserPlanStatus(userId, cliente) {
  const ejecutar = cliente ? cliente.query.bind(cliente) : query;
  const zona = config.cuota.zonaHoraria;

  const suscripcion = await ejecutar(
    `SELECT p.code, p.name, p.daily_query_limit, s.expires_at
       FROM user_subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > now()
      ORDER BY s.expires_at DESC
      LIMIT 1`,
    [userId]
  );

  let plan;
  let expiraEn = null;
  if (suscripcion.rows[0]) {
    plan = suscripcion.rows[0];
    expiraEn = suscripcion.rows[0].expires_at;
  } else {
    const gratis = await ejecutar(
      `SELECT code, name, daily_query_limit FROM plans WHERE code = 'free'`
    );
    plan = gratis.rows[0];
    if (!plan) {
      // La semilla no corrió: mejor fallar claro que servir cuota infinita.
      throw new Error('Falta el plan "free" en la base. Corre: pnpm migrate');
    }
  }

  const cuota = await ejecutar(SQL_CUOTA_DEL_DIA, [userId, zona]);
  const usadasHoy = cuota.rows[0].usadas;
  const limite = plan.daily_query_limit; // null = ilimitado

  return {
    plan_code: plan.code,
    plan_name: plan.name,
    daily_limit: limite,
    used_today: usadasHoy,
    remaining_today: limite === null ? null : Math.max(0, limite - usadasHoy),
    resets_at: cuota.rows[0].reinicio,
    timezone: zona,
    subscription_expires_at: expiraEn,
  };
}
