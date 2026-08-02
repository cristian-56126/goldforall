// Primitivas criptográficas compartidas.
import crypto from 'node:crypto';

/** Token aleatorio apto para enlaces y cookies (256 bits). */
export function tokenAleatorio(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 en hex. Se usa para guardar refresh tokens y tokens de recuperación:
 * la base nunca almacena el valor en claro, así que una copia de la base no
 * permite suplantar sesiones. bcrypt sería innecesario aquí porque el token ya
 * tiene 256 bits de entropía (no hay diccionario que probar).
 */
export function hashToken(valor) {
  return crypto.createHash('sha256').update(valor, 'utf8').digest('hex');
}

/** Comparación en tiempo constante; tolera longitudes distintas sin filtrarlas. */
export function comparacionSegura(a, b) {
  const bufferA = Buffer.from(String(a), 'utf8');
  const bufferB = Buffer.from(String(b), 'utf8');
  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual exige misma longitud: se compara contra sí mismo para
    // gastar el mismo tiempo y devolver false.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** HMAC-SHA256 en base64url. */
export function firmarHmac(valor, secreto) {
  return crypto.createHmac('sha256', secreto).update(valor, 'utf8').digest('base64url');
}

export function uuid() {
  return crypto.randomUUID();
}

/**
 * Parte un token con formato "<id>.<secreto>".
 * El id permite buscar la fila por clave primaria en lugar de recorrer hashes.
 */
export function partirTokenCompuesto(bruto) {
  if (typeof bruto !== 'string') return null;
  const separador = bruto.indexOf('.');
  if (separador <= 0 || separador === bruto.length - 1) return null;
  const id = bruto.slice(0, separador);
  const secreto = bruto.slice(separador + 1);
  // El id es un UUID: si no lo parece, ni siquiera se consulta la base.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { id, secreto };
}
