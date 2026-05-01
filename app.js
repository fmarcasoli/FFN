/**
 * app.js — Dashboard de Flujos de Bonos Soberanos Argentinos
 * Arquitectura: módulos separados por responsabilidad dentro de un IIFE.
 * Preparado para migración futura a React/Vue (lógica separada de UI).
 *
 * Módulos:
 *  1. DataLayer      — carga, caché, retry de data.json
 *  2. AppState       — estado global único y mutable
 *  3. Finance        — cálculos financieros (TIR, Duration, Yield, flujos)
 *  4. Insights       — análisis automático de cartera
 *  5. Storage        — persistencia en localStorage (carteras, precios, versiones)
 *  6. PricesAPI      — fetch de data912.com con 4 endpoints
 *  7. UI / Render    — todo el DOM: KPIs, charts, tabla, portfolio inputs
 *  8. ExportImport   — CSV, Excel (SheetJS), JSON, link compartible
 *  9. Scenarios      — sliders de escenarios, recálculo en tiempo real
 * 10. Init           — bootstrap, event wiring
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. DATA LAYER — fetch + cache + retry
  // ─────────────────────────────────────────────────────────────────────────────
  const DataLayer = (() => {
    const CACHE_KEY = 'bonos_data_v1';
    const CACHE_TTL = 60 * 60 * 1000; // 1 hora

    async function fetchWithRetry(url, retries = 3, delayMs = 800) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (err) {
          if (attempt === retries) throw err;
          await new Promise(r => setTimeout(r, delayMs * attempt));
        }
      }
    }

    function getFromCache() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const { ts, data } = JSON.parse(raw);
        if (Date.now() - ts > CACHE_TTL) return null;
        return data;
      } catch { return null; }
    }

    function saveToCache(data) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
      } catch { /* storage full — ignorar */ }
    }

    async function load(onProgress) {
      // 1) intentar caché
      const cached = getFromCache();
      if (cached) {
        onProgress?.('cache');
        return cached;
      }
      // 2) red
      onProgress?.('fetching');
      const data = await fetchWithRetry('./data.json');
      saveToCache(data);
      onProgress?.('ready');
      return data;
    }

    return { load };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. APP STATE — objeto global único, nunca mutado directamente desde la UI
  // ─────────────────────────────────────────────────────────────────────────────
  const AppState = (() => {
    const state = {
      // Datos base
      DATA: [],          // filas de flujos (cargado async)
      BOND_META: {},     // metadata de bonos (inyectada desde HTML)

      // Modo de vista
      VIEW_MODE: 'unit', // 'unit' | 'portfolio'
      TIMELINE_CURRENCY: 'both', // 'both' | 'USD' | 'ARS'

      // Filtros
      FILTERS: { anio: new Set(), mes: new Set(), dia: new Set(), bono: new Set() },

      // Precios de mercado
      PRICES: {},
      PRICES_FETCHED_AT: null,

      // Carteras
      PORTFOLIOS: {},
      ACTIVE_PF: null,

      // Costos de operación
      COSTS: { comision: 0.5, derechos: 0.045, iva: 21, inflacion: 49.4 },

      // Escenarios (separados del estado real)
      SCENARIO: {
        active: false,
        tasaDescuento: 0,
        inflacionDelta: 0,
        precioDelta: 0,
        horizonteMeses: 0,          // 0 = sin límite; 1/3/6/12/24/36 = filtrar flujos
        inflacionMensual: [3.4,3.4,3.4,3.4,3.4,3.4,3.4,3.4,3.4,3.4,3.4,3.4], // 12 valores mensuales % (último IPC: 3.4%)
        usarInflMensual: false,     // true = usar tabla mensual en vez de anual
      },

      // Escenarios guardados
      SAVED_SCENARIOS: [],
      ACTIVE_SCENARIO_ID: null,

      // Historial de versiones de cartera
      PF_VERSIONS: [],
    };

    function get(key) { return state[key]; }
    function set(key, value) { state[key] = value; }
    function getState() { return state; }

    return { get, set, getState };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. FINANCE — cálculos financieros puros (sin side effects de DOM)
  // ─────────────────────────────────────────────────────────────────────────────
  const Finance = (() => {
    const parseISO = s => new Date(s + 'T00:00:00');

    /** Newton-Raphson IRR. cashflow0 negativo = inversión. */
    function calcIRR(cashflow0, flujos, fechaInicial) {
      const today = fechaInicial || new Date();
      const dias = flujos.map(f => Math.max(0, (parseISO(f.Fecha_Pago) - today) / 86400000));
      const valores = flujos.map(f => f.flujo_esc ?? f.Flujo_Total_USD);

      const npv = r => cashflow0 + valores.reduce((s, v, i) => s + v / Math.pow(1 + r, dias[i] / 365), 0);
      const dnpv = r => valores.reduce((s, v, i) => {
        const t = dias[i] / 365;
        return s - t * v / Math.pow(1 + r, t + 1);
      }, 0);

      let r = 0.1;
      for (let i = 0; i < 120; i++) {
        const f = npv(r), df = dnpv(r);
        if (Math.abs(df) < 1e-12) break;
        const nr = r - f / df;
        if (!Number.isFinite(nr)) return null;
        if (Math.abs(nr - r) < 1e-9) return nr;
        r = Math.max(-0.99, Math.min(20, nr));
      }
      return Math.abs(npv(r)) < 0.1 ? r : null;
    }

    /**
     * TIR ponderada de la cartera.
     * Pondera cada bono por su monto invertido.
     */
    function portfolioWeightedTIR(holdings, bondMeta, prices, costs, data) {
      const today = new Date(); today.setHours(0,0,0,0);
      let totalWeight = 0, weightedTIR = 0;

      Object.keys(holdings).forEach(bono => {
        const h = holdings[bono];
        const vn = h.vn || 0;
        if (!vn) return;
        const meta = bondMeta[bono] || {};
        const currency = meta.moneda_nativa === 'ARS' ? 'ARS' : (h.currency || 'USD');
        const priceEntry = effectivePrice(bono, currency, h, meta, prices);
        if (!priceEntry) return;

        const montoInvertido = vn * priceEntry.price / 100;
        const costoTotal = montoInvertido * (1 + (costs.comision + costs.derechos) / 100 * (1 + costs.iva / 100));

        const esCER = meta.tipo === 'BONCER' || meta.tipo === 'BONCER cero';
        const flujosBono = data
          .filter(r => r.Bono === bono && r.Estado === 'Pendiente')
          .map(r => {
            const fInfla = esCER ? factorInflacion(r.Fecha_Pago, costs.inflacion) : 1;
            return { Fecha_Pago: r.Fecha_Pago, flujo_esc: r.Flujo_Total_USD * (vn / 100) * fInfla };
          });

        if (!flujosBono.length) return;
        const tir = calcIRR(-costoTotal, flujosBono, today);
        if (tir === null) return;

        weightedTIR += tir * montoInvertido;
        totalWeight += montoInvertido;
      });

      return totalWeight > 0 ? weightedTIR / totalWeight : null;
    }

    /**
     * Yield corriente = Σ cupones próximos 12m / precio de mercado actual
     */
    function currentYield(holdings, bondMeta, prices, data) {
      const today = new Date(); today.setHours(0,0,0,0);
      const in12m = new Date(today); in12m.setFullYear(in12m.getFullYear() + 1);
      let totalCupones = 0, totalInvertido = 0;

      Object.keys(holdings).forEach(bono => {
        const h = holdings[bono];
        const vn = h.vn || 0;
        if (!vn) return;
        const meta = bondMeta[bono] || {};
        const currency = meta.moneda_nativa === 'ARS' ? 'ARS' : (h.currency || 'USD');
        const priceEntry = effectivePrice(bono, currency, h, meta, prices);
        if (!priceEntry) return;

        const cupones12m = data.filter(r => {
          const d = new Date(r.Fecha_Pago + 'T00:00:00');
          return r.Bono === bono && r.Estado === 'Pendiente' && d <= in12m && r.Interes_USD > 0;
        }).reduce((s, r) => s + r.Interes_USD * (vn / 100), 0);

        totalCupones += cupones12m;
        totalInvertido += vn * priceEntry.price / 100;
      });

      return totalInvertido > 0 ? totalCupones / totalInvertido : null;
    }

    /**
     * Duration de Macaulay simplificada (base 30/360, sin cupones intermedios para CER).
     * duration = Σ(t_i × CF_i / (1+y)^t_i) / Precio
     * Supuesto: y = TIR ponderada de la cartera.
     */
    function macaulayDuration(holdings, bondMeta, prices, data, portfolioTIR) {
      const today = new Date(); today.setHours(0,0,0,0);
      const r = portfolioTIR || 0.08;
      let numerator = 0, denominator = 0;

      Object.keys(holdings).forEach(bono => {
        const h = holdings[bono];
        const vn = h.vn || 0;
        if (!vn) return;

        const flujos = data.filter(d => d.Bono === bono && d.Estado === 'Pendiente');
        flujos.forEach(row => {
          const t = Math.max(0, (new Date(row.Fecha_Pago + 'T00:00:00') - today) / (365.25 * 86400000));
          const cf = row.Flujo_Total_USD * (vn / 100);
          const pv = cf / Math.pow(1 + r, t);
          numerator += t * pv;
          denominator += pv;
        });
      });

      return denominator > 0 ? numerator / denominator : null;
    }

    /** Factor de inflación CER acumulado desde hoy hasta fechaIso */
    function factorInflacion(fechaIso, inflAnualPct) {
      const inflAnual = (inflAnualPct || 0) / 100;
      if (inflAnual <= 0) return 1;
      const d = (new Date(fechaIso + 'T00:00:00') - new Date()) / 86400000;
      return d <= 0 ? 1 : Math.pow(1 + inflAnual, d / 365);
    }

    /** Obtener precio efectivo (manual > mercado) */
    function effectivePrice(bono, currency, holding, meta, prices) {
      const manualKey = currency === 'ARS' ? 'precio_manual_ars' : 'precio_manual_usd';
      if (holding[manualKey] != null && holding[manualKey] > 0) {
        return { price: holding[manualKey], source: 'manual' };
      }
      const tickers = currency === 'ARS' ? (meta.tickers_ars || []) : (meta.tickers_usd || []);
      for (const t of tickers) {
        if (prices[t]) return prices[t];
      }
      return null;
    }

    /** Calcular costos totales sobre un monto de compra */
    function calcCosts(monto, costs) {
      const comision = monto * costs.comision / 100;
      const derechos = monto * costs.derechos / 100;
      const iva = (comision + derechos) * costs.iva / 100;
      return { comision, derechos, iva, total: comision + derechos + iva };
    }

    return { calcIRR, portfolioWeightedTIR, currentYield, macaulayDuration, factorInflacion, effectivePrice, calcCosts };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. INSIGHTS — análisis automático de la cartera
  // ─────────────────────────────────────────────────────────────────────────────
  const Insights = (() => {
    function analyze(rows, holdings, bondMeta) {
      const insights = [];
      if (!rows.length) return insights;

      // ── Concentración por año ──
      const byYear = {};
      rows.forEach(r => { byYear[r.Anio] = (byYear[r.Anio] || 0) + r.flujo_calc; });
      const totalFlujo = Object.values(byYear).reduce((a, b) => a + b, 0);
      if (totalFlujo > 0) {
        const topYear = Object.entries(byYear).sort((a, b) => b[1] - a[1])[0];
        const pct = (topYear[1] / totalFlujo * 100).toFixed(0);
        insights.push({
          icon: pct > 50 ? '⚠️' : '📅',
          type: pct > 50 ? 'warn' : 'info',
          title: 'Concentración temporal',
          text: `${pct}% del flujo total se concentra en ${topYear[0]}. ${pct > 50 ? 'Alta dependencia de un solo año.' : 'Distribución aceptable.'}`,
        });
      }

      // ── Distribución por moneda ──
      const usdFlujo = rows.filter(r => (r.moneda_nativa || 'USD') === 'USD').reduce((s, r) => s + r.flujo_calc, 0);
      const arsFlujo = rows.filter(r => r.moneda_nativa === 'ARS').reduce((s, r) => s + r.flujo_calc, 0);
      if (usdFlujo > 0 || arsFlujo > 0) {
        const usdPct = (usdFlujo / (usdFlujo + arsFlujo) * 100).toFixed(0);
        insights.push({
          icon: '💱',
          type: 'info',
          title: 'Distribución por moneda',
          text: `U$ ${usdPct}% / $ ${100 - usdPct}% del flujo. ${usdPct > 80 ? 'Exposición alta a USD.' : arsFlujo > usdFlujo ? 'Exposición mayoritaria a pesos.' : 'Mix balanceado.'}`,
        });
      }

      // ── Concentración en pocos bonos ──
      const byBono = {};
      rows.forEach(r => { byBono[r.Bono] = (byBono[r.Bono] || 0) + r.flujo_calc; });
      const bonosSorted = Object.entries(byBono).sort((a, b) => b[1] - a[1]);
      if (bonosSorted.length >= 2) {
        const top1Pct = (bonosSorted[0][1] / totalFlujo * 100).toFixed(0);
        insights.push({
          icon: top1Pct > 60 ? '⚠️' : '✅',
          type: top1Pct > 60 ? 'warn' : 'ok',
          title: 'Diversificación',
          text: `${bonosSorted.length} instrumento${bonosSorted.length > 1 ? 's' : ''} en cartera. El mayor (${bonosSorted[0][0].split('/')[0].trim()}) representa ${top1Pct}% del flujo total.`,
        });
      }

      // ── Riesgo de reinversión ──
      const nextPayments = rows
        .filter(r => r.Estado === 'Pendiente')
        .sort((a, b) => a.Fecha_Pago.localeCompare(b.Fecha_Pago));
      if (nextPayments.length > 0) {
        const next = nextPayments[0];
        const diasAlProx = Math.round((new Date(next.Fecha_Pago + 'T00:00:00') - new Date()) / 86400000);
        insights.push({
          icon: '🔄',
          type: diasAlProx < 30 ? 'warn' : 'muted',
          title: 'Próximo cobro',
          text: `${next.Bono} paga en ${diasAlProx} día${diasAlProx !== 1 ? 's' : ''} (${next.Fecha_Pago.slice(0, 7)}). Flujo: ${fmt(next.flujo_calc, 2)} ${next.moneda_nativa || 'USD'}.`,
        });
      }

      // ── Bonos sin precio ──
      const sinPrecio = Object.keys(holdings).filter(b => {
        const h = holdings[b];
        const meta = bondMeta[b] || {};
        const mn = meta.moneda_nativa || 'USD';
        return !h.precio_manual_usd && !h.precio_manual_ars && !AppState.get('PRICES')[meta.tickers_ars?.[0]] && !AppState.get('PRICES')[meta.tickers_usd?.[0]];
      });
      if (sinPrecio.length > 0) {
        insights.push({
          icon: '💡',
          type: 'muted',
          title: 'Precios faltantes',
          text: `${sinPrecio.length} bono${sinPrecio.length > 1 ? 's' : ''} sin precio de mercado: ${sinPrecio.slice(0, 2).join(', ')}${sinPrecio.length > 2 ? '…' : ''}. TIR no calculable para esos.`,
        });
      }

      return insights;
    }

    function render(insights) {
      const el = document.getElementById('insightsPanel');
      if (!el) return;
      if (!insights.length) {
        el.innerHTML = '<div class="insight-card muted"><div class="insight-icon">📊</div><div class="insight-body"><div class="insight-title">Sin datos suficientes</div><div class="insight-text">Cargá bonos en tu cartera para ver los insights automáticos.</div></div></div>';
        return;
      }
      el.innerHTML = insights.map(i => `
        <div class="insight-card ${i.type}">
          <div class="insight-icon">${i.icon}</div>
          <div class="insight-body">
            <div class="insight-title">${i.title}</div>
            <div class="insight-text">${i.text}</div>
          </div>
        </div>`).join('');
    }

    return { analyze, render };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. STORAGE — localStorage con versionado de cartera
  // ─────────────────────────────────────────────────────────────────────────────
  const Storage = (() => {
    const KEY = 'bonos_ar_v5';
    const VERSIONS_KEY = 'bonos_pf_versions';
    const MAX_VERSIONS = 10;

    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return false;
        const obj = JSON.parse(raw);
        const s = AppState.getState();
        s.PORTFOLIOS = obj.portfolios || {};
        s.ACTIVE_PF  = obj.active || null;
        s.PRICES     = obj.prices || {};
        s.PRICES_FETCHED_AT = obj.pricesFetchedAt || null;
        Object.assign(s.COSTS, obj.costs || {});
        s.SAVED_SCENARIOS = obj.savedScenarios || [];
        s.ACTIVE_SCENARIO_ID = obj.activeScenarioId || null;
        // Restaurar escenario activo si había uno
        if (s.ACTIVE_SCENARIO_ID) {
          const sc = s.SAVED_SCENARIOS.find(sc => sc.id === s.ACTIVE_SCENARIO_ID);
          if (sc) Object.assign(s.SCENARIO, sc.data, { active: true });
        }
        try { s.PF_VERSIONS = JSON.parse(localStorage.getItem(VERSIONS_KEY) || '[]'); } catch { s.PF_VERSIONS = []; }
        return true;
      } catch { return false; }
    }

    function save() {
      const s = AppState.getState();
      try {
        localStorage.setItem(KEY, JSON.stringify({
          portfolios: s.PORTFOLIOS, active: s.ACTIVE_PF,
          prices: s.PRICES, pricesFetchedAt: s.PRICES_FETCHED_AT,
          costs: s.COSTS,
          savedScenarios: s.SAVED_SCENARIOS,
          activeScenarioId: s.ACTIVE_SCENARIO_ID,
        }));
      } catch (e) { console.warn('save error', e); }
    }

    /** Guardar snapshot de la cartera activa como versión */
    function saveVersion(label) {
      const s = AppState.getState();
      const pf = s.PORTFOLIOS[s.ACTIVE_PF];
      if (!pf) return;
      const versions = s.PF_VERSIONS;
      versions.unshift({
        id: Date.now(),
        ts: new Date().toISOString(),
        label: label || `v${versions.length + 1} — ${new Date().toLocaleString('es-AR')}`,
        pfName: pf.name,
        holdings: JSON.parse(JSON.stringify(pf.holdings)),
      });
      if (versions.length > MAX_VERSIONS) versions.splice(MAX_VERSIONS);
      s.PF_VERSIONS = versions;
      try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions)); } catch {}
    }

    /** Restaurar una versión anterior */
    function restoreVersion(id) {
      const s = AppState.getState();
      const ver = s.PF_VERSIONS.find(v => v.id === id);
      if (!ver) return false;
      const pf = s.PORTFOLIOS[s.ACTIVE_PF];
      if (!pf) return false;
      pf.holdings = JSON.parse(JSON.stringify(ver.holdings));
      save();
      return true;
    }

    return { load, save, saveVersion, restoreVersion };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. PRICES API
  // ─────────────────────────────────────────────────────────────────────────────
  const PricesAPI = (() => {
    const ENDPOINTS = [
      { url: 'https://data912.com/live/arg_bonds', tag: 'ARS' },
      { url: 'https://data912.com/live/arg_notes', tag: 'USD' },
      { url: 'https://data912.com/live/arg_short', tag: 'ARS' },
      // arg_cer removido — devuelve 404. Los CER vienen en arg_bonds.
    ];

    let _refreshTimer = null;

    async function fetch5min() {
      await fetchAll();
      clearInterval(_refreshTimer);
      _refreshTimer = setInterval(fetchAll, 5 * 60 * 1000);
    }

    async function fetchAll() {
      const statusDot  = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      const pricesInfo = document.getElementById('pricesInfo');
      if (!statusDot) return;

      statusDot.className = 'status-dot loading';
      statusText.textContent = 'Consultando data912.com…';

      const s = AppState.getState();
      const newPrices = {};
      let anyOk = false, totalSymbols = 0;

      for (const ep of ENDPOINTS) {
        try {
          const r = await fetch(ep.url, { mode: 'cors' });
          if (!r.ok) continue;
          const arr = await r.json();
          if (!Array.isArray(arr)) continue;
          anyOk = true;
          arr.forEach(item => {
            const sym = item.symbol || item.ticker || item.s;
            const price = item.c ?? item.close ?? item.last ?? item.px;
            if (sym && price != null && Number.isFinite(Number(price))) {
              newPrices[sym] = { price: Number(price), source: 'live', ts: Date.now(), market: ep.tag };
              totalSymbols++;
            }
          });
        } catch (err) { console.warn('Prices fetch error:', ep.url, err); }
      }

      if (!anyOk) {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Sin conexión a la API';
        pricesInfo.innerHTML = '<strong>CORS bloqueado.</strong> Usá GitHub Pages o un servidor local. Podés ingresar precios manualmente.';
        return;
      }

      // Recalcular VN para holdings con monto_invertido sin VN
      Object.keys(s.PORTFOLIOS).forEach(pfId => {
        Object.keys(s.PORTFOLIOS[pfId].holdings || {}).forEach(bono => {
          const h = s.PORTFOLIOS[pfId].holdings[bono];
          if (!h || h.vn) return;
          if (!h.monto_invertido) return;
          const meta = s.BOND_META[bono] || {};
          const mn = meta.moneda_nativa || 'USD';
          const tickers = mn === 'ARS' ? (meta.tickers_ars || []) : (meta.tickers_usd || []);
          for (const t of tickers) {
            if (newPrices[t]) {
              h.vn = Math.round(h.monto_invertido / newPrices[t].price * 100);
              break;
            }
          }
        });
      });

      // Preservar manuales no sobrescritos
      Object.keys(s.PRICES).forEach(k => {
        if (s.PRICES[k].source === 'manual' && !newPrices[k]) newPrices[k] = s.PRICES[k];
      });
      s.PRICES = { ...s.PRICES, ...newPrices };
      s.PRICES_FETCHED_AT = Date.now();
      Storage.save();

      statusDot.className = 'status-dot live';
      statusText.textContent = `Precios en vivo (${Object.values(s.PRICES).filter(p => p.source === 'live').length})`;
      pricesInfo.innerHTML = `<strong>Actualizado:</strong> ${new Date(s.PRICES_FETCHED_AT).toLocaleTimeString('es-AR')} · ${totalSymbols} símbolos`;

      UI.renderPortfolioInputs();
      UI.render();

      // Snapshot automático de curvas
      if (typeof YieldCurves !== 'undefined') YieldCurves.onPricesUpdated();
    }

    return { fetchAll, fetch5min };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. EXPORT / IMPORT
  // ─────────────────────────────────────────────────────────────────────────────
  const ExportImport = (() => {
    /** CSV en formato argentino (sep=;, decimal=,, BOM UTF-8) */
    function toCSV(rows, pfName, costs, bondMeta, prices) {
      const SEP = ';';
      const n = (v, d = 2) => v == null || !Number.isFinite(v) ? '' : v.toFixed(d).replace('.', ',');
      const esc = s => /[;";\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
      const fecha = iso => { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; };
      const s = AppState.getState();

      const headers = ['Fecha','Bono','Ley','Moneda','VN','Precio_c100','Monto_Invertido',
        'Interes_U$','Amortizacion_U$','Flujo_Total_U$',
        'Interes_$','Amortizacion_$','Flujo_Total_$','FX_Implicito'].join(SEP);

      const dataLines = rows.filter(r => r.Estado === 'Pendiente' && r.vn > 0).map(r => {
        const h = normalizeHolding(s.PORTFOLIOS[s.ACTIVE_PF]?.holdings[r.Bono]);
        const meta = bondMeta[r.Bono] || {};
        const mn = meta.moneda_nativa || 'USD';
        const currency = mn === 'ARS' ? 'ARS' : (h.currency || 'USD');
        const priceEntry = Finance.effectivePrice(r.Bono, currency, h, meta, s.PRICES);
        const precioV = priceEntry ? priceEntry.price : 0;

        const precioUsd = mn === 'USD' ? Finance.effectivePrice(r.Bono, 'USD', h, meta, s.PRICES) : null;
        const precioArs = mn === 'USD' ? Finance.effectivePrice(r.Bono, 'ARS', h, meta, s.PRICES) : null;
        const fx = precioUsd && precioArs ? precioArs.price / precioUsd.price : null;

        let iUsd, aUsd, tUsd, iArs, aArs, tArs;
        if (mn === 'USD') {
          iUsd = r.interes_calc; aUsd = r.amort_calc; tUsd = r.flujo_calc;
          iArs = fx ? iUsd * fx : null; aArs = fx ? aUsd * fx : null; tArs = fx ? tUsd * fx : null;
        } else {
          iArs = r.interes_calc; aArs = r.amort_calc; tArs = r.flujo_calc;
          iUsd = null; aUsd = null; tUsd = null;
        }

        return [fecha(r.Fecha_Pago), esc(r.Bono), esc(r.Ley), mn,
          n(r.vn, 0), n(precioV, 2), n(r.vn * precioV / 100, 2),
          n(iUsd, 2), n(aUsd, 2), n(tUsd, 2),
          n(iArs, 2), n(aArs, 2), n(tArs, 2), n(fx, 2)].join(SEP);
      });

      const BOM = '\uFEFF';
      return BOM + [headers, ...dataLines].join('\r\n');
    }

    function downloadCSV(content, filename) {
      const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }

    /** Excel usando SheetJS (cargado bajo demanda) */
    async function toExcel(rows, pfName) {
      // Cargar SheetJS si no está disponible
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      const st = AppState.getState();
      const pending = rows.filter(r => r.Estado === 'Pendiente' && r.vn > 0);
      const wsData = [
        ['Fecha','Bono','Moneda','VN','Precio c/100','Monto Invertido','Interés U$','Amort U$','Flujo U$','Interés $','Amort $','Flujo $'],
        ...pending.map(r => {
          const meta = st.BOND_META[r.Bono] || {};
          const mn = meta.moneda_nativa || 'USD';
          return [r.Fecha_Pago, r.Bono, mn, r.vn, '', r.vn * 0 / 100,
            mn === 'USD' ? r.interes_calc : null, mn === 'USD' ? r.amort_calc : null, mn === 'USD' ? r.flujo_calc : null,
            mn === 'ARS' ? r.interes_calc : null, mn === 'ARS' ? r.amort_calc : null, mn === 'ARS' ? r.flujo_calc : null];
        })
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 16 },
        { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Flujos');
      XLSX.writeFile(wb, `cartera_${(pfName || 'export').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    /** Exportar cartera activa como JSON */
    function exportJSON() {
      const s = AppState.getState();
      const pf = s.PORTFOLIOS[s.ACTIVE_PF];
      if (!pf) return;
      const payload = JSON.stringify({ version: 1, ts: Date.now(), portfolio: pf }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `cartera_${pf.name.replace(/\s+/g,'_')}.json`; a.click();
      URL.revokeObjectURL(url);
    }

    /** Importar cartera desde JSON */
    function importJSON(file) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const { portfolio } = JSON.parse(e.target.result);
          if (!portfolio?.name) throw new Error('Formato inválido');
          const s = AppState.getState();
          const id = 'pf_' + Date.now();
          s.PORTFOLIOS[id] = portfolio;
          s.ACTIVE_PF = id;
          Storage.save();
          UI.renderTabs();
          UI.renderPortfolioInputs();
          UI.switchToPortfolioAndRender();
          alert(`Cartera "${portfolio.name}" importada correctamente.`);
        } catch (err) {
          alert('Error al importar: ' + err.message);
        }
      };
      reader.readAsText(file);
    }

    /** Generar link compartible con estado serializado en hash */
    function shareLink() {
      const s = AppState.getState();
      const pf = s.PORTFOLIOS[s.ACTIVE_PF];
      if (!pf) return;
      const payload = btoa(JSON.stringify({
        n: pf.name,
        h: Object.fromEntries(
          Object.entries(pf.holdings).map(([k, v]) => [k, { vn: v.vn, c: v.currency }])
        )
      }));
      const url = `${location.origin}${location.pathname}#share=${payload}`;
      navigator.clipboard.writeText(url).then(() => alert('Link copiado al portapapeles.')).catch(() => {
        prompt('Copiá este link:', url);
      });
    }

    /** Intentar cargar una cartera compartida del hash al iniciar */
    function tryLoadFromHash() {
      const m = location.hash.match(/^#share=(.+)$/);
      if (!m) return false;
      try {
        const { n, h } = JSON.parse(atob(m[1]));
        const s = AppState.getState();
        const id = 'pf_shared_' + Date.now();
        s.PORTFOLIOS[id] = {
          name: n + ' (compartida)',
          holdings: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { vn: v.vn, currency: v.c || 'USD' }]))
        };
        s.ACTIVE_PF = id;
        history.replaceState(null, '', location.pathname);
        return true;
      } catch { return false; }
    }

    return { toCSV, downloadCSV, toExcel, exportJSON, importJSON, shareLink, tryLoadFromHash };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  // 8. SCENARIOS — multi-escenario con CRUD, horizonte, inflación mensual
  // ─────────────────────────────────────────────────────────────────────────────
  const Scenarios = (() => {
    // ── Factor CER con tabla mensual ──
    // inflMensual: array de 12 % mensuales (ej: [3,2.5,2,2,2,2,2,2,2,2,2,2])
    // Capitalizados mes a mes hasta la fecha del flujo
    function factorCERMensual(fechaIso, inflMensual) {
      const today = new Date(); today.setHours(0,0,0,0);
      const fechaPago = new Date(fechaIso + 'T00:00:00');
      const diasTotal = Math.max(0, (fechaPago - today) / 86400000);
      if (diasTotal === 0) return 1;
      // Cuántos meses completos faltan (redondeado)
      const mesesFaltantes = Math.min(12, Math.round(diasTotal / 30.44));
      let factor = 1;
      for (let i = 0; i < mesesFaltantes; i++) {
        factor *= (1 + (inflMensual[i] || inflMensual[11] || 0) / 100);
      }
      // Meses más allá de los 12: usar el último valor mensual
      if (mesesFaltantes < Math.round(diasTotal / 30.44)) {
        const extra = Math.round(diasTotal / 30.44) - mesesFaltantes;
        const tasaExtra = (inflMensual[11] || 0) / 100;
        factor *= Math.pow(1 + tasaExtra, extra);
      }
      return factor;
    }

    // ── Sincronizar UI ↔ SCENARIO ──
    function syncUItoState() {
      const s = AppState.getState();
      const sc = s.SCENARIO;
      const el = id => document.getElementById(id);
      const setVal = (id, v) => { const e = el(id); if (e) e.value = v; };
      const setTxt = (id, t) => { const e = el(id); if (e) e.textContent = t; };

      setVal('scenTasa',     sc.tasaDescuento);
      setVal('scenInflacion', sc.inflacionDelta);
      setVal('scenPrecio',   sc.precioDelta);
      setVal('scenHorizonte', sc.horizonteMeses || 0);

      setTxt('scenTasaVal',   (sc.tasaDescuento >= 0 ? '+' : '') + sc.tasaDescuento + '%');
      setTxt('scenInflVal',   (sc.inflacionDelta >= 0 ? '+' : '') + sc.inflacionDelta + '%');
      setTxt('scenPrecioVal', (sc.precioDelta >= 0 ? '+' : '') + sc.precioDelta + '%');
      setTxt('scenHorizonteVal', sc.horizonteMeses ? sc.horizonteMeses + ' meses' : 'Sin límite');

      // Tabla de inflación mensual
      if (sc.inflacionMensual) {
        sc.inflacionMensual.forEach((v, i) => {
          const inp = el(`scenInfl_${i}`);
          if (inp) inp.value = v || '';
        });
      }
      // Toggle uso inflación mensual
      const tog = el('scenUsarMensual');
      if (tog) tog.checked = sc.usarInflMensual || false;
      const tablaMensual = el('scenInflMensualTable');
      if (tablaMensual) tablaMensual.style.display = sc.usarInflMensual ? '' : 'none';

      const anyActive = sc.active;
      el('scenActiveBadge')?.classList.toggle('visible', anyActive);
    }

    function readUItoState() {
      const s = AppState.getState();
      const sc = s.SCENARIO;
      const num = id => parseFloat(document.getElementById(id)?.value) || 0;
      sc.tasaDescuento  = num('scenTasa');
      sc.inflacionDelta = num('scenInflacion');
      sc.precioDelta    = num('scenPrecio');
      sc.horizonteMeses = parseInt(document.getElementById('scenHorizonte')?.value) || 0;
      sc.usarInflMensual = document.getElementById('scenUsarMensual')?.checked || false;
      sc.inflacionMensual = Array.from({ length: 12 }, (_, i) => num(`scenInfl_${i}`));
      sc.active = sc.tasaDescuento !== 0 || sc.inflacionDelta !== 0 || sc.precioDelta !== 0 || sc.horizonteMeses > 0 || sc.usarInflMensual;
    }

    // ── Render lista de escenarios guardados ──
    function renderSavedList() {
      const s = AppState.getState();
      const el = document.getElementById('savedScenariosList');
      if (!el) return;
      if (!s.SAVED_SCENARIOS.length) {
        el.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:8px 0">Sin escenarios guardados.</div>';
        return;
      }
      el.innerHTML = s.SAVED_SCENARIOS.map(sc => {
        const isActive = sc.id === s.ACTIVE_SCENARIO_ID;
        return `<div class="version-item" style="${isActive ? 'border-color:var(--accent);background:rgba(245,185,66,0.05)' : ''}">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:${isActive?'var(--accent)':'var(--text)'}">${escapeHtml(sc.name)}${isActive?' ✓':''}</div>
            <div class="version-meta">${sc.summary}</div>
          </div>
          <div class="version-actions">
            <button class="btn small" onclick="Scenarios_load(${sc.id})">${isActive?'Activo':'Cargar'}</button>
            <button class="btn small danger" onclick="Scenarios_delete(${sc.id})">×</button>
          </div>
        </div>`;
      }).join('');
    }

    function buildSummary(sc) {
      const parts = [];
      if (sc.tasaDescuento) parts.push(`tasa ${sc.tasaDescuento>0?'+':''}${sc.tasaDescuento}%`);
      if (sc.inflacionDelta) parts.push(`infl +${sc.inflacionDelta}%`);
      if (sc.precioDelta) parts.push(`precio ${sc.precioDelta>0?'+':''}${sc.precioDelta}%`);
      if (sc.horizonteMeses) parts.push(`horizonte ${sc.horizonteMeses}m`);
      if (sc.usarInflMensual) parts.push(`infl mensual`);
      return parts.length ? parts.join(' · ') : 'Sin cambios';
    }

    function init() {
      // Sliders principales
      const sliders = [
        { id: 'scenTasa',      key: 'tasaDescuento',  display: 'scenTasaVal',      suffix: '%' },
        { id: 'scenInflacion', key: 'inflacionDelta',  display: 'scenInflVal',      suffix: '%' },
        { id: 'scenPrecio',    key: 'precioDelta',     display: 'scenPrecioVal',    suffix: '%' },
        { id: 'scenHorizonte', key: 'horizonteMeses',  display: 'scenHorizonteVal', suffix: ' meses', zeroLabel: 'Sin límite' },
      ];
      sliders.forEach(({ id, key, display, suffix, zeroLabel }) => {
        document.getElementById(id)?.addEventListener('input', e => {
          const v = parseFloat(e.target.value) || 0;
          AppState.getState().SCENARIO[key] = v;
          const label = v === 0 && zeroLabel ? zeroLabel : (v >= 0 ? '+' : '') + v + suffix;
          const del = document.getElementById(display);
          if (del) del.textContent = label;
          readUItoState();
          Storage.save();
          document.getElementById('scenActiveBadge')?.classList.toggle('visible', AppState.getState().SCENARIO.active);
          UI.render();
        });
      });

      // Inputs de inflación mensual
      for (let i = 0; i < 12; i++) {
        document.getElementById(`scenInfl_${i}`)?.addEventListener('input', () => {
          readUItoState(); Storage.save(); UI.render();
        });
      }

      // Toggle inflación mensual
      document.getElementById('scenUsarMensual')?.addEventListener('change', e => {
        AppState.getState().SCENARIO.usarInflMensual = e.target.checked;
        const tablaMensual = document.getElementById('scenInflMensualTable');
        if (tablaMensual) tablaMensual.style.display = e.target.checked ? '' : 'none';
        readUItoState(); Storage.save(); UI.render();
      });

      // Reset
      document.getElementById('btnResetScenario')?.addEventListener('click', () => {
        const s = AppState.getState();
        s.SCENARIO = { active: false, tasaDescuento: 0, inflacionDelta: 0, precioDelta: 0,
                       horizonteMeses: 0, inflacionMensual: new Array(12).fill(3.4), usarInflMensual: false };
        s.ACTIVE_SCENARIO_ID = null;
        syncUItoState(); Storage.save(); UI.render();
        renderSavedList();
      });

      // Guardar escenario
      document.getElementById('btnSaveScenario')?.addEventListener('click', () => {
        readUItoState();
        const s = AppState.getState();
        const name = prompt('Nombre del escenario:', `Escenario ${s.SAVED_SCENARIOS.length + 1}`);
        if (!name) return;
        const id = Date.now();
        const sc = {
          id, name,
          data: JSON.parse(JSON.stringify(s.SCENARIO)),
          summary: buildSummary(s.SCENARIO),
          ts: new Date().toISOString(),
        };
        s.SAVED_SCENARIOS.unshift(sc);
        s.ACTIVE_SCENARIO_ID = id;
        Storage.save(); renderSavedList();
      });

      // Exponer funciones de carga y borrado globalmente
      window.Scenarios_load = id => {
        const s = AppState.getState();
        const sc = s.SAVED_SCENARIOS.find(sc => sc.id === id);
        if (!sc) return;
        Object.assign(s.SCENARIO, sc.data, { active: true });
        s.ACTIVE_SCENARIO_ID = id;
        syncUItoState(); Storage.save(); UI.render(); renderSavedList();
      };
      window.Scenarios_delete = id => {
        if (!confirm('¿Eliminar este escenario?')) return;
        const s = AppState.getState();
        s.SAVED_SCENARIOS = s.SAVED_SCENARIOS.filter(sc => sc.id !== id);
        if (s.ACTIVE_SCENARIO_ID === id) {
          s.ACTIVE_SCENARIO_ID = null;
          s.SCENARIO = { active: false, tasaDescuento: 0, inflacionDelta: 0, precioDelta: 0,
                         horizonteMeses: 0, inflacionMensual: new Array(12).fill(3.4), usarInflMensual: false };
          syncUItoState(); UI.render();
        }
        Storage.save(); renderSavedList();
      };

      renderSavedList();
    }

    // ── Aplica escenario a fila ya escalada ──
    function applyToRow(r) {
      const sc = AppState.getState().SCENARIO;
      if (!sc.active) return r;
      const s = AppState.getState();
      const meta = s.BOND_META[r.Bono] || {};
      const esCER = meta.tipo === 'BONCER' || meta.tipo === 'BONCER cero';

      // Filtro de horizonte
      if (sc.horizonteMeses > 0) {
        const today = new Date(); today.setHours(0,0,0,0);
        const limFecha = new Date(today); limFecha.setMonth(limFecha.getMonth() + sc.horizonteMeses);
        if (new Date(r.Fecha_Pago + 'T00:00:00') > limFecha) return null; // excluir
      }

      // Factor inflación CER
      let inflFactor = 1;
      if (esCER) {
        if (sc.usarInflMensual && sc.inflacionMensual) {
          inflFactor = factorCERMensual(r.Fecha_Pago, sc.inflacionMensual);
        } else {
          inflFactor = Finance.factorInflacion(r.Fecha_Pago, sc.inflacionDelta);
        }
      }

      // Factor de descuento adicional
      const today = new Date(); today.setHours(0,0,0,0);
      const dias = Math.max(0, (new Date(r.Fecha_Pago + 'T00:00:00') - today) / 86400000);
      const factorDesc = sc.tasaDescuento !== 0 ? 1 / Math.pow(1 + sc.tasaDescuento / 100, dias / 365) : 1;

      return {
        ...r,
        interes_calc: r.interes_calc * inflFactor * factorDesc,
        amort_calc:   r.amort_calc   * inflFactor * factorDesc,
        flujo_calc:   r.flujo_calc   * inflFactor * factorDesc,
        _scenario: true,
      };
    }

    function adjustedPrice(price) {
      const sc = AppState.getState().SCENARIO;
      if (!sc.active || sc.precioDelta === 0) return price;
      return { ...price, price: price.price * (1 + sc.precioDelta / 100) };
    }

    return { init, applyToRow, adjustedPrice, syncUItoState, renderSavedList, factorCERMensual };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS globales (usados por múltiples módulos)
  // ─────────────────────────────────────────────────────────────────────────────
  const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const fmt = (n, dec = 2) => n == null || !Number.isFinite(n) ? '–' : Number(n).toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtMoney = (n, curr = 'USD', dec = 2) => Math.abs(n ?? 0) < 0.00001 ? '–' : (curr === 'ARS' ? '$ ' : 'U$ ') + fmt(n, dec);
  const fmtPct = n => (n * 100).toFixed(2) + '%';
  const fmtFecha = iso => { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; };
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function normalizeHolding(h) {
    if (!h) return { vn: 0, currency: 'USD' };
    if (typeof h === 'number') return { vn: h, currency: 'USD' };
    return { vn: h.vn || 0, currency: h.currency || 'USD', precio_manual_usd: h.precio_manual_usd ?? h.precio_manual, precio_manual_ars: h.precio_manual_ars, monto_invertido: h.monto_invertido };
  }
  function effectivePrice(bono, currency) {
    const s = AppState.getState();
    const h = normalizeHolding(s.PORTFOLIOS[s.ACTIVE_PF]?.holdings[bono]);
    const meta = s.BOND_META[bono] || {};
    let p = Finance.effectivePrice(bono, currency, h, meta, s.PRICES);
    if (p && s.SCENARIO.active) p = Scenarios.adjustedPrice(p);
    return p;
  }
  function currentPF() { const s = AppState.getState(); return s.PORTFOLIOS[s.ACTIVE_PF]; }
  function holdings() { return currentPF()?.holdings || {}; }
  function factorInflacion(fechaIso) {
    const s = AppState.getState();
    const inflBase = s.COSTS.inflacion;
    const inflDelta = s.SCENARIO.active ? s.SCENARIO.inflacionDelta : 0;
    return Finance.factorInflacion(fechaIso, inflBase + inflDelta);
  }
  function calcCosts(monto) { return Finance.calcCosts(monto, AppState.getState().COSTS); }

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. UI — TODO el rendering (extraído del HTML original y extendido)
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * NOTA: Esta sección es el mayor bloque del archivo.
   * Para migracion futura a React:
   *   - Cada función render* se convierte en un componente funcional.
   *   - AppState se reemplaza por Zustand/Redux.
   *   - Los gráficos Chart.js se envuelven en useEffect.
   */
  const UI = (() => {
    // ── Charts ──
    const COLORS = { int: '#5aa4e8', amort: '#5fc387', total: '#f5b942' };
    const gridOpts = { color: '#1a1f2b', drawBorder: false };
    let chartTimeline, chartMonthly, chartBonds, chartMonthlyUSD, chartMonthlyARS;

    Chart.defaults.color = '#8a93a6';
    Chart.defaults.borderColor = '#232937';
    Chart.defaults.font.family = "'Manrope', sans-serif";
    Chart.defaults.font.size = 11;

    function afterBodyBonos(ctxArr, chart, sym) {
      if (!ctxArr.length || !chart._bonosPorMes) return [];
      const idx = ctxArr[0].dataIndex;
      const bonos = chart._bonosPorMes[idx];
      if (!bonos?.length) return [];
      const agg = {};
      bonos.forEach(b => {
        if (!agg[b.bono]) agg[b.bono] = { int: 0, amort: 0, moneda: b.moneda };
        agg[b.bono].int += b.int; agg[b.bono].amort += b.amort;
      });
      return ['', '─── Por bono ───', ...Object.keys(agg).sort().map(name => {
        const a = agg[name];
        const s = a.moneda === 'ARS' ? '$' : 'U$';
        return `${name}: ${[a.int > 0.001 ? `int ${s}${fmt(a.int, 0)}` : '', a.amort > 0.001 ? `amort ${s}${fmt(a.amort, 0)}` : ''].filter(Boolean).join(' + ')}`;
      })];
    }

    function createCharts() {
      const mkBase = (id, datasets, extraOpts = {}) =>
        new Chart(document.getElementById(id).getContext('2d'), {
          type: 'bar',
          data: { labels: [], datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#141821', borderColor: '#2f3747',
                borderWidth: 1, padding: 12,
                ...extraOpts.tooltipOpts,
              },
            },
            scales: extraOpts.scales || {
              x: { grid: gridOpts, ticks: { maxRotation: 60, minRotation: 60 }, stacked: true },
              y: { grid: gridOpts, stacked: true, ticks: { callback: v => fmt(v, 0) } }
            },
            onClick: extraOpts.onClick,
          }
        });

      chartTimeline = new Chart(document.getElementById('chartTimeline').getContext('2d'), {
        type: 'bar',
        data: { labels: [], datasets: [
          { label: 'Interés',       data: [], backgroundColor: COLORS.int, stack: 'a', borderRadius: 3 },
          { label: 'Amortización',  data: [], backgroundColor: COLORS.amort, stack: 'a', borderRadius: 3 }
        ]},
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#141821', borderColor: '#2f3747', borderWidth: 1, padding: 12,
              callbacks: {
                title: c => c[0].label,
                label: ctx => ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2),
                afterBody: ctxArr => {
                  if (!ctxArr.length || !chartTimeline._bonosPorFecha) return [];
                  const bonos = chartTimeline._bonosPorFecha[ctxArr[0].dataIndex];
                  if (!bonos?.length) return [];
                  const agg = {};
                  bonos.forEach(b => {
                    if (!agg[b.bono]) agg[b.bono] = { int: 0, amort: 0, total: 0, moneda: b.moneda };
                    agg[b.bono].int += b.int; agg[b.bono].amort += b.amort; agg[b.bono].total += b.total;
                  });
                  return ['', '─── Detalle por bono ───', ...Object.keys(agg).sort().map(name => {
                    const a = agg[name]; const s = a.moneda === 'ARS' ? '$' : 'U$';
                    return `${name} (${a.moneda}): ${s} ${fmt(a.total, 2)}`;
                  })];
                }
              }
            },
          },
          scales: {
            x: { grid: gridOpts, ticks: { maxRotation: 45, minRotation: 45 }, stacked: true },
            y: { grid: gridOpts, stacked: true, ticks: { callback: v => fmt(v, 0) } }
          },
          // Click en barra → filtrar tabla por esa fecha
          onClick: (evt, elements) => {
            if (!elements.length) return;
            const label = chartTimeline.data.labels[elements[0].index];
            document.getElementById('tableInfo').textContent = `Filtrado por: ${label}`;
          }
        }
      });

      chartMonthly = new Chart(document.getElementById('chartMonthly').getContext('2d'), {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Flujo', data: [], backgroundColor: COLORS.total, borderRadius: 3 }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#141821', borderColor: '#2f3747', borderWidth: 1, padding: 10,
              callbacks: {
                title: c => c[0].label,
                label: ctx => 'Total: ' + fmt(ctx.parsed.y, 0),
                afterBody: ctxArr => afterBodyBonos(ctxArr, chartMonthly, ''),
              }
            }
          },
          scales: {
            x: { grid: gridOpts, ticks: { maxRotation: 60, minRotation: 60 } },
            y: { grid: gridOpts, ticks: { callback: v => fmt(v, 0) } }
          }
        }
      });

      chartBonds = new Chart(document.getElementById('chartBonds').getContext('2d'), {
        type: 'bar',
        data: { labels: [], datasets: [
          { label: 'Interés',      data: [], backgroundColor: COLORS.int,  stack: 'a' },
          { label: 'Amortización', data: [], backgroundColor: COLORS.amort, stack: 'a' }
        ]},
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#141821', borderColor: '#2f3747', borderWidth: 1,
              callbacks: { label: ctx => ctx.dataset.label + ': ' + fmt(ctx.parsed.x, 2) }
            }
          },
          scales: {
            x: { grid: gridOpts, stacked: true, ticks: { callback: v => fmt(v, 0) } },
            y: { grid: { display: false }, stacked: true }
          }
        }
      });

      chartMonthlyUSD = new Chart(document.getElementById('chartMonthlyUSD').getContext('2d'), {
        type: 'bar',
        data: { labels: [], datasets: [
          { label: 'Interés U$', data: [], backgroundColor: COLORS.int,  stack: 'a', borderRadius: 2 },
          { label: 'Amort. U$',  data: [], backgroundColor: COLORS.amort, stack: 'a', borderRadius: 2 }
        ]},
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#141821', borderColor: '#2f3747', borderWidth: 1, padding: 10,
              callbacks: {
                title: c => c[0].label,
                label: ctx => ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 2),
                afterBody: ctxArr => afterBodyBonos(ctxArr, chartMonthlyUSD, 'U$'),
              }
            }
          },
          scales: {
            x: { grid: gridOpts, ticks: { maxRotation: 60, minRotation: 60 }, stacked: true },
            y: { grid: gridOpts, stacked: true, ticks: { callback: v => 'U$ ' + fmt(v, 0) } }
          }
        }
      });

      chartMonthlyARS = new Chart(document.getElementById('chartMonthlyARS').getContext('2d'), {
        type: 'bar',
        data: { labels: [], datasets: [
          { label: 'Interés $', data: [], backgroundColor: '#b88ee8', stack: 'a', borderRadius: 2 },
          { label: 'Amort. $',  data: [], backgroundColor: '#e87066', stack: 'a', borderRadius: 2 }
        ]},
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#141821', borderColor: '#2f3747', borderWidth: 1, padding: 10,
              callbacks: {
                title: c => c[0].label,
                label: ctx => ctx.dataset.label + ': $ ' + fmt(ctx.parsed.y, 0),
                afterBody: ctxArr => afterBodyBonos(ctxArr, chartMonthlyARS, '$'),
              }
            }
          },
          scales: {
            x: { grid: gridOpts, ticks: { maxRotation: 60, minRotation: 60 }, stacked: true },
            y: { grid: gridOpts, stacked: true, ticks: { callback: v => '$ ' + fmt(v, 0) } }
          }
        }
      });
    }

    // ── Core filter + scale ──
    function scaleRow(r) {
      const s = AppState.getState();
      const hs = holdings();
      const h = normalizeHolding(hs[r.Bono]);
      const vn = h.vn || 0;
      const factor = s.VIEW_MODE === 'portfolio' ? vn / 100 : 1;
      const meta = s.BOND_META[r.Bono] || {};
      const monedaNativa = r.Moneda_Nativa || meta.moneda_nativa || 'USD';
      const esCER = meta.tipo === 'BONCER' || meta.tipo === 'BONCER cero';
      const fInfla = esCER ? factorInflacion(r.Fecha_Pago) : 1;
      const scaled = {
        ...r, vn, moneda_nativa: monedaNativa, es_cer: esCER, f_inflacion: fInfla,
        currency: monedaNativa === 'ARS' ? 'ARS' : (h.currency || 'USD'),
        interes_calc: r.Interes_USD * factor * fInfla,
        amort_calc:   r.Amortizacion_USD * factor * fInfla,
        flujo_calc:   r.Flujo_Total_USD * factor * fInfla,
        factor,
      };
      if (!s.SCENARIO.active) return scaled;
      const adjusted = Scenarios.applyToRow(scaled);
      return adjusted; // puede ser null si fuera del horizonte
    }

    function getFiltered() {
      const s = AppState.getState();
      const estado = document.getElementById('fEstado')?.value || 'Pendiente';
      const tipo = document.getElementById('fTipo')?.value || 'todos';
      let rows = s.DATA.filter(r => {
        if (s.FILTERS.anio.size > 0 && !s.FILTERS.anio.has(String(r.Anio))) return false;
        if (s.FILTERS.mes.size > 0 && !s.FILTERS.mes.has(String(r.Mes))) return false;
        if (s.FILTERS.dia.size > 0) {
          if (!s.FILTERS.dia.has(String(new Date(r.Fecha_Pago + 'T00:00:00').getDate()))) return false;
        }
        if (s.FILTERS.bono.size > 0 && !s.FILTERS.bono.has(r.Bono)) return false;
        if (estado !== 'todos' && r.Estado !== estado) return false;
        if (tipo === 'interes' && r.Interes_USD === 0) return false;
        if (tipo === 'amort'   && r.Amortizacion_USD === 0) return false;
        return true;
      }).map(scaleRow);

      if (s.VIEW_MODE === 'portfolio') rows = rows.filter(r => r && r.vn > 0);
      else rows = rows.filter(r => r !== null);
      return rows;
    }

    function switchToPortfolioAndRender() {
      const s = AppState.getState();
      if (s.VIEW_MODE !== 'portfolio') {
        s.VIEW_MODE = 'portfolio';
        document.querySelectorAll('.toggle-btn[data-mode]').forEach(b => b.classList.remove('active'));
        document.querySelector('.toggle-btn[data-mode="portfolio"]')?.classList.add('active');
      }
      render();
    }

    // ── Main render ──
    function render() {
      const s = AppState.getState();
      const rows = getFiltered();
      const isPortfolio = s.VIEW_MODE === 'portfolio';

      // Banner de modo cartera
      const banner = document.getElementById('modeBanner');
      if (banner) {
        if (isPortfolio) {
          banner.classList.add('visible');
          const pf = currentPF();
          const totalVN = Object.values(pf?.holdings || {}).reduce((a, h) => a + (normalizeHolding(h).vn || 0), 0);
          const bonosEn = Object.keys(pf?.holdings || {}).filter(k => normalizeHolding(pf.holdings[k]).vn > 0).length;
          document.getElementById('modeBannerText').textContent = `Modo CARTERA · ${pf?.name || ''} · ${bonosEn} bonos · VN ${totalVN.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
          if (s.SCENARIO.active) document.getElementById('modeBannerText').textContent += ' · ⚠ ESCENARIO ACTIVO';
        } else {
          banner.classList.remove('visible');
        }
      }

      // KPIs base
      const totalesUSD = { int: 0, amort: 0, total: 0 };
      const totalesARS = { int: 0, amort: 0, total: 0 };
      rows.forEach(r => {
        const t = r.moneda_nativa === 'ARS' ? totalesARS : totalesUSD;
        t.int += r.interes_calc; t.amort += r.amort_calc; t.total += r.flujo_calc;
      });

      const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
      const setHTML = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

      set('kpiTotalLabel', isPortfolio ? 'Flujo a Cobrar' : 'Flujo Total Filtrado');
      set('kpiTotalSub', isPortfolio ? 'en moneda de cada bono' : 'cada VN 100');

      const bonosEnCartera = Object.keys(holdings()).filter(k => normalizeHolding(holdings()[k]).vn > 0).length;

      if (isPortfolio && bonosEnCartera === 0) {
        ['kpiTotal','kpiInt','kpiAmort'].forEach(id => set(id, '–'));
        set('kpiCount', '0'); set('kpiIntSub', 'Cargá tu cartera');
        set('kpiAmortSub', '–'); set('kpiCountSub', '–');
      } else {
        // Flujo total (multi-moneda)
        const lineasTotal = [];
        if (totalesUSD.total > 0) lineasTotal.push('U$ ' + fmt(totalesUSD.total, 0));
        if (totalesARS.total > 0) lineasTotal.push('$ ' + fmt(totalesARS.total, 0));
        set('kpiTotal', lineasTotal.join(' + ') || '–');
        const lineasInt = [];
        if (totalesUSD.int > 0) lineasInt.push('U$ ' + fmt(totalesUSD.int, 0));
        if (totalesARS.int > 0) lineasInt.push('$ ' + fmt(totalesARS.int, 0));
        set('kpiInt', lineasInt.join(' + ') || '–');
        const lineasAm = [];
        if (totalesUSD.amort > 0) lineasAm.push('U$ ' + fmt(totalesUSD.amort, 0));
        if (totalesARS.amort > 0) lineasAm.push('$ ' + fmt(totalesARS.amort, 0));
        set('kpiAmort', lineasAm.join(' + ') || '–');
        set('kpiCount', rows.length);
        set('kpiIntSub', `${totalesUSD.total > 0 && totalesARS.total > 0 ? 'U$ + $' : totalesARS.total > 0 ? '$' : 'U$'}`);
        set('kpiAmortSub', s.COSTS.inflacion > 0 ? `CER proyectado al ${s.COSTS.inflacion + (s.SCENARIO.active ? s.SCENARIO.inflacionDelta : 0)}%` : '–');
        set('kpiCountSub', `${new Set(rows.map(r => r.Bono)).size} bonos`);
      }

      // ── KPIs financieros avanzados ──
      if (isPortfolio && bonosEnCartera > 0) {
        const pf = currentPF();
        const tirProm = Finance.portfolioWeightedTIR(pf.holdings, s.BOND_META, s.PRICES, s.COSTS, s.DATA);
        const yield_c = Finance.currentYield(pf.holdings, s.BOND_META, s.PRICES, s.DATA);
        const dur = Finance.macaulayDuration(pf.holdings, s.BOND_META, s.PRICES, s.DATA, tirProm);

        set('kpiTirProm',    tirProm !== null ? (tirProm * 100).toFixed(2) + '%' : '–');
        set('kpiYieldCorr',  yield_c !== null ? (yield_c * 100).toFixed(2) + '%' : '–');
        set('kpiDuration',   dur !== null ? dur.toFixed(2) + ' años' : '–');
        set('kpiTirSub',     tirProm !== null ? 'TIR ponderada por inv.' : 'Sin precio suficiente');
        set('kpiYieldSub',   'Cupones próx. 12m / precio');
        set('kpiDurationSub','Macaulay · base actual/365');
      } else {
        ['kpiTirProm','kpiYieldCorr','kpiDuration'].forEach(id => set(id, '–'));
      }

      // ── Insights ──
      if (isPortfolio) {
        const insights = Insights.analyze(rows, holdings(), s.BOND_META);
        Insights.render(insights);
      }

      // ── Charts ──
      const TIMELINE_CURRENCY = s.TIMELINE_CURRENCY;
      const rowsTimeline = TIMELINE_CURRENCY === 'both' ? rows : rows.filter(r => (r.moneda_nativa || 'USD') === TIMELINE_CURRENCY);

      const byDate = {};
      rowsTimeline.forEach(r => {
        if (!byDate[r.Fecha_Pago]) byDate[r.Fecha_Pago] = { int: 0, amort: 0, bonos: [] };
        byDate[r.Fecha_Pago].int += r.interes_calc;
        byDate[r.Fecha_Pago].amort += r.amort_calc;
        byDate[r.Fecha_Pago].bonos.push({ bono: r.Bono, moneda: r.moneda_nativa || 'USD', int: r.interes_calc, amort: r.amort_calc, total: r.flujo_calc });
      });
      const sd = Object.keys(byDate).sort();
      chartTimeline._bonosPorFecha = sd.map(d => byDate[d].bonos);
      chartTimeline.data.labels = sd.map(d => fmtFecha(d));
      chartTimeline.data.datasets[0].data = sd.map(d => byDate[d].int);
      chartTimeline.data.datasets[1].data = sd.map(d => byDate[d].amort);
      chartTimeline.update('none'); // 'none' = sin animación → más rápido en re-renders frecuentes

      const byMonth = {}, byMonthBonos = {};
      rows.forEach(r => {
        const key = `${r.Anio}-${String(r.Mes).padStart(2,'0')}`;
        byMonth[key] = (byMonth[key] || 0) + r.flujo_calc;
        if (!byMonthBonos[key]) byMonthBonos[key] = [];
        byMonthBonos[key].push({ bono: r.Bono, moneda: r.moneda_nativa || 'USD', int: r.interes_calc, amort: r.amort_calc });
      });
      const sm = Object.keys(byMonth).sort();
      const fmtMes = m => { const [y, mo] = m.split('-'); return MESES[parseInt(mo)-1] + ' ' + y; };
      chartMonthly._bonosPorMes = sm.map(m => byMonthBonos[m] || []);
      chartMonthly.data.labels = sm.map(fmtMes);
      chartMonthly.data.datasets[0].data = sm.map(m => byMonth[m]);
      chartMonthly.update('none');

      const byBond = {};
      rows.forEach(r => {
        if (!byBond[r.Bono]) byBond[r.Bono] = { int: 0, amort: 0 };
        byBond[r.Bono].int += r.interes_calc; byBond[r.Bono].amort += r.amort_calc;
      });
      const sortedBonds = Object.keys(byBond).sort((a,b) => (byBond[b].int+byBond[b].amort) - (byBond[a].int+byBond[a].amort));
      chartBonds.data.labels = sortedBonds;
      chartBonds.data.datasets[0].data = sortedBonds.map(b => byBond[b].int);
      chartBonds.data.datasets[1].data = sortedBonds.map(b => byBond[b].amort);
      chartBonds.update('none');

      const byMonthUSD = {}, byMonthARS = {}, byMonthBUSD = {}, byMonthBARS = {};
      rows.forEach(r => {
        const key = `${r.Anio}-${String(r.Mes).padStart(2,'0')}`;
        const mn = r.moneda_nativa || 'USD';
        const entry = { bono: r.Bono, moneda: mn, int: r.interes_calc, amort: r.amort_calc };
        if (mn === 'USD') {
          if (!byMonthUSD[key]) byMonthUSD[key] = { int: 0, amort: 0 };
          byMonthUSD[key].int += r.interes_calc; byMonthUSD[key].amort += r.amort_calc;
          if (!byMonthBUSD[key]) byMonthBUSD[key] = [];
          byMonthBUSD[key].push(entry);
        } else {
          if (!byMonthARS[key]) byMonthARS[key] = { int: 0, amort: 0 };
          byMonthARS[key].int += r.interes_calc; byMonthARS[key].amort += r.amort_calc;
          if (!byMonthBARS[key]) byMonthBARS[key] = [];
          byMonthBARS[key].push(entry);
        }
      });
      const smUSD = Object.keys(byMonthUSD).sort();
      chartMonthlyUSD._bonosPorMes = smUSD.map(m => byMonthBUSD[m] || []);
      chartMonthlyUSD.data.labels = smUSD.map(fmtMes);
      chartMonthlyUSD.data.datasets[0].data = smUSD.map(m => byMonthUSD[m].int);
      chartMonthlyUSD.data.datasets[1].data = smUSD.map(m => byMonthUSD[m].amort);
      chartMonthlyUSD.update('none');
      const smARS = Object.keys(byMonthARS).sort();
      chartMonthlyARS._bonosPorMes = smARS.map(m => byMonthBARS[m] || []);
      chartMonthlyARS.data.labels = smARS.map(fmtMes);
      chartMonthlyARS.data.datasets[0].data = smARS.map(m => byMonthARS[m].int);
      chartMonthlyARS.data.datasets[1].data = smARS.map(m => byMonthARS[m].amort);
      chartMonthlyARS.update('none');

      // ── Tabla ──
      renderTable(rows, isPortfolio, totalesUSD, totalesARS);
    }

    function renderTable(rows, isPortfolio, totalesUSD, totalesARS) {
      const thead = document.getElementById('tablaThead');
      const tbody = document.getElementById('tablaTbody');
      if (!thead || !tbody) return;

      thead.innerHTML = isPortfolio ? `<tr>
        <th>Fecha</th><th>Bono</th><th>Mon.</th><th style="text-align:right">VN</th><th>Ley</th>
        <th style="text-align:right">Interés</th><th style="text-align:right">Amort.</th><th style="text-align:right">Flujo</th>
      </tr>` : `<tr>
        <th>Fecha</th><th>Bono</th><th>Tipo</th><th>Ley</th><th>Estado</th>
        <th style="text-align:right">Residual</th><th style="text-align:right">Tasa</th>
        <th style="text-align:right">Interés</th><th style="text-align:right">Amort</th><th style="text-align:right">Flujo</th>
      </tr>`;

      const sorted = [...rows].sort((a,b) => a.Fecha_Pago.localeCompare(b.Fecha_Pago) || a.Bono.localeCompare(b.Bono));
      if (!sorted.length) {
        const span = isPortfolio ? 8 : 10;
        tbody.innerHTML = `<tr><td colspan="${span}" class="empty-state"><h3>Sin resultados</h3><div>Cargá bonos o ajustá los filtros.</div></td></tr>`;
        return;
      }

      tbody.innerHTML = sorted.map(r => {
        if (isPortfolio) {
          const mon = r.moneda_nativa || 'USD';
          const cerNote = r.es_cer && r.f_inflacion > 1.001 ? ` <span style="color:var(--purple);font-size:9px">×${r.f_inflacion.toFixed(2)}</span>` : '';
          const scenNote = r._scenario ? ` <span style="color:var(--red);font-size:9px">~</span>` : '';
          return `<tr class="${r.Estado === 'Pagado' ? 'paid' : ''}">
            <td class="mono">${fmtFecha(r.Fecha_Pago)}</td>
            <td>${escapeHtml(r.Bono)}${cerNote}${scenNote}</td>
            <td><span class="badge ${mon === 'ARS' ? 'ars' : 'usd'}">${mon}</span></td>
            <td class="num">${r.vn.toLocaleString('es-AR')}</td>
            <td>${r.Ley}</td>
            <td class="num">${fmtMoney(r.interes_calc, mon, 2)}</td>
            <td class="num">${fmtMoney(r.amort_calc, mon, 2)}</td>
            <td class="num highlight">${fmtMoney(r.flujo_calc, mon, 2)}</td>
          </tr>`;
        } else {
          return `<tr class="${r.Estado === 'Pagado' ? 'paid' : ''}">
            <td class="mono">${fmtFecha(r.Fecha_Pago)}</td>
            <td>${escapeHtml(r.Bono)}</td>
            <td>${r.Tipo_Instrumento}</td><td>${r.Ley}</td>
            <td><span class="badge ${r.Estado === 'Pendiente' ? 'pending' : 'paid'}">${r.Estado}</span></td>
            <td class="num">${fmtPct(r.Residual_Inicio_Pct)}</td>
            <td class="num">${(r.Tasa_Anual_Pct*100).toFixed(3)}%</td>
            <td class="num">${fmtMoney(r.Interes_USD, r.Moneda_Nativa||'USD', 4)}</td>
            <td class="num">${fmtMoney(r.Amortizacion_USD, r.Moneda_Nativa||'USD', 4)}</td>
            <td class="num highlight">${fmtMoney(r.Flujo_Total_USD, r.Moneda_Nativa||'USD', 4)}</td>
          </tr>`;
        }
      }).join('');

      const info = document.getElementById('tableInfo');
      if (info) {
        const parts = [];
        if (totalesUSD.total > 0) parts.push('U$ ' + fmt(totalesUSD.total, 0));
        if (totalesARS.total > 0) parts.push('$ ' + fmt(totalesARS.total, 0));
        info.textContent = `${sorted.length} pagos · ${new Set(sorted.map(r => r.Bono)).size} bonos · ${parts.join(' + ')}`;
      }
    }

    // ── renderPortfolioInputs: igual que el original pero usando AppState ──
    function renderPortfolioInputs() {
      const s = AppState.getState();
      const pf = currentPF();
      if (!pf) return;

      const pfNameInput = document.getElementById('pfNameInput');
      const pfTitle = document.getElementById('pfTitle');
      if (pfNameInput) pfNameInput.value = pf.name;
      if (pfTitle) pfTitle.textContent = pf.name;

      const btnDelete = document.getElementById('btnDeletePf');
      if (btnDelete) btnDelete.style.display = Object.keys(s.PORTFOLIOS).length > 1 ? '' : 'none';

      const container = document.getElementById('portfolioSections');
      if (!container) return;

      const grupos = { 'Tesoro USD': [], 'BOPREAL': [], 'LECAPs / BONCAPs': [], 'BONCER (CER)': [] };
      Object.keys(s.BOND_META).forEach(b => {
        const m = s.BOND_META[b];
        if (m.tipo === 'BOPREAL') grupos['BOPREAL'].push(b);
        else if (m.tipo === 'LECAP' || m.tipo === 'BONCAP') grupos['LECAPs / BONCAPs'].push(b);
        else if (m.tipo === 'BONCER' || m.tipo === 'BONCER cero') grupos['BONCER (CER)'].push(b);
        else grupos['Tesoro USD'].push(b);
      });

      let html = '';
      Object.entries(grupos).forEach(([grupoNombre, bonos]) => {
        if (!bonos.length) return;
        html += `<div class="portfolio-section"><div class="portfolio-section-title">${grupoNombre}</div><div class="portfolio-inputs">`;
        bonos.forEach(b => {
          const meta = s.BOND_META[b];
          const h = normalizeHolding(pf.holdings[b]);
          const isArsNative = meta.moneda_nativa === 'ARS';
          const currency = isArsNative ? 'ARS' : (h.currency || 'USD');
          const vn = h.vn || 0;
          const manualKey = currency === 'ARS' ? 'precio_manual_ars' : 'precio_manual_usd';
          const precioManual = h[manualKey];
          const precioMercado = Finance.effectivePrice(b, currency, h, meta, s.PRICES);
          // Aplicar escenario al precio mostrado
          const precioMercadoAdj = precioMercado && s.SCENARIO.active ? Scenarios.adjustedPrice(precioMercado) : precioMercado;
          const precioFinal = precioManual != null ? precioManual : (precioMercadoAdj ? precioMercadoAdj.price : null);
          const precioSource = precioManual != null ? 'manual' : (precioMercado ? 'live' : null);
          const sym = currency === 'ARS' ? '$' : 'U$';
          const hasVal = vn > 0 ? 'has-value' : '';
          const montoCalculado = vn > 0 && precioFinal != null ? (vn * precioFinal / 100) : 0;
          const montoGuardado = h.monto_invertido || 0;
          const montoMostrar = montoCalculado > 0 ? montoCalculado.toFixed(2) : (montoGuardado > 0 ? montoGuardado.toFixed(2) : '');
          const tipoBadge = meta.tipo ? `<span style="font-size:9px;color:var(--text-faint);font-family:'JetBrains Mono',monospace;margin-left:4px">${meta.tipo}${meta.es_custom ? ' ★' : ''}</span>` : '';
          const currencyToggle = isArsNative
            ? `<span class="badge ars" style="font-size:9px;padding:2px 6px">ARS</span>`
            : `<div class="bond-currency-toggle" data-nomodal>
                <button type="button" class="${currency==='USD'?'active':''}" data-currency-btn="USD" data-bono="${b}">U$</button>
                <button type="button" class="${currency==='ARS'?'active':''}" data-currency-btn="ARS" data-bono="${b}">$</button>
               </div>`;
          let priceLabel = '';
          if (precioFinal != null) {
            const icon = precioSource === 'manual' ? '✎' : (s.SCENARIO.active ? '⚠' : '●');
            priceLabel = `<div class="bond-input-price ${precioSource}">${icon} ${sym}${precioFinal.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})} (${precioSource}${s.SCENARIO.active&&s.SCENARIO.precioDelta!==0?` ${s.SCENARIO.precioDelta>0?'+':''}${s.SCENARIO.precioDelta}%`:''})${meta.tipo==='LECAP'||meta.tipo==='BONCAP'?` <span style="color:var(--accent-dim);font-size:9px">TEM implícita calculada en popup</span>`:''}</div>`;
          } else {
            priceLabel = `<div class="bond-input-price">Sin precio · ingresá manualmente</div>`;
          }

          html += `<div class="bond-input ${hasVal}" data-bono="${b}" data-open-modal>
            <div class="bond-input-header"><span class="bond-input-name">${escapeHtml(b)}${tipoBadge}</span>${currencyToggle}</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-faint);margin-bottom:4px">Vto ${meta.venc}</div>
            ${priceLabel}
            <div class="bond-input-row" style="margin-bottom:4px" data-nomodal>
              <span class="prefix">VN</span>
              <input type="number" class="vn-input" data-bono="${b}" data-field="vn" value="${vn||''}" placeholder="0" min="0" step="100">
            </div>
            <div class="bond-input-row" style="margin-bottom:4px" data-nomodal title="Monto a invertir. Calcula VN automáticamente.">
              <span class="prefix" style="color:var(--accent-dim)">${sym}</span>
              <input type="number" class="monto-input" data-bono="${b}" value="${montoMostrar}" placeholder="monto a invertir" min="0" step="0.01" style="border-color:rgba(245,185,66,0.2)">
            </div>
            <div class="bond-input-row" data-nomodal>
              <span class="prefix" style="font-size:10px;opacity:.7">Px</span>
              <input type="number" class="price-input" data-bono="${b}" data-field="${manualKey}" value="${precioManual!=null?precioManual:''}" placeholder="${precioMercado?precioMercado.price.toFixed(2):'precio c/100 VN'}" min="0" step="0.01">
            </div>
            <div class="bond-input-open-hint">→ ver calc</div>
          </div>`;
        });
        html += '</div></div>';
      });
      container.innerHTML = html;
      wirePortfolioInputs(container);
      updateCarteraTotal();
    }

    function wirePortfolioInputs(container) {
      // Monto input
      container.querySelectorAll('.monto-input').forEach(inp => {
        inp.addEventListener('input', e => {
          const bono = e.target.dataset.bono;
          const monto = parseFloat(e.target.value);
          const s = AppState.getState();
          const pf = currentPF();
          const meta = s.BOND_META[bono] || {};
          const mn = meta.moneda_nativa || 'USD';
          if (!pf.holdings[bono] || typeof pf.holdings[bono]==='number') pf.holdings[bono] = normalizeHolding(pf.holdings[bono]);
          const h = pf.holdings[bono];
          if (!Number.isFinite(monto) || monto <= 0) {
            delete h.vn; delete h.monto_invertido;
            if (!h.precio_manual_usd && !h.precio_manual_ars) delete pf.holdings[bono];
            Storage.save(); updateCarteraTotal(); switchToPortfolioAndRender(); return;
          }
          h.monto_invertido = monto;
          const currency = mn === 'ARS' ? 'ARS' : (h.currency || 'USD');
          const precio = Finance.effectivePrice(bono, currency, h, meta, s.PRICES);
          if (precio?.price > 0) {
            h.vn = Math.round(monto / precio.price * 100);
            const vnInp = e.target.closest('.bond-input')?.querySelector('.vn-input');
            if (vnInp) vnInp.value = h.vn;
            const aviso = e.target.closest('.bond-input')?.querySelector('.monto-aviso');
            if (aviso) aviso.style.display = 'none';
          } else {
            const aviso = e.target.closest('.bond-input')?.querySelector('.monto-aviso');
            if (aviso) { aviso.style.display = 'block'; aviso.textContent = '⚠ Sin precio · el VN se calculará al actualizar precios.'; }
          }
          Storage.save(); updateCarteraTotal(); switchToPortfolioAndRender();
        });
        inp.addEventListener('blur', () => { renderPortfolioInputs(); render(); });
      });

      // VN + precio manual
      container.querySelectorAll('.vn-input, .price-input').forEach(inp => {
        inp.addEventListener('input', e => {
          const bono = e.target.dataset.bono;
          const field = e.target.dataset.field;
          const val = parseFloat(e.target.value);
          const pf = currentPF();
          if (!pf.holdings[bono] || typeof pf.holdings[bono]==='number') pf.holdings[bono] = normalizeHolding(pf.holdings[bono]);
          if (Number.isFinite(val) && val > 0) {
            pf.holdings[bono][field] = val;
            if (field === 'vn') {
              delete pf.holdings[bono].monto_invertido;
              const s = AppState.getState();
              const meta = s.BOND_META[bono] || {};
              const mn = meta.moneda_nativa || 'USD';
              const currency = mn === 'ARS' ? 'ARS' : (pf.holdings[bono].currency || 'USD');
              const precio = Finance.effectivePrice(bono, currency, pf.holdings[bono], meta, s.PRICES);
              if (precio?.price > 0) {
                const montoInp = e.target.closest('.bond-input')?.querySelector('.monto-input');
                if (montoInp) montoInp.value = (val * precio.price / 100).toFixed(2);
              }
            }
          } else {
            delete pf.holdings[bono][field];
          }
          const h = pf.holdings[bono];
          if (!h.vn && !h.monto_invertido && h.precio_manual_usd==null && h.precio_manual_ars==null) delete pf.holdings[bono];
          Storage.save(); updateCarteraTotal(); switchToPortfolioAndRender();
        });
        inp.addEventListener('blur', () => { renderPortfolioInputs(); render(); });
      });

      // Toggle de moneda
      container.querySelectorAll('[data-currency-btn]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const bono = btn.dataset.bono;
          const newCurr = btn.dataset.currencyBtn;
          const pf = currentPF();
          pf.holdings[bono] = normalizeHolding(pf.holdings[bono]);
          pf.holdings[bono].currency = newCurr;
          Storage.save(); renderPortfolioInputs(); switchToPortfolioAndRender();
        });
      });

      // Abrir modal al click en card
      container.querySelectorAll('[data-open-modal]').forEach(card => {
        card.addEventListener('click', e => {
          if (e.target.closest('[data-nomodal]') || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
          openBondModal(card.dataset.bono);
        });
      });
    }

    function updateCarteraTotal() {
      const s = AppState.getState();
      const pf = currentPF();
      if (!pf) return;
      let vnUSD = 0, vnARS = 0, invUSD = 0, invARS = 0;
      Object.keys(pf.holdings).forEach(b => {
        const h = normalizeHolding(pf.holdings[b]);
        const meta = s.BOND_META[b] || {};
        const mn = meta.moneda_nativa || 'USD';
        const vn = h.vn || 0;
        if (mn === 'ARS') vnARS += vn; else vnUSD += vn;
        if (!vn) return;
        const currency = mn === 'ARS' ? 'ARS' : (h.currency || 'USD');
        const precio = Finance.effectivePrice(b, currency, h, meta, s.PRICES);
        if (!precio) return;
        const m = vn * precio.price / 100;
        if (mn === 'ARS') invARS += m; else invUSD += m;
      });
      const vnParts = [];
      if (vnUSD > 0) vnParts.push('USD ' + vnUSD.toLocaleString('es-AR', { maximumFractionDigits: 0 }));
      if (vnARS > 0) vnParts.push('ARS ' + vnARS.toLocaleString('es-AR', { maximumFractionDigits: 0 }));
      const el = document.getElementById('carteraTotal');
      if (el) el.textContent = vnParts.length ? vnParts.join(' + ') : '0';
      const invParts = [];
      if (invUSD > 0) invParts.push('U$ ' + invUSD.toLocaleString('es-AR', { maximumFractionDigits: 0 }));
      if (invARS > 0) invParts.push('$ ' + invARS.toLocaleString('es-AR', { maximumFractionDigits: 0 }));
      const invEl = document.getElementById('carteraInv');
      if (invEl) { invEl.textContent = invParts.length ? invParts.join(' + ') : '—'; invEl.title = 'Monto invertido aprox.'; }
    }

    // ── Tabs de cartera ──
    function renderTabs() {
      const s = AppState.getState();
      const tabsEl = document.getElementById('pfTabs');
      if (!tabsEl) return;
      tabsEl.innerHTML = Object.keys(s.PORTFOLIOS).map(id => {
        const pf = s.PORTFOLIOS[id];
        const isActive = id === s.ACTIVE_PF;
        const canDel = Object.keys(s.PORTFOLIOS).length > 1;
        return `<button class="pf-tab ${isActive?'active':''}" data-pf-id="${id}">
          <span>${escapeHtml(pf.name)}</span>
          ${canDel ? `<span class="pf-tab-close" data-close-id="${id}" title="Eliminar">×</span>` : ''}
        </button>`;
      }).join('');
      tabsEl.querySelectorAll('.pf-tab').forEach(btn => {
        btn.addEventListener('click', e => {
          if (e.target.classList.contains('pf-tab-close')) return;
          const id = btn.dataset.pfId;
          if (id !== s.ACTIVE_PF) { s.ACTIVE_PF = id; Storage.save(); renderTabs(); renderPortfolioInputs(); render(); }
        });
      });
      tabsEl.querySelectorAll('.pf-tab-close').forEach(x => {
        x.addEventListener('click', e => {
          e.stopPropagation();
          const id = x.dataset.closeId;
          if (!confirm(`¿Eliminar la cartera "${s.PORTFOLIOS[id].name}"?`)) return;
          delete s.PORTFOLIOS[id];
          if (s.ACTIVE_PF === id) s.ACTIVE_PF = Object.keys(s.PORTFOLIOS)[0];
          Storage.save(); renderTabs(); renderPortfolioInputs(); render();
        });
      });
    }

    function openBondModal(bono) {
      // Delegamos a la función existente en el HTML (modal completo)
      // En una migración a React, esto sería un componente <BondModal bono={bono} />
      if (typeof window._openBondModal === 'function') window._openBondModal(bono);
    }

    return { render, renderPortfolioInputs, renderTabs, switchToPortfolioAndRender, updateCarteraTotal, createCharts, getFiltered, scaleRow };
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. INIT — bootstrap
  // ─────────────────────────────────────────────────────────────────────────────
  async function init() {
    const loadingEl = document.getElementById('appLoading');
    const loadingMsg = document.getElementById('loadingMsg');
    const loadingErr = document.getElementById('loadingError');

    function setMsg(m) { if (loadingMsg) loadingMsg.textContent = m; }
    function showError(msg) {
      if (loadingErr) {
        loadingErr.innerHTML = `<div class="loading-error">${msg}<br><button onclick="window.location.reload()">Reintentar</button></div>`;
        loadingErr.style.display = 'block';
        if (loadingMsg) loadingMsg.style.display = 'none';
      }
    }

    try {
      setMsg('Cargando datos de flujos…');
      const data = await DataLayer.load(status => {
        if (status === 'cache') setMsg('Cargando desde caché…');
        else if (status === 'fetching') setMsg('Descargando data.json…');
      });

      const s = AppState.getState();
      s.DATA = data;
      // BOND_META viene inyectado desde index.html (window.BOND_META_INIT)
      s.BOND_META = window.BOND_META_INIT || {};

      setMsg('Inicializando…');

      // Storage
      const loaded = Storage.load();
      if (!Object.keys(s.PORTFOLIOS).length) {
        const id = 'pf_' + Date.now();
        s.PORTFOLIOS[id] = { name: 'Cartera Principal', holdings: {} };
        s.ACTIVE_PF = id;
      }
      if (!s.ACTIVE_PF || !s.PORTFOLIOS[s.ACTIVE_PF]) s.ACTIVE_PF = Object.keys(s.PORTFOLIOS)[0];

      // Cartura compartida vía hash
      ExportImport.tryLoadFromHash();

      // Custom instruments guardados
      loadCustomInstruments();

      // Escenarios
      Scenarios.init();

      // Inicializar filtros multiselect
      initMultiselects();

      // Tabs + inputs + charts
      UI.renderTabs();
      UI.renderPortfolioInputs();
      UI.createCharts();

      // Mostrar estado de precios previos
      if (Object.values(s.PRICES).some(p => p.source === 'live')) {
        document.getElementById('statusDot')?.classList.add('live');
        document.getElementById('statusText').textContent = `Precios cargados (${Object.values(s.PRICES).filter(p => p.source==='live').length})`;
      }

      // Inicializar curvas de rendimiento
      YieldCurves.init();

      // Wire eventos
      wireEvents();

      // Render inicial
      UI.render();

      // Ocultar loading
      if (loadingEl) {
        loadingEl.classList.add('done');
        setTimeout(() => loadingEl.remove(), 500);
      }

      // Precios en vivo + APIs externas
      PricesAPI.fetch5min().catch(() => {});
      ExternalAPIs.refresh().catch(() => {});

    } catch (err) {
      console.error('Init error:', err);
      showError(`Error al inicializar la aplicación:<br><em>${err.message}</em><br>Verificá que <code>data.json</code> esté en el mismo directorio que <code>index.html</code>.`);
    }
  }

  function wireEvents() {
    const s = AppState.getState();
    const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);

    // View toggle
    document.querySelectorAll('.toggle-btn[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        s.VIEW_MODE = btn.dataset.mode;
        if (s.VIEW_MODE === 'portfolio') document.getElementById('portfolioPanel')?.setAttribute('open', '');
        UI.render();
      });
    });

    // Timeline currency toggle
    document.querySelectorAll('#timelineCurrencyToggle .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#timelineCurrencyToggle .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        s.TIMELINE_CURRENCY = btn.dataset.tcurr;
        UI.render();
      });
    });

    // Filtros
    on('fEstado', 'change', () => UI.render());
    on('fTipo',   'change', () => UI.render());
    on('btnReset', 'click', () => {
      ['anio','mes','dia','bono'].forEach(k => { s.FILTERS[k].clear(); buildMultiselectDropdown(k); updateMultiselectUI(k); });
      document.getElementById('fEstado').value = 'Pendiente';
      document.getElementById('fTipo').value = 'todos';
      UI.render();
    });

    // Portfolio actions
    on('btnClearCartera', 'click', () => {
      const pf = currentPF();
      if (!confirm(`¿Vaciar "${pf.name}"?`)) return;
      pf.holdings = {}; Storage.save(); UI.renderPortfolioInputs(); UI.switchToPortfolioAndRender();
    });
    on('btnExampleCartera', 'click', () => {
      currentPF().holdings = {
        'AL30 / GD30': { vn: 10000, currency: 'USD' },
        'AL35 / GD35': { vn: 5000,  currency: 'USD' },
        'AN29':        { vn: 8000,  currency: 'ARS' },
        'AO27':        { vn: 5000,  currency: 'USD' },
        'BPD7 (BOPREAL S.1-D)': { vn: 3000, currency: 'USD' },
      };
      Storage.save(); UI.renderPortfolioInputs(); UI.switchToPortfolioAndRender();
    });
    on('btnDeletePf', 'click', () => {
      if (Object.keys(s.PORTFOLIOS).length <= 1) return alert('No podés eliminar la última cartera.');
      const pf = currentPF();
      if (!confirm(`¿Eliminar "${pf.name}"?`)) return;
      delete s.PORTFOLIOS[s.ACTIVE_PF];
      s.ACTIVE_PF = Object.keys(s.PORTFOLIOS)[0];
      Storage.save(); UI.renderTabs(); UI.renderPortfolioInputs(); UI.render();
    });
    on('pfNameInput', 'change', e => {
      const pf = currentPF();
      pf.name = (e.target.value || 'Sin nombre').trim().slice(0, 40);
      Storage.save(); UI.renderTabs();
      document.getElementById('pfTitle').textContent = pf.name;
    });

    // Nueva cartera
    const modalNewPf = document.getElementById('modalNewPf');
    const newPfInput = document.getElementById('newPfNameInput');
    on('btnNewPf', 'click', () => {
      if (newPfInput) newPfInput.value = `Cartera ${Object.keys(s.PORTFOLIOS).length + 1}`;
      modalNewPf?.classList.add('open');
      setTimeout(() => newPfInput?.focus(), 50);
    });
    on('modalNewCancel', 'click', () => modalNewPf?.classList.remove('open'));
    on('modalNewConfirm', 'click', () => {
      const name = newPfInput?.value.trim();
      if (!name) return;
      const id = 'pf_' + Date.now();
      s.PORTFOLIOS[id] = { name, holdings: {} };
      s.ACTIVE_PF = id;
      Storage.save(); UI.renderTabs(); UI.renderPortfolioInputs();
      document.getElementById('portfolioPanel')?.setAttribute('open', '');
      modalNewPf?.classList.remove('open');
      UI.render();
    });
    newPfInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') on('modalNewConfirm', 'click', ()=>{});
      if (e.key === 'Escape') modalNewPf?.classList.remove('open');
    });
    modalNewPf?.addEventListener('click', e => { if (e.target === modalNewPf) modalNewPf.classList.remove('open'); });

    // Precios
    on('btnFetchPrices', 'click', () => PricesAPI.fetchAll());

    // Costos
    ['costComision','costDerechos','costIva','costInflacion'].forEach(id => {
      const map = { costComision:'comision', costDerechos:'derechos', costIva:'iva', costInflacion:'inflacion' };
      document.getElementById(id)?.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        s.COSTS[map[id]] = Number.isFinite(v) ? v : 0;
        Storage.save();
        document.getElementById('costsSubtitle').textContent =
          `Broker ${s.COSTS.comision}% + Derechos ${s.COSTS.derechos}% + IVA ${s.COSTS.iva}% · Inflación ${s.COSTS.inflacion}% (CER)`;
        if (id === 'costInflacion') UI.render();
      });
    });

    // Exports
    on('btnExport', 'click', () => {
      const rows = UI.getFiltered();
      const pf = currentPF();
      const csv = ExportImport.toCSV(rows, pf.name, s.COSTS, s.BOND_META, s.PRICES);
      const fecha = new Date().toISOString().slice(0,10);
      ExportImport.downloadCSV(csv, `cartera_${(pf.name||'').replace(/\s+/g,'_')}_${fecha}.csv`);
    });
    on('btnExportExcel', 'click', () => ExportImport.toExcel(UI.getFiltered(), currentPF()?.name).catch(e => alert('Error al generar Excel: ' + e.message)));
    on('btnExportJSON', 'click', () => ExportImport.exportJSON());
    on('btnImportJSON', 'click', () => document.getElementById('fileImportJSON')?.click());
    document.getElementById('fileImportJSON')?.addEventListener('change', e => {
      if (e.target.files[0]) ExportImport.importJSON(e.target.files[0]);
    });
    on('btnShareLink', 'click', () => ExportImport.shareLink());

    // Versionado
    on('btnSaveVersion', 'click', () => {
      const label = prompt('Nombre para esta versión (opcional):');
      Storage.saveVersion(label || undefined);
      renderVersionsList();
      alert('Versión guardada.');
    });

    // Cerrar modales con ESC
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
    });

    // Modal bond: cerrar al click en backdrop
    document.getElementById('modalBond')?.addEventListener('click', e => {
      if (e.target.id === 'modalBond') e.currentTarget.classList.remove('open');
    });

    // Add instrument modal
    on('btnAddInstrument', 'click', () => {
      ['instTicker','instEmision','instVencimiento','instTem','instCupon','instAmortCuotas']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      document.getElementById('instTipo').value = 'LECAP';
      const prev = document.getElementById('instPreview');
      if (prev) { prev.textContent = 'Completá los campos para ver el preview.'; prev.style.color = 'var(--text-faint)'; }
      actualizarCamposInst();
      document.getElementById('modalAddInst')?.classList.add('open');
    });
    on('modalAddInstCancel', 'click', () => document.getElementById('modalAddInst')?.classList.remove('open'));
    on('modalAddInstConfirm', 'click', () => { if (addCustomInstrumentGlobal()) document.getElementById('modalAddInst')?.classList.remove('open'); });
    ['instTicker','instEmision','instVencimiento','instTem','instCupon','instSpread','instTasaBase','instAmortCuotas','instFreq','instMoneda','instFlujosManual','instEmisor','instChequePrec','instChequeMon']
      .forEach(id => document.getElementById(id)?.addEventListener('input', actualizarPreviewInst));
    document.getElementById('instTipo')?.addEventListener('change', actualizarCamposInst);
  }

  // ── Multiselect filters ──
  const FILTER_OPTIONS = {};
  function buildFilterOptions() {
    const s = AppState.getState();
    const anios = [...new Set(s.DATA.map(r => r.Anio))].sort();
    const bonos = Object.keys(s.BOND_META);
    const diasSet = [...new Set(s.DATA.map(r => new Date(r.Fecha_Pago+'T00:00:00').getDate()))].sort((a,b)=>a-b);
    FILTER_OPTIONS.anio = anios.map(a => ({ value: String(a), label: String(a) }));
    FILTER_OPTIONS.mes  = MESES.map((m, i) => ({ value: String(i+1), label: m }));
    FILTER_OPTIONS.dia  = diasSet.map(d => ({ value: String(d), label: String(d) }));
    FILTER_OPTIONS.bono = bonos.map(b => ({ value: b, label: b }));
  }

  function initMultiselects() {
    buildFilterOptions();
    ['anio','mes','dia','bono'].forEach(key => {
      buildMultiselectDropdown(key);
      updateMultiselectUI(key);
      const el = document.querySelector(`.multiselect[data-filter="${key}"]`);
      if (!el) return;
      el.addEventListener('click', e => {
        if (e.target.classList.contains('x')) return;
        const dropdown = el.querySelector('.multiselect-dropdown');
        const alreadyOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.multiselect-dropdown.open').forEach(d => d.classList.remove('open'));
        document.querySelectorAll('.multiselect.open').forEach(m => m.classList.remove('open'));
        if (!alreadyOpen) { dropdown.classList.add('open'); el.classList.add('open'); }
      });
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.multiselect')) {
        document.querySelectorAll('.multiselect-dropdown.open').forEach(d => d.classList.remove('open'));
        document.querySelectorAll('.multiselect.open').forEach(m => m.classList.remove('open'));
      }
    });
  }

  function buildMultiselectDropdown(key) {
    const s = AppState.getState();
    const el = document.querySelector(`.multiselect[data-filter="${key}"]`);
    if (!el) return;
    const dropdown = el.querySelector('.multiselect-dropdown');
    const opts = FILTER_OPTIONS[key] || [];
    const selected = s.FILTERS[key];
    dropdown.innerHTML = `
      <div class="ms-option all" data-ms-all><input type="checkbox" ${selected.size===0?'checked':''}><span>(Todos)</span></div>
      ${opts.map(o => `<div class="ms-option" data-ms-value="${escapeHtml(o.value)}"><input type="checkbox" ${selected.has(o.value)?'checked':''}><span>${escapeHtml(o.label)}</span></div>`).join('')}`;
    dropdown.querySelectorAll('.ms-option').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        if (opt.dataset.msAll !== undefined) { selected.clear(); }
        else { const v = opt.dataset.msValue; selected.has(v) ? selected.delete(v) : selected.add(v); }
        buildMultiselectDropdown(key); updateMultiselectUI(key); UI.render();
      });
    });
  }

  function updateMultiselectUI(key) {
    const s = AppState.getState();
    const el = document.querySelector(`.multiselect[data-filter="${key}"]`);
    if (!el) return;
    el.querySelectorAll('.multiselect-chip').forEach(c => c.remove());
    const placeholder = el.querySelector('.multiselect-placeholder');
    const selected = s.FILTERS[key];
    if (selected.size === 0) { if (placeholder) { placeholder.style.display=''; placeholder.textContent='Todos'; } }
    else {
      if (placeholder) placeholder.style.display = 'none';
      const dropdown = el.querySelector('.multiselect-dropdown');
      const chips = [...selected].map(v => {
        const opt = (FILTER_OPTIONS[key]||[]).find(o => o.value === v);
        return `<span class="multiselect-chip">${escapeHtml(opt?.label||v)}<span class="x" data-ms-remove="${escapeHtml(v)}">×</span></span>`;
      }).join('');
      dropdown.insertAdjacentHTML('beforebegin', chips);
    }
    const badge = document.getElementById('badge' + key.charAt(0).toUpperCase() + key.slice(1));
    if (badge) badge.innerHTML = selected.size > 0 ? `<span class="filter-label-badge">${selected.size}</span>` : '';
    el.querySelectorAll('[data-ms-remove]').forEach(x => {
      x.addEventListener('click', e => {
        e.stopPropagation(); s.FILTERS[key].delete(x.dataset.msRemove);
        updateMultiselectUI(key); UI.render();
      });
    });
  }

  // ── Versiones ──
  function renderVersionsList() {
    const s = AppState.getState();
    const el = document.getElementById('versionsList');
    if (!el) return;
    if (!s.PF_VERSIONS.length) { el.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:8px 0">Sin versiones guardadas.</div>'; return; }
    el.innerHTML = s.PF_VERSIONS.map(v => `
      <div class="version-item">
        <div>
          <div style="font-size:12px;font-weight:600">${escapeHtml(v.label)}</div>
          <div class="version-meta">${v.pfName} · ${Object.keys(v.holdings).length} bonos</div>
        </div>
        <div class="version-actions">
          <button class="btn small" onclick="restoreVersionGlobal(${v.id})">Restaurar</button>
        </div>
      </div>`).join('');
  }

  // Exponer para uso inline en HTML
  window.restoreVersionGlobal = id => {
    if (!confirm('¿Restaurar esta versión? La cartera actual se reemplazará.')) return;
    if (Storage.restoreVersion(id)) { UI.renderPortfolioInputs(); UI.render(); renderVersionsList(); }
  };

  // ── Custom instruments ──
  function actualizarCamposInst() {
    const tipo = document.getElementById('instTipo')?.value;
    const esBulletTem   = tipo === 'LECAP' || tipo === 'BONCAP';
    const esCupon       = tipo === 'BONCER' || tipo === 'Bonar' || tipo === 'ON';
    const esTamar       = tipo === 'TAMAR' || tipo === 'DUAL';
    const esDL          = tipo === 'Dólar Linked';
    const esCheque      = tipo === 'Cheque';
    const tieneFreq     = esCupon || esTamar || esDL;
    const tieneMoneda   = tipo === 'ON' || tipo === 'Bonar';

    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };

    show('instTemRow',      esBulletTem);
    show('instCuponRow',    esCupon);
    show('instSpreadRow',   esTamar);
    show('instTasaBaseRow', esTamar);
    show('instAmortRow',    esCupon || esTamar);
    show('instFreqRow',     tieneFreq);
    show('instMonedaRow',   tieneMoneda);
    show('instChequeRow',   esCheque);

    // Cheque: no necesita TEM ni cupón ni fechas de emisión obligatorias
    // Los campos de precio general se ocultan porque usa el propio precio del cheque
    const precioGenRow = document.querySelector('#instPrecio')?.closest('div[style*="border"]');
    if (precioGenRow) precioGenRow.style.display = esCheque ? 'none' : '';

    actualizarPreviewInst();
  }

  function actualizarPreviewInst() {
    const preview = document.getElementById('instPreview');
    if (!preview) return;
    const chequePrec = parseFloat(document.getElementById('instChequePrec')?.value) || 0;
    const chequeMon  = document.getElementById('instChequeMon')?.value || 'ARS';
    const emisor     = document.getElementById('instEmisor')?.value.trim() || '';

    // Preview especial para cheque: mostrar TIR implícita
    if (tipo === 'Cheque' && venc && chequePrec > 0) {
      const vtoD = new Date(venc + 'T00:00:00');
      const hoyD = new Date(); hoyD.setHours(0,0,0,0);
      const dias = Math.max(1, (vtoD - hoyD) / 86400000);
      const tirDiaria = (100 / chequePrec) ** (1/dias) - 1;
      const tirMensual = ((1 + tirDiaria) ** 30 - 1) * 100;
      const tirAnual = ((1 + tirDiaria) ** 365 - 1) * 100;
      const descuento = 100 - chequePrec;
      const sym = chequeMon === 'USD' ? 'U$' : '$';
      preview.style.color = 'var(--green)';
      preview.textContent = [
        `✓ Cheque${emisor ? ` — ${emisor}` : ''} · ${chequeMon} · ${Math.round(dias)} días`,
        `  Precio compra: ${sym}${chequePrec.toFixed(2)} → cobras ${sym}100.00`,
        `  Descuento: ${sym}${descuento.toFixed(2)} (${(descuento/chequePrec*100).toFixed(2)}% sobre inversión)`,
        `  TIR: ${tirMensual.toFixed(2)}% TEM · ${tirAnual.toFixed(2)}% TEA`,
      ].join('\n');
      const tirEl = document.getElementById('instChequeTirPreview');
      if (tirEl) tirEl.textContent = `TIR: ${tirMensual.toFixed(2)}% TEM · ${tirAnual.toFixed(2)}% TEA · ${Math.round(dias)} días`;
      return;
    }
    const tipo   = document.getElementById('instTipo')?.value;
    const emision= document.getElementById('instEmision')?.value;
    const venc   = document.getElementById('instVencimiento')?.value;
    const tem    = parseFloat(document.getElementById('instTem')?.value);
    const cupon  = parseFloat(document.getElementById('instCupon')?.value);
    const spread = parseFloat(document.getElementById('instSpread')?.value);
    const tasaBase = parseFloat(document.getElementById('instTasaBase')?.value) || 33.61;
    const nCuotas= parseInt(document.getElementById('instAmortCuotas')?.value) || 1;
    const freq   = parseInt(document.getElementById('instFreq')?.value) || 6;
    const moneda = document.getElementById('instMoneda')?.value || 'USD';
    const flujosManual = document.getElementById('instFlujosManual')?.value || '';

    if (!ticker || !venc) {
      preview.style.color = 'var(--text-faint)';
      preview.textContent = 'Completá ticker y vencimiento para ver el preview.';
      return;
    }
    try {
      const cfg = { ticker, tipo, emision: emision||venc, vencimiento: venc,
                    tem, cupon, spread, tasaBase, amortCuotas: nCuotas, freq, moneda, flujosManual };
      const flujos = generarFlujosCustom(cfg).filter(f => f.Estado === 'Pendiente');
      if (!flujos.length) {
        preview.style.color = 'var(--red)';
        preview.textContent = '⚠ Sin flujos futuros (vencimiento pasado o datos insuficientes).';
        return;
      }
      const tInt  = flujos.reduce((a,f) => a + f.Interes_USD, 0);
      const tAmort= flujos.reduce((a,f) => a + f.Amortizacion_USD, 0);
      const mn = flujos[0].Moneda_Nativa; const sym = mn==='ARS'?'$':'U$';
      const freqLabel = {6:'Semestral',3:'Trimestral',1:'Mensual',12:'Anual'}[freq]||'';
      preview.style.color = 'var(--green)';
      preview.textContent = [
        `✓ ${ticker} (${tipo}) · ${flujos.length} pago(s) · ${mn} · ${freqLabel}`,
        `  Interés total: ${sym}${tInt.toFixed(2)} · Amort total: ${sym}${tAmort.toFixed(2)} (por c/100 VN)`,
        `  Fechas: ${flujos[0].Fecha_Pago} → ${flujos[flujos.length-1].Fecha_Pago}`,
        flujosManual ? '  ★ Usando flujos cargados manualmente.' : '',
      ].filter(Boolean).join('\n');
    } catch(e) {
      preview.style.color = 'var(--red)';
      preview.textContent = '⚠ Error: ' + e.message;
    }
  }

  function generarFlujosCustom(cfg) {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const flujos = [];
    const vto = new Date(cfg.vencimiento + 'T00:00:00');
    const emi = new Date((cfg.emision||cfg.vencimiento) + 'T00:00:00');
    const est = d => d < hoy ? 'Pagado' : 'Pendiente';

    // ── Flujos manuales CSV ──
    if (cfg.flujosManual && cfg.flujosManual.trim()) {
      const mn = cfg.moneda || 'ARS';
      cfg.flujosManual.trim().split('\n').forEach(line => {
        const parts = line.trim().split(',');
        if (parts.length < 3) return;
        const [fechaStr, intStr, amortStr] = parts;
        const fecha = new Date(fechaStr.trim() + 'T00:00:00');
        if (isNaN(fecha)) return;
        const int = parseFloat(intStr) || 0;
        const amort = parseFloat(amortStr) || 0;
        flujos.push({
          Fecha_Pago: fechaStr.trim(), Anio: fecha.getFullYear(), Mes: fecha.getMonth()+1,
          Bono: cfg.ticker, Tipo_Instrumento: cfg.tipo, Ley: 'Local',
          Moneda: mn, Moneda_Nativa: mn,
          Estado: est(fecha), Residual_Inicio_Pct: 1, Tasa_Anual_Pct: 0,
          Interes_USD: int, Amortizacion_USD: amort, Flujo_Total_USD: int + amort,
        });
      });
      return flujos.sort((a,b) => a.Fecha_Pago.localeCompare(b.Fecha_Pago));
    }

    // ── Generar fechas periódicas ──
    function genFechas(freqMeses) {
      const res = [];
      let cur = new Date(vto);
      while (cur > emi) {
        res.unshift(new Date(cur));
        const m = cur.getMonth() - freqMeses;
        const y = cur.getFullYear() + Math.floor(m / 12);
        const mo = ((m % 12) + 12) % 12;
        try { cur = new Date(y, mo, cur.getDate()); }
        catch { cur = new Date(y, mo, 28); }
      }
      if (!res.length) res.push(vto);
      return res;
    }

    function buildCouponRows(tipo_inst, moneda, cuponAnual, freqMeses, nCuotas) {
      const fechas = genFechas(freqMeses);
      const amortFechas = new Set(fechas.slice(-Math.max(1, nCuotas)).map(f => f.toISOString().slice(0,10)));
      const amortPct = 100 / Math.max(1, nCuotas);
      let residual = 100;
      fechas.forEach(fecha => {
        const iso = fecha.toISOString().slice(0,10);
        const int = residual * (cuponAnual/100) / (12/freqMeses);
        const amort = amortFechas.has(iso) ? amortPct : 0;
        flujos.push({
          Fecha_Pago: iso, Anio: fecha.getFullYear(), Mes: fecha.getMonth()+1,
          Bono: cfg.ticker, Tipo_Instrumento: tipo_inst, Ley: 'Local',
          Moneda: moneda, Moneda_Nativa: moneda,
          Estado: est(fecha), Residual_Inicio_Pct: residual/100, Tasa_Anual_Pct: cuponAnual/100,
          Interes_USD: round(int), Amortizacion_USD: round(amort), Flujo_Total_USD: round(int+amort),
        });
        residual -= amort;
      });
    }

    const round = v => Math.round(v * 1e6) / 1e6;
    const freq = parseInt(cfg.freq) || 6;
    const nCuotas = Math.max(1, parseInt(cfg.amortCuotas) || 1);

    if (cfg.tipo === 'LECAP' || cfg.tipo === 'BONCAP') {
      const meses = Math.max(1, (vto.getFullYear()-emi.getFullYear())*12 + (vto.getMonth()-emi.getMonth()));
      const tem = (cfg.tem||0)/100;
      const vf = 100 * (1+tem)**meses;
      flujos.push({
        Fecha_Pago: cfg.vencimiento, Anio: vto.getFullYear(), Mes: vto.getMonth()+1,
        Bono: cfg.ticker, Tipo_Instrumento: cfg.tipo, Ley: 'Local',
        Moneda: 'ARS', Moneda_Nativa: 'ARS', Estado: est(vto),
        Residual_Inicio_Pct: 1, Tasa_Anual_Pct: round((1+tem)**12-1),
        Interes_USD: round(vf-100), Amortizacion_USD: 100, Flujo_Total_USD: round(vf),
      });

    } else if (cfg.tipo === 'BONCER cero') {
      flujos.push({
        Fecha_Pago: cfg.vencimiento, Anio: vto.getFullYear(), Mes: vto.getMonth()+1,
        Bono: cfg.ticker, Tipo_Instrumento: 'BONCER cero', Ley: 'Local',
        Moneda: 'ARS', Moneda_Nativa: 'ARS', Estado: est(vto),
        Residual_Inicio_Pct: 1, Tasa_Anual_Pct: 0,
        Interes_USD: 0, Amortizacion_USD: 100, Flujo_Total_USD: 100,
      });

    } else if (cfg.tipo === 'BONCER') {
      buildCouponRows('BONCER', 'ARS', cfg.cupon||0, freq, nCuotas);

    } else if (cfg.tipo === 'TAMAR') {
      const tasaTotal = (parseFloat(cfg.tasaBase)||33.61) + (parseFloat(cfg.spread)||0);
      buildCouponRows('TAMAR', 'ARS', tasaTotal, freq, nCuotas);

    } else if (cfg.tipo === 'DUAL') {
      // Piso = tasa fija del cupón; techo variable (no modelamos techo)
      buildCouponRows('DUAL', 'ARS', cfg.cupon||0, freq, nCuotas);

    } else if (cfg.tipo === 'Dólar Linked') {
      buildCouponRows('Dólar Linked', 'ARS', cfg.cupon||0, freq, nCuotas);

    } else if (cfg.tipo === 'Bonar' || cfg.tipo === 'ON') {
      const mn = cfg.moneda || 'USD';
      buildCouponRows(cfg.tipo, mn, cfg.cupon||0, freq, nCuotas);

    } else if (cfg.tipo === 'Cheque') {
      // Bullet único. Interés = descuento implícito (VN - precio_compra).
      const mn = cfg.moneda || 'ARS';
      const descuento = cfg.chequePrec > 0 ? round(100 - cfg.chequePrec) : 0;
      flujos.push({
        Fecha_Pago: cfg.vencimiento, Anio: vto.getFullYear(), Mes: vto.getMonth()+1,
        Bono: cfg.ticker, Tipo_Instrumento: 'Cheque', Ley: 'Privado',
        Moneda: mn, Moneda_Nativa: mn,
        Estado: est(vto), Residual_Inicio_Pct: 1, Tasa_Anual_Pct: 0,
        Interes_USD: descuento,
        Amortizacion_USD: 100,
        Flujo_Total_USD: round(100 + descuento),
        _emisor: cfg.emisor || '',
      });
    }

    return flujos.sort((a,b) => a.Fecha_Pago.localeCompare(b.Fecha_Pago));
  }

  function addCustomInstrumentGlobal() {
    const s = AppState.getState();
    const ticker  = document.getElementById('instTicker')?.value.trim().toUpperCase();
    const tipo    = document.getElementById('instTipo')?.value;
    const emision = document.getElementById('instEmision')?.value;
    const venc    = document.getElementById('instVencimiento')?.value;
    const tem     = parseFloat(document.getElementById('instTem')?.value) || 0;
    const cupon   = parseFloat(document.getElementById('instCupon')?.value) || 0;
    const spread  = parseFloat(document.getElementById('instSpread')?.value) || 0;
    const tasaBase= parseFloat(document.getElementById('instTasaBase')?.value) || 33.61;
    const nCuotas = parseInt(document.getElementById('instAmortCuotas')?.value) || 1;
    const freq    = parseInt(document.getElementById('instFreq')?.value) || 6;
    const moneda  = tipo === 'Cheque'
      ? (document.getElementById('instChequeMon')?.value || 'ARS')
      : (document.getElementById('instMoneda')?.value || 'USD');
    const precio  = parseFloat(document.getElementById('instPrecio')?.value);
    const precioMoneda = document.getElementById('instPrecioMoneda')?.value || 'ARS';
    const flujosManual = document.getElementById('instFlujosManual')?.value || '';
    // Campos específicos de cheque
    const emisor      = document.getElementById('instEmisor')?.value.trim() || '';
    const chequePrec  = parseFloat(document.getElementById('instChequePrec')?.value) || 0;

    if (!ticker) { alert('Ingresá el ticker.'); return false; }
    if (!venc)   { alert('Ingresá la fecha de vencimiento.'); return false; }
    if (s.BOND_META[ticker]) { alert(`"${ticker}" ya existe.`); return false; }

    const cfg = { ticker, tipo, emision: emision||venc, vencimiento: venc,
                  tem, cupon, spread, tasaBase, amortCuotas: nCuotas, freq, moneda,
                  flujosManual, emisor, chequePrec };
    const flujos = generarFlujosCustom(cfg);
    if (!flujos.length) { alert('Sin flujos generados. Revisá los datos.'); return false; }

    flujos.forEach(f => s.DATA.push(f));

    // Determinar moneda nativa
    const arsTypes = ['LECAP','BONCAP','BONCER cero','BONCER','TAMAR','DUAL','Dólar Linked','Cheque'];
    const mn = arsTypes.includes(tipo) ? (tipo === 'Cheque' ? moneda : 'ARS') : (tipo === 'ON' ? moneda : 'USD');

    const [dy, dm, dd] = [venc.slice(8,10), venc.slice(5,7), venc.slice(0,4)];
    s.BOND_META[ticker] = {
      venc: `${dy}/${dm}/${dd}`, emisor: emisor || 'Custom',
      moneda_nativa: mn, tipo,
      tickers_usd: mn === 'USD' ? [ticker+'D', ticker] : [],
      tickers_ars: [ticker], es_custom: true,
    };

    // Precio: cheque usa chequePrec, otros usan instPrecio
    const precioFinal = tipo === 'Cheque' ? chequePrec : precio;
    const monedaPrecio = tipo === 'Cheque' ? moneda : precioMoneda;
    if (Number.isFinite(precioFinal) && precioFinal > 0) {
      s.PRICES[ticker] = { price: precioFinal, source: 'manual', ts: Date.now(), market: monedaPrecio };
    }

    Storage.save();
    const customs = JSON.parse(localStorage.getItem('bonos_custom') || '[]');
    customs.push({ cfg, flujos, meta: s.BOND_META[ticker] });
    localStorage.setItem('bonos_custom', JSON.stringify(customs));

    if (FILTER_OPTIONS.bono && !FILTER_OPTIONS.bono.find(o => o.value === ticker)) {
      FILTER_OPTIONS.bono.push({ value: ticker, label: ticker + ' ★' });
      buildMultiselectDropdown('bono');
    }
    UI.renderPortfolioInputs(); UI.render();
    return true;
  }

  function loadCustomInstruments() {
    const s = AppState.getState();
    try {
      const customs = JSON.parse(localStorage.getItem('bonos_custom')||'[]');
      customs.forEach(({ cfg, flujos, meta }) => {
        if (s.BOND_META[cfg.ticker]) return;
        s.BOND_META[cfg.ticker] = meta;
        flujos.forEach(f => s.DATA.push(f));
      });
    } catch(e) { console.warn('loadCustomInstruments', e); }
  }

  // Exponer openBondModal al HTML (el modal completo vive en index.html por ahora)
  window._openBondModal = function(bono) {
    // El modal usa datos de AppState
    const s = AppState.getState();
    const meta = s.BOND_META[bono] || {};
    const mn = meta.moneda_nativa || 'USD';
    const esCER   = meta.tipo === 'BONCER' || meta.tipo === 'BONCER cero';
    const esLecap = meta.tipo === 'LECAP' || meta.tipo === 'BONCAP';
    const esDual  = meta.tipo === 'DUAL';
    const esTamar = meta.tipo === 'TAMAR';
    const h = normalizeHolding(currentPF()?.holdings[bono]);
    const currency = mn === 'ARS' ? 'ARS' : (h.currency || 'USD');
    const vn = h.vn || 0;
    const precio = Finance.effectivePrice(bono, currency, h, meta, s.PRICES);
    let priceAdj = precio;
    if (precio && s.SCENARIO.active) priceAdj = Scenarios.adjustedPrice(precio);
    const precioValue = priceAdj ? priceAdj.price : 0;
    const today = new Date(); today.setHours(0,0,0,0);
    const flujosBono = s.DATA.filter(r => r.Bono === bono && r.Estado === 'Pendiente');
    const factor = vn > 0 ? vn / 100 : 0;
    const flujosEscalados = flujosBono.map(r => {
      const fInfla = esCER ? factorInflacion(r.Fecha_Pago) : 1;
      return { ...r, f_inflacion: fInfla, interes_esc: r.Interes_USD * factor * fInfla, amort_esc: r.Amortizacion_USD * factor * fInfla, flujo_esc: r.Flujo_Total_USD * factor * fInfla };
    });
    const totalInt = flujosEscalados.reduce((a,r) => a+r.interes_esc, 0);
    const totalAmort = flujosEscalados.reduce((a,r) => a+r.amort_esc, 0);
    const totalCobrar = totalInt + totalAmort;
    const montoCompraBruto = vn * precioValue / 100;
    const costos = calcCosts(montoCompraBruto);
    const montoTotalPagado = montoCompraBruto + costos.total;
    const precioUsd = mn === 'USD' ? Finance.effectivePrice(bono,'USD',h,meta,s.PRICES) : null;
    const precioArs = mn === 'USD' ? Finance.effectivePrice(bono,'ARS',h,meta,s.PRICES) : null;
    const implicitFX = precioUsd && precioArs ? precioArs.price / precioUsd.price : null;
    let montoPagadoEn = null;
    if (mn === 'USD') montoPagadoEn = currency === 'USD' ? montoTotalPagado : (implicitFX ? montoTotalPagado/implicitFX : null);
    else montoPagadoEn = montoTotalPagado;
    const gananciaBruta = montoPagadoEn != null ? totalCobrar - montoPagadoEn : null;
    const gananciaPct = gananciaBruta != null && montoPagadoEn > 0 ? gananciaBruta / montoPagadoEn : null;
    let tirAnual = null;
    if (montoPagadoEn != null && montoPagadoEn > 0 && flujosEscalados.length) {
      tirAnual = Finance.calcIRR(-montoPagadoEn, flujosEscalados.map(r => ({Fecha_Pago: r.Fecha_Pago, flujo_esc: r.flujo_esc})), today);
    }
    const sym = currency === 'ARS' ? '$' : 'U$';
    const flujoSym = mn === 'ARS' ? '$' : 'U$';
    const scenNote = s.SCENARIO.active ? `<span style="color:var(--red);font-size:10px;margin-left:8px">⚠ ESCENARIO ACTIVO${s.SCENARIO.precioDelta!==0?` precio ${s.SCENARIO.precioDelta>0?'+':''}${s.SCENARIO.precioDelta}%`:''}</span>` : '';

    const html = `
      <div class="bond-modal-header">
        <div>
          <div class="bond-modal-title">${escapeHtml(bono)}</div>
          <div class="bond-modal-subtitle">
            ${meta.tipo||''} · Vto ${meta.venc||'—'} <span class="badge ${currency==='ARS'?'ars':'usd'}" style="margin-left:8px">${currency}</span>
            ${priceAdj ? `<span style="color:var(--text-dim);margin-left:8px">${sym}${priceAdj.price.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})} (${priceAdj.source})</span>` : ''}
            ${esCER && s.COSTS.inflacion > 0 ? `<span style="color:var(--purple);margin-left:8px">Inflación proy.: ${s.COSTS.inflacion + (s.SCENARIO.active?s.SCENARIO.inflacionDelta:0)}%/año</span>` : ''}
            ${scenNote}
          </div>
        </div>
        <button class="bond-modal-close" id="closeBondModal">×</button>
      </div>
      ${vn === 0 ? '<div class="empty-state" style="padding:30px"><h3>Cargá un VN o monto para ver la calculadora</h3></div>' : !priceAdj ? '<div class="empty-state" style="padding:30px"><h3>Sin precio cargado</h3><div>Ingresá un precio manual o actualizá los precios de mercado.</div></div>' : `
        <div class="bond-modal-kpis">
          <div class="bond-modal-kpi"><div class="bond-modal-kpi-label">Invertido (${currency})</div><div class="bond-modal-kpi-value">${sym} ${fmt(montoTotalPagado,2)}</div><div class="bond-modal-kpi-sub">VN ${vn.toLocaleString('es-AR')} × ${precioValue.toFixed(2)}/100 + costos</div></div>
          <div class="bond-modal-kpi accent"><div class="bond-modal-kpi-label">Total a Cobrar</div><div class="bond-modal-kpi-value">${flujoSym} ${fmt(totalCobrar,2)}</div><div class="bond-modal-kpi-sub">${flujosEscalados.length} pagos${esCER?' (proyectados)':''}</div></div>
          <div class="bond-modal-kpi ${gananciaBruta!=null&&gananciaBruta>=0?'positive':'negative'}"><div class="bond-modal-kpi-label">Ganancia Bruta</div><div class="bond-modal-kpi-value">${montoPagadoEn!=null?flujoSym+' '+fmt(gananciaBruta,2):'—'}</div><div class="bond-modal-kpi-sub">${gananciaPct!=null?(gananciaPct>=0?'+':''+(gananciaPct*100).toFixed(1)+'% sobre inversión'):'—'}</div></div>
          <div class="bond-modal-kpi ${tirAnual!=null&&tirAnual>=0?'positive':tirAnual!=null?'negative':''}"><div class="bond-modal-kpi-label">TIR Neta ${mn}</div><div class="bond-modal-kpi-value">${tirAnual!=null?(tirAnual*100).toFixed(2)+'%':'—'}</div><div class="bond-modal-kpi-sub">${tirAnual!=null?(esLecap?'según precio actual':'después de costos'):'No calculable'}</div></div>
        </div>
        <div class="breakdown-section">
          <h4>Desglose de compra <span class="sub">VN ${vn.toLocaleString('es-AR')} @ ${precioValue.toFixed(2)}/100</span></h4>
          <div class="breakdown-row"><span class="label-dim">Monto bruto</span><span class="val">${sym} ${fmt(montoCompraBruto,2)}</span></div>
          <div class="breakdown-row"><span class="label-dim">Comisión (${s.COSTS.comision}%)</span><span class="val">${sym} ${fmt(costos.comision,2)}</span></div>
          <div class="breakdown-row"><span class="label-dim">Derechos (${s.COSTS.derechos}%)</span><span class="val">${sym} ${fmt(costos.derechos,2)}</span></div>
          <div class="breakdown-row"><span class="label-dim">IVA (${s.COSTS.iva}%)</span><span class="val">${sym} ${fmt(costos.iva,2)}</span></div>
          <div class="breakdown-row total"><span>TOTAL A PAGAR</span><span class="val">${sym} ${fmt(montoTotalPagado,2)}</span></div>
        </div>
        ${mn==='USD'&&currency==='ARS'&&implicitFX?`<div class="breakdown-section" style="border-color:rgba(184,142,232,0.3)"><h4 style="color:var(--purple)">Conversión a USD</h4><div class="breakdown-row"><span class="label-dim">FX implícito</span><span class="val">$ ${implicitFX.toFixed(2)}</span></div><div class="breakdown-row"><span class="label-dim">Invertido en USD</span><span class="val">U$ ${fmt(montoPagadoEn,2)}</span></div></div>`:''}
        <div class="breakdown-section">
          <h4>Calendario de pagos <span class="sub">VN ${vn.toLocaleString('es-AR')}${esCER?' · con inflación':''}</span></h4>
          <div class="modal-table-wrap"><table>
            <thead><tr><th>Fecha</th><th style="text-align:right">Interés ${mn}</th><th style="text-align:right">Amort ${mn}</th><th style="text-align:right">Flujo ${mn}</th><th style="text-align:right">Acumulado</th></tr></thead>
            <tbody>${(() => { let ac=0; return flujosEscalados.sort((a,b)=>a.Fecha_Pago.localeCompare(b.Fecha_Pago)).map(r=>{ ac+=r.flujo_esc; return `<tr><td class="mono">${fmtFecha(r.Fecha_Pago)}</td><td class="num">${fmtMoney(r.interes_esc,mn,2)}</td><td class="num">${fmtMoney(r.amort_esc,mn,2)}</td><td class="num highlight">${fmtMoney(r.flujo_esc,mn,2)}</td><td class="num" style="color:var(--green)">${fmtMoney(ac,mn,2)}</td></tr>`; }).join(''); })()}</tbody>
          </table><div class="note">Flujos en <strong>${mn}</strong>.${esCER?` Proyectados con inflación ${s.COSTS.inflacion+(s.SCENARIO.active?s.SCENARIO.inflacionDelta:0)}%/año. Los pagos reales dependen del CER publicado por el BCRA.`:''}${tirAnual!=null?` TIR: ${(tirAnual*100).toFixed(2)}%.`:''}</div></div>
        </div>

        ${(esDual || esTamar) ? `
        <details style="border:1px dashed var(--border);border-radius:8px;margin-top:16px;overflow:hidden">
          <summary style="padding:12px 16px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-dim);user-select:none;list-style:none;display:flex;justify-content:space-between">
            <span>📋 Nota del analista — modelo ${esDual?'DUAL':'TAMAR'}</span><span>▾</span>
          </summary>
          <div style="padding:16px;border-top:1px solid var(--border)">
            <div style="background:rgba(232,112,102,0.08);border:1px solid rgba(232,112,102,0.25);border-radius:6px;padding:12px;margin-bottom:14px;font-size:12px;line-height:1.7;color:var(--text-dim)">
              <strong style="color:var(--red)">⚠ Limitación del modelo</strong><br>
              ${esDual
                ? 'El DUAL paga el <strong>mayor</strong> entre la tasa fija y la TAMAR vigente en cada cupón. El modelo usa <strong>solo la tasa fija como piso</strong> — la componente TAMAR no está proyectada. Si TAMAR sube → cobrás más. Si baja → cobrás exactamente lo proyectado. La TIR mostrada es el piso real.'
                : 'El TAMAR paga tasa variable = TAMAR + spread fijo. El modelo usa la tasa actual como proxy constante. Si la TAMAR cambia significativamente, los flujos reales diferirán.'}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
              <div>
                <label class="cost-item-label">TAMAR estimada al vto %</label>
                <input type="number" class="modal-input" id="dualNota_tamarEst" step="0.1" placeholder="ej: 28.00" style="margin-top:4px">
              </div>
              <div>
                <label class="cost-item-label">Prob. TAMAR > tasa fija %</label>
                <input type="number" class="modal-input" id="dualNota_prob" min="0" max="100" step="1" placeholder="ej: 60" style="margin-top:4px">
              </div>
              <div>
                <label class="cost-item-label">TIR ajustada estimada %</label>
                <input type="number" class="modal-input" id="dualNota_tirAdj" step="0.01" placeholder="ej: 35.00" style="margin-top:4px">
              </div>
              <div>
                <label class="cost-item-label">Horizonte de análisis</label>
                <select class="modal-input" id="dualNota_horizonte" style="margin-top:4px">
                  <option value="">— Seleccionar —</option>
                  <option value="1">1 mes</option><option value="3">3 meses</option>
                  <option value="6">6 meses</option><option value="12">12 meses</option>
                  <option value="vto">Hasta vencimiento</option>
                </select>
              </div>
            </div>
            <div>
              <label class="cost-item-label">Notas libres del analista</label>
              <textarea class="modal-input" id="dualNota_texto" rows="4" placeholder="Contexto macro, hipótesis de tasa, comparación con alternativas, riesgo de reinversión..." style="margin-top:4px;font-size:12px;resize:vertical"></textarea>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
              <button class="btn small" onclick="(function(){const bonoKey='${escapeHtml(bono).replace(/'/g,'\\x27')}';const d={tamarEst:document.getElementById('dualNota_tamarEst')?.value,prob:document.getElementById('dualNota_prob')?.value,tirAdj:document.getElementById('dualNota_tirAdj')?.value,horizonte:document.getElementById('dualNota_horizonte')?.value,texto:document.getElementById('dualNota_texto')?.value,ts:new Date().toISOString()};localStorage.setItem('analista_'+bonoKey,JSON.stringify(d));alert('Nota guardada.');})()">💾 Guardar</button>
              <button class="btn small" onclick="(function(){const bonoKey='${escapeHtml(bono).replace(/'/g,'\\x27')}';const raw=localStorage.getItem('analista_'+bonoKey);if(!raw){alert('Sin nota guardada.');return;}const d=JSON.parse(raw);['tamarEst','prob','tirAdj','horizonte','texto'].forEach(k=>{const el=document.getElementById('dualNota_'+k);if(el&&d[k]!=null)el.value=d[k];});})()">📂 Cargar</button>
            </div>
          </div>
        </details>
        ` : ''}
        `}`;  

    const content = document.getElementById('modalBondContent');
    if (content) content.innerHTML = html;
    document.getElementById('modalBond')?.classList.add('open');
    document.getElementById('closeBondModal')?.addEventListener('click', () => {
      document.getElementById('modalBond')?.classList.remove('open');
    });
  };

  // ── Countdown de precios ──
  setInterval(() => {
    const s = AppState.getState();
    if (!s.PRICES_FETCHED_AT) return;
    const minHace = Math.floor((Date.now() - s.PRICES_FETCHED_AT) / 60000);
    const info = document.getElementById('pricesInfo');
    if (info && Object.values(s.PRICES).some(p => p.source==='live')) {
      info.innerHTML = `<strong>Actualizado:</strong> hace ${minHace} min · Próx. actualización en ${5-minHace%5} min`;
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────────
  // MÓDULO: YIELD CURVES — curvas de rendimiento + historial diario
  // ─────────────────────────────────────────────────────────────────────────────
  const YieldCurves = (() => {
    const HIST_KEY = 'bonos_curvas_hist_v1';
    const MAX_SNAPSHOTS = 90;

    const CURVAS = {
      usd: {
        label: 'Soberanos USD', color: '#5aa4e8',
        bonos: ['AO27','AO28','AL29 / GD29','AN29','AL30 / GD30','BPD7 (BOPREAL S.1-D)','BOPREAL Serie 4','AL35 / GD35','AE38 / GD38','AL41 / GD41','GD46'],
        priceCurrency: 'USD',
        labelMap: { 'AO27':'AO27','AO28':'AO28','AL29 / GD29':'AL29','AN29':'AN29','AL30 / GD30':'AL30','BPD7 (BOPREAL S.1-D)':'BPD7','BOPREAL Serie 4':'BPS4','AL35 / GD35':'AL35','AE38 / GD38':'AE38','AL41 / GD41':'AL41','GD46':'GD46' },
      },
      fija: {
        label: 'Tasa fija ARS', color: '#f5b942',
        bonos: ['S12J6','S29Y6','T30J6','S31L6','S30S6','T15E7'],
        priceCurrency: 'ARS',
        labelMap: {},
      },
      cer: {
        label: 'CER', color: '#b88ee8',
        bonos: ['TX26','TZXM7','TZXD7','TZXS8','TX28','TZXM9','TX31'],
        priceCurrency: 'ARS',
        labelMap: {},
      },
    };

    // ── Regresión cuadrática OLS ──
    // Retorna [a, b, c] de y = ax² + bx + c
    function quadReg(points) {
      const n = points.length;
      if (n < 3) return null;
      let sx=0, sx2=0, sx3=0, sx4=0, sy=0, sxy=0, sx2y=0;
      points.forEach(({x, y}) => {
        sx  += x; sx2 += x*x; sx3 += x*x*x; sx4 += x*x*x*x;
        sy  += y; sxy += x*y; sx2y += x*x*y;
      });
      // Matriz 3×3 normal equations: [[n,sx,sx2],[sx,sx2,sx3],[sx2,sx3,sx4]] * [c,b,a] = [sy,sxy,sx2y]
      const M = [[n,sx,sx2],[sx,sx2,sx3],[sx2,sx3,sx4]];
      const V = [sy, sxy, sx2y];
      // Gauss elimination
      for (let i = 0; i < 3; i++) {
        let maxR = i;
        for (let r = i+1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[maxR][i])) maxR = r;
        [M[i], M[maxR]] = [M[maxR], M[i]]; [V[i], V[maxR]] = [V[maxR], V[i]];
        if (Math.abs(M[i][i]) < 1e-12) return null;
        for (let r = i+1; r < 3; r++) {
          const f = M[r][i] / M[i][i];
          for (let c = i; c < 3; c++) M[r][c] -= f * M[i][c];
          V[r] -= f * V[i];
        }
      }
      const coef = [0,0,0];
      for (let i = 2; i >= 0; i--) {
        coef[i] = V[i];
        for (let j = i+1; j < 3; j++) coef[i] -= M[i][j] * coef[j];
        coef[i] /= M[i][i];
      }
      return coef; // [c, b, a]
    }

    function calcPunto(bono, priceCurrency) {
      const s = AppState.getState();
      const meta = s.BOND_META[bono] || {};
      const h = { vn: 100, currency: priceCurrency };
      const precio = Finance.effectivePrice(bono, priceCurrency, h, meta, s.PRICES);
      if (!precio || precio.price <= 0) return null;
      const today = new Date(); today.setHours(0,0,0,0);
      const flujos = s.DATA.filter(r => r.Bono === bono && r.Estado === 'Pendiente');
      if (!flujos.length) return null;
      const vtoFecha = new Date(flujos.at(-1).Fecha_Pago + 'T00:00:00');
      const plazo = Math.max(0.01, (vtoFecha - today) / (365.25 * 86400000));
      const flujosBase = flujos.map(r => ({ Fecha_Pago: r.Fecha_Pago, flujo_esc: r.Flujo_Total_USD }));
      const tir = Finance.calcIRR(-precio.price, flujosBase, today);
      if (tir === null || !Number.isFinite(tir) || tir < -0.8 || tir > 15) return null;
      return { bono, plazo, tir, precio: precio.price, source: precio.source };
    }

    function calcAllCurvas() {
      const result = {};
      Object.entries(CURVAS).forEach(([key, cfg]) => {
        result[key] = cfg.bonos.map(b => calcPunto(b, cfg.priceCurrency)).filter(Boolean).sort((a,b) => a.plazo - b.plazo);
      });
      return result;
    }

    // ── Historial ──
    function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }

    function saveSnapshot() {
      const curvas = calcAllCurvas();
      const totalPts = Object.values(curvas).reduce((a, arr) => a + arr.length, 0);
      if (totalPts === 0) return null;
      const today = new Date().toISOString().slice(0,10);
      const hist = loadHist();
      const idx = hist.findIndex(s => s.date === today);
      const snap = { date: today, curvas };
      if (idx >= 0) hist[idx] = snap; else hist.push(snap);
      hist.sort((a,b) => a.date.localeCompare(b.date));
      if (hist.length > MAX_SNAPSHOTS) hist.splice(0, hist.length - MAX_SNAPSHOTS);
      try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); }
      catch { hist.splice(0, 10); try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch {} }
      return today;
    }

    // ── Chart.js plugin para labels de puntos ──
    const labelPlugin = {
      id: 'pointLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets.forEach((ds, di) => {
          if (!ds.showLabels) return;
          const meta = chart.getDatasetMeta(di);
          meta.data.forEach((pt, i) => {
            const raw = ds.data[i];
            if (!raw?.label) return;
            ctx.save();
            ctx.font = `500 10px 'JetBrains Mono', monospace`;
            ctx.fillStyle = ds.labelColor || '#e6e9ef';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            // Offset pequeño para que el texto no tape el punto
            ctx.fillText(raw.label, pt.x + 8, pt.y - 6);
            ctx.restore();
          });
        });
      }
    };

    let charts = {};

    function mkChart(id, color) {
      const ctx = document.getElementById(id)?.getContext('2d');
      if (!ctx) return null;
      return new Chart(ctx, {
        type: 'scatter',
        plugins: [labelPlugin],
        data: {
          datasets: [
            // 0: puntos hoy con labels
            {
              label: 'Hoy', data: [], showLabels: true,
              backgroundColor: color, borderColor: color, labelColor: '#e6e9ef',
              pointRadius: 5, pointHoverRadius: 8, pointStyle: 'circle',
              showLine: false,
            },
            // 1: regresión cuadrática hoy (línea punteada)
            {
              label: 'Regresión', data: [],
              backgroundColor: 'transparent', borderColor: color,
              borderWidth: 1.5, borderDash: [5, 4],
              pointRadius: 0, showLine: true, tension: 0.4, fill: false,
            },
            // 2: puntos comparativa
            {
              label: 'Hist', data: [], showLabels: false,
              backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.35)',
              pointRadius: 4, pointHoverRadius: 6,
              showLine: false,
            },
            // 3: regresión comparativa
            {
              label: 'Hist reg', data: [],
              backgroundColor: 'transparent', borderColor: 'rgba(255,255,255,0.3)',
              borderWidth: 1, borderDash: [3, 5],
              pointRadius: 0, showLine: true, tension: 0.4, fill: false,
            },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'nearest', intersect: false },
          layout: { padding: { top: 20, right: 60, bottom: 10, left: 10 } },
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: item => item.datasetIndex === 0 || item.datasetIndex === 2,
              backgroundColor: '#141821', borderColor: '#2f3747', borderWidth: 1, padding: 12,
              callbacks: {
                title: () => '',
                label: ctx => {
                  const d = ctx.raw;
                  if (!d?.bono) return '';
                  return [`${d.label || d.bono}`, `Plazo: ${d.x.toFixed(2)}a`, `TIR: ${(d.y*100).toFixed(2)}%`, `Precio: ${d.precio?.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}) ?? '—'}`];
                }
              }
            }
          },
          scales: {
            x: {
              type: 'linear', min: 0,
              title: { display: true, text: 'DUR', color: '#5a6478', font: { family: "'JetBrains Mono',monospace", size: 10 } },
              grid: { color: '#161b25' },
              ticks: { color: '#5a6478', font: { family: "'JetBrains Mono',monospace", size: 10 }, callback: v => v + 'y' }
            },
            y: {
              title: { display: true, text: 'YTM', color: '#5a6478', font: { family: "'JetBrains Mono',monospace", size: 10 } },
              grid: { color: '#161b25' },
              ticks: { color: '#5a6478', font: { family: "'JetBrains Mono',monospace", size: 10 }, callback: v => (v*100).toFixed(1)+'%' }
            }
          }
        }
      });
    }

    // Genera la curva de regresión como array de puntos {x,y}
    function buildRegCurve(pts) {
      if (!pts.length) return [];
      const coef = quadReg(pts.map(p => ({x: p.plazo, y: p.tir})));
      if (!coef) return pts.map(p => ({x: p.plazo, y: p.tir})); // fallback: conectar puntos
      const [c, b, a] = coef;
      const xMin = Math.max(0, Math.min(...pts.map(p=>p.plazo)) - 0.1);
      const xMax = Math.max(...pts.map(p=>p.plazo)) + 0.2;
      const steps = 60;
      return Array.from({length: steps+1}, (_, i) => {
        const x = xMin + (xMax - xMin) * i / steps;
        return { x, y: a*x*x + b*x + c };
      });
    }

    function updateCharts(curvasHoy, curvasComp) {
      Object.entries(CURVAS).forEach(([key, cfg]) => {
        const ch = charts[key];
        if (!ch) return;

        const ptHoy = (curvasHoy[key] || []).map(p => ({
          x: p.plazo, y: p.tir, bono: p.bono,
          label: cfg.labelMap?.[p.bono] || p.bono.split('/')[0].trim().replace(' ',''),
          precio: p.precio, source: p.source,
        }));
        const regHoy = buildRegCurve(curvasHoy[key] || []);

        const ptComp = (curvasComp?.[key] || []).map(p => ({
          x: p.plazo, y: p.tir, bono: p.bono,
          label: cfg.labelMap?.[p.bono] || p.bono.split('/')[0].trim().replace(' ',''),
          precio: p.precio,
        }));
        const regComp = buildRegCurve(curvasComp?.[key] || []);

        ch.data.datasets[0].data = ptHoy;
        ch.data.datasets[1].data = regHoy;
        ch.data.datasets[2].data = ptComp;
        ch.data.datasets[3].data = regComp;
        ch.update('none');

        // Actualizar el label de regresión
        const metaEl = document.getElementById('curvaReg' + key.charAt(0).toUpperCase() + key.slice(1));
        if (metaEl && ptHoy.length) {
          metaEl.textContent = `CURVA: REGRESIÓN CUADRÁTICA · ${ptHoy.length} PUNTOS`;
        }
      });
    }

    function renderHistList() {
      const hist = loadHist();
      const el = document.getElementById('curvaHistList');
      if (!el) return;
      el.innerHTML = '<option value="">— Elegir fecha comparativa —</option>' +
        [...hist].reverse().map(s => {
          const pts = Object.values(s.curvas).reduce((a, arr) => a + arr.length, 0);
          return `<option value="${s.date}">${s.date} · ${pts} pts</option>`;
        }).join('');
      const badge = document.getElementById('curvaHistBadge');
      if (badge) badge.textContent = hist.length > 0 ? `${hist.length} días guardados` : '';
    }

    function renderStats(curvasHoy) {
      const el = document.getElementById('curvaStats');
      if (!el) return;
      const parts = [];
      Object.entries(CURVAS).forEach(([key, cfg]) => {
        const pts = curvasHoy[key] || [];
        if (!pts.length) { parts.push(`<span style="color:${cfg.color}">${cfg.label}</span>: sin precio`); return; }
        const tirs = pts.map(p => p.tir * 100);
        parts.push(`<span style="color:${cfg.color};font-weight:600">${cfg.label}</span>: ${pts.length} pts · ${Math.min(...tirs).toFixed(2)}%–${Math.max(...tirs).toFixed(2)}% TIR`);
      });
      el.innerHTML = parts.join(' &nbsp;&nbsp;|&nbsp;&nbsp; ') || 'Sin precios de mercado. Actualizá precios para ver las curvas.';
    }

    function renderDiag() {
      const el = document.getElementById('curvaDiagContent');
      if (!el) return;
      const s = AppState.getState();
      const allPriceKeys = Object.keys(s.PRICES);
      if (!allPriceKeys.length) {
        el.innerHTML = '<span style="color:var(--red)">Sin precios cargados. Actualizá los precios primero.</span>';
        return;
      }

      let html = `<div style="margin-bottom:10px;color:var(--text)">Tickers en PRICES: <strong>${allPriceKeys.length}</strong> — muestra: ${allPriceKeys.slice(0,14).join(', ')}${allPriceKeys.length > 14 ? '…' : ''}</div>`;
      html += `<div style="margin-bottom:10px;font-size:10px;color:var(--text-faint)">✅ precio encontrado &nbsp;·&nbsp; ❌ ticker no coincide con lo que devuelve data912</div>`;

      Object.entries(CURVAS).forEach(([key, cfg]) => {
        html += `<div style="margin-top:14px;color:${cfg.color};font-weight:600;letter-spacing:0.08em;margin-bottom:4px">${cfg.label.toUpperCase()}</div>`;
        cfg.bonos.forEach(bono => {
          const meta = s.BOND_META[bono] || {};
          const tickers = cfg.priceCurrency === 'ARS' ? (meta.tickers_ars || []) : (meta.tickers_usd || []);
          const foundKey = tickers.find(t => s.PRICES[t]);
          const foundPrice = foundKey ? s.PRICES[foundKey] : null;
          const shortLabel = (cfg.labelMap?.[bono] || bono.split('/')[0].trim()).padEnd(8);
          html += `<div style="display:grid;grid-template-columns:20px 90px 160px 1fr;gap:4px;align-items:baseline">
            <span style="color:${foundKey?'var(--green)':'var(--red)'}">${foundKey ? '✅' : '❌'}</span>
            <span style="color:var(--text)">${shortLabel}</span>
            <span style="color:var(--text-faint)">busca: <em>${tickers.join(', ')}</em></span>
            <span style="color:${foundKey?'var(--green)':'var(--red)'}">${foundKey ? `→ ${foundKey} = ${foundPrice.price.toFixed(2)}` : '→ no encontrado'}</span>
          </div>`;
        });
      });

      html += `<div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--border);color:var(--text-faint);font-size:10px;line-height:1.8">
        <strong style="color:var(--text)">Si ves ❌:</strong> el ticker en data912 es distinto al de BOND_META.<br>
        Abrí F12 → Console y ejecutá:<br>
        <code style="background:var(--bg);padding:3px 8px;border-radius:3px;display:inline-block;margin-top:4px">console.table(Object.fromEntries(Object.entries(AppState.getState().PRICES).filter(([k])=>!k.endsWith('D')).slice(0,40)))</code><br>
        Eso muestra todos los tickers ARS con sus precios. Buscás TX26, TZXM7, S30A6, etc. y me avisás los nombres reales.
      </div>`;

      el.innerHTML = html;
    }

    function refresh(compDate) {
      const curvasHoy = calcAllCurvas();
      let curvasComp = null;
      if (compDate) {
        const snap = loadHist().find(s => s.date === compDate);
        if (snap) curvasComp = snap.curvas;
      }
      updateCharts(curvasHoy, curvasComp);
      renderStats(curvasHoy);
      renderHistList();
      renderDiag();
    }

    function init() {
      charts.usd  = mkChart('chartCurvaUSD',  '#5aa4e8');
      charts.fija = mkChart('chartCurvaFija', '#f5b942');
      charts.cer  = mkChart('chartCurvaCER',  '#b88ee8');

      // Nav tabs
      document.querySelectorAll('.app-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.app-nav-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById(btn.dataset.page)?.classList.add('active');
          // Al entrar a curvas: refresh + resize de charts
          if (btn.dataset.page === 'pageCurvas') {
            setTimeout(() => { Object.values(charts).forEach(c => c?.resize()); refresh(document.getElementById('curvaHistList')?.value || null); }, 50);
          }
        });
      });

      document.getElementById('curvaHistList')?.addEventListener('change', e => {
        const d = e.target.value || null;
        const lbl = document.getElementById('curvaCompLabel');
        if (lbl) lbl.textContent = d ? `vs ${d}` : '';
        refresh(d);
      });

      document.getElementById('btnCurvaSnapshot')?.addEventListener('click', () => {
        const d = saveSnapshot();
        if (d) { renderHistList(); alert(`Snapshot guardado: ${d}`); }
        else alert('Sin precios cargados. Actualizá los precios primero.');
      });

      document.getElementById('btnCurvaClearHist')?.addEventListener('click', () => {
        if (!confirm('¿Borrar todo el historial de curvas?')) return;
        localStorage.removeItem(HIST_KEY);
        refresh();
      });
    }

    function onPricesUpdated() {
      saveSnapshot();
      // Solo actualizar charts si la página de curvas está visible
      if (document.getElementById('pageCurvas')?.classList.contains('active')) {
        refresh(document.getElementById('curvaHistList')?.value || null);
      }
    }

    return { init, refresh, onPricesUpdated, saveSnapshot };
  })();

    // Grupos de bonos por curva
    const CURVAS = {
      usd: {
        label: 'Soberanos USD', color: '#5aa4e8',
        // BOPREAL Serie 1/3 sin precio en data912 → excluidos hasta confirmar ticker
        bonos: ['AO27','AO28','AL29 / GD29','AN29','AL30 / GD30','BPD7 (BOPREAL S.1-D)','BOPREAL Serie 4','AL35 / GD35','AE38 / GD38','AL41 / GD41','GD46'],
        priceCurrency: 'USD',
        labelMap: { 'AO27':'AO27','AO28':'AO28','AL29 / GD29':'AL29','AN29':'AN29','AL30 / GD30':'AL30','BPD7 (BOPREAL S.1-D)':'BPD7','BOPREAL Serie 4':'BPS4','AL35 / GD35':'AL35','AE38 / GD38':'AE38','AL41 / GD41':'AL41','GD46':'GD46' },
      },
      fija: {
        label: 'Tasa fija ARS', color: '#f5b942',
        // Confirmados con precio: S12J6, S29Y6, T30J6, S31L6, S30S6, T15E7
        // Sin precio en data912: S30A6 (vencida), S30J6, T30D6, T30E7, S29G6
        bonos: ['S12J6','S29Y6','T30J6','S31L6','S30S6','T15E7'],
        priceCurrency: 'ARS',
        labelMap: {},
      },
      cer: {
        label: 'CER', color: '#b88ee8',
        // Confirmados: TX26, TZXM7, TZXD7, TZXS8, TX28, TZXM9, TX31
        // Sin precio en data912: TZXJ7, TZXM8
        bonos: ['TX26','TZXM7','TZXD7','TZXS8','TX28','TZXM9','TX31'],
        priceCurrency: 'ARS',
        labelMap: {},
      },
    };

    // Calcular un punto de curva: { bono, plazo_anios, tir, precio }
    function calcPunto(bono, priceCurrency) {
      const s = AppState.getState();
      const meta = s.BOND_META[bono] || {};
      const h = { vn: 100, currency: priceCurrency }; // VN=100 como base
      const precio = Finance.effectivePrice(bono, priceCurrency, h, meta, s.PRICES);
      if (!precio || precio.price <= 0) return null;

      const today = new Date(); today.setHours(0,0,0,0);
      const flujos = s.DATA.filter(r => r.Bono === bono && r.Estado === 'Pendiente');
      if (!flujos.length) return null;

      // Plazo al vencimiento en años
      const vtoFecha = new Date(flujos.at(-1).Fecha_Pago + 'T00:00:00');
      const plazo = Math.max(0.01, (vtoFecha - today) / (365.25 * 86400000));

      // Flujos escalados a 100 VN
      const flujosBase = flujos.map(r => ({
        Fecha_Pago: r.Fecha_Pago,
        flujo_esc: r.Flujo_Total_USD * 1,  // ya está en base 100
      }));

      // TIR respecto al precio actual
      const tir = Finance.calcIRR(-precio.price, flujosBase, today);
      if (tir === null || !Number.isFinite(tir) || tir < -0.5 || tir > 10) return null;

      return { bono, plazo, tir, precio: precio.price, source: precio.source };
    }

    // Calcular todas las curvas actuales
    function calcAllCurvas() {
      const result = {};
      Object.entries(CURVAS).forEach(([key, cfg]) => {
        result[key] = cfg.bonos
          .map(b => calcPunto(b, cfg.priceCurrency))
          .filter(Boolean)
          .sort((a, b) => a.plazo - b.plazo);
      });
      return result;
    }

    // ── Historial ──
    function loadHist() {
      try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
      catch { return []; }
    }

    function saveSnapshot() {
      const curvas = calcAllCurvas();
      const totalPuntos = Object.values(curvas).reduce((a, arr) => a + arr.length, 0);
      if (totalPuntos === 0) return; // sin precios, no guardar

      const today = new Date().toISOString().slice(0, 10);
      const hist = loadHist();

      // Reemplazar si ya existe el día de hoy
      const idx = hist.findIndex(s => s.date === today);
      const snapshot = { date: today, curvas };
      if (idx >= 0) hist[idx] = snapshot;
      else hist.push(snapshot);

      // Mantener solo los últimos MAX_SNAPSHOTS días hábiles
      hist.sort((a, b) => a.date.localeCompare(b.date));
      if (hist.length > MAX_SNAPSHOTS) hist.splice(0, hist.length - MAX_SNAPSHOTS);

      try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); }
      catch (e) {
        // localStorage lleno: eliminar los más viejos
        hist.splice(0, 10);
        try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch {}
      }

      return today;
    }

    // ── Charts ──
    let charts = {};

    function createCharts() {
      const mkScatter = (id, label, color) => {
        const ctx = document.getElementById(id)?.getContext('2d');
        if (!ctx) return null;
        return new Chart(ctx, {
          type: 'scatter',
          data: {
            datasets: [
              {
                label: 'Hoy',
                data: [],
                backgroundColor: color,
                borderColor: color,
                pointRadius: 6,
                pointHoverRadius: 9,
                showLine: true,
                tension: 0.3,
                fill: false,
                borderWidth: 2,
              },
              {
                label: 'Comparativa',
                data: [],
                backgroundColor: 'rgba(255,255,255,0.15)',
                borderColor: 'rgba(255,255,255,0.3)',
                pointRadius: 4,
                showLine: true,
                tension: 0.3,
                fill: false,
                borderWidth: 1,
                borderDash: [4, 3],
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#141821',
                borderColor: '#2f3747',
                borderWidth: 1,
                padding: 12,
                callbacks: {
                  title: () => '',
                  label: ctx => {
                    const d = ctx.raw;
                    return [
                      `${d.bono}`,
                      `Plazo: ${d.x.toFixed(2)} años`,
                      `TIR: ${(d.y * 100).toFixed(2)}%`,
                      `Precio: ${d.precio?.toFixed(2) ?? '—'}`,
                      d.source === 'manual' ? '(precio manual)' : '(mercado)',
                    ];
                  }
                }
              }
            },
            scales: {
              x: {
                type: 'linear',
                title: { display: true, text: 'Plazo al vencimiento (años)', color: '#8a93a6', font: { size: 11 } },
                grid: { color: '#1a1f2b' },
                ticks: { callback: v => v + 'a' }
              },
              y: {
                title: { display: true, text: 'TIR anual (%)', color: '#8a93a6', font: { size: 11 } },
                grid: { color: '#1a1f2b' },
                ticks: { callback: v => (v * 100).toFixed(1) + '%' }
              }
            }
          }
        });
      };

      charts.usd  = mkScatter('chartCurvaUSD',  'Soberanos USD',  '#5aa4e8');
      charts.fija = mkScatter('chartCurvaFija', 'Tasa fija ARS',  '#f5b942');
      charts.cer  = mkScatter('chartCurvaCER',  'CER',            '#b88ee8');
    }

    function updateCharts(curvasHoy, curvasComp) {
      Object.entries(CURVAS).forEach(([key, cfg]) => {
        const ch = charts[key];
        if (!ch) return;
        const toPoint = p => ({ x: p.plazo, y: p.tir, bono: p.bono, precio: p.precio, source: p.source });
        ch.data.datasets[0].data = (curvasHoy[key] || []).map(toPoint);
        ch.data.datasets[1].data = (curvasComp?.[key] || []).map(toPoint);
        ch.data.datasets[0].label = 'Hoy';
        ch.data.datasets[1].label = curvasComp ? `Comparativa` : '';
        ch.update('none');
      });
    }

    function renderHistList() {
      const hist = loadHist();
      const el = document.getElementById('curvaHistList');
      if (!el) return;
      if (hist.length === 0) {
        el.innerHTML = '<option value="">Sin historial aún. Los precios se guardan automáticamente.</option>';
        return;
      }
      el.innerHTML = '<option value="">— Elegir fecha comparativa —</option>' +
        [...hist].reverse().map(s => {
          const pts = Object.values(s.curvas).reduce((a, arr) => a + arr.length, 0);
          return `<option value="${s.date}">${s.date} (${pts} puntos)</option>`;
        }).join('');
    }

    function renderStats(curvasHoy) {
      const el = document.getElementById('curvaStats');
      if (!el) return;
      const parts = [];
      Object.entries(CURVAS).forEach(([key, cfg]) => {
        const pts = curvasHoy[key] || [];
        if (!pts.length) return;
        const tirs = pts.map(p => p.tir * 100);
        const min = Math.min(...tirs).toFixed(2);
        const max = Math.max(...tirs).toFixed(2);
        const n = pts.length;
        parts.push(`<span style="color:${cfg.color};font-weight:600">${cfg.label}</span>: ${n} pts · TIR ${min}%–${max}%`);
      });
      el.innerHTML = parts.join(' &nbsp;·&nbsp; ') || 'Sin precios de mercado cargados.';
    }

    function refresh(compDate) {
      const curvasHoy = calcAllCurvas();
      let curvasComp = null;
      if (compDate) {
        const hist = loadHist();
        const snap = hist.find(s => s.date === compDate);
        if (snap) curvasComp = snap.curvas;
      }
      updateCharts(curvasHoy, curvasComp);
      renderStats(curvasHoy);
      renderHistList();

      // Mostrar conteo en el badge de historial
      const hist = loadHist();
      const badge = document.getElementById('curvaHistBadge');
      if (badge) badge.textContent = hist.length > 0 ? `${hist.length} días guardados` : '';
    }

  // ─────────────────────────────────────────────────────────────────────────────
  // EXTERNAL APIs — BCRA (CER diario) + argentinadatos (IPC mensual)
  // Ambas APIs tienen CORS habilitado para browsers. Fallan desde server-side.
  // ─────────────────────────────────────────────────────────────────────────────
  const ExternalAPIs = (() => {
    const BCRA_BASE = 'https://api.bcra.gob.ar/estadisticas/v2.0';
    const ADATA_BASE = 'https://argentinadatos.com/api/v1';

    async function safeFetch(url) {
      try {
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch { return null; }
    }

    // Trae el valor del CER del día (variable 4 en BCRA)
    async function fetchCER() {
      const today = new Date().toISOString().slice(0,10);
      const hace30 = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
      const data = await safeFetch(`${BCRA_BASE}/DatosVariable/4/${hace30}/${today}`);
      if (!data?.results?.length) return null;
      const ultimo = data.results.at(-1);
      return { fecha: ultimo.fecha, valor: ultimo.valor }; // ej: {fecha:'2026-04-30', valor: 1458.23}
    }

    // Trae inflación mensual IPC (últimos 12 meses)
    async function fetchIPC() {
      const data = await safeFetch(`${ADATA_BASE}/finanzas/indices/inflacion`);
      if (!Array.isArray(data) || !data.length) return null;
      // Retorna array de {fecha: "YYYY-MM-DD", valor: 3.7} — ya en %
      return data.slice(-12).map(d => ({ fecha: d.fecha, pct: d.valor }));
    }

    // Trae tipo de cambio oficial
    async function fetchTCO() {
      const data = await safeFetch(`${ADATA_BASE}/finanzas/tipo-cambio/oficial`);
      if (!Array.isArray(data) || !data.length) return null;
      const ultimo = data.at(-1);
      return { fecha: ultimo.fecha, valor: ultimo.venta || ultimo.valor };
    }

    // Actualizar todo y mostrar en UI
    async function refresh() {
      const [cer, ipc, tco] = await Promise.all([fetchCER(), fetchIPC(), fetchTCO()]);

      // CER → mostrar en el panel de costos y en la curva
      const cerEl = document.getElementById('bcracer_valor');
      if (cerEl && cer) {
        cerEl.textContent = `CER ${cer.fecha}: ${cer.valor.toFixed(2)}`;
        cerEl.style.display = '';
      }

      // IPC → auto-poblar la tabla de inflación mensual en escenarios
      if (ipc?.length) {
        const s = AppState.getState();
        // Solo poblar si el usuario no modificó los valores (todos siguen en 3.4 o en 0)
        const esPorDefecto = s.SCENARIO.inflacionMensual.every(v => v === 3.4 || v === 0);
        if (esPorDefecto) {
          ipc.forEach((d, i) => { if (i < 12) s.SCENARIO.inflacionMensual[i] = d.pct; });
          Scenarios.syncUItoState();
        }
        // Mostrar el último dato
        const ipcEl = document.getElementById('ipc_ultimo');
        if (ipcEl) {
          const ult = ipc.at(-1);
          ipcEl.textContent = `IPC ${ult.fecha.slice(0,7)}: ${ult.pct}% mensual`;
          ipcEl.style.display = '';
        }
      }

      // TCO → mostrar en status bar
      const tcoEl = document.getElementById('tco_valor');
      if (tcoEl && tco) {
        tcoEl.textContent = `TCO: $${tco.valor.toFixed(2)}`;
        tcoEl.style.display = '';
      }

      return { cer, ipc, tco };
    }

    return { refresh, fetchCER, fetchIPC, fetchTCO };
  })();

  // ── Arrancar ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
