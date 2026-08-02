import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  ...config.db.conexion,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Un error en una conexión ociosa del pool emite 'error' en el pool; sin este
// listener Node tumba el proceso por excepción no capturada.
pool.on('error', (err) => {
  console.error('[db] error en conexión ociosa del pool:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Ejecuta una función dentro de una transacción con su propia conexión.
 * COMMIT si resuelve, ROLLBACK si lanza. La conexión siempre se devuelve al pool.
 */
export async function enTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    try {
      await cliente.query('ROLLBACK');
    } catch (errorRollback) {
      console.error('[db] falló el ROLLBACK:', errorRollback.message);
    }
    throw err;
  } finally {
    cliente.release();
  }
}

// Espacios de nombres para los advisory locks. Postgres los indexa por par de
// enteros; separar por espacio evita que dos funcionalidades distintas se
// bloqueen entre sí por usar el mismo user_id.
export const CERROJO = {
  CUOTA: 1001,
  SUSCRIPCION: 1002,
};

/**
 * Cerrojo por usuario, válido hasta el fin de la transacción actual.
 * Serializa operaciones que leen-y-luego-escriben (cuota diaria, alta de
 * suscripción) para que dos peticiones en paralelo no se pisen.
 */
export async function cerrojoDeUsuario(cliente, espacio, userId) {
  await cliente.query('SELECT pg_advisory_xact_lock($1, $2)', [espacio, userId]);
}

export async function cerrarPool() {
  await pool.end();
}
