import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// Solo se renderiza si el usuario tiene rol admin, pero eso es cosmético:
// quien manda es el servidor, que revalida el rol contra la base en cada
// petición a /api/admin.
export default function AdminPanel() {
  const [stats, setStats] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [total, setTotal] = useState(0);
  const [busqueda, setBusqueda] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [nuevo, setNuevo] = useState({ name: '', email: '', role: 'user', password: '' });
  // Contraseña temporal recién generada. El servidor solo la devuelve una vez
  // (guarda el hash), así que se muestra hasta que el admin la descarta.
  const [credencial, setCredencial] = useState(null);
  // Editor de Premium abierto para un usuario concreto (id) y su fecha.
  const [premiumEdit, setPremiumEdit] = useState(null);
  const [premiumHasta, setPremiumHasta] = useState('');

  const hoy = new Date().toISOString().slice(0, 10);
  const enUnMes = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const abrirPremium = (usuario) => {
    setPremiumEdit(usuario.id);
    // Si ya tiene Premium, se parte de su vencimiento actual; si no, de +30 días.
    setPremiumHasta(
      usuario.premium_hasta ? String(usuario.premium_hasta).slice(0, 10) : enUnMes
    );
  };

  // "En línea" = sesión viva cuya última renovación es reciente. El refresh
  // token rota cada ~15 min mientras la app está abierta, así que 20 min de
  // margen distingue "app abierta ahora" de "dejó sesión iniciada".
  const estadoDeConexion = (usuario) => {
    if (!usuario.sesiones_activas) return { clase: 'off', texto: 'Sin sesión' };
    const ultima = usuario.ultima_conexion ? new Date(usuario.ultima_conexion).getTime() : 0;
    if (Date.now() - ultima < 20 * 60_000) return { clase: 'on', texto: 'En línea' };
    return { clase: 'idle', texto: 'Sesión abierta' };
  };

  const formatearFecha = (valor) => {
    if (!valor) return '—';
    return new Date(valor).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const cargar = useCallback(async (q = '') => {
    setError('');
    try {
      const [datosStats, datosUsuarios] = await Promise.all([
        api.adminStats(),
        api.adminUsers({ q, limit: 50 }),
      ]);
      setStats(datosStats.stats);
      setUsuarios(datosUsuarios.users);
      setTotal(datosUsuarios.total);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const ejecutar = async (accion) => {
    setOcupado(true);
    setError('');
    try {
      await accion();
      await cargar(busqueda);
    } catch (err) {
      setError(err.message);
    } finally {
      setOcupado(false);
    }
  };

  const buscar = (e) => {
    e.preventDefault();
    cargar(busqueda);
  };

  const crearUsuario = async (e) => {
    e.preventDefault();
    setOcupado(true);
    setError('');
    try {
      const datos = {
        name: nuevo.name,
        email: nuevo.email,
        role: nuevo.role,
        // Sin contraseña, el servidor genera una temporal y la devuelve.
        ...(nuevo.password ? { password: nuevo.password } : {}),
      };
      const respuesta = await api.adminCreateUser(datos);
      if (respuesta.password_temporal) {
        setCredencial({ email: respuesta.user.email, password: respuesta.password_temporal });
      }
      setNuevo({ name: '', email: '', role: 'user', password: '' });
      await cargar(busqueda);
    } catch (err) {
      setError(err.message);
    } finally {
      setOcupado(false);
    }
  };

  const regenerarContrasena = async (usuario) => {
    setOcupado(true);
    setError('');
    try {
      const respuesta = await api.adminSetPassword(usuario.id);
      if (respuesta.password_temporal) {
        setCredencial({ email: usuario.email, password: respuesta.password_temporal });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setOcupado(false);
    }
  };

  const copiar = (texto) => {
    navigator.clipboard?.writeText(texto).catch(() => {});
  };

  return (
    <div className="admin">
      <h2 className="seccion-titulo">Administración</h2>

      {error && <p className="error">{error}</p>}

      {stats && (
        <div className="admin-stats">
          <Metrica etiqueta="Usuarios" valor={stats.usuarios} />
          <Metrica etiqueta="Admins" valor={stats.admins} />
          <Metrica etiqueta="Premium" valor={stats.premium_activos} />
          <Metrica etiqueta="Desactivados" valor={stats.desactivados} />
          <Metrica etiqueta="Con Google" valor={stats.con_google} />
          <Metrica etiqueta="Sesiones" valor={stats.sesiones_activas} />
          <Metrica etiqueta="En línea ahora" valor={stats.en_linea} />
          <Metrica etiqueta="Conversiones 24 h" valor={stats.conversiones_24h} />
          <Metrica etiqueta="Conversiones total" valor={stats.conversiones_totales} />
        </div>
      )}

      {credencial && (
        <div className="credencial">
          <div>
            <b>Contraseña temporal de {credencial.email}</b>
            <p className="hint">
              No se vuelve a mostrar: la base solo guarda el hash. Entrégasela por un
              canal seguro y pídele que la cambie al ingresar.
            </p>
            <code className="credencial-valor">{credencial.password}</code>
          </div>
          <div className="acciones">
            <button className="btn-mini" onClick={() => copiar(credencial.password)}>
              Copiar
            </button>
            <button className="btn-mini" onClick={() => setCredencial(null)}>
              Ya la guardé
            </button>
          </div>
        </div>
      )}

      <form className="card admin-alta" onSubmit={crearUsuario}>
        <h3>Crear usuario</h3>
        <p className="hint">
          El registro público está cerrado: esta es la única vía de alta de cuentas.
        </p>

        <div className="admin-alta-campos">
          <label>
            Nombre
            <input
              value={nuevo.name}
              onChange={(e) => setNuevo({ ...nuevo, name: e.target.value })}
              required
              minLength={2}
              maxLength={120}
              placeholder="Nombre y apellido"
            />
          </label>
          <label>
            Correo
            <input
              type="email"
              value={nuevo.email}
              onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })}
              required
              placeholder="persona@empresa.com"
            />
          </label>
          <label>
            Rol
            <select
              value={nuevo.role}
              onChange={(e) => setNuevo({ ...nuevo, role: e.target.value })}
            >
              <option value="user">Usuario</option>
              <option value="admin">Administrador</option>
            </select>
          </label>
          <label>
            Contraseña <span className="etiqueta-menor">opcional</span>
            <input
              type="text"
              value={nuevo.password}
              onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })}
              minLength={8}
              placeholder="Vacío = se genera una segura"
              autoComplete="off"
            />
          </label>
        </div>

        <button className="btn-gold" disabled={ocupado}>
          {ocupado ? 'Creando…' : 'Crear usuario'}
        </button>
      </form>

      <form className="admin-buscar" onSubmit={buscar}>
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por nombre o correo"
          maxLength={120}
        />
        <button className="btn-ghost" type="submit">Buscar</button>
      </form>

      <p className="hint">{total} usuario(s)</p>

      <div className="tabla-envoltorio">
        <table className="tabla">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Actividad</th>
              <th>Consultas</th>
              <th>Premium</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((usuario) => {
              const conexion = estadoDeConexion(usuario);
              return (
              <tr key={usuario.id} className={usuario.disabled_at ? 'fila-inactiva' : undefined}>
                <td>
                  <div className="celda-usuario">
                    <b>{usuario.name}</b>
                    <span>{usuario.email}</span>
                    <span>
                      {usuario.tiene_password ? 'contraseña' : ''}
                      {usuario.tiene_password && usuario.usa_google ? ' + ' : ''}
                      {usuario.usa_google ? 'Google' : ''}
                    </span>
                    {usuario.disabled_at && <span className="etiqueta roja">desactivado</span>}
                  </div>
                </td>
                <td>
                  <span className={usuario.role === 'admin' ? 'etiqueta dorada' : 'etiqueta'}>
                    {usuario.role}
                  </span>
                </td>
                <td className="celda-menor">
                  <span className={`estado-conexion ${conexion.clase}`}>{conexion.texto}</span>
                  <span className="celda-linea">Última: {formatearFecha(usuario.ultima_conexion)}</span>
                  {usuario.sesiones_activas > 1 && (
                    <span className="celda-linea">{usuario.sesiones_activas} sesiones</span>
                  )}
                </td>
                <td className="celda-menor">
                  <span className="celda-linea">Hoy: <b>{usuario.consultas_hoy}</b></span>
                  <span className="celda-linea">Total: {usuario.conversiones}</span>
                </td>
                <td className="celda-menor">
                  {usuario.premium_hasta ? (
                    <>
                      <span className="etiqueta dorada">premium</span>
                      <span className="celda-linea">
                        hasta {new Date(usuario.premium_hasta).toLocaleDateString('es-CO')}
                      </span>
                    </>
                  ) : (
                    'gratis (3/día)'
                  )}
                </td>
                <td>
                  <div className="acciones">
                    <button
                      className="btn-mini"
                      disabled={ocupado}
                      onClick={() =>
                        premiumEdit === usuario.id ? setPremiumEdit(null) : abrirPremium(usuario)
                      }
                    >
                      Premium…
                    </button>
                    <button
                      className="btn-mini"
                      disabled={ocupado}
                      onClick={() =>
                        ejecutar(() =>
                          api.adminSetRole(usuario.id, usuario.role === 'admin' ? 'user' : 'admin')
                        )
                      }
                    >
                      {usuario.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}
                    </button>
                    <button
                      className="btn-mini"
                      disabled={ocupado}
                      onClick={() => regenerarContrasena(usuario)}
                    >
                      Nueva contraseña
                    </button>
                    <button
                      className="btn-mini"
                      disabled={ocupado}
                      onClick={() => ejecutar(() => api.adminRevokeSessions(usuario.id))}
                    >
                      Cerrar sesiones
                    </button>
                    <button
                      className="btn-mini peligro"
                      disabled={ocupado}
                      onClick={() =>
                        ejecutar(() =>
                          usuario.disabled_at
                            ? api.adminEnable(usuario.id)
                            : api.adminDisable(usuario.id)
                        )
                      }
                    >
                      {usuario.disabled_at ? 'Reactivar' : 'Desactivar'}
                    </button>
                  </div>

                  {premiumEdit === usuario.id && (
                    <div className="premium-editor">
                      <label>
                        Premium hasta (incluido)
                        <input
                          type="date"
                          min={hoy}
                          value={premiumHasta}
                          onChange={(e) => setPremiumHasta(e.target.value)}
                        />
                      </label>
                      <div className="acciones">
                        <button
                          className="btn-mini"
                          disabled={ocupado || !premiumHasta}
                          onClick={() =>
                            ejecutar(async () => {
                              await api.adminGrantPremium(usuario.id, { hasta: premiumHasta });
                              setPremiumEdit(null);
                            })
                          }
                        >
                          Aplicar fecha
                        </button>
                        <button
                          className="btn-mini"
                          disabled={ocupado}
                          onClick={() =>
                            ejecutar(async () => {
                              await api.adminGrantPremium(usuario.id, { dias: 30 });
                              setPremiumEdit(null);
                            })
                          }
                        >
                          +30 días
                        </button>
                        {usuario.premium_hasta && (
                          <button
                            className="btn-mini peligro"
                            disabled={ocupado}
                            onClick={() =>
                              ejecutar(async () => {
                                await api.adminRevokePremium(usuario.id);
                                setPremiumEdit(null);
                              })
                            }
                          >
                            Quitar Premium
                          </button>
                        )}
                        <button className="btn-mini" onClick={() => setPremiumEdit(null)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metrica({ etiqueta, valor }) {
  return (
    <div className="metrica">
      <span className="metrica-valor">{valor}</span>
      <span className="metrica-etiqueta">{etiqueta}</span>
    </div>
  );
}
