// Política de contraseñas y hashing.
//
// Criterio NIST SP 800-63B: longitud mínima razonable y bloqueo de las
// contraseñas más usadas, en vez de reglas de composición (una mayúscula, un
// símbolo...) que empujan a la gente a "Password1!" y no aportan entropía real.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { tokenAleatorio } from './seguridad.js';

export const LONGITUD_MINIMA = 8;
// bcrypt trunca en silencio a partir del byte 72: aceptar más daría una falsa
// sensación de seguridad (dos contraseñas largas con prefijo común colisionan).
export const BYTES_MAXIMOS = 72;

const MAS_USADAS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
  'qwerty123', 'qwertyuiop', '11111111', '00000000', 'abc12345', 'iloveyou',
  'admin123', 'administrador', 'contrasena', 'contraseña', 'micontrasena',
  'football', 'baseball', 'sunshine', 'princess', 'welcome1', 'letmein1',
  'monkey123', 'dragon123', 'superman', 'trustno1', 'starwars', 'goldforall',
]);

export const esquemaContrasena = z
  .string()
  .min(LONGITUD_MINIMA, `La contraseña debe tener mínimo ${LONGITUD_MINIMA} caracteres`)
  .refine(
    (valor) => Buffer.byteLength(valor, 'utf8') <= BYTES_MAXIMOS,
    `La contraseña no puede superar los ${BYTES_MAXIMOS} bytes`
  )
  .refine(
    (valor) => !MAS_USADAS.has(valor.toLowerCase()),
    'Esa contraseña es demasiado común. Elige otra.'
  );

/** Rechaza contraseñas derivadas del propio correo o nombre. */
export function contrasenaEsDerivadaDelUsuario(contrasena, { email, name } = {}) {
  const normalizada = contrasena.toLowerCase();
  const parteLocal = String(email || '').split('@')[0].toLowerCase();
  if (parteLocal.length >= 4 && normalizada.includes(parteLocal)) return true;
  const nombre = String(name || '').trim().toLowerCase();
  if (nombre.length >= 4 && normalizada.includes(nombre)) return true;
  return false;
}

// Alfabeto sin caracteres que se confunden al dictar o copiar a mano
// (0/O, 1/l/I). Una contraseña temporal se transcribe, así que la ambigüedad
// cuesta soporte.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * Contraseña temporal para una cuenta creada por un administrador.
 * 16 caracteres del alfabeto anterior ≈ 92 bits de entropía, elegidos con
 * rechazo de módulo para que la distribución sea uniforme.
 */
export function generarContrasenaTemporal(longitud = 16) {
  const limite = 256 - (256 % ALFABETO.length);
  let salida = '';
  while (salida.length < longitud) {
    for (const byte of crypto.randomBytes(longitud)) {
      if (byte >= limite) continue; // descarta el sesgo del módulo
      salida += ALFABETO[byte % ALFABETO.length];
      if (salida.length === longitud) break;
    }
  }
  return salida;
}

export function hashearContrasena(contrasena) {
  return bcrypt.hash(contrasena, config.auth.bcryptRounds);
}

export function verificarContrasena(contrasena, hash) {
  return bcrypt.compare(contrasena, hash);
}

// Hash señuelo generado al arrancar sobre un valor aleatorio: nadie conoce su
// preimagen. Sirve para gastar el mismo tiempo de CPU cuando el correo no
// existe, de modo que el atacante no pueda distinguir "usuario inexistente" de
// "contraseña incorrecta" midiendo la latencia.
const HASH_SENUELO = bcrypt.hashSync(tokenAleatorio(24), config.auth.bcryptRounds);

export async function gastarTiempoDeVerificacion() {
  await bcrypt.compare('contrasena-que-no-existe', HASH_SENUELO);
}
