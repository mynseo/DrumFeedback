import { OnsetDetector, type Onset } from './onset';
import { MAX_BPM, MIN_BPM, TempoTracker, type Feel } from './tracker';

/**
 * 소리 → 지금 빠르기. 화면(마이크·그리기)과 떨어져 있어서 테스트에서 합성한 소리로 그대로 돌린다.
 *
 * - locked: 빠르기를 믿을 만하다
 * - hold: 방금까지 믿을 만했는데 잠깐 흐트러졌거나(필인) 쉬는 중. 마지막 값을 흐리게 보여 준다
 * - searching: 타격은 들리지만 아직 빠르기를 모른다 ("측정 중"). 틀린 숫자를 보여 주지 않는다
 * - silent: 타격이 없다
 */
export type Phase = 'silent' | 'searching' | 'hold' | 'locked';

export interface TempoState {
  phase: Phase;
  bpm: number | null;
  confidence: number;
  /** 듣기 시작한 뒤 흐른 시간(초) */
  time: number;
}

/** 이 이상이어야 숫자를 믿는다 */
export const MIN_CONFIDENCE = 0.45;
/** 처음 숫자를 보여 줄 때는 더 까다롭게: 이 이상으로, 같은 빠르기가 두 번 이어져야 한다 */
const LOCK_CONFIDENCE = 0.6;
const HOLD_SEC = 2.5;

/**
 * 박 단위(2배·절반·3/2배 …)는 처음 SETTLE_SEC 동안 투표로 정하고, 그 뒤로는 거의 바꾸지 않는다.
 * 연주 중에 패턴이 바뀌면(킥만 치기, 16분 필인, 하이햇만) 같은 빠르기도 50·200처럼 보이지만,
 * 곡 중간에 빠르기가 정말 반으로 줄거나 두 배가 되는 일은 드물다.
 */
const SETTLE_SEC = 12;
/** 다른 단위가 지금 단위보다 이만큼 더 많이 표를 받아야 바꾼다 */
const SWITCH_MARGIN = 1.25;
/** 정해진 뒤에 단위를 바꾸려면 필요한 표 (확신² × 초). 수십 초 동안 꾸준해야 넘는다 */
const LATE_VOTES = 15;
/** 정해진 뒤에는 오래된 표가 이 시간(초)으로 줄어든다 */
const VOTE_DECAY = 30;
/** 박 단위로 보는 배수들 */
const RATIOS = [2, 1 / 2, 3, 1 / 3, 4, 1 / 4, 3 / 2, 2 / 3, 4 / 3, 3 / 4];
/** 박 단위(2배·절반 등)로 설명되지 않게 이만큼(비율) 넘게 튀면, 같은 값이 BIG_JUMP_SEC 동안 이어져야 믿는다 */
const BIG_JUMP = 0.25;
const BIG_JUMP_SEC = 1.5;
/** 잠깐 놓쳤다가 다시 잡을 때 이 시간 안이면 전에 쓰던 박 단위를 따른다 */
const REMEMBER_SEC = 20;

/** a/b가 RATIOS 중 하나에 가까우면 그 배수, 같은 단위면 1, 둘 다 아니면 null */
function ratioOf(a: number, b: number): number | null {
  const r = a / b;
  if (Math.abs(r - 1) < 0.08) return 1;
  for (const k of RATIOS) if (Math.abs(r / k - 1) < 0.05) return k;
  return null;
}

export class TempoEngine {
  private readonly detector: OnsetDetector;
  private readonly tracker = new TempoTracker();
  private bpm: number | null = null;
  private confidence = 0;
  private lastOnset = -Infinity;
  private lastLocked = -Infinity;
  private target: number | null = null;
  private candidate: number | null = null;
  /** 지금 박 단위에 대한 배수별 표 (1 = 지금 단위). 표 = 확신² × 그렇게 보인 시간 */
  private votes = new Map<number, number>();
  private lastUnitAt: number | null = null;
  /** 마지막으로 보여 준 빠르기와 시각 (놓쳤다 다시 잡을 때 박 단위를 이어 간다) */
  private prevBpm: number | null = null;
  private prevAt = -Infinity;
  /** 이번 연주에서 처음 빠르기를 잡은 시각 */
  private firstLockAt: number | null = null;
  /** 크게 튄 값과 그 값이 처음 보인 시각 */
  private jumpTo: number | null = null;
  private jumpSince = 0;

  constructor(sampleRate: number) {
    this.detector = new OnsetDetector(sampleRate);
  }

  get time() {
    return this.detector.time;
  }

  /** 입력 크기 0..1 */
  get level() {
    return this.detector.level;
  }

  /** 소리를 넣는다. 이번에 새로 찾은 타격을 돌려준다 */
  push(samples: Float32Array): Onset[] {
    const onsets = this.detector.push(samples);
    for (const o of onsets) {
      this.tracker.add(o);
      this.lastOnset = o.time;
    }
    if (onsets.length) this.update();
    else if (this.time - this.lastOnset > this.silenceAfter() && (this.bpm !== null || this.tracker.size)) {
      // 연주가 끝났다: 다음 연주는 새로 찾는다 (다른 곡일 수 있으니 ½×·2×와 박 단위도 푼다)
      this.tracker.clear();
      this.tracker.hint = this.target;
      this.bpm = null;
      this.confidence = 0;
      this.prevBpm = null;
      this.votes.clear();
      this.lastUnitAt = null;
      this.firstLockAt = null;
    }
    return onsets;
  }

  state(): TempoState {
    const time = this.time;
    let phase: Phase;
    if (this.bpm === null) phase = this.tracker.size && time - this.lastOnset < 2 ? 'searching' : 'silent';
    else if (this.confidence >= MIN_CONFIDENCE && time - this.lastOnset < (60 / this.bpm) * 2 + 0.3) phase = 'locked';
    else phase = 'hold';
    return { phase, bpm: this.bpm, confidence: this.confidence, time };
  }

  /** 목표 템포. 정하면 그 근처에서만 찾는다 (null이면 자동) */
  setTarget(bpm: number | null) {
    this.target = bpm && bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null;
    this.tracker.hint = this.target;
    this.tracker.last = null;
  }

  /** 리듬(한 박을 어떻게 나눠 치는지). null이면 자동 */
  setFeel(feel: Feel | null) {
    this.tracker.feel = feel;
    this.tracker.last = null;
    if (!this.target) this.tracker.hint = null;
  }

  /** 2배·절반으로 잘못 읽었을 때 바로잡는다. 바꾼 배수를 돌려준다 (못 바꾸면 1) */
  scale(factor: number): number {
    if (this.bpm === null) return 1;
    const next = this.bpm * factor;
    if (next < MIN_BPM || next > MAX_BPM) return 1;
    this.bpm = next;
    this.prevBpm = next;
    // 사용자가 정한 단위: 바로 정해진 것으로 본다
    this.votes.clear();
    this.firstLockAt = -Infinity;
    this.tracker.hint = next;
    this.tracker.last = next;
    return factor;
  }

  private silenceAfter() {
    return Math.max(3, this.bpm ? (60 / this.bpm) * 4 : 0);
  }

  /**
   * 새로 읽은 빠르기가 지금 쓰는 박 단위의 2배·절반 등이면, 지금 단위로 바꿔 읽는다 (빠르기 정보는 그대로 쓴다).
   * 단위 자체는 표로 정한다: 처음 SETTLE_SEC 동안은 표가 더 많은 쪽으로, 그 뒤로는 아주 오래 꾸준할 때만 바꾼다.
   */
  private keepUnit(bpm: number, time: number, conf: number): number {
    const ref = this.bpm ?? (time - this.prevAt < REMEMBER_SEC ? this.prevBpm : null);
    const dt = this.lastUnitAt === null ? 0.25 : Math.min(1, Math.max(0, time - this.lastUnitAt));
    this.lastUnitAt = time;
    this.firstLockAt ??= time;
    if (ref === null || this.target) return bpm;
    const k = ratioOf(bpm, ref);
    if (k === null) return bpm; // 정말로 빠르기가 바뀌었다
    const settling = time - this.firstLockAt < SETTLE_SEC;
    if (!settling) {
      const fade = Math.exp(-dt / VOTE_DECAY);
      for (const [r, v] of this.votes) this.votes.set(r, v * fade);
    }
    const alt = (this.votes.get(k) ?? 0) + conf * conf * dt;
    this.votes.set(k, alt);
    if (k === 1) return bpm;
    const cur = this.votes.get(1) ?? 0;
    if (alt > Math.max(cur * SWITCH_MARGIN, settling ? 0.4 : LATE_VOTES)) {
      // 단위를 바꾼다: 표도 새 단위 기준으로 옮긴다
      const moved = new Map<number, number>();
      for (const [r, v] of this.votes) {
        const nr = r / k;
        const key = Math.abs(nr - 1) < 0.02 ? 1 : RATIOS.find((x) => Math.abs(nr / x - 1) < 0.02);
        if (key !== undefined) moved.set(key, (moved.get(key) ?? 0) + v);
      }
      this.votes = moved;
      return bpm;
    }
    return bpm / k;
  }

  private update() {
    const time = this.time;
    const est = this.tracker.estimate(time);
    this.confidence = est?.confidence ?? 0;
    if (est && this.bpm === null) {
      // 아무렇게나 친 타격이 우연히 맞아떨어진 것을 거른다
      const agrees = this.candidate !== null && Math.abs(est.bpm / this.candidate - 1) < 0.04;
      this.candidate = est.confidence >= LOCK_CONFIDENCE ? est.bpm : null;
      if (!agrees || this.candidate === null) return;
    }
    if (est && est.confidence >= MIN_CONFIDENCE) {
      const unrelated = this.bpm !== null && ratioOf(est.bpm, this.bpm) === null;
      const value = this.keepUnit(est.bpm, time, est.confidence);
      if (unrelated && Math.abs(Math.log(value / this.bpm!)) > Math.log(1 + BIG_JUMP)) {
        // 잡음·울림 때문에 엉뚱한 값이 잠깐 나올 수 있다. 같은 값이 이어질 때만 넘어간다
        if (this.jumpTo === null || Math.abs(value / this.jumpTo - 1) > 0.04) {
          this.jumpTo = value;
          this.jumpSince = time;
        }
        if (time - this.jumpSince < BIG_JUMP_SEC) {
          // 기다리는 동안은 확신하지 않는다: 마지막 숫자를 흐리게(잠깐 놓침) 보여 준다
          this.confidence = Math.min(this.confidence, MIN_CONFIDENCE * 0.99);
          return;
        }
      }
      this.jumpTo = null;
      // 숫자가 잘게 떨리지 않게 살짝 고르되, 크게 바뀌면 바로 따라간다
      const jump = this.bpm === null || Math.abs(value / this.bpm - 1) > 0.06;
      this.bpm = jump ? value : this.bpm! + (value - this.bpm!) * 0.4;
      this.prevBpm = this.bpm;
      this.prevAt = time;
      this.lastLocked = time;
      this.tracker.last = this.bpm;
      // 사용자가 고른 배수는 빠르기가 조금씩 바뀌어도 따라간다 (목표 템포는 그대로 둔다)
      if (this.tracker.hint && !this.target) this.tracker.hint = this.bpm;
    } else if (this.bpm !== null && time - this.lastLocked > HOLD_SEC) {
      // 숫자는 내리지만 박 단위는 기억해 둔다 (prevBpm)
      this.bpm = null;
      this.tracker.last = null;
    }
  }
}
