'use strict';

/* ================= 分析画面 =================
 * app.js の api() / esc() / toast() を使う。グラフは外部ライブラリを使わず SVG で描く
 * （オフラインでも表示でき、Service Worker のキャッシュだけで完結するため）。
 */

const dash = { days: 30, data: null, fetchedDays: null };

/* ---------- 小さな SVG グラフ部品 ---------- */

const MiniChart = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const PAD = { l: 42, r: 12, t: 14, b: 24 };

  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    if (parent) parent.appendChild(n);
    return n;
  };

  function niceStep(range, count) {
    const raw = range / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  }

  function fmtNum(v, decimals) {
    return Number(v).toLocaleString('ja-JP', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
  }

  // 上側の角だけ丸めた棒（データの端を丸め、基準線側は角のまま）
  function barPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function render(host, cfg) {
    host._cfg = cfg;
    host.innerHTML = '';
    const W = host.clientWidth || 300;
    const H = host.clientHeight || 200;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cfg.title || '' }, host);
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const n = cfg.labels.length;

    const all = [];
    cfg.series.forEach(s => s.values.forEach(v => { if (v != null) all.push(v); }));
    if (!all.length || !n) {
      el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-note' }, svg).textContent = cfg.emptyText || '記録なし';
      return;
    }
    if (cfg.ref) all.push(cfg.ref.value);
    let min = cfg.zero ? 0 : Math.min(...all);
    let max = Math.max(...all);
    if (min === max) { min -= 1; max += 1; }
    const step = niceStep(max - min, 4);
    min = cfg.zero ? 0 : Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    const y = v => PAD.t + plotH - ((v - min) / (max - min)) * plotH;
    const slot = plotW / n;
    const cx = i => PAD.l + slot * (i + 0.5);

    // 目盛りと補助線（控えめに）
    for (let v = min; v <= max + step / 2; v += step) {
      el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), stroke: v === min && cfg.zero ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
      el('text', { x: PAD.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmtNum(v, cfg.decimals || 0);
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 58))));
    for (let i = 0; i < n; i += every) {
      el('text', { x: cx(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = cfg.labels[i];
    }

    // 棒（複数系列は横に並べ、間に2pxのすき間）
    const bars = cfg.series.filter(s => s.kind === 'bar');
    if (bars.length) {
      const group = Math.min(slot * 0.78, 30 * bars.length);
      const bw = Math.max(1.5, (group - 2 * (bars.length - 1)) / bars.length);
      bars.forEach((s, bi) => {
        s.values.forEach((v, i) => {
          if (v == null || v <= min) return;
          const x0 = cx(i) - group / 2 + bi * (bw + 2);
          el('path', { d: barPath(x0, y(v), bw, y(min) - y(v)), fill: s.color }, svg);
        });
      });
    }

    // 目標線（点線）と、その場のラベル
    if (cfg.ref) {
      el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(cfg.ref.value), y2: y(cfg.ref.value), stroke: 'var(--ink-muted)', 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, svg);
      el('text', { x: W - PAD.r, y: y(cfg.ref.value) - 5, 'text-anchor': 'end', class: 'label-direct' }, svg).textContent = cfg.ref.label;
    }

    // 線と点
    cfg.series.filter(s => s.kind === 'line').forEach(s => {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + cx(i) + ',' + y(v);
        pen = true;
      });
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      const last = s.values.map((v, i) => [v, i]).filter(p => p[0] != null).pop();
      if (last && s.directLabel) {
        el('text', { x: Math.min(cx(last[1]) + 6, W - PAD.r), y: y(last[0]) - 8, 'text-anchor': 'end', class: 'label-direct' }, svg)
          .textContent = fmtNum(last[0], cfg.decimals || 0) + (cfg.unit || '');
      }
    });
    cfg.series.filter(s => s.kind === 'dot').forEach(s => {
      const r = n > 90 ? 3 : 4;
      s.values.forEach((v, i) => {
        if (v == null) return;
        el('circle', { cx: cx(i), cy: y(v), r, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
      });
    });

    // 凡例（2系列以上のときだけ）
    if (cfg.series.length >= 2) {
      const lg = document.createElement('div');
      lg.className = 'chart-legend';
      lg.innerHTML = cfg.series.map(s =>
        `<span><i class="${s.kind === 'line' ? 'line' : ''}" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') +
        (cfg.ref ? `<span><i class="ref"></i>${esc(cfg.ref.label)}</span>` : '');
      host.after(lg);
      host._legend = lg;
    }

    // ホバー：縦の補助線＋その日の値
    const cross = el('line', { y1: PAD.t, y2: PAD.t + plotH, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.appendChild(tip);
    const hit = el('rect', { x: PAD.l, y: 0, width: plotW, height: H, fill: 'transparent' }, svg);
    const move = e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (W / rect.width);
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - PAD.l) / slot)));
      cross.setAttribute('x1', cx(i));
      cross.setAttribute('x2', cx(i));
      cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>${esc(cfg.fullLabels ? cfg.fullLabels[i] : cfg.labels[i])}</b>` + cfg.series.map(s => {
        const v = s.values[i];
        return `<div class="row"><i style="background:${s.color}"></i>${esc(s.name)}：${v == null ? '記録なし' : fmtNum(v, cfg.decimals || 0) + (cfg.unit || '')}</div>`;
      }).join('');
      tip.hidden = false;
      const left = cx(i) * (rect.width / W);
      const tw = tip.offsetWidth;
      tip.style.left = (left + 12 + tw > rect.width ? Math.max(0, left - tw - 12) : left + 12) + 'px';
      tip.style.top = '4px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  }

  // 表で見る（色に頼らずに数値を確認できるように）
  function table(host, cfg) {
    const d = document.createElement('details');
    d.className = 'chart-table';
    d.innerHTML = '<summary>表で見る</summary>';
    d.addEventListener('toggle', () => {
      if (!d.open || d.querySelector('table')) return;
      const rows = cfg.labels.map((l, i) => `<tr><td>${esc(cfg.fullLabels ? cfg.fullLabels[i] : l)}</td>` +
        cfg.series.map(s => `<td>${s.values[i] == null ? '—' : fmtNum(s.values[i], cfg.decimals || 0)}</td>`).join('') + '</tr>').reverse();
      d.insertAdjacentHTML('beforeend', `<div class="scroll"><table><thead><tr><th>日付</th>${cfg.series.map(s =>
        `<th>${esc(s.name)}${cfg.unit ? '(' + esc(cfg.unit) + ')' : ''}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
    });
    (host._legend || host).after(d);
    host._table = d;
  }

  function draw(host, cfg) {
    if (host._legend) { host._legend.remove(); host._legend = null; }
    if (host._table) { host._table.remove(); host._table = null; }
    render(host, cfg);
    table(host, cfg);
  }

  return { draw, fmtNum };
})();

/* ---------- データの取得と画面の組み立て ---------- */

async function loadAnalysis() {
  const status = $('#dashStatus');
  // 先週比などのタイル用に、最低14日分は取得しておく
  const need = dash.days === 0 ? 0 : Math.max(dash.days, 14);
  const covered = dash.data && (dash.fetchedDays === 0 || (need !== 0 && dash.fetchedDays >= need));
  if (!covered) {
    status.textContent = '読み込み中…';
    try {
      dash.data = await api('getDashboard', { days: need }, 60000);
      dash.fetchedDays = need;
    } catch (e) {
      status.textContent = e.network ? 'オフラインのため表示できません' : e.message;
      return;
    }
  }
  renderAnalysis();
}

function renderAnalysis() {
  const d = dash.data;
  if (!d) return;
  const all = d.daily;
  const daily = dash.days ? all.slice(-dash.days) : all;
  const start = daily.length ? daily[0].date : d.today;
  const t = d.targets;

  const sync = d.lastSync ? d.lastSync.slice(5, 16).replace('-', '/').replace('T', ' ') : '記録なし';
  $('#dashStatus').textContent = `ヘルスケアの最終同期：${sync} ・ 基礎代謝（推定）：` +
    (d.bmr ? d.bmr.toLocaleString() + 'kcal' : '設定でプロフィールを入力すると計算します');

  renderTiles(all, d);

  const dow = '日月火水木金土';
  const md = s => { const [, m, dd] = s.split('-').map(Number); return `${m}/${dd}`; };
  const full = s => md(s) + '（' + dow[new Date(s + 'T00:00:00').getDay()] + '）' + (s === d.today ? ' 途中' : '');
  const labels = daily.map(x => md(x.date));
  const fullLabels = daily.map(x => full(x.date));
  const nz = v => (v ? v : null);
  const ma7 = key => all.map((x, i) => {
    const w = all.slice(Math.max(0, i - 6), i + 1).map(y => y[key]).filter(v => v > 0);
    return w.length ? Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10 : null;
  }).slice(all.length - daily.length);
  const S1 = 'var(--series-1)';
  const S2 = 'var(--series-2)';
  const ref = (v, label) => (v ? { value: v, label } : null);

  MiniChart.draw($('#chartWeight'), {
    title: '体重', labels, fullLabels, unit: 'kg', decimals: 1, emptyText: '体重の記録なし（体重計の連携後に表示）',
    ref: ref(t.goalWeight, '目標 ' + t.goalWeight + 'kg'),
    series: [
      { name: 'その日の体重', kind: 'dot', color: 'var(--ink-muted)', values: daily.map(x => nz(x.weightKg)) },
      { name: '7日平均', kind: 'line', color: S1, values: ma7('weightKg'), directLabel: true },
    ],
  });

  MiniChart.draw($('#chartKcal'), {
    title: 'カロリー収支', labels, fullLabels, unit: 'kcal', zero: true,
    ref: ref(t.kcal, '摂取目標 ' + t.kcal),
    series: [
      { name: '摂取', kind: 'bar', color: S1, values: daily.map(x => (x.mealCount ? x.intakeKcal : null)) },
      { name: '推定消費', kind: 'bar', color: S2, values: daily.map(x => nz(x.burnKcal)) },
    ],
  });

  const weeks = weeklyKm(daily);
  MiniChart.draw($('#chartWeekKm'), {
    title: '週の距離', labels: weeks.map(w => md(w.monday) + '〜'), fullLabels: weeks.map(w => md(w.monday) + '〜の週' + (w.current ? '（今週）' : '')),
    unit: 'km', decimals: 1, zero: true, ref: ref(t.weeklyKm, '目標 ' + t.weeklyKm + 'km'),
    series: [{ name: '距離', kind: 'bar', color: S1, values: weeks.map(w => (w.km ? Math.round(w.km * 10) / 10 : null)) }],
  });

  MiniChart.draw($('#chartSteps'), {
    title: '歩数', labels, fullLabels, unit: '歩', zero: true,
    series: [{ name: '歩数', kind: 'bar', color: S1, values: daily.map(x => nz(x.steps)) }],
  });

  [['chartP', 'protein', t.protein, 'タンパク質'], ['chartF', 'fat', t.fat, '脂質'], ['chartC', 'carb', t.carb, '炭水化物']].forEach(([id, key, target, name]) => {
    MiniChart.draw($('#' + id), {
      title: name, labels, fullLabels, unit: 'g', zero: true, ref: ref(target, '目標 ' + target + 'g'),
      series: [{ name, kind: 'bar', color: S1, values: daily.map(x => (x.mealCount ? x[key] : null)) }],
    });
  });

  MiniChart.draw($('#chartFat'), {
    title: '体脂肪率', labels, fullLabels, unit: '%', decimals: 1, emptyText: '体脂肪率の記録なし（体重計の連携後に表示）',
    series: [
      { name: 'その日の体脂肪率', kind: 'dot', color: 'var(--ink-muted)', values: daily.map(x => nz(x.bodyFatPct)) },
      { name: '7日平均', kind: 'line', color: S1, values: ma7('bodyFatPct'), directLabel: true },
    ],
  });

  const meals = d.meals.filter(m => m.date >= start);
  $('#gallery').innerHTML = meals.length ? meals.map(m => `<figure>
      ${m.thumb ? `<img src="${m.thumb}" alt="${esc(m.dishes.join('、'))}" loading="lazy">` : '<div class="noimg">🍽</div>'}
      <figcaption><strong>${md(m.date)} ${esc(m.time)} ${m.kcal}kcal</strong><br>${esc(m.dishes.join('、'))}</figcaption>
    </figure>`).join('') : '<p class="empty">この期間の食事の記録はありません</p>';

  const label = { morning: '朝のまとめ', night: '夜のまとめ', weekly: '週報' };
  $('#reports').innerHTML = d.reports.length ? d.reports.map((r, i) => `<details ${i === 0 ? 'open' : ''}>
      <summary>${md(r.date)} ${esc(label[r.type] || r.type)}</summary><pre>${esc(r.text)}</pre></details>`).join('')
    : '<p class="empty">まだレポートはありません</p>';
}

function weeklyKm(daily) {
  const weeks = [];
  daily.forEach(x => {
    const dt = new Date(x.date + 'T00:00:00');
    const monday = localDate(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7)));
    let w = weeks[weeks.length - 1];
    if (!w || w.monday !== monday) weeks.push(w = { monday, km: 0, current: false });
    w.km += x.distanceKm || 0;
  });
  if (weeks.length) weeks[weeks.length - 1].current = true;
  return weeks;
}

function renderTiles(all, d) {
  const t = d.targets;
  const past = all.filter(x => x.date < d.today); // 今日は途中なので平均から外す
  const last7 = past.slice(-7);
  const prev7 = past.slice(-14, -7);
  const avg = (rows, key) => {
    const v = rows.map(r => r[key]).filter(x => x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const latestW = all.filter(x => x.weightKg > 0).pop();
  const wNow = avg(all.slice(-7), 'weightKg');
  const wPrev = avg(all.slice(-14, -7), 'weightKg');
  const weeks = weeklyKm(all);
  const thisWeek = weeks.length ? weeks[weeks.length - 1].km : 0;
  const lastWeek = weeks.length > 1 ? weeks[weeks.length - 2].km : 0;
  const intake = avg(last7.filter(x => x.mealCount), 'intakeKcal');
  const steps = avg(last7, 'steps');
  const raceDays = t.raceDate ? Math.ceil((new Date(t.raceDate + 'T00:00:00') - new Date(d.today + 'T00:00:00')) / 86400000) : null;
  const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);

  const tiles = [
    ['体重', latestW ? `${latestW.weightKg.toFixed(1)}<small>kg</small>` : '記録なし',
      wNow ? `7日平均 ${wNow.toFixed(1)}kg` + (wPrev ? `（先週比 ${sign(wNow - wPrev)}）` : '') : '体重計の連携後に表示'],
    ['今週の距離', `${thisWeek.toFixed(1)}<small>km</small>`,
      `先週 ${lastWeek.toFixed(1)}km` + (t.weeklyKm ? ` ・ 目標 ${t.weeklyKm}km` : '')],
    ['平均摂取（7日）', intake ? `${Math.round(intake).toLocaleString()}<small>kcal</small>` : '記録なし',
      t.kcal ? `目標 ${t.kcal.toLocaleString()}kcal` : '目標は設定タブで入力'],
    ['平均歩数（7日）', steps ? `${Math.round(steps).toLocaleString()}<small>歩</small>` : '記録なし', '今日を除く直近7日'],
    ['レースまで', raceDays != null ? `${raceDays}<small>日</small>` : '未設定',
      t.raceDate ? `${t.raceDate}${t.raceGoalTime ? ' ・ 目標 ' + t.raceGoalTime : ''}` : 'レース日は設定タブで入力'],
  ];
  $('#tiles').innerHTML = tiles.map(([label, value, sub]) =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`).join('');
}

/* ---------- 操作 ---------- */

document.querySelectorAll('.range button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.range button').forEach(x => x.classList.toggle('active', x === b));
  dash.days = Number(b.dataset.days);
  loadAnalysis();
}));

// 画面幅が変わったら描き直す
let dashResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(dashResizeTimer);
  dashResizeTimer = setTimeout(() => { if (!$('#view-analysis').hidden) renderAnalysis(); }, 200);
});
