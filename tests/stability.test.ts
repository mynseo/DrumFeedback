import { describe, expect, it } from 'vitest';
import { TempoEngine } from '../src/engine';
import type { Feel } from '../src/tracker';
const RATE = 44100;

/** 재현되는 난수 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Drum = 'kick' | 'snare' | 'hat';
interface Hit {
  time: number;
  drum: Drum;
}

/** 합성 드럼 소리 + 방 소음 */
function render(hits: Hit[], seconds: number, seed = 1): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.ceil(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = (rand() - 0.5) * 0.004;
  for (const h of hits) {
    const start = Math.round(h.time * RATE);
    const len = Math.round((h.drum === 'kick' ? 0.18 : h.drum === 'snare' ? 0.12 : 0.03) * RATE);
    let prev = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / RATE;
      let v: number;
      if (h.drum === 'kick') v = 0.8 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 40)) * t) * Math.exp(-t * 22);
      else if (h.drum === 'snare') v = (0.5 * (rand() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 30);
      else {
        // 하이햇: 높은 소리만 남긴 잡음, 작게
        const n = rand() * 2 - 1;
        v = 0.12 * (n - prev) * Math.exp(-t * 120);
        prev = n;
      }
      out[start + i] += v;
    }
  }
  return out;
}

/** 8비트 록: 킥 1·3, 스네어 2·4, 하이햇 8분음표. bpmAt으로 빠르기를 바꿀 수 있다 */
function changing(bpm: number, seed: number, messy: boolean): Hit[] {
  const beat = 60 / bpm; const hits: Hit[] = []; const rand = rng(seed);
  const j = () => (rand() - 0.5) * 0.02;
  const push = (h: Hit) => { if (messy && rand() < 0.12) return; hits.push(h); if (messy && rand() < 0.05) hits.push({ time: h.time + 0.06 + rand() * 0.15, drum: 'snare' }); };
  for (let b = 0; 0.3 + b * beat < 59; b++) {
    const t = 0.3 + b * beat; const seg = t < 12 ? 0 : Math.floor((t - 12) / 5) % 6;
    if (seg === 0 || seg === 3) { push({ time: t + j(), drum: b % 2 ? 'snare' : 'kick' }); push({ time: t + j(), drum: 'hat' }); push({ time: t + beat / 2 + j(), drum: 'hat' }); }
    else if (seg === 1) { if (b % 2 === 0) push({ time: t + j(), drum: 'kick' }); }
    else if (seg === 2) { for (let k = 0; k < 4; k++) push({ time: t + (k * beat) / 4 + j(), drum: 'snare' }); }
    else if (seg === 4) { push({ time: t + j(), drum: 'hat' }); push({ time: t + beat / 2 + j(), drum: 'hat' }); }
    else { push({ time: t + j(), drum: 'kick' }); push({ time: t + beat / 2 + j(), drum: 'snare' }); }
  }
  return hits;
}
describe('박 단위가 튀지 않는다', () => {
  // 처음 12초는 평소 8비트, 그 뒤로 5초씩: 킥만 1·3박(절반처럼 보임) · 16분 스네어(두 배처럼 보임) · 8비트 ·
  // 하이햇만 · 킥·스네어 8분음표. 지저분하면 타격 12%를 빼먹고 5%는 헛타격이 끼어든다
  for (const messy of [false, true]) {
    for (const feel of [undefined, 'eighth'] as (Feel | undefined)[]) {
      it(`${messy ? '빠지고 헛도는 타격' : '깨끗한 타격'}, 리듬 ${feel ?? '자동'}: 70·100·140 BPM을 그대로 유지한다`, () => {
        for (const bpm of [70, 100, 140]) {
          const audio = render(changing(bpm, bpm + 1, messy), 60);
          const e = new TempoEngine(RATE);
          if (feel) e.setFeel(feel);
          let next = 0.25;
          let shown = 0;
          const off: string[] = [];
          for (let i = 0; i < audio.length; i += 512) {
            e.push(audio.subarray(i, i + 512));
            if (e.time < next) continue;
            next += 0.25;
            const s = e.state();
            if (s.time <= 5 || s.bpm === null || s.phase === 'searching') continue;
            shown++;
            if (Math.abs(s.bpm / bpm - 1) > 0.03) off.push(`${s.time.toFixed(1)}s:${s.bpm.toFixed(0)}`);
          }
          expect(shown, `${bpm} BPM 보인 횟수`).toBeGreaterThan(150);
          expect(off.slice(0, 8), `${bpm} BPM에서 틀린 숫자`).toEqual([]);
        }
      }, 60000);
    }
  }
});
