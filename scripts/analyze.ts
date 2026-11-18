/**
 * 녹음 파일을 웹 페이지와 같은 엔진으로 분석해 시간별 빠르기를 출력한다 (개발용).
 *
 *   npm run analyze -- 녹음.mp3 [--feel eighth] [--target 100] [--every 1]
 *
 * ffmpeg로 44.1kHz 모노로 바꿔 읽는다.
 */
import { execFileSync } from 'node:child_process';
import { TempoEngine } from '../src/engine';
import { Session } from '../src/session';
import { FEELS, type Feel } from '../src/tracker';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('사용법: npm run analyze -- 파일.mp3 [--feel eighth|sixteenth|shuffle|bounce|triplet|quarter] [--target 100] [--every 1]');
  process.exit(1);
}
const feel = opt('feel');
if (feel && !(feel in FEELS)) throw new Error(`리듬은 ${Object.keys(FEELS).join(', ')} 중 하나`);
const target = opt('target') ? Number(opt('target')) : null;
const every = Number(opt('every') ?? 1);

const RATE = 44100;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

const engine = new TempoEngine(RATE);
engine.setTarget(target);
engine.setFeel((feel as Feel) ?? null);
const session = new Session();
let next = every;
let hits = 0;
const lines: string[] = [];
for (let i = 0; i < samples.length; i += 1024) {
  hits += engine.push(samples.subarray(i, i + 1024)).length;
  const s = engine.state();
  if (s.phase === 'locked' && s.bpm !== null) session.add(s.time, s.bpm);
  if (s.time >= next) {
    next += every;
    lines.push(`${s.time.toFixed(1).padStart(6)}s  ${s.phase.padEnd(9)} ${s.bpm === null ? '   -  ' : s.bpm.toFixed(1).padStart(6)}  확신 ${s.confidence.toFixed(2)}  타격 ${hits}`);
  }
}
console.log(lines.join('\n'));
const r = session.report(target);
console.log(
  r
    ? `\n평균 ${r.mean.toFixed(1)} · 범위 ${r.min.toFixed(1)}–${r.max.toFixed(1)} · 흔들림 ±${r.wobblePct.toFixed(1)}% · 안정성 ${r.score}점 · 잰 시간 ${r.measured.toFixed(0)}초`
    : '\n빠르기를 5초 넘게 재지 못했어요',
);
