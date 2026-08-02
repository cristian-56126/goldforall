import { useState } from 'react';
import { api } from '../api.js';

// Pantalla a la que lleva el enlace del correo: /restablecer?token=…
// No inicia sesión al terminar; el usuario entra de nuevo con la contraseña
// nueva, para que un enlace filtrado no entregue además una sesión activa.
export default function ResetPasswordView({ token }) {
  const [password, setPassword] = useState('');
  const [repetir, setRepetir] = useState('');
  const [error, setError] = useState('');
  const [listo, setListo] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== repetir) {
      setError('Las dos contraseñas no coinciden');
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setListo(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const irAlInicio = () => {
    window.location.href = '/';
  };

  return (
    <div className="auth-wrap">
      <header className="auth-hero">
        <div className="logo-big">Gold<span>ForAll</span></div>
        <p className="tagline">Elige una contraseña nueva</p>
      </header>

      <div className="card auth-card">
        {!token ? (
          <>
            <p className="error">El enlace está incompleto. Solicita uno nuevo desde la pantalla de ingreso.</p>
            <button className="btn-gold" onClick={irAlInicio}>Ir al inicio</button>
          </>
        ) : listo ? (
          <>
            <p className="exito">Contraseña actualizada. Ya puedes ingresar con ella.</p>
            <button className="btn-gold" onClick={irAlInicio}>Ir a ingresar</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <label>
              Contraseña nueva
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>

            <label>
              Repite la contraseña
              <input
                type="password"
                value={repetir}
                onChange={(e) => setRepetir(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>

            {error && <p className="error">{error}</p>}

            <button className="btn-gold" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar contraseña'}
            </button>
            <p className="hint">
              Al cambiarla se cierran todas las sesiones abiertas en otros dispositivos.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
