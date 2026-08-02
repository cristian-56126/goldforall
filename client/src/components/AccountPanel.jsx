import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AccountPanel({ user, onLogout }) {
  const [sesiones, setSesiones] = useState([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState({ actual: '', nueva: '', repetir: '' });
  const [ocupado, setOcupado] = useState(false);

  const cargarSesiones = useCallback(async () => {
    try {
      const datos = await api.sessions();
      setSesiones(datos.sessions);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    cargarSesiones();
  }, [cargarSesiones]);

  const cambiarContrasena = async (e) => {
    e.preventDefault();
    setError('');
    setOk('');
    if (form.nueva !== form.repetir) {
      setError('Las dos contraseñas nuevas no coinciden');
      return;
    }
    setOcupado(true);
    try {
      const respuesta = await api.changePassword(form.actual, form.nueva);
      setOk(respuesta.message);
      setForm({ actual: '', nueva: '', repetir: '' });
      await cargarSesiones();
    } catch (err) {
      setError(err.message);
    } finally {
      setOcupado(false);
    }
  };

  const revocar = async (id) => {
    setError('');
    try {
      await api.revokeSession(id);
      await cargarSesiones();
    } catch (err) {
      setError(err.message);
    }
  };

  const cerrarTodas = async () => {
    try {
      await api.logoutAll();
    } finally {
      onLogout();
    }
  };

  return (
    <div className="cuenta">
      <h2 className="seccion-titulo">Tu cuenta</h2>

      <div className="card">
        <h3>Datos</h3>
        <p className="plan-line">{user.name}</p>
        <p className="plan-line small">{user.email}</p>
        <p className="plan-line small">
          Rol: <b>{user.role}</b>
          {user.usa_google ? ' · vinculada con Google' : ''}
        </p>
      </div>

      <div className="card">
        <h3>Sesiones activas</h3>
        {sesiones.length === 0 && <p className="plan-line small">No hay sesiones registradas.</p>}
        <ul className="lista-sesiones">
          {sesiones.map((sesion) => (
            <li key={sesion.id}>
              <div>
                <b>{sesion.es_la_actual ? 'Este dispositivo' : 'Otro dispositivo'}</b>
                <span className="plan-line small">
                  {String(sesion.dispositivo || 'desconocido').slice(0, 60)} · {sesion.ip}
                </span>
                <span className="plan-line small">
                  Inició {new Date(sesion.iniciada_en).toLocaleString('es-CO')}
                </span>
              </div>
              {!sesion.es_la_actual && (
                <button className="btn-mini peligro" onClick={() => revocar(sesion.id)}>
                  Cerrar
                </button>
              )}
            </li>
          ))}
        </ul>
        <button className="btn-ghost" onClick={cerrarTodas}>
          Cerrar sesión en todos los dispositivos
        </button>
      </div>

      <form className="card" onSubmit={cambiarContrasena}>
        <h3>Cambiar contraseña</h3>
        {!user.tiene_password && (
          <p className="hint">
            Tu cuenta entra con Google. Para definir una contraseña usa
            “¿Olvidaste tu contraseña?” en la pantalla de ingreso.
          </p>
        )}
        <label>
          Contraseña actual
          <input
            type="password"
            value={form.actual}
            onChange={(e) => setForm({ ...form, actual: e.target.value })}
            required
            autoComplete="current-password"
            disabled={!user.tiene_password}
          />
        </label>
        <label>
          Contraseña nueva
          <input
            type="password"
            value={form.nueva}
            onChange={(e) => setForm({ ...form, nueva: e.target.value })}
            required
            minLength={8}
            autoComplete="new-password"
            disabled={!user.tiene_password}
          />
        </label>
        <label>
          Repite la nueva
          <input
            type="password"
            value={form.repetir}
            onChange={(e) => setForm({ ...form, repetir: e.target.value })}
            required
            minLength={8}
            autoComplete="new-password"
            disabled={!user.tiene_password}
          />
        </label>

        {error && <p className="error">{error}</p>}
        {ok && <p className="exito">{ok}</p>}

        <button className="btn-gold" disabled={ocupado || !user.tiene_password}>
          {ocupado ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
        <p className="hint">Al cambiarla se cierran las sesiones de los demás dispositivos.</p>
      </form>
    </div>
  );
}
