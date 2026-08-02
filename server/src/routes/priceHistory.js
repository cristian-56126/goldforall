// Históricos de precio: ventana de las últimas 6 horas únicamente.
// Volumen mínimo: una muestra cada 5 min = máx ~72 filas; la poda en cada
// inserción mantiene la tabla acotada.
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { getPrices } from '../prices.js';

// Único número que define la ventana: lo usan la poda, la consulta y la
// respuesta (de ahí sale el título de la gráfica en el cliente).
const VENTANA_HORAS = 6;

export const priceHistoryRouter = Router();

// Hora de la última muestra grabada por este proceso. Evita repetir la
// consulta de "¿hace cuánto fue la última?" en cada petición de la gráfica.
let ultimaMuestraMs = 0;
let muestraEnVuelo = null;

async function grabarMuestra() {
  try {
    const precios = await getPrices();
    // Con el proveedor de oro caído, getPrices sirve el último valor conocido
    // (stale). Grabarlo repetiría el mismo número como si fuera una lectura
    // nueva y aplanaría la gráfica con datos falsos; mejor un hueco honesto.
    //
    // Solo se mira goldStale: la gráfica es del oro. Las tasas de cambio se
    // publican una vez al día, así que servirlas desde cache es lo normal y
    // no es motivo para tirar una lectura de oro que sí es fresca.
    if (precios.goldStale) {
      console.error('[muestreador] proveedor de oro caído; muestra omitida (valor de respaldo)');
      return;
    }
    await query(
      `INSERT INTO price_history (gold_usd_oz, usd_cop, usd_gbp, usd_eur)
       VALUES ($1, $2, $3, $4)`,
      [precios.goldUsdOz, precios.rates.COP, precios.rates.GBP, precios.rates.EUR]
    );
    ultimaMuestraMs = Date.now();
    // Retención estricta: solo la ventana declarada.
    // make_interval con cast explícito: node-postgres manda los parámetros sin
    // tipo declarado, y "$1 * interval" deja la resolución del operador al
    // criterio del planificador.
    await query(
      `DELETE FROM price_history WHERE recorded_at < now() - make_interval(hours => $1::int)`,
      [VENTANA_HORAS]
    );
  } catch (err) {
    console.error('[muestreador]', err.message);
  }
}

/** Nunca rechaza. Si ya hay una muestra en curso, se espera a esa. */
export function tomarMuestra() {
  if (!muestraEnVuelo) {
    muestraEnVuelo = grabarMuestra().finally(() => {
      muestraEnVuelo = null;
    });
  }
  return muestraEnVuelo;
}

export function arrancarMuestreador() {
  tomarMuestra(); // muestra inmediata al arrancar
  const temporizador = setInterval(tomarMuestra, config.precios.historySampleMs);
  temporizador.unref?.();
  return temporizador;
}

// Serie de la ventana + resumen (no consume cuota)
priceHistoryRouter.get(
  '/price-history',
  requireAuth,
  asyncHandler(async (_req, res) => {
    // El temporizador solo corre mientras el proceso está vivo, y el plan
    // gratuito de Render duerme la instancia cuando nadie la usa: de ahí los
    // huecos de horas en la serie. Si la muestra que tocaba no se llegó a
    // grabar (arranque con el proveedor caído, temporizador retrasado), se
    // lanza aquí para que la curva se rellene mientras alguien la mira.
    //
    // Sin await a propósito: el proveedor tarda hasta 8 s en dar timeout y la
    // gráfica no debe quedarse esperando por eso. La muestra entra a tiempo
    // para el siguiente sondeo del cliente, que es cada 60 s.
    if (Date.now() - ultimaMuestraMs >= config.precios.historySampleMs) {
      tomarMuestra();
    }

    const resultado = await query(
      `SELECT gold_usd_oz, usd_cop, recorded_at
         FROM price_history
        WHERE recorded_at >= now() - make_interval(hours => $1::int)
        ORDER BY recorded_at`,
      [VENTANA_HORAS]
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

    res.json({
      hours: VENTANA_HORAS,
      // Cada cuánto se espera una muestra: el cliente lo usa para saber qué
      // separación entre puntos es un hueco real y no dibujar una recta
      // atravesando un tramo que nadie midió.
      sample_seconds: Math.round(config.precios.historySampleMs / 1000),
      history: filas,
      summary: resumen,
    });
  })
);
