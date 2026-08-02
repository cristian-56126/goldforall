import { useEffect, useState } from 'react';
import { api, URL_LOGIN_GOOGLE } from '../api.js';

export default function AuthView({ onAuthed, aviso, onCerrarAviso }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'olvide'
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [proveedores, setProveedores] = useState({ google: false });

  useEffect(() => {
    // El botón de Google solo se muestra si el servidor lo tiene configurado.
    api.providers().then(setProveedores).catch(() => {});
  }, []);

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const cambiarModo = (nuevo) => {
    setMode(nuevo);
    setError('');
    setOk('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setOk('');
    setBusy(true);
    try {
      if (mode === 'olvide') {
        const respuesta = await api.forgotPassword(form.email);
        setOk(respuesta.message);
      } else if (mode === 'login') {
        await api.login({ email: form.email, password: form.password });
        onAuthed();
      } else {
        await api.register(form);
        onAuthed();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <header className="auth-hero">
        <div className="logo-big">Gold<span>ForAll</span></div>
        <p className="tagline">Compra y venta de oro con precio internacional en tiempo real</p>
      </header>

      {aviso && (
        <div className={aviso.tipo === 'ok' ? 'aviso aviso-ok' : 'aviso aviso-error'}>
          <span>{aviso.texto}</span>
          <button type="button" className="aviso-cerrar" onClick={onCerrarAviso}>
            ×
          </button>
        </div>
      )}

      <form className="card auth-card" onSubmit={submit}>
        <div className="tabs">
          <button
            type="button"
            className={mode === 'login' ? 'tab active' : 'tab'}
            onClick={() => cambiarModo('login')}
          >
            Ingresar
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'tab active' : 'tab'}
            onClick={() => cambiarModo('register')}
          >
            Crear cuenta
          </button>
        </div>

        {mode === 'olvide' && (
          <p className="hint">
            Escribe tu correo y te enviamos un enlace para elegir una contraseña nueva.
          </p>
        )}

        {mode === 'register' && (
          <label>
            Nombre
            <input
              name="name"
              value={form.name}
              onChange={change}
              placeholder="Tu nombre"
              required
              minLength={2}
              maxLength={120}
              autoComplete="name"
            />
          </label>
        )}

        <label>
          Email
          <input
            name="email"
            type="email"
            value={form.email}
            onChange={change}
            placeholder="tu@email.com"
            required
            autoComplete="email"
          />
        </label>

        {mode !== 'olvide' && (
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              value={form.password}
              onChange={change}
              placeholder={mode === 'register' ? 'Mínimo 8 caracteres' : 'Tu contraseña'}
              required
              minLength={mode === 'register' ? 8 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
        )}

        {error && <p className="error">{error}</p>}
        {ok && <p className="exito">{ok}</p>}

        <button className="btn-gold" disabled={busy}>
          {busy
            ? 'Un momento…'
            : mode === 'login'
              ? 'Ingresar'
              : mode === 'register'
                ? 'Crear cuenta gratis'
                : 'Enviar enlace'}
        </button>

        {proveedores.google && mode !== 'olvide' && (
          <>
            <div className="separador"><span>o</span></div>
            {/* Enlace normal, no fetch: el flujo OAuth es una redirección del
                navegador y termina con el servidor poniendo las cookies. */}
            <a className="btn-google" href={URL_LOGIN_GOOGLE}>
              <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
              </svg>
              Continuar con Google
            </a>
          </>
        )}

        <div className="auth-pie">
          {mode === 'olvide' ? (
            <button type="button" className="enlace" onClick={() => cambiarModo('login')}>
              Volver a ingresar
            </button>
          ) : (
            <button type="button" className="enlace" onClick={() => cambiarModo('olvide')}>
              ¿Olvidaste tu contraseña?
            </button>
          )}
        </div>

        {mode === 'register' && (
          <p className="hint">Plan gratis: 3 consultas al día. Premium: ilimitadas.</p>
        )}
      </form>
    </div>
  );
}
