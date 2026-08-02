// Históricos de precio: ventana de las últimas 12 horas únicamente.
// Volumen mínimo: una muestra cada 5 min = máx ~144 filas; la poda en cada
// inserción mantiene la tabla acotada.
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { getPrices } from '../prices.js';

export const priceHistoryRouter = Router();

export async function tomarMuestra() {
  try {
    const precios = await getPrices();
    // Con el proveedor caído, getPrices sirve el último valor conocido
    // (stale). Grabarlo repetiría el mismo número como si fuera una lectura
    // nueva y aplanaría la gráfica con datos falsos; mejor un hueco honesto.
    if (precios.stale) {
      console.error('[muestreador] proveedor caído; muestra omitida (valor de respaldo)');
      return;
    }
    await query(
      `INSERT INTO price_history (gold_usd_oz, usd_cop, usd_gbp, usd_eur)
       VALUES ($1, $2, $3, $4)`,
      [precios.goldUsdOz, precios.rates.COP, precios.rates.GBP, precios.rates.EUR]
    );
    // Retención estricta: solo últimas 12 horas.
    await query(`DELETE FROM price_history WHERE recorded_at < now() - interval '12 hours'`);
  } catch (err) {
    console.error('[muestreador]', err.message);
  }
}

export function arrancarMuestreador() {
  tomarMuestra(); // muestra inmediata al arrancar
  const temporizador = setInterval(tomarMuestra, config.precios.historySampleMs);
  temporizador.unref?.();
  return temporizador;
}

// Serie de las últimas 12 horas + resumen (no consume cuota)
priceHistoryRouter.get(
  '/price-history',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const resultado = await query(
      `SELECT gold_usd_oz, usd_cop, recorded_at
         FROM price_history
        WHERE recorded_at >= now() - interval '12 hours'
        ORDER BY recorded_at`
    );
    const filas = resultado.rows;

    let resumen = null;
    if (filas.length > 0) {
      const valores = filas.map((fila) => Number(fila.gold_usd_oz));
      const primero = valores[0];
      const ultimo = valores[valores.length - 1];
      resumen = {
        first: primero,
        last: ultimo,
        min: Math.min(...valores),
        max: Math.max(...valores),
        change: ultimo - primero,
        change_pct: primero ? ((ultimo - primero) / primero) * 100 : 0,
        samples: filas.length,
      };
    }

    res.json({ hours: 12, history: filas, summary: resumen });
  })
);
