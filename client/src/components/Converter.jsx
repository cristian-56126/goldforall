import { useState } from 'react';
import { api } from '../api.js';
import { fmtMoney, fmtNum, CURRENCY_LABELS, CURRENCY_FLAGS } from '../format.js';

const TROY_OZ_GRAMS = 31.1035;

// Cantidad con formato es-CO mientras se escribe: puntos de miles y coma
// decimal ("12.500,5"). Un input type="number" no puede mostrar separadores,
// por eso el campo es de texto y el número se deriva al parsear.
function formatearCantidad(texto) {
  const limpio = texto.replace(/[^\d,]/g, '');
  const [entera, ...resto] = limpio.split(',');
  const enteraFmt = entera.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  // Solo se conserva la primera coma; el resto de comas se ignoran.
  return resto.length > 0 ? `${enteraFmt},${resto.join('').slice(0, 4)}` : enteraFmt;
}

function parsearCantidad(texto) {
  const numero = Number(texto.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(numero) ? numero : 0;
}

export default function Converter({ units, plan, onConverted, onSubscribe }) {
  const [unitCode, setUnitCode] = useState('castellano');
  const [qtyText, setQtyText] = useState('1');
  const quantity = parsearCantidad(qtyText);
  const [pct, setPct] = useState(100);
  const [pctText, setPctText] = useState('100');

  // Slider y campo de texto sincronizados; acepta coma o punto decimal
  const setPctFromSlider = (value) => {
    setPct(value);
    setPctText(String(value));
  };
  const setPctFromText = (raw) => {
    setPctText(raw);
    const parsed = Number(raw.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) setPct(parsed);
  };
  const normalizePctText = () => setPctText(String(pct));
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [limitHit, setLimitHit] = useState(false);
  const [busy, setBusy] = useState(false);

  const traditional = units.filter((u) => u.is_traditional);
  const standard = units.filter((u) => !u.is_traditional);
  const selected = units.find((u) => u.code === unitCode);

  // Recalculo en vivo: al cambiar unidad o cantidad, los valores se
  // rederivan del precio de la ultima consulta (sin consumir cuota).
  // "Consultar valor" trae precio fresco del servidor y si consume.
  let display = null;
  if (result && selected) {
    const gramsTotal = quantity * Number(selected.grams);
    const intlUsd = gramsTotal * (result.gold_usd_oz / TROY_OZ_GRAMS);
    const usd = intlUsd * (pct / 100);
    display = {
      unitName: selected.name_es,
      quantity,
      grams_total: gramsTotal,
      pct,
      intl_usd: intlUsd,
      values: {
        USD: usd,
        COP: usd * result.rates.COP,
        GBP: usd * result.rates.GBP,
        EUR: usd * result.rates.EUR,
      },
    };
  }

  const convert = async (e) => {
    e.preventDefault();
    setError('');
    setLimitHit(false);
    if (quantity <= 0) {
      setError('Escribe una cantidad mayor que 0');
      return;
    }
    setBusy(true);
    try {
      const data = await api.convert({
        unit_code: unitCode,
        quantity,
        percentage: pct,
      });
      data.consulted_at = new Date().toISOString();
      setResult(data);
      onConverted();
    } catch (err) {
      if (err.status === 429) setLimitHit(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remaining = plan.remaining_today;

  return (
    <div className="card converter">
      <h2>Convertir oro</h2>

      <form onSubmit={convert}>
        <div className="conv-row">
          <label className="conv-qty">
            Cantidad
            <input
              type="text"
              inputMode="decimal"
              value={qtyText}
              onChange={(e) => setQtyText(formatearCantidad(e.target.value))}
              placeholder="0"
              required
              aria-label="Cantidad de oro en la unidad elegida"
            />
          </label>

          <label className="conv-unit">
            Unidad de peso
            <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)}>
              <optgroup label="Tradicionales">
                {traditional.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name_es} ({fmtNum(Number(u.grams), 4)} g)
                  </option>
                ))}
              </optgroup>
              <optgroup label="Estándar">
                {standard.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name_es} ({fmtNum(Number(u.grams), 4)} g)
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>

        {selected && (
          <p className="conv-grams">
            = {fmtNum(quantity * Number(selected.grams), 4)} gramos de oro
          </p>
        )}

        <div className="pct-slider-block">
          <div className="pct-head">
            <span>Porcentaje de negociación</span>
            <span className="pct-input-wrap">
              <input
                type="text"
                inputMode="decimal"
                className="pct-input"
                value={pctText}
                onChange={(e) => setPctFromText(e.target.value)}
                onBlur={normalizePctText}
                aria-label="Porcentaje escrito"
              />
              <b className="pct-sign">%</b>
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="0.5"
            value={pct}
            onChange={(e) => setPctFromSlider(Number(e.target.value))}
            aria-label="Porcentaje de negociación sobre el valor internacional"
          />
          <div className="pct-scale">
            <span>0%</span>
            <span>50%</span>
            <span>100% intl.</span>
          </div>
          <span className="pct-hint">
            Nacional se suele pactar entre 90% y 99,5% del valor internacional
          </span>
        </div>

        <button className="btn-gold" disabled={busy}>
          {busy ? 'Consultando…' : 'Consultar valor'}
        </button>

        {remaining !== null && (
          <p className="quota-note">
            Te quedan <b>{remaining}</b> de {plan.daily_limit} consultas hoy
          </p>
        )}
      </form>

      {limitHit && (
        <div className="limit-box">
          <p>Alcanzaste el límite de {plan.daily_limit} consultas de hoy.</p>
          {onSubscribe ? (
            <button className="btn-gold" onClick={onSubscribe}>
              Pasar a Premium — consultas ilimitadas
            </button>
          ) : (
            <p className="hint">
              Para consultas ilimitadas, pide al administrador que active tu plan Premium.
            </p>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {display && !limitHit && (
        <div className="result">
          <p className="result-head">
            {fmtNum(display.quantity, 4)} × {display.unitName} ={' '}
            <b>{fmtNum(display.grams_total, 4)} g</b> de oro
            {display.pct !== 100 && (
              <span className="pct-applied"> al {fmtNum(display.pct, 1)}%</span>
            )}
          </p>
          <ul className="result-list">
            {['COP', 'USD', 'GBP', 'EUR'].map((c) => (
              <li key={c} className={c === 'COP' ? 'main-currency' : ''}>
                <span className="cur-flag">{CURRENCY_FLAGS[c]}</span>
                <span className="cur-name">{CURRENCY_LABELS[c]}</span>
                <span className="cur-value">{fmtMoney(display.values[c], c)}</span>
              </li>
            ))}
          </ul>
          <p className="result-foot">
            Base: oro {fmtMoney(result.gold_usd_oz, 'USD')}/oz troy
            {display.pct !== 100 && (
              <>
                {' '}· internacional pleno: {fmtMoney(display.intl_usd, 'USD')} · aplicado{' '}
                {fmtNum(display.pct, 1)}%
              </>
            )}{' '}
            · consulta de las{' '}
            {new Date(result.consulted_at || Date.now()).toLocaleTimeString('es-CO', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
      )}
    </div>
  );
}
