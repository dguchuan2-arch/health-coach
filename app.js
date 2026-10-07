'use strict';

/* ================= 設定・状態 ================= */

const CFG = { url: 'hc_api_url', key: 'hc_api_key' };
const $ = (s, el = document) => el.querySelector(s);

const state = {
  date: localDate(new Date()),
  meals: [],
  totals: null,
  targets: {},
  processing: false,
  sendingId: null,
  queueErrors: {},
};

// 設定画面の項目（キーは Apps Script の Settings シートと一致させる）
const SETTING_GROUPS = [
  { title: 'レース目標', fields: [
    { key: 'race_date', label: 'レース日', type: 'date' },
    { key: 'race_goal_time', label: '目標タイム', type: 'text', placeholder: '2:15:00' },
  ]},
  { title: '体重目標', fields: [
    { key: 'goal_weight', label: '目標体重', type: 'number', unit: 'kg', step: '0.1' },
    { key: 'goal_weight_date', label: '期限', type: 'date' },
  ]},
  { title: '1日の栄養目標', fields: [
    { key: 'kcal_target', label: '摂取カロリー', type: 'number', unit: 'kcal' },
    { key: 'protein_target', label: 'タンパク質 (P)', type: 'number', unit: 'g' },
    { key: 'fat_target', label: '脂質 (F)', type: 'number', unit: 'g' },
    { key: 'carb_target', label: '炭水化物 (C)', type: 'number', unit: 'g' },
  ]},
  { title: '練習', fields: [
    { key: 'runs_per_week', label: '週の練習回数', type: 'number', unit: '回' },
    { key: 'weekly_km_target', label: '週の走行距離目標', type: 'number', unit: 'km', step: '0.1' },
  ]},
  { title: 'プロフィール（消費カロリーの推定に使用）', fields: [
    { key: 'height_cm', label: '身長', type: 'number', unit: 'cm', step: '0.1' },
    { key: 'birth_year', label: '生まれ年', type: 'number', placeholder: '1990' },
    { key: 'sex', label: '性別', type: 'select', options: [['', '未設定'], ['male', '男性'], ['female', '女性']] },
  ]},
  { title: '通知', fields: [
    { key: 'night_summary_time', label: '夜のまとめ', type: 'time' },
    { key: 'morning_fallback_time', label: '朝のまとめ（最終送信）', type: 'time' },
  ]},
  { title: 'AI', fields: [
    { key: 'coach_tone', label: '口調', type: 'select', options: [['strict', '厳しめのコーチ'], ['neutral', '中立'], ['gentle', '穏やか']] },
    { key: 'model_meal', label: '食事解析モデル (Gemini)', type: 'text' },
    { key: 'model_daily', label: '朝夜まとめモデル', type: 'text' },
    { key: 'model_weekly', label: '週報モデル', type: 'text' },
  ]},
];

/* ================= ユーティリティ ================= */

function localDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function getCfg() {
  try {
    return { url: localStorage.getItem(CFG.url) || '', key: localStorage.getItem(CFG.key) || '' };
  } catch {
    return { url: '', key: '' };
  }
}

function setCfg(url, key) {
  try {
    localStorage.setItem(CFG.url, url);
    localStorage.setItem(CFG.key, key);
    return true;
  } catch {
    return false;
  }
}

/* ================= API ================= */

async function api(action, data = {}, timeoutMs = 60000, cfg = getCfg()) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    // text/plain にすると CORS のプリフライトが発生せず Apps Script に直接届く
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: cfg.key, action, ...data }),
      signal: ctrl.signal,
    });
  } catch {
    const err = new Error('通信できませんでした');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Apps Script が JSON ではなくエラーページを返した場合は、その見出しを表示して原因を追えるようにする
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1]
      || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error(`サーバーの応答を読めませんでした（${action}: ${title || 'HTTP ' + res.status}）`);
  }
  if (!json.ok) throw new Error(json.error === 'unauthorized' ? '合言葉が違います' : json.error);
  return json;
}

/* ================= 未送信キュー（IndexedDB） ================= */

const queue = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('health-coach', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', mode);
      const req = fn(tx.objectStore('queue'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    all: async () => ((await run('readonly', s => s.getAll())) || []).sort((a, b) => a.queuedAt - b.queuedAt),
    put: item => run('readwrite', s => s.put(item)),
    del: id => run('readwrite', s => s.delete(id)),
  };
})();

/* ================= 画像処理 ================= */

// JPEG の EXIF から撮影日時（DateTimeOriginal）を読む。読めなければ null
async function readExifDate(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) return null;
      const len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiffDate(v, off + 10);
      off += 2 + len;
    }
  } catch { /* 読めない形式は無視 */ }
  return null;
}

function parseTiffDate(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = o => v.getUint16(start + o, le);
  const u32 = o => v.getUint32(start + o, le);
  const findTag = (ifd, tag) => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === tag) return e;
    }
    return -1;
  };
  const exifPtr = findTag(u32(4), 0x8769);
  if (exifPtr < 0) return null;
  const dt = findTag(u32(exifPtr + 8), 0x9003);
  if (dt < 0) return null;
  const valOff = u32(dt + 8);
  let s = '';
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(start + valOff + i));
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function toJpeg(img, maxSide, quality) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/* ================= 撮影 → キュー → 送信 ================= */

async function handleFiles(files, source) {
  if (!files || !files.length) return;
  for (const file of files) {
    try {
      const exifDate = await readExifDate(file);
      const takenAt = exifDate || (source === 'album' && file.lastModified ? new Date(file.lastModified) : new Date());
      const img = await loadImage(file);
      const image = toJpeg(img, 1280, 0.8).split(',')[1];
      let thumb = toJpeg(img, 320, 0.6);
      if (thumb.length > 45000) thumb = toJpeg(img, 220, 0.5);
      await queue.put({
        id: uuid(),
        takenAt: takenAt.toISOString(),
        source,
        memo: '',
        image,
        thumb,
        queuedAt: Date.now(),
      });
      // 撮った日の画面に移動しておく
      state.date = localDate(takenAt);
    } catch (e) {
      toast('画像を読み込めませんでした: ' + e.message, 4000);
    }
  }
  await renderToday();
  processQueue();
}

async function processQueue() {
  if (state.processing || !getCfg().url) return;
  state.processing = true;
  try {
    for (const item of await queue.all()) {
      state.sendingId = item.id;
      renderMealList(await queue.all());
      try {
        const r = await api('uploadMeal', {
          id: item.id,
          takenAt: item.takenAt,
          source: item.source,
          memo: item.memo,
          imageBase64: item.image,
          mime: 'image/jpeg',
          thumb: item.thumb,
        }, 120000);
        await queue.del(item.id);
        delete state.queueErrors[item.id];
        if (r.meal && r.meal.date === state.date) {
          upsertMeal(r.meal);
          state.totals = r.totals;
        }
      } catch (e) {
        if (e.network) {
          // 圏外など。次に開いたとき・電波が戻ったときに再送する
          state.queueErrors[item.id] = '圏外のため未送信（電波が戻ると自動で送信）';
          break;
        }
        state.queueErrors[item.id] = e.message;
      }
    }
  } finally {
    state.sendingId = null;
    state.processing = false;
    await renderToday();
  }
}

function upsertMeal(meal) {
  const i = state.meals.findIndex(m => m.id === meal.id);
  if (i >= 0) state.meals[i] = meal;
  else state.meals.push(meal);
  state.meals.sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
}

/* ================= 今日の画面 ================= */

async function loadDay() {
  try {
    const r = await api('listMeals', { date: state.date });
    state.meals = r.meals;
    state.totals = r.totals;
    state.targets = r.targets || {};
  } catch (e) {
    if (!e.network) toast(e.message, 4000);
  }
  await renderToday();
}

async function renderToday() {
  const today = localDate(new Date());
  const [, m, d] = state.date.split('-').map(Number);
  const dow = '日月火水木金土'[new Date(state.date + 'T00:00:00').getDay()];
  $('#dayLabel').textContent = `${m}/${d}（${dow}）${state.date === today ? ' 今日' : ''}`;
  $('#nextDay').disabled = state.date >= today;
  renderTotals();
  const pending = await queue.all();
  renderMealList(pending);
  const badge = $('#queueBadge');
  badge.hidden = pending.length === 0;
  badge.textContent = `未送信 ${pending.length}`;
}

function renderTotals() {
  const t = state.totals || { kcal: 0, protein: 0, fat: 0, carb: 0, count: 0 };
  const g = state.targets || {};
  const rows = [
    ['カロリー', t.kcal, g.kcal, 'kcal'],
    ['P', t.protein, g.protein, 'g'],
    ['F', t.fat, g.fat, 'g'],
    ['C', t.carb, g.carb, 'g'],
  ].map(([label, val, target, unit]) => {
    const pct = target ? Math.min(100, (val / target) * 100) : 0;
    const over = target && val > target;
    return `<div class="row"><span>${label}</span>
      <span class="bar">${target ? `<i class="${over ? 'over' : ''}" style="width:${pct}%"></i>` : ''}</span>
      <span class="val">${val}${target ? ` / ${target}` : ''} ${unit}</span></div>`;
  }).join('');
  const note = g.kcal ? '' : '<p class="note">目標は「設定」タブで入力すると、残り枠が表示されます。</p>';
  $('#totals').innerHTML = `<h2>合計（${t.count}食）</h2>${rows}${note}`;
}

function renderMealList(pending = []) {
  const pend = pending.filter(p => localDate(new Date(p.takenAt)) === state.date);
  const html = [
    ...pend.map(pendingCard),
    ...state.meals.map(mealCard),
  ].join('');
  $('#mealList').innerHTML = html || '<p class="empty">まだ記録がありません</p>';
}

function timeOf(iso) {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pendingCard(p) {
  const sending = state.sendingId === p.id;
  const err = state.queueErrors[p.id];
  return `<article class="card meal">
    <img class="thumb" src="${p.thumb}" alt="">
    <div>
      <div class="head"><strong>${timeOf(p.takenAt)}</strong>
        <span class="chip ${err ? 'warn' : ''}">${sending ? '送信・解析中…' : (err ? '未送信' : '送信待ち')}</span></div>
      ${err ? `<p class="memo">${esc(err)}</p>` : '<p class="memo">AIが解析しています。10〜20秒ほどかかります。</p>'}
    </div>
    ${!sending ? `<div class="actions"><button class="btn small" data-act="retry">今すぐ再送</button>
      <button class="btn small danger" data-act="discard" data-id="${p.id}">取り消し</button></div>` : ''}
  </article>`;
}

function mealCard(m) {
  const thumb = m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : '<div class="thumb">🍽</div>';
  let body;
  if (m.status === 'done') {
    body = `<div class="kcal">${m.kcal}<small> kcal</small></div>
      <div class="pfc">P ${m.protein}g ・ F ${m.fat}g ・ C ${m.carb}g${m.confidence ? ` ・ 確度 ${esc(m.confidence)}` : ''}</div>
      <ul>${(m.dishes || []).map(d => `<li>${esc(d.name)}${d.amount ? `（${esc(d.amount)}）` : ''} ${Math.round(d.kcal || 0)}kcal</li>`).join('')}</ul>`;
  } else if (m.status === 'not_food') {
    body = '<p class="memo">食事として認識されませんでした。</p>';
  } else if (m.status === 'analysis_failed') {
    body = `<p class="memo">解析に失敗しました：${esc(m.error)}</p>`;
  } else {
    body = '<p class="memo">解析中…</p>';
  }
  return `<article class="card meal" data-id="${esc(m.id)}">
    ${thumb}
    <div>
      <div class="head"><strong>${esc(m.time)} ${esc(m.mealType)}</strong>
        ${m.labelUsed ? '<span class="chip">成分表示</span>' : ''}
        ${m.source === 'shortcut' ? '<span class="chip">クイック撮影</span>' : ''}</div>
      ${body}
      ${m.memo ? `<p class="memo">補足：${esc(m.memo)}</p>` : ''}
    </div>
    ${m.comment ? `<p class="comment">${esc(m.comment)}</p>` : ''}
    <div class="actions">
      <button class="btn small" data-act="reanalyze" data-id="${esc(m.id)}">補足して再解析</button>
      <button class="btn small danger" data-act="delete" data-id="${esc(m.id)}">削除</button>
    </div>
  </article>`;
}

async function onMealAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  if (act === 'retry') {
    state.queueErrors = {};
    processQueue();
    return;
  }
  if (act === 'discard') {
    if (!confirm('この写真の送信を取り消しますか？')) return;
    await queue.del(id);
    await renderToday();
    return;
  }

  const meal = state.meals.find(m => m.id === id);
  if (!meal) return;

  if (act === 'reanalyze') {
    const memo = prompt('補足を入力（例：ご飯大盛り、半分残した、ドレッシングなし）', meal.memo || '');
    if (memo === null) return;
    btn.disabled = true;
    btn.textContent = '再解析中…';
    try {
      const r = await api('reanalyzeMeal', { id, memo }, 120000);
      upsertMeal(r.meal);
      state.totals = r.totals;
      toast('再解析しました');
    } catch (err) {
      toast(err.message, 4000);
    }
    await renderToday();
  }

  if (act === 'delete') {
    if (!confirm('この記録を削除しますか？（写真はGoogle Driveに残ります）')) return;
    try {
      const r = await api('deleteMeal', { id });
      state.meals = state.meals.filter(m => m.id !== id);
      state.totals = r.totals;
    } catch (err) {
      toast(err.message, 4000);
    }
    await renderToday();
  }
}

/* ================= 設定画面 ================= */

async function loadSettings() {
  const form = $('#settingsForm');
  form.innerHTML = '<p class="muted">読み込み中…</p>';
  $('#connInfo').textContent = getCfg().url;
  let s;
  try {
    s = (await api('getSettings')).settings;
  } catch (e) {
    form.innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
    return;
  }
  form.innerHTML = SETTING_GROUPS.map(g => `<fieldset><legend>${esc(g.title)}</legend><div class="grid">
    ${g.fields.map(f => fieldHtml(f, s[f.key] ?? '')).join('')}</div></fieldset>`).join('') +
    '<div class="save"><button class="btn primary wide" type="submit">保存</button></div>';
}

function fieldHtml(f, value) {
  const label = `${esc(f.label)}${f.unit ? ` <span class="unit">(${esc(f.unit)})</span>` : ''}`;
  if (f.type === 'select') {
    return `<label class="field"><span>${label}</span><select name="${f.key}">
      ${f.options.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}
    </select></label>`;
  }
  const extra = [
    f.step ? `step="${f.step}"` : '',
    f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '',
    f.type === 'number' ? 'inputmode="decimal"' : '',
  ].join(' ');
  return `<label class="field"><span>${label}</span>
    <input name="${f.key}" type="${f.type}" value="${esc(value)}" ${extra}></label>`;
}

async function saveSettings(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const values = Object.fromEntries(new FormData(e.target).entries());
    await api('saveSettings', { values });
    toast('保存しました');
    loadDay();
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

/* ================= 接続設定 ================= */

async function saveConnection() {
  const url = $('#cfgUrl').value.trim();
  const key = $('#cfgKey').value.trim();
  const msg = $('#cfgMsg');
  msg.className = 'msg';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    msg.className = 'msg err';
    msg.textContent = 'URLは https://script.google.com/macros/s/…/exec の形式です';
    return;
  }
  msg.textContent = '接続テスト中…';
  try {
    await api('ping', {}, 30000, { url, key });
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '接続できませんでした：' + e.message;
    return;
  }
  if (!setCfg(url, key)) {
    msg.className = 'msg err';
    msg.textContent = 'この端末に保存できませんでした（プライベートブラウズでは保存できません）';
    return;
  }
  msg.textContent = '';
  start();
}

/* ================= 画面切り替え・起動 ================= */

function showTab(name) {
  ['today', 'analysis', 'settings'].forEach(t => { $(`#view-${t}`).hidden = t !== name; });
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'settings') loadSettings();
  if (name === 'today') loadDay();
  window.scrollTo(0, 0);
}

function start() {
  const hasCfg = !!getCfg().url;
  $('#view-connect').hidden = hasCfg;
  $('#tabbar').hidden = !hasCfg;
  if (!hasCfg) {
    ['today', 'analysis', 'settings'].forEach(t => { $(`#view-${t}`).hidden = true; });
    return;
  }
  showTab('today');
  processQueue();
}

function bind() {
  $('#camInput').addEventListener('change', e => { handleFiles([...e.target.files], 'camera'); e.target.value = ''; });
  $('#albumInput').addEventListener('change', e => { handleFiles([...e.target.files], 'album'); e.target.value = ''; });
  $('#prevDay').addEventListener('click', () => { state.date = shiftDate(state.date, -1); loadDay(); });
  $('#nextDay').addEventListener('click', () => { state.date = shiftDate(state.date, 1); loadDay(); });
  $('#mealList').addEventListener('click', onMealAction);
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#cfgSave').addEventListener('click', saveConnection);
  $('#reconnect').addEventListener('click', () => {
    const c = getCfg();
    $('#cfgUrl').value = c.url;
    $('#cfgKey').value = '';
    $('#view-connect').hidden = false;
    $('#view-settings').hidden = true;
    $('#tabbar').hidden = true;
  });
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  window.addEventListener('online', processQueue);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getCfg().url) {
      // 日付が変わっていたら今日に戻す
      if (!$('#view-today').hidden) loadDay();
      processQueue();
    }
  });
}

bind();
start();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
