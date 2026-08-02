// Validación de entrada con zod. Nada llega a la lógica de negocio sin pasar
// por un esquema: cierra de golpe la clase de bugs de "Number('1e400') pasa la
// validación y revienta el INSERT".
import { errorPeticion } from '../lib/errors.js';

function validar(fuente, esquema) {
  return (req, _res, next) => {
    const resultado = esquema.safeParse(req[fuente]);
    if (!resultado.success) {
      const detalles = resultado.error.issues.map((issue) => ({
        campo: issue.path.join('.') || fuente,
        mensaje: issue.message,
      }));
      return next(
        errorPeticion(detalles[0]?.mensaje || 'Datos inválidos', {
          codigo: 'validacion',
          detalles,
        })
      );
    }
    // Se reemplaza por el valor ya parseado y saneado (coerciones, trim,
    // campos desconocidos fuera).
    req[fuente] = resultado.data;
    return next();
  };
}

export const validarBody = (esquema) => validar('body', esquema);
export const validarQuery = (esquema) => validar('query', esquema);
export const validarParams = (esquema) => validar('params', esquema);
