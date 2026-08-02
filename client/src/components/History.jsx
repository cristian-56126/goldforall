import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtMoney, fmtNum } from '../format.js';

export default function History({ refreshKey }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    api.history().then((d) => setItems(d.history)).catch(() => {});
  }, [refreshKey]);

  if (!items.length) return null;

  return (
    <div className="card history">
      <h3>Consultas recientes</h3>
      <ul>
        {items.map((h, i) => (
          <li key={i}>
            <div className="hist-top">
              <span>
                {fmtNum(Number(h.quantity), 2)} {h.unit_code} ({fmtNum(Number(h.grams_total), 2)} g)
              </span>
              <b>{fmtMoney(Number(h.value_cop), 'COP')}</b>
            </div>
            <div className="hist-sub">
              {fmtMoney(Number(h.value_usd), 'USD')}
              {h.percentage && Number(h.percentage) !== 100 && (
                <> · {fmtNum(Number(h.percentage), 1)}%</>
              )}{' '}
              ·{' '}
              {new Date(h.created_at).toLocaleString('es-CO', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
