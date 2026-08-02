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

let cacheOro = null; // { goldUsdOz, goldUpdatedAt, fetchedAt }
let cacheTasas = null; // { rates, ratesUpdatedAt, fetchedAt }

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

async function obtenerOro() {
  if (cacheOro && Date.now() - cacheOro.fetchedAt < config.precios.goldCacheMs) return cacheOro;
  try {
    const oro = await traerJson(config.precios.goldApiUrl);
    const goldUsdOz = Number(oro.price);
    if (!Number.isFinite(goldUsdOz) || goldUsdOz <= 0) {
      throw new Error('Respuesta de API de oro incompleta');
    }
    cacheOro = { goldUsdOz, goldUpdatedAt: oro.updatedAt || null, fetchedAt: Date.now() };
    return cacheOro;
  } catch (err) {
    if (cacheOro) return cacheOro; // respaldo: último valor conocido
    throw err;
  }
}

async function obtenerTasas() {
  if (cacheTasas && Date.now() - cacheTasas.fetchedAt < config.precios.ratesCacheMs) {
    return cacheTasas;
  }
  try {
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

    cacheTasas = {
      rates,
      ratesUpdatedAt: datos.time_last_update_utc || null,
      fetchedAt: Date.now(),
    };
    return cacheTasas;
  } catch (err) {
    if (cacheTasas) return cacheTasas;
    throw err;
  }
}

export async function getPrices() {
  const [oro, cambio] = await Promise.all([obtenerOro(), obtenerTasas()]);
  return {
    goldUsdOz: oro.goldUsdOz,
    goldUpdatedAt: oro.goldUpdatedAt,
    rates: cambio.rates,
    ratesUpdatedAt: cambio.ratesUpdatedAt,
    fetchedAt: Math.max(oro.fetchedAt, cambio.fetchedAt),
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
