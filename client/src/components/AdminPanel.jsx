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
          <Metrica etiqueta="Conversiones 24 h" valor={stats.conversiones_24h} />
          <Metrica etiqueta="Conversiones total" valor={stats.conversiones_totales} />
        </div>
      )}

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
              <th>Acceso</th>
              <th>Premium</th>
              <th>Consultas</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((usuario) => (
              <tr key={usuario.id} className={usuario.disabled_at ? 'fila-inactiva' : undefined}>
                <td>
                  <div className="celda-usuario">
                    <b>{usuario.name}</b>
                    <span>{usuario.email}</span>
                    {usuario.disabled_at && <span className="etiqueta roja">desactivado</span>}
                  </div>
                </td>
                <td>
                  <span className={usuario.role === 'admin' ? 'etiqueta dorada' : 'etiqueta'}>
                    {usuario.role}
                  </span>
                </td>
                <td className="celda-menor">
                  {usuario.tiene_password ? 'contraseña' : ''}
                  {usuario.tiene_password && usuario.usa_google ? ' + ' : ''}
                  {usuario.usa_google ? 'Google' : ''}
                </td>
                <td className="celda-menor">
                  {usuario.premium_hasta
                    ? new Date(usuario.premium_hasta).toLocaleDateString('es-CO')
                    : '—'}
                </td>
                <td>{usuario.conversiones}</td>
                <td>
                  <div className="acciones">
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
                      onClick={() => ejecutar(() => api.adminGrantPremium(usuario.id, 30))}
                    >
                      +30 d Premium
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
                </td>
              </tr>
            ))}
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
