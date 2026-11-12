import { BadGatewayException, Injectable, Logger, type OnModuleInit, ServiceUnavailableException } from '@nestjs/common';

/** 음성 인식이 잡음·무음에서 자주 지어내는 문장 (Whisper 계열의 알려진 버릇) */
const HALLUCINATIONS = [/^시청해\s*주셔서\s*감사합니다\.?$/, /^구독과\s*좋아요/, /^MBC\s*뉴스/, /^감사합니다\.?$/, /^\.+$/];
/** 공장 용어를 알려 주면 받아쓰기가 정확해진다 */
const PROMPT = '헤드램프, 사이드미러, 전장 모듈, 설비, 불량, 불량률, 원인, 조치, 고장, 정지, 광축, 배광, 소음, 사출, 증착, 코팅, 도장, LOT, SPC, Cpk, OEE, 작업표준서';

/**
 * 음성 질의 받아쓰기. OpenAI 호환 /v1/audio/transcriptions 엔드포인트로 넘긴다.
 * - 로컬: tools/whisper의 faster-whisper 서버, 또는 whisper.cpp server(--inference-path /v1/audio/transcriptions)
 * - 클라우드: OpenAI 등 같은 형식의 서비스 (STT_API_KEY)
 * STT_BASE_URL이 없으면 꺼 두고, 화면은 브라우저 음성 인식(Web Speech API)으로 대신한다.
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

  async transcribe(audio: Buffer, mime: string, filename = 'speech.webm'): Promise<{ text: string; ms: number }> {
    if (!this.base) throw new ServiceUnavailableException('서버 음성 인식이 꺼져 있습니다(STT_BASE_URL 없음)');
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), filename);
    form.append('model', this.model);
    form.append('language', 'ko');
    form.append('prompt', PROMPT);
    form.append('response_format', 'json');
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        headers: this.key ? { Authorization: `Bearer ${this.key}` } : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      this.log.warn(`음성 인식 서버 연결 실패: ${(e as Error).message}`);
      this.probe = { at: Date.now(), ok: false };
      throw new BadGatewayException('음성 인식 서버에 연결하지 못했습니다. 브라우저 음성 인식으로 바꿉니다');
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      this.log.warn(`음성 인식 실패 ${res.status}: ${body}`);
      throw new BadGatewayException(`음성 인식 서버 오류(${res.status})`);
    }
    const json = (await res.json().catch(() => ({}))) as { text?: unknown };
    let text = typeof json.text === 'string' ? json.text.trim() : '';
    if (HALLUCINATIONS.some((r) => r.test(text))) text = '';
    return { text, ms: Date.now() - started };
  }
}
