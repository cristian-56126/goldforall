// Express 4 no captura las promesas rechazadas de un handler async: el error
// se pierde y la petición queda colgada hasta el timeout del cliente.
// Todo handler async del proyecto va envuelto en esto.
export function asyncHandler(handler) {
  return function envoltorio(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
