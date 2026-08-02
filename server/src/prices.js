// Precios externos con cache en memoria, TTL separado por fuente.
// API 1: oro internacional (USD por onza troy) - gold-api.com, gratis sin key.
//        Se actualiza cada pocos minutos; cache corto (10 s) para frescura máxima.
// API 2: dólar internacional (tasas USD -> COP/GBP/EUR) - open.er-api.com,
//        gratis sin key. El proveedor actualiza 1 vez al día; cache 10 min.
import { config } from './config.js';

const TROY_OZ_GRAMS = 31.1035;

// Corta la petición si el proveedor no responde: sin esto, un proveedor colgado
// deja peticiones esperando indefinidamente y agota el pool de conexiones.
const TIMEOUT_MS = 8000;

// Piso del refresco forzado: aunque el cliente pida "ahora", nunca se golpea
// al proveedor más de una vez cada 2 s por fuente. Protege a las APIs
// gratuitas de un dedo nervioso o de muchos usuarios pulsando a la vez.
const FORZADO_MIN_MS = 2000;

// Tras un fallo del proveedor, se sirve el último valor conocido sin
// reintentar durante este lapso: si no, cada petición esperaría el timeout de
// 8 s mientras el proveedor siga caído. El refresco forzado sí reintenta.
const FALLO_BACKOFF_MS = 30_000;

async function traerJson(url) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controlador.signal,
    });
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} desde ${url}`);
    return await respuesta.json();
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Fuente de datos con cache, deduplicación y respaldo:
 *  - TTL normal, o piso de FORZADO_MIN_MS cuando forzar=true.
 *  - Una sola petición en vuelo: N peticiones con el cache vencido esperan el
 *    mismo fetch en lugar de disparar N contra el proveedor.
 *  - Si el proveedor falla y hay valor previo, se sirve marcado stale=true;
 *    fetchedAt conserva la hora del último dato real.
 */
function crearFuente({ nombre, ttlMs, traer }) {
  let cache = null;
  let enVuelo = null;
  let ultimoFallo = 0;

  return async function obtener(forzar = false) {
    if (cache) {
      const edad = Date.now() - cache.fetchedAt;
      if (edad < (forzar ? FORZADO_MIN_MS : ttlMs)) return cache;
      if (!forzar && cache.stale && Date.now() - ultimoFallo < FALLO_BACKOFF_MS) {
        return cache;
      }
    }
    if (!enVuelo) {
      enVuelo = traer()
        .then((fresco) => {
          cache = { ...fresco, fetchedAt: Date.now(), stale: false };
          return cache;
        })
        .catch((err) => {
          ultimoFallo = Date.now();
          if (cache) {
            cache = { ...cache, stale: true }; // respaldo: último valor conocido
            console.error(`[precios] ${nombre}: ${err.message} — sirviendo último valor conocido`);
            return cache;
          }
          throw err;
        })
        .finally(() => {
          enVuelo = null;
        });
    }
    return enVuelo;
  };
}

const obtenerOro = crearFuente({
  nombre: 'oro',
  ttlMs: config.precios.goldCacheMs,
  async traer() {
    const oro = await traerJson(config.precios.goldApiUrl);
    const goldUsdOz = Number(oro.price);
    if (!Number.isFinite(goldUsdOz) || goldUsdOz <= 0) {
      throw new Error('Respuesta de API de oro incompleta');
    }
    return { goldUsdOz, goldUpdatedAt: oro.updatedAt || null };
  },
});

const obtenerTasas = crearFuente({
  nombre: 'tasas',
  ttlMs: config.precios.ratesCacheMs,
  async traer() {
    const datos = await traerJson(config.precios.ratesApiUrl);
    const rates = {
      USD: 1,
      COP: Number(datos?.rates?.COP),
      GBP: Number(datos?.rates?.GBP),
      EUR: Number(datos?.rates?.EUR),
    };
    const validas = [rates.COP, rates.GBP, rates.EUR].every(
      (valor) => Number.isFinite(valor) && valor > 0
    );
    if (!validas) throw new Error('Respuesta de API de tasas incompleta');
    return { rates, ratesUpdatedAt: datos.time_last_update_utc || null };
  },
});

export async function getPrices({ forzar = false } = {}) {
  const [oro, cambio] = await Promise.all([obtenerOro(forzar), obtenerTasas(forzar)]);
  return {
    goldUsdOz: oro.goldUsdOz,
    goldUpdatedAt: oro.goldUpdatedAt,
    goldFetchedAt: oro.fetchedAt,
    goldStale: Boolean(oro.stale),
    rates: cambio.rates,
    ratesUpdatedAt: cambio.ratesUpdatedAt,
    ratesFetchedAt: cambio.fetchedAt,
    ratesStale: Boolean(cambio.stale),
    fetchedAt: Math.max(oro.fetchedAt, cambio.fetchedAt),
    stale: Boolean(oro.stale || cambio.stale),
  };
}

export function goldValue(gramsTotal, prices) {
  const usdPerGram = prices.goldUsdOz / TROY_OZ_GRAMS;
  const valueUsd = gramsTotal * usdPerGram;
  return {
    usd_per_gram: usdPerGram,
    value_usd: valueUsd,
    value_cop: valueUsd * prices.rates.COP,
    value_gbp: valueUsd * prices.rates.GBP,
    value_eur: valueUsd * prices.rates.EUR,
  };
}

export { TROY_OZ_GRAMS };
