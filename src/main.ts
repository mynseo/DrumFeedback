import './style.css';
import { TempoEngine, type TempoState } from './engine';
import { openMic, type Mic } from './mic';
import { Session, type Report, type TempoSample } from './session';
import { FEELS, type Feel } from './tracker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const statusEl = $('status');
const eyebrowEl = $('eyebrow');
const bpmEl = $('bpm');
const deltaEl = $('delta');
const levelEl = $('level');
const toggle = $<HTMLButtonElement>('toggle');
const toggleLabel = $('toggle-label');
const half = $<HTMLButtonElement>('half');
const double = $<HTMLButtonElement>('double');
const targetEl = $<HTMLInputElement>('target');
const feelEl = $<HTMLSelectElement>('feel');
const moreEl = $('more');
const canvas = $<HTMLCanvasElement>('graph');
const dock = document.querySelector<HTMLElement>('.dock')!;
const reportEl = $('report');

/** 실시간 그래프에서 맨 위까지 보이는 길이(초) */
const LIVE_SPAN = 40;
/** 기준에서 이만큼(비율) 안이면 잘 맞는 것으로 본다 */
const ON_TEMPO = 0.01;

const session = new Session();
let mic: Mic | null = null;
let engine: TempoEngine | null = null;
let target: number | null = null;
let feel: Feel | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
/** 지금 연주의 기준 템포 (목표가 없을 때 처음 4초에서 잡는다) */
let baseline: number | null = null;
let report: Report | null = null;
/** 마지막 타격 시각(performance.now). 선의 머리에서 번지는 고리를 그린다 */
let hitAt = -Infinity;
/** 그래프 가로 폭이 나타내는 범위(기준 대비 비율). 값이 벗어나면 천천히 넓어진다 */
let range = 0.08;

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

toggle.addEventListener('click', () => void (mic ? stop() : start()));
half.addEventListener('click', () => rescale(0.5));
double.addEventListener('click', () => rescale(2));
// 고른 리듬은 다음에 열 때도 그대로 (저장이 안 되는 브라우저면 그냥 자동)
try {
  const saved = localStorage.getItem('feel');
  if (saved && saved in FEELS) {
    feel = saved as Feel;
    feelEl.value = saved;
  }
} catch {
  /* 저장소를 못 쓰면 자동 */
}
feelEl.addEventListener('change', () => {
  feel = feelEl.value in FEELS ? (feelEl.value as Feel) : null;
  engine?.setFeel(feel);
  try {
    if (feel) localStorage.setItem('feel', feel);
    else localStorage.removeItem('feel');
  } catch {
    /* 저장 못 해도 이번에는 쓴다 */
  }
});
targetEl.addEventListener('change', () => {
  const v = Number(targetEl.value);
  target = v >= 30 && v <= 300 ? v : null;
  if (!target) targetEl.value = '';
  engine?.setTarget(target);
  if (!mic && session.samples.length) showReport();
});
window.addEventListener('resize', () => draw());
document.addEventListener('visibilitychange', () => {
  if (mic && document.visibilityState === 'visible') void keepAwake();
});

async function start() {
  toggle.disabled = true;
  statusEl.textContent = '마이크를 켜는 중';
  try {
    mic = await openMic(onSamples);
  } catch (e) {
    const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    const missing = e instanceof DOMException && e.name === 'NotFoundError';
    statusEl.textContent = '마이크 꺼짐';
    deltaEl.textContent = denied
      ? '브라우저에서 마이크 권한을 허용해 주세요'
      : missing
        ? '마이크를 찾지 못했어요'
        : e instanceof Error && !(e instanceof DOMException)
          ? e.message
          : '마이크를 켜지 못했어요';
    delete deltaEl.dataset.kind;
    toggle.disabled = false;
    return;
  }
  engine = new TempoEngine(mic.sampleRate);
  engine.setTarget(target);
  engine.setFeel(feel);
  session.clear();
  baseline = null;
  report = null;
  range = 0.08;
  reportEl.hidden = true;
  moreEl.hidden = true;
  eyebrowEl.textContent = 'BPM';
  stage.classList.add('running');
  toggleLabel.textContent = '마침';
  toggle.setAttribute('aria-label', '측정 마치고 결과 보기');
  toggle.disabled = false;
  window.scrollTo({ top: 0 });
  void keepAwake();
  requestAnimationFrame(frame);
}

function stop() {
  mic?.stop();
  mic = null;
  engine = null;
  void wakeLock?.release();
  wakeLock = null;
  stage.classList.remove('running');
  toggleLabel.textContent = '다시';
  toggle.setAttribute('aria-label', '다시 측정');
  half.disabled = double.disabled = true;
  levelEl.style.width = '0';
  showReport();
}

async function keepAwake() {
  // 연습하는 동안 화면이 꺼지지 않게 (지원하는 브라우저에서만)
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

function onSamples(samples: Float32Array) {
  if (!engine) return;
  if (engine.push(samples).length) hitAt = performance.now();
  const s = engine.state();
  if (s.phase === 'locked' && s.bpm !== null) {
    const before = session.samples.length;
    session.add(s.time, s.bpm);
    if (session.samples.length !== before) updateBaseline();
  }
}

function updateBaseline() {
  if (target) {
    baseline = target;
    return;
  }
  const groups = session.groups();
  const take = groups[groups.length - 1];
  const start = take[0].t;
  if (take[take.length - 1].t - start < 4) {
    baseline = null;
    return;
  }
  const first = take.filter((x) => x.t - start <= 4).map((x) => x.bpm).sort((a, b) => a - b);
  baseline = first[first.length >> 1];
}

function rescale(factor: number) {
  if (!engine) return;
  const done = engine.scale(factor);
  if (done === 1) return;
  session.scale(done);
  if (session.samples.length) updateBaseline();
}

function frame() {
  if (!engine) return;
  const s = engine.state();
  renderMeter(s);
  draw(s);
  requestAnimationFrame(frame);
}

/** 큰 숫자: 정수는 크게, 소수 첫째 자리는 작게 */
function setNumber(bpm: number | null) {
  bpmEl.classList.toggle('empty', bpm === null);
  if (bpm === null) {
    bpmEl.textContent = '—';
    return;
  }
  const [whole, frac] = bpm.toFixed(1).split('.');
  const small = document.createElement('small');
  small.textContent = `.${frac}`;
  bpmEl.replaceChildren(whole, small);
}

function renderMeter(s: TempoState) {
  stage.dataset.phase = s.phase;
  const shown = s.bpm !== null && (s.phase === 'locked' || s.phase === 'hold');
  setNumber(shown ? s.bpm : null);
  half.disabled = double.disabled = !shown;
  levelEl.style.width = `${Math.min(100, Math.sqrt(engine!.level) * 100)}%`;
  statusEl.textContent = s.phase === 'locked' ? '듣는 중' : s.phase === 'hold' ? '잠깐 놓침' : s.phase === 'searching' ? '측정 중' : '기다리는 중';

  delete deltaEl.dataset.kind;
  if (!shown) {
    deltaEl.textContent = s.phase === 'searching' ? '박을 찾고 있어요' : '드럼을 쳐 보세요';
  } else if (baseline === null) {
    deltaEl.textContent = '기준 템포를 잡는 중';
  } else {
    const off = s.bpm! - baseline;
    const kind = Math.abs(off) <= baseline * ON_TEMPO ? 'ok' : off > 0 ? 'fast' : 'slow';
    deltaEl.dataset.kind = kind;
    const word = kind === 'ok' ? '잘 맞아요' : kind === 'fast' ? `${signed(off)} 빨라요` : `${signed(off)} 느려요`;
    deltaEl.textContent = `${target ? '목표' : '기준'} ${baseline.toFixed(target ? 0 : 1)} · ${word}`;
  }
}

function showReport() {
  report = session.report(target);
  stage.dataset.phase = report ? 'locked' : 'off';
  statusEl.textContent = '마침';
  delete deltaEl.dataset.kind;
  const tiles = $('tiles');
  const takes = $('takes');
  tiles.replaceChildren();
  takes.replaceChildren();
  if (!report) {
    eyebrowEl.textContent = 'BPM';
    setNumber(null);
    deltaEl.textContent = '빠르기를 5초 넘게 재지 못했어요. 조금 더 길게 쳐 보세요';
    reportEl.hidden = true;
    moreEl.hidden = true;
    draw();
    return;
  }
  eyebrowEl.textContent = '평균 BPM';
  setNumber(report.mean);
  deltaEl.textContent = `안정성 ${report.score}점 · 흔들림 ±${report.wobblePct.toFixed(1)}%`;
  reportEl.hidden = false;
  moreEl.hidden = false;

  $('report-time').textContent = `잰 시간 ${clock(report.measured)}`;
  const tile = (value: string, label: string) => {
    const d = el('div', 'tile');
    d.append(el('b', '', value), el('span', '', label));
    tiles.append(d);
  };
  tile(report.mean.toFixed(1), '평균 BPM');
  tile(`${report.min.toFixed(0)}–${report.max.toFixed(0)}`, '가장 느릴 때–빠를 때');
  tile(`±${report.wobblePct.toFixed(1)}%`, '빠르기 흔들림');
  tile(`${report.score}`, '안정성 점수');

  report.takes.forEach((take, i) => {
    const box = el('div', 'take');
    const title = report!.takes.length > 1 ? `연주 ${i + 1} · ` : '';
    box.append(el('h3', '', `${title}${clock(take.start)}–${clock(take.end)} · 평균 ${take.mean.toFixed(1)} BPM`));
    const drift = take.endBpm - take.startBpm;
    const trend =
      Math.abs(drift) < take.startBpm * ON_TEMPO
        ? '처음과 끝의 빠르기가 거의 같아요'
        : `끝으로 갈수록 ${Math.abs(drift).toFixed(1)} BPM ${drift > 0 ? '빨라졌어요' : '느려졌어요'}`;
    box.append(el('p', '', `처음 ${take.startBpm.toFixed(1)} → 끝 ${take.endBpm.toFixed(1)} · ${trend}`));
    const ref = `${target ? '목표' : '기준'} ${take.baseline.toFixed(1)} BPM`;
    if (!take.sections.length) {
      box.append(el('p', 'tag ok', `${ref}에서 크게 벗어난 구간이 없어요`));
    } else {
      box.append(el('p', '', `${ref}에서 벗어난 구간`));
      const ul = el('ul');
      for (const sec of take.sections) {
        const li = el('li');
        li.append(el('time', '', `${clock(sec.start)}–${clock(sec.end)}`), el('span', `tag ${sec.kind}`, `${sec.kind === 'fast' ? '빨라짐' : '느려짐'} ${signed(sec.delta)} BPM`));
        ul.append(li);
      }
      box.append(ul);
    }
    takes.append(box);
  });
  draw();
}

function el(tag: string, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ---- 그래프 ----
// 시간은 세로(지금이 아래, 지난 것은 위로 흘러가며 흐려진다), 빠르기는 가로(가운데 = 기준, 오른쪽 = 빠름, 왼쪽 = 느림)

const css = getComputedStyle(document.documentElement);
const INK = css.getPropertyValue('--ink').trim();
const FAST = css.getPropertyValue('--fast').trim();
const SLOW = css.getPropertyValue('--slow').trim();
const MUTED = css.getPropertyValue('--muted').trim();

/** 실시간이면 상태를 넘긴다. 없으면 연습 전체를 한 화면에 그린다 */
function draw(live?: TempoState) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const all = session.samples;
  const cx = w / 2;
  // 지금 위치(선의 머리)는 아래 버튼들 바로 위. 그 밑에 눈금 숫자가 들어간다
  const headY = dock.offsetTop - 40;
  let y: (t: number) => number;
  let pts: TempoSample[];
  if (live) {
    const pps = headY / LIVE_SPAN;
    y = (t) => headY - (live.time - t) * pps;
    pts = all.filter((s) => s.t >= live.time - LIVE_SPAN - 2);
  } else {
    const from = all.length ? all[0].t : 0;
    const to = all.length ? all[all.length - 1].t : 1;
    const topY = h * 0.1;
    y = (t) => topY + ((t - from) / Math.max(1, to - from)) * (headY - topY);
    pts = report ? all : [];
  }

  // 가운데(기준)와 가로 범위
  const ref = live ? (baseline ?? pts[pts.length - 1]?.bpm ?? null) : (target ?? report?.mean ?? null);
  if (ref !== null && pts.length) {
    let far = 0;
    for (const p of pts) far = Math.max(far, Math.abs(p.bpm / ref - 1));
    const want = Math.max(0.08, far * 1.25);
    range = live ? range + (want - range) * 0.06 : want;
  }
  const half = Math.min(w * 0.44, 420);
  const x = (bpm: number) => (ref === null ? cx : cx + (bpm / ref - 1) / range * half);

  if (ref !== null && pts.length) {
    // 벗어난 구간: 결과 화면에서만, 그 시간대를 가로 띠로
    if (!live && report) {
      for (const take of report.takes) {
        for (const sec of take.sections) {
          const band = g.createLinearGradient(0, 0, w, 0);
          const c = sec.kind === 'fast' ? FAST : SLOW;
          band.addColorStop(sec.kind === 'fast' ? 0.5 : 0, alpha(c, sec.kind === 'fast' ? 0 : 0.16));
          band.addColorStop(sec.kind === 'fast' ? 1 : 0.5, alpha(c, sec.kind === 'fast' ? 0.16 : 0));
          g.fillStyle = band;
          g.fillRect(0, y(sec.start), w, Math.max(2, y(sec.end) - y(sec.start)));
        }
      }
    }

    // 끊긴 곳에서 나눈 선들
    const runs: TempoSample[][] = [];
    for (const p of pts) {
      const cur = runs[runs.length - 1];
      if (cur && p.t - cur[cur.length - 1].t <= 1) cur.push(p);
      else runs.push([p]);
    }
    const trace = (run: TempoSample[]) => {
      g.moveTo(x(run[0].bpm), y(run[0].t));
      for (let i = 1; i < run.length - 1; i++) {
        const mx = (x(run[i].bpm) + x(run[i + 1].bpm)) / 2;
        const my = (y(run[i].t) + y(run[i + 1].t)) / 2;
        g.quadraticCurveTo(x(run[i].bpm), y(run[i].t), mx, my);
      }
      const last = run[run.length - 1];
      g.lineTo(x(last.bpm), y(last.t));
    };

    // 기준선과 선 사이를 엷게 채운다: 오른쪽(빠름)은 따뜻하게, 왼쪽(느림)은 차갑게
    const wash = g.createLinearGradient(cx - half, 0, cx + half, 0);
    wash.addColorStop(0, alpha(SLOW, 0.34));
    wash.addColorStop(0.5, alpha(INK, 0));
    wash.addColorStop(1, alpha(FAST, 0.34));
    g.fillStyle = wash;
    for (const run of runs) {
      if (run.length < 2) continue;
      g.beginPath();
      trace(run);
      g.lineTo(cx, y(run[run.length - 1].t));
      g.lineTo(cx, y(run[0].t));
      g.closePath();
      g.fill();
    }

    g.lineWidth = 1.6;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = INK;
    g.shadowColor = alpha(INK, 0.55);
    g.shadowBlur = 12;
    for (const run of runs) {
      if (run.length < 2) continue;
      g.beginPath();
      trace(run);
      g.stroke();
    }
    g.shadowBlur = 0;

    // 위로 갈수록 사라지게
    if (live) {
      const fade = g.createLinearGradient(0, 0, 0, headY);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(0.12, 'rgba(0,0,0,0.12)');
      fade.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = fade;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    }
  }

  // 기준선(가운데)과 눈금
  const axis = g.createLinearGradient(0, 0, 0, h);
  axis.addColorStop(0, alpha(INK, 0));
  axis.addColorStop(0.5, alpha(INK, 0.1));
  axis.addColorStop(headY / h, alpha(INK, 0.22));
  axis.addColorStop(Math.min(1, (headY + 10) / h), alpha(INK, 0));
  g.strokeStyle = axis;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx, 0);
  g.lineTo(cx, h);
  g.stroke();

  if (ref !== null && pts.length) {
    const span = ref * range;
    const step = [1, 2, 5, 10, 20, 50].find((s) => span / s <= 2.2) ?? 50;
    g.font = "400 10.5px 'Inter', system-ui, sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let k = -2; k <= 2; k++) {
      const px = x(ref + k * step);
      if (px < 14 || px > w - 14) continue;
      g.fillStyle = alpha(k === 0 ? INK : MUTED, k === 0 ? 0.75 : 0.6);
      g.fillText(k === 0 ? ref.toFixed(0) : `${k > 0 ? '+' : '−'}${Math.abs(k * step)}`, px, headY + 16);
      if (k === 0) continue;
      g.strokeStyle = alpha(INK, 0.1);
      g.beginPath();
      g.moveTo(px, headY + 4);
      g.lineTo(px, headY + 11);
      g.stroke();
    }

    // 지금 위치: 점과, 타격마다 번지는 고리
    const last = pts[pts.length - 1];
    if (live && live.time - last.t < 1) {
      const hx = x(last.bpm);
      const hy = y(last.t);
      const off = baseline ? last.bpm / baseline - 1 : 0;
      const tint = Math.abs(off) <= ON_TEMPO ? INK : off > 0 ? FAST : SLOW;
      const age = (performance.now() - hitAt) / 450;
      if (age >= 0 && age < 1) {
        g.strokeStyle = alpha(tint, 0.5 * (1 - age));
        g.lineWidth = 1;
        g.beginPath();
        g.arc(hx, hy, 5 + age * 20, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = tint;
      g.shadowColor = tint;
      g.shadowBlur = 16;
      g.beginPath();
      g.arc(hx, hy, 3.5, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }
  }
}

/** #rrggbb → rgba() */
function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

draw();
