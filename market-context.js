/* Independent contextual panels: never feed incomplete/proxy series into the
   regime classifier. SVGs share the page's light/dark theme and resize naturally. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const compact = v => v == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
  const usd = v => v == null ? '—' : (v < 0 ? '−' : '') + '$' + compact(Math.abs(v));
  const signed = (v, money = false) => v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + (money ? '$' : '') + compact(Math.abs(v));
  const tone = v => v == null || v === 0 ? 'neutral' : v > 0 ? 'up' : 'down';
  const stamp = v => v ? new Date(v).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' UTC' : '—';
  const stale = (d, days) => Date.now() - Date.parse(d) > days * 86400000;
  const metric = (name, value, detail, cls = '') => `<div class="mc-metric"><span class="mc-eyebrow">${esc(name)}</span><strong class="${cls}">${esc(value)}</strong><small>${esc(detail)}</small></div>`;
  const table = (caption, headers, rows) => `<table class="mc-table"><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const details = (label, body) => `<details><summary>${esc(label)}</summary><div class="mc-history">${body}</div></details>`;
  const legend = items => `<div class="mc-legend">${items.map(([label, color]) => `<span><i style="background:${color}"></i>${esc(label)}</span>`).join('')}</div>`;
  const note = (text, warning = false) => `<p class="mc-note${warning ? ' mc-warning' : ''}">${esc(text)}</p>`;
  const COLORS = ['#5782dc', '#309d91', '#cb7c43'];
  const state = { asset: 'btc', mode: 'recorded', versions: {}, data: new Map(), requests: new Map() };

  function flag(panel, label, warning = false) {
    const el = panel.querySelector('[data-status]');
    if (el) { el.textContent = label; el.className = 'p-flag ' + (warning ? 'caution' : 'flat'); }
  }
  function empty(message, title = 'Data unavailable') {
    return `<div class="mc-empty"><strong>${esc(title)}</strong><p class="sub">${esc(message)}</p></div>`;
  }
  function svg(title, content) {
    return `<svg class="mc-chart" viewBox="0 0 520 185" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${content}</svg>`;
  }

  function flowChart(rows) {
    const w = 454, x0 = 58, y0 = 20, h = 132, step = w / rows.length;
    const max = Math.max(1, ...rows.map(r => Math.abs(r.flow || 0))), zero = y0 + h / 2;
    let s = `<text x="0" y="15">USD</text><text x="0" y="${y0 + 5}">${esc(usd(max))}</text><text x="10" y="${zero + 4}">0</text><text x="0" y="${y0 + h}">${esc(usd(-max))}</text><line class="mc-zero" x1="${x0}" x2="512" y1="${zero}" y2="${zero}"/>`;
    rows.forEach((r, i) => {
      const x = x0 + i * step + 1;
      if (r.flow === null) { s += `<text x="${x}" y="${zero + 4}">·</text>`; return; }
      const height = Math.max(1, Math.abs(r.flow) / max * h / 2), y = r.flow >= 0 ? zero - height : zero;
      s += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(1, step - 3).toFixed(2)}" height="${height.toFixed(2)}" fill="var(--${r.flow >= 0 ? 'bull' : 'bear'})" opacity="${r.complete ? 1 : .4}"><title>${esc(r.date + ': ' + signed(r.flow, true) + (r.complete ? '' : ' · partial reports'))}</title></rect>`;
    });
    s += `<text x="${x0}" y="177">${esc(rows[0].date)}</text><text x="512" y="177" text-anchor="end">${esc(rows.at(-1).date)}</text>`;
    return svg('Daily holdings-derived ETF flow. Faded bars have incomplete fund reports; missing days are not zero.', s);
  }

  function holderChart(rows) {
    const x0 = 58, w = 454, y0 = 20, h = 132;
    const start = Date.parse(rows[0].date), end = Date.parse(rows.at(-1).date);
    const max = Math.max(1, ...rows.flatMap(r => [Math.abs(r.change30.long || 0), Math.abs(r.change30.short || 0)]));
    const zero = y0 + h / 2;
    let s = `<text x="0" y="15">BTC</text><text x="0" y="${y0 + 5}">${esc(compact(max))}</text><text x="10" y="${zero + 4}">0</text><text x="0" y="${y0 + h}">−${esc(compact(max))}</text><line class="mc-zero" x1="${x0}" x2="512" y1="${zero}" y2="${zero}"/>`;
    ['long', 'short'].forEach((key, index) => {
      let path = '', connected = false, lastTime = null;
      rows.forEach(r => {
        const v = r.change30[key], time = Date.parse(r.date);
        if (v === null) { connected = false; return; }
        const x = x0 + (time - start) / Math.max(1, end - start) * w, y = zero - v / max * h / 2;
        const contiguous = connected && time - lastTime === 86400000;
        path += `${contiguous ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
        connected = true; lastTime = time;
      });
      s += `<path d="${path}" fill="none" stroke="${COLORS[index]}" stroke-width="2"/>`;
    });
    s += `<text x="${x0}" y="177">${esc(rows[0].date)}</text><text x="512" y="177" text-anchor="end">${esc(rows.at(-1).date)}</text>`;
    return svg('Rolling 30-day supply change in BTC for long-term and short-term age bands.', s);
  }

  function liquidationChart(data) {
    const rows = data.bins, modeled = data.mode === 'modeled';
    const min = rows[0].price, maxPrice = rows.at(-1).price + (modeled ? 0 : 100), range = Math.max(100, maxPrice - min);
    const max = Math.max(1, ...rows.map(r => modeled ? r.level : r.long + r.short));
    const x0 = 58, w = 454, y0 = 22, h = 132;
    const barWidth = Math.max(1, Math.min(32, w / Math.max(1, rows.length) - 1, (modeled ? w / Math.max(1, rows.length) : 100 / range * w) - 1));
    let s = `<text x="0" y="14">${modeled ? 'Intensity' : 'USD'}</text><text x="0" y="28">${esc(modeled ? compact(max) : usd(max))}</text><text x="10" y="${y0 + h}">0</text><line class="mc-axis" x1="${x0}" x2="512" y1="${y0 + h}" y2="${y0 + h}"/>`;
    for (const r of rows) {
      const x = x0 + (r.price - min) / range * (w - barWidth);
      if (modeled) {
        const height = r.level / max * h;
        s += `<rect x="${x}" y="${y0 + h - height}" width="${barWidth}" height="${height}" fill="var(--caution)"><title>${esc(usd(r.price) + ': ' + compact(r.level) + ' intensity')}</title></rect>`;
      } else {
        const lh = r.long / max * h, sh = r.short / max * h;
        s += `<rect x="${x}" y="${y0 + h - lh}" width="${barWidth}" height="${lh}" fill="var(--bear)"><title>${esc(usd(r.price) + '–' + usd(r.price + 100) + ' · longs ' + usd(r.long))}</title></rect>`;
        s += `<rect x="${x}" y="${y0 + h - lh - sh}" width="${barWidth}" height="${sh}" fill="var(--bull)"><title>${esc(usd(r.price) + '–' + usd(r.price + 100) + ' · shorts ' + usd(r.short))}</title></rect>`;
      }
    }
    s += `<text x="${x0}" y="179">${esc(usd(min))}</text><text x="285" y="179" text-anchor="middle">BTC price</text><text x="512" y="179" text-anchor="end">${esc(usd(maxPrice))}</text>`;
    return svg(modeled ? 'Modeled liquidation intensity by BTC price, Binance 1-day model.' : 'Recorded OKX liquidation notional by bankruptcy price in $100 bands.', s);
  }

  function renderOI(data, panel) {
    const old = Date.now() - Date.parse(data.fetchedAt) > 15 * 60000;
    flag(panel, old ? 'Delayed snapshot' : 'Current snapshot', old);
    const metrics = data.groups.map((g, i) => metric(g.name, g.share.toFixed(1) + '%', usd(g.usd), ['mc-btc', 'mc-eth', 'mc-other'][i])).join('');
    const shares = data.groups.map((g, i) => `<span style="width:${g.share}%;background:${COLORS[i]}" title="${esc(g.name + ' ' + g.share.toFixed(2) + '%')}"></span>`).join('');
    panel.querySelector('[data-updated]').textContent = 'Fetched ' + stamp(data.fetchedAt);
    return `<div class="mc-metrics">${metrics}</div><div class="mc-share" role="img" aria-label="${esc(data.groups.map(g => g.name + ': ' + g.share.toFixed(1) + '%').join(', '))}">${shares}</div>`
      + table('Share of covered USD open interest', ['Metric', 'Value'], [['Total covered OI', usd(data.total)], ['BTC / ETH OI ratio', data.btcEthRatio.toFixed(2) + '×'], ['Venues / contracts', data.exchanges + ' / ' + data.contracts.toLocaleString()]])
      + note(data.note, true)
      + `<p class="sub"><a href="https://www.coingecko.com/en/derivatives" target="_blank" rel="noopener noreferrer">CoinGecko source ↗</a> · <a href="https://coinalyze.net/futures-data/global-charts/" target="_blank" rel="noopener noreferrer">View the requested Coinalyze history ↗</a></p>`
      + note('Snapshot only; no historical trend is inferred. Last-trade timestamps filter inactive contracts; they are not OI update timestamps.');
  }

  function renderETF(data, panel) {
    const latest = data.latest, old = stale(latest.date, 5), recent = data.history.slice(-20);
    panel.querySelector('[data-updated]').textContent = (old ? 'Delayed · ' : '') + 'Report ' + latest.date;
    const completeDays = data.history.filter(r => r.complete).slice(-5);
    const sum = completeDays.length === 5 ? completeDays.reduce((s, r) => s + r.flow, 0) : null;
    return `<div class="mc-metrics two">${metric(data.asset + ' · ' + (latest.complete ? 'covered flow' : 'partial flow'), signed(latest.flow, true), latest.date + ' · ' + latest.reported + '/' + data.expected.length + ' funds', tone(latest.flow))}${metric('Last 5 complete reports', signed(sum, true), completeDays.length === 5 ? 'Through ' + completeDays.at(-1).date : 'Insufficient complete reports', tone(sum))}</div>`
      + note(data.expected.join(' · ') + ' only. ' + data.note, true)
      + (old ? note('The latest report is more than five calendar days old.', true) : '')
      + flowChart(recent)
      + table('Latest day · USD · — means not reported', ['Fund', 'Flow', 'Coins held'], latest.funds.map(f => [f.ticker, signed(f.flow, true), compact(f.holdings)]))
      + details('Daily history & reporting coverage', table('Publisher dates; no weekend values filled in', ['Date', 'USD flow', 'Funds'], data.history.slice().reverse().map(r => [r.date, signed(r.flow, true), r.reported + '/' + data.expected.length])))
      + note(data.attribution + '. Faded bars indicate partial fund reports.');
  }

  function renderHolders(data, panel) {
    const d = data.latest, old = stale(d.date, 3);
    flag(panel, old ? 'Delayed · 6m proxy' : '6-month proxy', true);
    panel.querySelector('[data-updated]').textContent = 'As of ' + d.date;
    return `<div class="mc-metrics two">${metric('Long-term · ≥6 months', compact(d.long) + ' BTC', (d.long / (d.long + d.short) * 100).toFixed(1) + '% of cohort supply', 'mc-btc')}${metric('Short-term · <6 months', compact(d.short) + ' BTC', (d.short / (d.long + d.short) * 100).toFixed(1) + '% of cohort supply', 'mc-eth')}</div>`
      + table('Net supply change · BTC', ['Window', 'Long-term', 'Short-term'], [1, 7, 30].map(n => [n + ' day' + (n > 1 ? 's' : ''), signed(data.changes[n].long), signed(data.changes[n].short)]))
      + holderChart(data.history.slice(-90)) + legend([['Long-term · rolling 30d change', COLORS[0]], ['Short-term · rolling 30d change', COLORS[1]]])
      + note(data.note, true)
      + (old ? note('The last on-chain observation is more than three days old.', true) : '')
      + details('Daily cohort supply', table('BTC supply by age', ['Date', 'Long-term', 'Short-term'], data.history.slice(-30).reverse().map(r => [r.date, compact(r.long), compact(r.short)])));
  }

  function renderLiquidations(data, panel) {
    const modeled = data.mode === 'modeled';
    panel.querySelector('[data-updated]').textContent = modeled ? 'Fetched ' + stamp(data.fetchedAt) : data.to ? stamp(data.from) + ' → ' + stamp(data.to) : 'Fetched ' + stamp(data.fetchedAt);
    if (!data.bins.length) return empty('OKX returned no liquidation events in its available window. This does not mean there were no liquidations elsewhere.', 'No reported events') + note(data.note);
    return (modeled ? note(data.note, true) : `<div class="mc-metrics two">${metric('Longs liquidated', usd(data.long), data.count + ' reported events in total', 'down')}${metric('Shorts liquidated', usd(data.short), 'OKX · returned window', 'up')}</div>`)
      + liquidationChart(data)
      + (modeled ? '' : legend([['Long liquidations', 'var(--bear)'], ['Short liquidations', 'var(--bull)']]) + note(data.note))
      + (!modeled && stale(data.to, 1) ? note('The newest returned liquidation is more than 24 hours old.', true) : '')
      + details('Price-level data', table(modeled ? 'Provider liquidation intensity' : 'USD notional by bankruptcy-price band', modeled ? ['BTC price', 'Intensity'] : ['BTC price band', 'Longs', 'Shorts'], data.bins.map(r => modeled ? [usd(r.price), compact(r.level)] : [usd(r.price) + '–' + usd(r.price + 100), usd(r.long), usd(r.short)])));
  }

  async function getData(kind, mode, force) {
    const key = kind + ':' + mode;
    const cached = state.data.get(key);
    if (!force && cached && Date.now() - cached.time < 300000) return cached.body;
    if (!state.requests.has(key)) {
      state.requests.set(key, (async () => {
        const r = await fetch('/api/market-context?kind=' + kind + '&mode=' + mode, { signal: AbortSignal.timeout(18000) });
        if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error('These panels need the dashboard API. Open the Vercel deployment or run the local development server.');
        const body = await r.json();
        if (!r.ok || body.error) { const e = new Error(body.detail || 'Source unavailable (HTTP ' + r.status + ')'); e.code = body.error; throw e; }
        state.data.set(key, { time: Date.now(), body }); return body;
      })().finally(() => state.requests.delete(key)));
    }
    return state.requests.get(key);
  }

  async function loadPanel(name, force = false) {
    const panel = $('mc-' + name), content = panel.querySelector('[data-content]');
    const version = state.versions[name] = (state.versions[name] || 0) + 1;
    const kind = name === 'etf' ? 'etf-' + state.asset : name;
    const mode = name === 'liquidations' ? state.mode : 'recorded';
    const switching = content.dataset.key && content.dataset.key !== kind + mode;
    content.dataset.key = kind + mode;
    if (switching) {
      content.innerHTML = empty('Fetching this dataset…', 'Loading');
      panel.querySelector('[data-updated]').textContent = 'Loading source…';
    }
    content.dataset.loading = 'true'; panel.setAttribute('aria-busy', 'true');
    try {
      const data = await getData(kind, mode, force);
      if (version !== state.versions[name]) return;
      content.innerHTML = ({ oi: renderOI, etf: renderETF, holders: renderHolders, liquidations: renderLiquidations })[name](data, panel);
    } catch (e) {
      if (version !== state.versions[name]) return;
      flag(panel, 'Unavailable', true);
      // Clear previous values on failure instead of presenting them as fresh.
      content.innerHTML = empty(e.message, e.code === 'provider_not_configured' ? 'Modeled map needs a provider' : 'Source unavailable');
      panel.querySelector('[data-updated]').textContent = 'Unavailable · checked ' + stamp(new Date().toISOString());
    } finally {
      if (version === state.versions[name]) { content.dataset.loading = 'false'; panel.setAttribute('aria-busy', 'false'); }
    }
  }

  async function refreshPanels(force = false) {
    const button = $('mcRefresh'); button.disabled = true; button.textContent = 'Refreshing…';
    try { await Promise.all(['oi', 'etf', 'holders', 'liquidations'].map(name => loadPanel(name, force))); }
    finally { button.disabled = false; button.textContent = 'Refresh panels'; }
  }
  document.querySelectorAll('[data-etf]').forEach(button => button.addEventListener('click', () => {
    state.asset = button.dataset.etf;
    document.querySelectorAll('[data-etf]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    loadPanel('etf');
  }));
  document.querySelectorAll('[data-liq]').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.liq;
    document.querySelectorAll('[data-liq]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    loadPanel('liquidations');
  }));
  $('mcRefresh').addEventListener('click', () => refreshPanels(true));
  $('btnRefresh').addEventListener('click', () => refreshPanels(true));
  refreshPanels();
  setInterval(() => { if (!document.hidden) refreshPanels(); }, 300000);
})();
