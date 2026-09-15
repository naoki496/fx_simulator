(() => {
  'use strict';

  const INITIAL_CASH = 10_000_000;
  const START_PRICE = 10_000;
  const FEE_RATE = 0.0015;
  const GAME_SECONDS = 300;
  const TICK_MS = 250;
  const TICKS_PER_CANDLE = 20;
  const TOTAL_CANDLES = 60;
  const SCENARIOS = {
    A: {
      id: 'A', seed: 'CLASS-A', label: '成長と調整', badge: 'CASE A',
      note: '緩やかな成長と一時的な調整が交互に現れる、基本的な相場です。',
      regimes: [
        ['上昇', .0038, .0030, 11], ['横ばい', .0004, .0023, 8], ['調整', -.0032, .0038, 8],
        ['反発', .0045, .0040, 11], ['過熱', .0026, .0050, 9], ['調整', -.0024, .0035, 6], ['安定', .0015, .0024, 7]
      ]
    },
    B: {
      id: 'B', seed: 'CLASS-B', label: '乱高下', badge: 'CASE B',
      note: '上昇と下落が短い間隔で入れ替わる、値動きの大きな相場です。',
      regimes: [
        ['急騰', .0045, .0100, 7], ['急落', -.0065, .0120, 7], ['反発', .0060, .0110, 8],
        ['混乱', -.0010, .0140, 10], ['上昇', .0040, .0080, 8], ['下落', -.0050, .0100, 8], ['回復', .0030, .0070, 12]
      ]
    },
    C: {
      id: 'C', seed: 'CLASS-C', label: '静かな転換', badge: 'CASE C',
      note: '小さな値動きが続いた後、市場の方向が徐々に変わる相場です。',
      regimes: [
        ['横ばい', .0001, .0018, 13], ['小幅上昇', .0015, .0022, 10], ['停滞', -.0002, .0017, 9],
        ['転換', -.0028, .0030, 10], ['下落', -.0036, .0043, 10], ['反発', .0038, .0045, 8]
      ]
    },
    LEHMAN: {
      id: 'LEHMAN', seed: 'HISTORICAL-2008', label: 'リーマン・ショック', badge: 'HISTORICAL', historical: true,
      note: '2008年9月のリーマン・ブラザーズ破綻後、市場の混乱が深まった時期を参考に、急落と短い反発を60本のローソク足へ再構成した教材用シナリオです。実際のOHLCをそのまま再現するものではありません。'
    }
  };
  const HISTORICAL_ANCHORS = [
    [0, 1.000], [4, 1.025], [8, .978], [11, .930], [15, 1.010], [18, .921], [20, .951],
    [25, .780], [28, .873], [30, .794], [32, .722], [36, .755], [40, .835], [44, .760],
    [48, .690], [52, .620], [56, .700], [59, .720]
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    start: $('start-screen'), game: $('game-screen'), result: $('result-screen'),
    startButton: $('start-button'), seedDisplay: $('seed-display'), scenarioLabel: $('scenario-label'),
    timer: $('timer'), help: $('help-button'), dialog: $('guide-dialog'), paused: $('paused-label'), warning: $('market-warning'),
    chart: $('chart'), resultChart: $('result-chart'), currentPrice: $('current-price'),
    priceChange: $('price-change'), o: $('ohlc-open'), h: $('ohlc-high'), l: $('ohlc-low'), c: $('ohlc-close'),
    candleCount: $('candle-count'), totalAssets: $('total-assets'), totalReturn: $('total-return'),
    cash: $('cash'), stockValue: $('stock-value'), shares: $('shares'), unrealized: $('unrealized'),
    avgCost: $('avg-cost'), fees: $('fees'), cashBar: $('cash-bar'), stockBar: $('stock-bar'),
    buy: $('buy-button'), sell: $('sell-button'), sellAll: $('sell-all-button'), estimate: $('order-estimate'),
    toast: $('toast'), replay: $('replay-button'), newSeed: $('new-seed-button'), capitalStatus: $('capital-status'),
    assetSummary: document.querySelector('.asset-summary'), resultCaseNote: $('result-case-note'),
    buttonTip: $('button-tip'), tipTitle: $('tip-title'), tipText: $('tip-text'), tipClose: $('tip-close')
  };

  let selectedScenarioId = 'A';
  let state = makeInitialState('A');
  let timerId = null;
  let resizeFrame = null;
  let animationFrame = null;
  let lastUiPaint = 0;
  const seenTips = new Set();

  function makeInitialState(scenarioId) {
    const scenario = SCENARIOS[scenarioId] || SCENARIOS.A;
    return {
      scenarioId: scenario.id, seed: scenario.seed, rng: mulberry32(hashSeed(scenario.seed)), running: false, paused: false,
      elapsedTicks: 0, remainingMs: GAME_SECONDS * 1000, price: START_PRICE, displayPrice: START_PRICE,
      tweenFrom: START_PRICE, tweenTo: START_PRICE, tweenStarted: 0, pausedAt: 0, liveScale: null,
      cash: INITIAL_CASH, shares: 0, costBasis: 0, fees: 0, selectedLot: 100,
      candles: [], currentCandle: null, trades: [], assetHistory: [INITIAL_CASH],
      peakAssets: INITIAL_CASH, maxDrawdown: 0, maxExposure: 0, regimes: [], regimeIndex: 0,
      lastAlertCandle: -1
    };
  }

  function hashSeed(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  function buildRegimes() {
    const templates = SCENARIOS[state.scenarioId].regimes || [];
    const list = [];
    let covered = 0;
    templates.forEach(([name, drift, volatility, requestedLength]) => {
      const length = Math.min(TOTAL_CANDLES - covered, requestedLength);
      if (length <= 0) return;
      list.push({ name, drift, volatility, start: covered, end: covered + length });
      covered += length;
    });
    state.regimes = list;
  }

  function historicalTarget(candleIndex) {
    const index = Math.max(0, Math.min(TOTAL_CANDLES - 1, candleIndex));
    let left = HISTORICAL_ANCHORS[0], right = HISTORICAL_ANCHORS[HISTORICAL_ANCHORS.length - 1];
    for (let i = 1; i < HISTORICAL_ANCHORS.length; i++) {
      if (index <= HISTORICAL_ANCHORS[i][0]) { left = HISTORICAL_ANCHORS[i - 1]; right = HISTORICAL_ANCHORS[i]; break; }
    }
    const progress = right[0] === left[0] ? 0 : (index - left[0]) / (right[0] - left[0]);
    return Math.round(START_PRICE * (left[1] + (right[1] - left[1]) * progress));
  }

  function normalRandom() {
    const u = Math.max(state.rng(), 1e-9); const v = state.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function activeRegime(candleIndex) {
    while (state.regimeIndex < state.regimes.length - 1 && candleIndex >= state.regimes[state.regimeIndex].end) state.regimeIndex++;
    return state.regimes[state.regimeIndex];
  }

  function normalizeScenario(value) {
    const key = String(value || '').trim().toUpperCase();
    if (SCENARIOS[key]) return key;
    if (key === 'CLASS-A') return 'A'; if (key === 'CLASS-B') return 'B'; if (key === 'CLASS-C') return 'C';
    if (key.includes('2008') || key.includes('LEHMAN')) return 'LEHMAN';
    return selectedScenarioId;
  }

  function selectScenario(value) {
    selectedScenarioId = normalizeScenario(value);
    document.querySelectorAll('.scenario-card').forEach(button => {
      const selected = button.dataset.scenario === selectedScenarioId;
      button.classList.toggle('active', selected); button.setAttribute('aria-checked', String(selected));
    });
  }

  function startGame(scenarioOverride) {
    clearInterval(timerId);
    cancelAnimationFrame(animationFrame);
    hideButtonTip();
    clearTimeout(showMarketWarning.timeout); els.warning.classList.add('hidden');
    const scenarioId = normalizeScenario(scenarioOverride || selectedScenarioId);
    const scenario = SCENARIOS[scenarioId]; selectedScenarioId = scenarioId;
    state = makeInitialState(scenarioId);
    if (!scenario.historical) buildRegimes();
    state.running = true;
    startCandle();
    els.start.classList.add('hidden'); els.result.classList.add('hidden'); els.game.classList.remove('hidden');
    els.seedDisplay.textContent = scenario.badge; els.scenarioLabel.textContent = scenario.label;
    document.title = '取引中 — MARKET LAB';
    scheduleNextMove(performance.now());
    updateUI(); drawChart(els.chart, false);
    timerId = setInterval(tick, TICK_MS);
    animationFrame = requestAnimationFrame(renderLoop);
  }

  function startCandle() {
    const price = marketPrice();
    state.currentCandle = { open: price, high: price, low: price, close: price };
  }

  function scheduleNextMove(now) {
    const candleIndex = state.candles.length;
    state.tweenFrom = state.displayPrice;
    if (SCENARIOS[state.scenarioId].historical) {
      const ticksIntoCandle = state.elapsedTicks % TICKS_PER_CANDLE;
      const ticksRemaining = TICKS_PER_CANDLE - ticksIntoCandle;
      const target = historicalTarget(candleIndex);
      const directMove = (target - state.price) / ticksRemaining;
      const noise = ticksRemaining === 1 ? 0 : normalRandom() * state.price * .0016;
      state.price = Math.max(500, Math.round(ticksRemaining === 1 ? target : state.price + directMove + noise));
    } else {
      const regime = activeRegime(candleIndex);
      let returnRate = regime.drift / TICKS_PER_CANDLE + normalRandom() * regime.volatility / Math.sqrt(TICKS_PER_CANDLE);
      if (state.rng() < .0025) returnRate += (state.rng() - .58) * .025;
      state.price = Math.max(500, Math.round(state.price * (1 + returnRate)));
    }
    state.tweenTo = state.price;
    state.tweenStarted = now;
  }

  function updateCurrentCandle(price) {
    const cc = state.currentCandle;
    if (!cc) return;
    cc.high = Math.max(cc.high, price); cc.low = Math.min(cc.low, price); cc.close = price;
  }

  function tick() {
    if (!state.running || state.paused) return;
    state.displayPrice = state.tweenTo;
    updateCurrentCandle(state.displayPrice);
    checkMarketAlert();
    state.remainingMs = Math.max(0, state.remainingMs - TICK_MS);
    state.elapsedTicks++;
    const assets = totalAssets();
    state.peakAssets = Math.max(state.peakAssets, assets);
    state.maxDrawdown = Math.max(state.maxDrawdown, state.peakAssets ? (state.peakAssets - assets) / state.peakAssets : 0);
    state.maxExposure = Math.max(state.maxExposure, assets ? (state.shares * marketPrice()) / assets : 0);
    state.assetHistory.push(assets);

    if (state.elapsedTicks % TICKS_PER_CANDLE === 0) {
      state.candles.push({ ...state.currentCandle });
      if (state.candles.length < TOTAL_CANDLES) startCandle();
    }
    if (state.remainingMs <= 0 || state.candles.length >= TOTAL_CANDLES) return finishGame();
    scheduleNextMove(performance.now());
  }

  function checkMarketAlert() {
    const candleIndex = state.candles.length; const cc = state.currentCandle;
    if (!cc || state.lastAlertCandle === candleIndex) return;
    const candleDrop = (marketPrice() - cc.open) / cc.open;
    const stepDrop = (state.tweenTo - state.tweenFrom) / Math.max(1, state.tweenFrom);
    if (candleDrop <= -.025 || stepDrop <= -.012) {
      state.lastAlertCandle = candleIndex; showMarketWarning();
    }
  }

  function showMarketWarning() {
    clearTimeout(showMarketWarning.timeout); els.warning.classList.remove('hidden');
    showMarketWarning.timeout = setTimeout(() => els.warning.classList.add('hidden'), 2100);
  }

  function renderLoop(now) {
    if (!state.running) return;
    if (!state.paused) {
      const progress = Math.max(0, Math.min(1, (now - state.tweenStarted) / TICK_MS));
      const eased = progress * progress * (3 - 2 * progress);
      state.displayPrice = state.tweenFrom + (state.tweenTo - state.tweenFrom) * eased;
      updateCurrentCandle(state.displayPrice);
      if (now - lastUiPaint >= 45) { updateUI(); lastUiPaint = now; }
      drawChart(els.chart, false);
    }
    animationFrame = requestAnimationFrame(renderLoop);
  }

  function marketPrice() { return Math.max(1, Math.round(state.displayPrice)); }
  function totalAssets() { return Math.round(state.cash + state.shares * marketPrice()); }
  function feeFor(value) { return Math.round(value * FEE_RATE); }
  function averageCost() { return state.shares ? state.costBasis / state.shares : 0; }

  function resolveLot(side) {
    if (state.selectedLot !== 'max') return Number(state.selectedLot);
    const price = marketPrice();
    if (side === 'buy') return Math.max(0, Math.floor(state.cash / (price * (1 + FEE_RATE)) / 100) * 100);
    return state.shares;
  }

  function buy(lotInput) {
    if (!state.running || state.paused) return fail('ヘルプを閉じてから注文してください');
    const lot = Number(lotInput || resolveLot('buy'));
    if (!Number.isFinite(lot) || lot <= 0 || lot % 100 !== 0) return fail('購入できる数量がありません');
    const price = marketPrice(); const value = lot * price; const fee = feeFor(value); const cost = value + fee;
    if (cost > state.cash) return fail('現金が不足しています');
    state.cash -= cost; state.shares += lot; state.costBasis += value; state.fees += fee;
    recordTrade('buy', lot, fee, price); success(`${lot.toLocaleString()}株を ${yen(price)} で購入`); updateUI(); drawChart(els.chart, false);
    return { side: 'buy', shares: lot, price, fee, totalAssets: totalAssets() };
  }

  function sell(lotInput) {
    if (!state.running || state.paused) return fail('ヘルプを閉じてから注文してください');
    const lot = Number(lotInput || resolveLot('sell'));
    if (!Number.isFinite(lot) || lot <= 0 || lot % 100 !== 0) return fail('売却できる株がありません');
    if (lot > state.shares) return fail('保有株数が不足しています');
    const price = marketPrice(); const beforeShares = state.shares; const value = lot * price; const fee = feeFor(value);
    state.cash += value - fee; state.shares -= lot; state.costBasis -= state.costBasis * (lot / beforeShares); state.fees += fee;
    if (state.shares === 0) state.costBasis = 0;
    recordTrade('sell', lot, fee, price); success(`${lot.toLocaleString()}株を ${yen(price)} で売却`); updateUI(); drawChart(els.chart, false);
    return { side: 'sell', shares: lot, price, fee, totalAssets: totalAssets() };
  }

  function recordTrade(side, shares, fee, price) {
    state.trades.push({ side, shares, price, fee, candleIndex: state.candles.length, tickInCandle: state.elapsedTicks % TICKS_PER_CANDLE });
    const assets = totalAssets(); state.peakAssets = Math.max(state.peakAssets, assets);
    state.maxExposure = Math.max(state.maxExposure, assets ? (state.shares * marketPrice()) / assets : 0);
  }

  function finishGame() {
    if (!state.running) return;
    state.running = false; clearInterval(timerId); timerId = null; cancelAnimationFrame(animationFrame); animationFrame = null;
    clearTimeout(showMarketWarning.timeout); els.warning.classList.add('hidden');
    if (state.currentCandle && state.candles.length < TOTAL_CANDLES) state.candles.push({ ...state.currentCandle });
    els.game.classList.add('hidden'); els.result.classList.remove('hidden');
    document.title = 'RESULT — MARKET LAB';
    renderResult();
  }

  function renderResult() {
    const assets = totalAssets(); const profit = assets - INITIAL_CASH; const rate = profit / INITIAL_CASH;
    const scenario = SCENARIOS[state.scenarioId];
    const score = riskScore(rate, state.maxDrawdown, state.fees);
    setSigned($('final-return'), percent(rate));
    $('final-assets').textContent = yen(assets); $('result-seed').textContent = scenario.badge;
    setSigned($('result-profit'), signedYen(profit));
    $('result-drawdown').textContent = `-${(state.maxDrawdown * 100).toFixed(2)}%`;
    $('result-exposure').textContent = percent(state.maxExposure, false);
    $('result-trades').textContent = `${state.trades.length}回`; $('result-fees').textContent = yen(state.fees); $('result-score').textContent = score;
    $('style-comment').innerHTML = investmentStyle(rate, state.maxExposure, state.trades.length, state.maxDrawdown);
    els.resultCaseNote.textContent = scenario.note;
    els.resultCaseNote.classList.toggle('historical', !!scenario.historical);
    requestAnimationFrame(() => drawChart(els.resultChart, true));
  }

  function riskScore(rate, drawdown, fees) {
    const base = 55 + rate * 130 - drawdown * 75 - (fees / INITIAL_CASH) * 80;
    return Math.max(0, Math.min(100, Math.round(base)));
  }

  function investmentStyle(rate, exposure, trades, drawdown) {
    let type = '慎重型';
    if (exposure > .85) type = '強気集中型'; else if (trades >= 18) type = '短期売買型'; else if (trades <= 3 && exposure > .35) type = '長期保有型'; else if (exposure > .55) type = '積極運用型'; else if (trades === 0) type = '現金保有型';
    let note = rate >= 0 ? '利益を確保しました。' : '今回は損失となりました。';
    if (drawdown > .2) note += ' 一方、途中の資産変動は大きめでした。'; else if (exposure > .1) note += ' 資産の下落幅は比較的抑えられています。';
    return `<strong>今回の投資スタイル：${type}</strong><br>${note} 同じ結果でも、その時点の情報から判断を振り返ることが大切です。`;
  }

  function updateUI() {
    const price = marketPrice(); const assets = totalAssets(); const stock = state.shares * price; const rate = (assets - INITIAL_CASH) / INITIAL_CASH;
    const profit = assets - INITIAL_CASH;
    const marketRate = (price - START_PRICE) / START_PRICE; const avg = averageCost(); const unrealized = state.shares ? Math.round((price - avg) * state.shares) : 0;
    els.timer.textContent = formatTime(state.remainingMs); els.currentPrice.textContent = yen(price); setSigned(els.priceChange, percent(marketRate));
    const cc = state.currentCandle || { open: price, high: price, low: price, close: price };
    els.o.textContent = num(cc.open); els.h.textContent = num(cc.high); els.l.textContent = num(cc.low); els.c.textContent = num(cc.close);
    els.candleCount.textContent = `${Math.min(state.candles.length, TOTAL_CANDLES)} / ${TOTAL_CANDLES}`;
    els.totalAssets.textContent = yen(assets); setSigned(els.totalReturn, percent(rate)); els.cash.textContent = yen(state.cash); els.stockValue.textContent = yen(stock); els.shares.innerHTML = `${num(state.shares)} <small>株</small>`;
    updateCapitalStatus(profit);
    setSigned(els.unrealized, signedYen(unrealized)); els.avgCost.textContent = state.shares ? yen(Math.round(avg)) : '—'; els.fees.textContent = yen(state.fees);
    const stockPct = assets ? Math.max(0, Math.min(100, stock / assets * 100)) : 0; els.cashBar.style.width = `${100-stockPct}%`; els.stockBar.style.width = `${stockPct}%`;
    const buyLot = resolveLot('buy'), sellLot = resolveLot('sell'); els.buy.disabled = !state.running || state.paused || buyLot <= 0 || buyLot * price + feeFor(buyLot * price) > state.cash;
    els.sell.disabled = !state.running || state.paused || sellLot <= 0 || sellLot > state.shares; els.sellAll.disabled = !state.running || state.paused || state.shares <= 0;
    const displayLot = state.selectedLot === 'max' ? buyLot : Number(state.selectedLot); const estimate = displayLot * price + feeFor(displayLot * price);
    els.estimate.textContent = displayLot > 0 ? `${num(displayLot)}株の購入額（手数料込） ${yen(estimate)}` : '購入できる数量がありません';
  }

  function updateCapitalStatus(profit) {
    const status = profit > 0 ? 'up' : profit < 0 ? 'down' : 'even';
    els.capitalStatus.className = `capital-status ${status}`;
    els.assetSummary.classList.toggle('capital-up', status === 'up');
    els.assetSummary.classList.toggle('capital-down', status === 'down');
    const label = profit > 0 ? `元本を +${yen(profit)} 上回っています` : profit < 0 ? `元本を ${yen(Math.abs(profit))} 下回っています` : '元本と同額です';
    els.capitalStatus.querySelector('strong').textContent = label;
  }

  function drawChart(canvas, withTrades) {
    if (!canvas || !canvas.isConnected) return;
    const rect = canvas.getBoundingClientRect(); if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    const candles = withTrades ? state.candles : [...state.candles, ...(state.currentCandle && state.candles.length < TOTAL_CANDLES ? [state.currentCandle] : [])];
    const pad = { l: 8, r: 64, t: withTrades ? 20 : 12, b: 24 }; const cw = rect.width - pad.l - pad.r, ch = rect.height - pad.t - pad.b;
    const lows = candles.map(c => c.low), highs = candles.map(c => c.high); let min = Math.min(...lows, START_PRICE), max = Math.max(...highs, START_PRICE); const range = Math.max(100, max-min); min -= range*.14; max += range*.14;
    if (!withTrades) {
      if (!state.liveScale) state.liveScale = { min, max };
      state.liveScale.min += (min - state.liveScale.min) * .09;
      state.liveScale.max += (max - state.liveScale.max) * .09;
      min = state.liveScale.min; max = state.liveScale.max;
    }
    const y = p => pad.t + (max-p)/(max-min)*ch;
    ctx.strokeStyle = 'rgba(91,99,232,.10)'; ctx.lineWidth = 1; ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = '#7d8ba0'; ctx.textAlign = 'left';
    for (let i=0; i<=5; i++) { const yy = pad.t + ch*i/5; ctx.beginPath(); ctx.moveTo(pad.l, yy+.5); ctx.lineTo(pad.l+cw, yy+.5); ctx.stroke(); ctx.fillText(num(Math.round(max-(max-min)*i/5)), pad.l+cw+8, yy+3); }
    const slot = cw / TOTAL_CANDLES; const bodyW = Math.max(2, Math.min(10, slot*.58));
    candles.forEach((c, i) => { const x = pad.l + slot*(i+.5), up = c.close >= c.open, color = up ? '#16b88a' : '#f05b78'; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y(c.high)); ctx.lineTo(x, y(c.low)); ctx.stroke(); const top = y(Math.max(c.open,c.close)), bottom = y(Math.min(c.open,c.close)); ctx.fillRect(x-bodyW/2, top, bodyW, Math.max(1.5,bottom-top)); });
    if (!withTrades && candles.length) { const yy = y(marketPrice()); ctx.setLineDash([4,4]); ctx.strokeStyle = 'rgba(58,72,99,.35)'; ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(pad.l+cw,yy); ctx.stroke(); ctx.setLineDash([]); }
    if (withTrades) drawTradeMarkers(ctx, state.trades, slot, y, pad, cw, ch);
  }

  function drawTradeMarkers(ctx, trades, slot, y, pad, cw, ch) {
    const grouped = trades.reduce((acc,t) => { const key = `${t.side}-${t.candleIndex}`; acc[key] = acc[key] || t; return acc; }, {});
    Object.values(grouped).forEach(t => { const index = Math.min(t.candleIndex, state.candles.length-1), x = pad.l + slot*(index+.5), baseY = y(t.price), buySide = t.side === 'buy'; const markerY = Math.max(pad.t+8, Math.min(pad.t+ch-8, baseY + (buySide ? 14 : -14))); ctx.fillStyle = buySide ? '#16b88a' : '#f05b78'; ctx.beginPath(); if (buySide) { ctx.moveTo(x, markerY-6); ctx.lineTo(x-5,markerY+3); ctx.lineTo(x+5,markerY+3); } else { ctx.moveTo(x, markerY+6); ctx.lineTo(x-5,markerY-3); ctx.lineTo(x+5,markerY-3); } ctx.closePath(); ctx.fill(); });
  }

  function setPaused(paused) {
    if (!state.running || state.paused === paused) return;
    if (paused) { state.pausedAt = performance.now(); }
    else if (state.pausedAt) { state.tweenStarted += performance.now() - state.pausedAt; state.pausedAt = 0; }
    state.paused = paused; els.paused.classList.toggle('hidden', !paused); updateUI();
  }
  function openGuide() { if (state.running) setPaused(true); els.dialog.showModal(); }
  function closeGuide() { els.dialog.close(); if (state.running) setPaused(false); }
  function showToast(message, error=false) { els.toast.textContent = message; els.toast.classList.toggle('error', error); els.toast.classList.add('show'); clearTimeout(showToast.timeout); showToast.timeout = setTimeout(()=>els.toast.classList.remove('show'), 1900); }
  function showButtonTip(button) {
    const key = `${button.id || button.dataset.lot || button.textContent.trim()}`;
    if (!button.dataset.tip || seenTips.has(key)) return;
    seenTips.add(key); clearTimeout(showButtonTip.timeout);
    els.tipTitle.textContent = button.dataset.tipTitle || '操作の説明'; els.tipText.textContent = button.dataset.tip;
    els.buttonTip.classList.remove('hidden'); positionButtonTip(button);
    showButtonTip.timeout = setTimeout(hideButtonTip, 6200);
  }
  function positionButtonTip(button) {
    const rect = button.getBoundingClientRect(); const tipRect = els.buttonTip.getBoundingClientRect(); const gap = 12;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(12, Math.min(window.innerWidth - tipRect.width - 12, left));
    let top = rect.top - tipRect.height - gap;
    const below = top < 12;
    if (below) top = rect.bottom + gap;
    els.buttonTip.classList.toggle('tip-below', below);
    els.buttonTip.style.left = `${left}px`; els.buttonTip.style.top = `${top}px`;
  }
  function hideButtonTip() { clearTimeout(showButtonTip.timeout); els.buttonTip.classList.add('hidden'); }
  function success(message) { showToast(message); }
  function fail(message) { showToast(message, true); return { error: message }; }
  function yen(value) { return `¥${Math.round(value).toLocaleString('ja-JP')}`; }
  function signedYen(value) { return `${value > 0 ? '+' : value < 0 ? '-' : ''}¥${Math.abs(Math.round(value)).toLocaleString('ja-JP')}`; }
  function num(value) { return Math.round(value).toLocaleString('ja-JP'); }
  function percent(value, signed=true) { return `${signed && value > 0 ? '+' : ''}${(value*100).toFixed(2)}%`; }
  function setSigned(el, text) { el.textContent = text; const raw = text.replace(/[¥,%]/g,''); const n = Number(raw); el.classList.remove('positive','negative','neutral'); el.classList.add(n>0?'positive':n<0?'negative':'neutral'); }
  function formatTime(ms) { const s = Math.ceil(ms/1000); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
  els.startButton.addEventListener('click', () => startGame());
  document.querySelectorAll('.scenario-card').forEach(button => button.addEventListener('click', () => selectScenario(button.dataset.scenario)));
  document.querySelectorAll('[data-open-guide]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); openGuide(); }));
  document.querySelectorAll('[data-close-guide]').forEach(b => b.addEventListener('click', closeGuide));
  els.help.addEventListener('click', openGuide);
  els.dialog.addEventListener('cancel', e => { e.preventDefault(); closeGuide(); });
  els.dialog.addEventListener('click', e => { if (e.target === els.dialog) closeGuide(); });
  document.querySelectorAll('.lot').forEach(button => button.addEventListener('click', () => { state.selectedLot = button.dataset.lot === 'max' ? 'max' : Number(button.dataset.lot); document.querySelectorAll('.lot').forEach(x=>x.classList.toggle('active',x===button)); updateUI(); }));
  els.buy.addEventListener('click', () => buy()); els.sell.addEventListener('click', () => sell()); els.sellAll.addEventListener('click', () => sell(state.shares));
  document.querySelectorAll('[data-tip]').forEach(button => button.addEventListener('click', () => showButtonTip(button)));
  els.tipClose.addEventListener('click', hideButtonTip);
  els.replay.addEventListener('click', () => startGame(state.scenarioId));
  els.newSeed.addEventListener('click', () => { els.result.classList.add('hidden'); els.start.classList.remove('hidden'); selectScenario(state.scenarioId); document.title = 'MARKET LAB — 投資シミュレーター'; window.scrollTo(0,0); });
  window.addEventListener('resize', () => { hideButtonTip(); cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(()=>{ if (!els.game.classList.contains('hidden')) drawChart(els.chart,false); if (!els.result.classList.contains('hidden')) drawChart(els.resultChart,true); }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.running && !els.dialog.open) { setPaused(true); openGuide(); } });

  function registerWebMCP() {
    const context = document.modelContext; if (!context?.registerTool) return;
    const tools = [
      { name:'read_market_state', title:'市場状況を確認', description:'現在価格、資産、保有株、残り時間を確認します。', inputSchema:{type:'object',properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,untrustedContentHint:false}, execute:()=>({scenario:state.scenarioId,price:marketPrice(),cash:Math.round(state.cash),shares:state.shares,totalAssets:totalAssets(),remainingSeconds:Math.ceil(state.remainingMs/1000),running:state.running,paused:state.paused}) },
      { name:'start_market_session', title:'取引を開始', description:'選択したCASEで5分間の投資ゲームを開始します。', inputSchema:{type:'object',properties:{scenario:{type:'string',enum:['A','B','C','LEHMAN']}},required:['scenario'],additionalProperties:false}, annotations:{readOnlyHint:false,untrustedContentHint:false}, execute:(input)=>{ if(!input || !SCENARIOS[input.scenario]) throw new Error('valid scenario is required'); startGame(input.scenario); return {started:true,scenario:state.scenarioId,durationSeconds:GAME_SECONDS}; } },
      { name:'place_market_order', title:'売買注文', description:'進行中のゲームで100株単位の買いまたは売り注文を実行します。', inputSchema:{type:'object',properties:{side:{type:'string',enum:['buy','sell']},shares:{type:'integer',minimum:100,multipleOf:100}},required:['side','shares'],additionalProperties:false}, annotations:{readOnlyHint:false,untrustedContentHint:false}, execute:(input)=>{ if(!input || !['buy','sell'].includes(input.side) || !Number.isInteger(input.shares) || input.shares%100!==0) throw new Error('valid side and shares are required'); const result=input.side==='buy'?buy(input.shares):sell(input.shares); if(result.error) throw new Error(result.error); return result; } }
    ];
    tools.forEach(tool => { try { Promise.resolve(context.registerTool(tool)).catch(()=>{}); } catch (_) {} });
  }

  const params = new URLSearchParams(location.search); const urlScenario = params.get('scenario') || params.get('seed');
  if (urlScenario) selectScenario(urlScenario); else selectScenario('A');
  updateUI(); registerWebMCP();
})();
