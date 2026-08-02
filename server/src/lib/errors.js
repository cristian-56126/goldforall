// Errores con código HTTP explícito. El manejador global los convierte en
// respuesta JSON; cualquier otro error se reporta como 500 genérico sin
// filtrar el mensaje interno al cliente.
export class AppError extends Error {
  constructor(status, mensaje, { codigo, detalles } = {}) {
    super(mensaje);
    this.name = 'AppError';
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
    this.esPublico = true;
  }
}

export const errorPeticion = (mensaje, opciones) => new AppError(400, mensaje, opciones);
export const errorNoAutenticado = (mensaje = 'No autenticado', opciones) =>
  new AppError(401, mensaje, opciones);
export const errorProhibido = (mensaje = 'No tienes permiso para esta acción', opciones) =>
  new AppError(403, mensaje, opciones);
export const errorNoEncontrado = (mensaje = 'Recurso no encontrado', opciones) =>
  new AppError(404, mensaje, opciones);
export const errorConflicto = (mensaje, opciones) => new AppError(409, mensaje, opciones);
export const errorDemasiadasPeticiones = (mensaje, opciones) => new AppError(429, mensaje, opciones);
export const errorNoDisponible = (mensaje, opciones) => new AppError(503, mensaje, opciones);
export const errorNoImplementado = (mensaje, opciones) => new AppError(501, mensaje, opciones);
