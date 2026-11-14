import { BadGatewayException, Injectable, Logger, type OnModuleInit, ServiceUnavailableException } from '@nestjs/common';

/** 음성 인식이 잡음·무음에서 자주 지어내는 문장 (Whisper 계열의 알려진 버릇) */
const HALLUCINATIONS = [/^시청해\s*주셔서\s*감사합니다\.?$/, /^구독과\s*좋아요/, /^MBC\s*뉴스/, /^감사합니다\.?$/, /^\.+$/];
/** 공장 용어를 알려 주면 받아쓰기가 정확해진다 */
const PROMPT = '헤드램프, 사이드미러, 전장 모듈, 설비, 불량, 불량률, 원인, 조치, 고장, 정지, 광축, 배광, 소음, 사출, 증착, 코팅, 도장, LOT, SPC, Cpk, OEE, 작업표준서';
/** 짧은 음성 질의를 기다리는 시간 */
const QUERY_TIMEOUT_MS = 60_000;

/** 받아쓰기 실패. message는 현장 사용자가 읽을 한국어 문장이다 */
export class SttError extends Error {
  constructor(
    message: string,
    readonly kind: 'off' | 'connect' | 'http' | 'timeout',
  ) {
    super(message);
  }
}

/** 받아쓰기 결과: 말 구간(segment)마다 한 줄 */
export interface SttSegments {
  segments: string[];
  text: string;
  ms: number;
}

/**
 * 음성 받아쓰기. OpenAI 호환 /v1/audio/transcriptions 엔드포인트로 넘긴다. AI 비서(음성 질의)와 TBM 회의 녹음이 같이 쓴다.
 * - 로컬: tools/whisper의 faster-whisper 서버, 또는 whisper.cpp server(--inference-path /v1/audio/transcriptions)
 * - 클라우드: OpenAI 등 같은 형식의 서비스 (STT_API_KEY)
 * STT_BASE_URL이 없으면 꺼 두고, 비서 화면은 브라우저 음성 인식(Web Speech API)으로 대신한다.
 */
@Injectable()
export class SttService implements OnModuleInit {
  private readonly log = new Logger('STT');
  private readonly base = (process.env.STT_BASE_URL ?? '').replace(/\/+$/, '');
  readonly model = process.env.STT_MODEL || 'whisper-1';
  private readonly key = process.env.STT_API_KEY;

  onModuleInit() {
    if (!this.base) this.log.log('음성 질의: 브라우저 음성 인식 (STT_BASE_URL 없음)');
    else void this.available(); // 닿는지 한 번 보고 로그를 남긴다
  }

  private probe: { at: number; ok: boolean } | null = null;

  /** 받아쓰기 서버 주소(호스트:포트). 꺼져 있으면 null */
  get host(): string | null {
    if (!this.base) return null;
    try {
      return new URL(this.base).host;
    } catch {
      return this.base;
    }
  }

  /**
   * 받아쓰기 서버가 지금 닿는지 (30초 캐시). STT_BASE_URL을 넣어 두고 서버를 안 켰으면 false라서
   * 화면이 브라우저 음성 인식으로 대신한다. 응답 코드는 따지지 않는다(연결만 되면 켜진 것).
   */
  async available(): Promise<boolean> {
    if (!this.base) return false;
    if (this.probe && Date.now() - this.probe.at < 30_000) return this.probe.ok;
    let ok = false;
    try {
      const res = await fetch(this.base, { signal: AbortSignal.timeout(1_500) });
      await res.body?.cancel();
      ok = true;
    } catch {
      ok = false;
    }
    if (this.probe?.ok !== ok) this.log.log(ok ? `음성 인식 서버 연결: ${this.base} (${this.model})` : `음성 인식 서버에 닿지 않음: ${this.base} → 화면은 브라우저 음성 인식으로 대신`);
    this.probe = { at: Date.now(), ok };
    return ok;
  }

  /** 비서 음성 질의 (짧은 말 한마디) */
  async transcribe(audio: Buffer, mime: string, filename = 'speech.webm'): Promise<{ text: string; ms: number }> {
    if (!this.base) throw new ServiceUnavailableException('서버 음성 인식이 꺼져 있습니다(STT_BASE_URL 없음)');
    const started = Date.now();
    let json: { text?: unknown };
    try {
      json = (await this.request(audio, mime, filename, { prompt: PROMPT, format: 'json', timeoutMs: QUERY_TIMEOUT_MS })) as { text?: unknown };
    } catch (e) {
      if (e instanceof SttError && e.kind !== 'http') throw new BadGatewayException('음성 인식 서버에 연결하지 못했습니다. 브라우저 음성 인식으로 바꿉니다');
      throw new BadGatewayException((e as Error).message);
    }
    return { text: clean(typeof json.text === 'string' ? json.text : ''), ms: Date.now() - started };
  }

  /**
   * 긴 녹음(TBM 회의)을 말 구간마다 한 줄로 받아쓴다 (verbose_json의 segments).
   * segments를 주지 않는 서버면 전체 글을 문장 끝(. ? !)으로 나눈다. 실패하면 SttError (한국어 문장)
   */
  async transcribeSegments(audio: Buffer, mime: string, filename: string, opts: { prompt?: string; timeoutMs: number }): Promise<SttSegments> {
    if (!this.base) throw new SttError('서버 음성 인식이 꺼져 있습니다(STT_BASE_URL 없음). 대화록 텍스트 파일(.txt)로 올리거나, 받아쓰기 서버(npm run whisper)를 켜 주세요', 'off');
    const started = Date.now();
    const json = (await this.request(audio, mime, filename, { prompt: opts.prompt ?? PROMPT, format: 'verbose_json', timeoutMs: opts.timeoutMs })) as { text?: unknown; segments?: { text?: unknown }[] };
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    let segments = Array.isArray(json.segments) ? json.segments.map((s) => clean(typeof s?.text === 'string' ? s.text : '')).filter(Boolean) : [];
    if (!segments.length && text) segments = text.split(/(?<=[.?!。])\s+/).map(clean).filter(Boolean);
    return { segments, text, ms: Date.now() - started };
  }

  private async request(audio: Buffer, mime: string, filename: string, o: { prompt: string; format: 'json' | 'verbose_json'; timeoutMs: number }): Promise<unknown> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), filename);
    form.append('model', this.model);
    form.append('language', 'ko');
    form.append('prompt', o.prompt);
    form.append('response_format', o.format);
    let res: Response;
    const timer = AbortSignal.timeout(o.timeoutMs);
    try {
      res = await fetch(`${this.base}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        headers: this.key ? { Authorization: `Bearer ${this.key}` } : undefined,
        signal: timer,
      });
    } catch (e) {
      this.log.warn(`음성 인식 서버 연결 실패: ${(e as Error).message}`);
      if (timer.aborted) throw new SttError(`음성 인식 서버가 ${Math.round(o.timeoutMs / 1000)}초 안에 받아쓰기를 끝내지 못했습니다. 녹음을 나눠 올려 주세요`, 'timeout');
      this.probe = { at: Date.now(), ok: false };
      throw new SttError(`음성 인식 서버(${this.host})에 연결하지 못했습니다. 받아쓰기 서버(npm run whisper)가 켜져 있는지 확인해 주세요`, 'connect');
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      this.log.warn(`음성 인식 실패 ${res.status}: ${body}`);
      let detail = '';
      try {
        detail = String((JSON.parse(body) as { error?: { message?: unknown } }).error?.message ?? '');
      } catch {
        detail = '';
      }
      throw new SttError(`음성 인식 서버 오류(${res.status})${detail ? `: ${detail.slice(0, 120)}` : ''}`, 'http');
    }
    return res.json().catch(() => ({}));
  }
}

/** 지어낸 문장(무음·잡음)은 빈 글로 */
function clean(s: string): string {
  const t = s.trim();
  return HALLUCINATIONS.some((r) => r.test(t)) ? '' : t;
}
