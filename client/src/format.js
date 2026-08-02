// Formateo de moneda y números para es-CO.
const currencyFormats = {
  COP: new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }),
  GBP: new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }),
  EUR: new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }),
};

export function fmtMoney(value, currency) {
  return currencyFormats[currency].format(value);
}

export function fmtNum(value, decimals = 2) {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: decimals }).format(value);
}

export const CURRENCY_LABELS = {
  COP: 'Peso colombiano',
  USD: 'Dólar',
  GBP: 'Libra esterlina',
  EUR: 'Euro',
};

export const CURRENCY_FLAGS = { COP: '🇨🇴', USD: '🇺🇸', GBP: '🇬🇧', EUR: '🇪🇺' };
