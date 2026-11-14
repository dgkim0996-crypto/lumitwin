import { randomUUID } from 'node:crypto';
import { ConflictException, HttpException, HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { AssistantChatRequest, AssistantEvent, AssistantInfo } from '@lumitwin/shared';
import { LiveService } from '../live/live.service';
import { buildSystemPrompt, SUGGESTIONS } from './assistant.prompt';
import { AssistantTools } from './assistant.tools';
import { friendly } from './llm.errors';
import { endpointLabel, isExternal, resolveLlmSettings } from './llm.settings';
import { ClaudeProvider } from './providers/claude.provider';
import { LocalProvider } from './providers/local.provider';
import { MockProvider } from './providers/mock.provider';
import { LlmError, OpenAiCompatClient } from './providers/openai-compat';
import type { AssistantProvider, Conversation } from './providers/provider';
import { StandardsIndex } from './standards.index';
import { SttService } from './stt.service';

/** 대화는 서버 메모리에만 둔다. 오래 안 쓴 것부터 지운다 */
const CONV_TTL_MS = 2 * 3_600_000;
const MAX_CONVS = 200;
const MAX_MESSAGE_CHARS = 2_000;
const HOUR_MS = 3_600_000;

/** 0이나 잘못된 값은 "제한 없음" */
const limitEnv = (v: string | undefined) => Math.max(0, Math.floor(Number(v ?? 0)) || 0);

/**
 * AI 현장 비서. 환경 변수로 응답기를 고른다 (llm.settings.ts).
 * - ASSISTANT_PROVIDER=auto(기본): ANTHROPIC_API_KEY가 있으면 Claude, 없으면 모의 모드
 * - ASSISTANT_PROVIDER=claude | local | mock: 강제. local은 사내 오픈소스 LLM(LLM_BASE_URL의 OpenAI 호환 서버)
 * 세 응답기는 같은 도구 실행기(AssistantTools)로 실제 공장 데이터를 조회한다.
 */
@Injectable()
export class AssistantService implements OnModuleInit {
  private readonly log = new Logger('Assistant');
  private provider!: AssistantProvider;
  private endpoint: string | null = null;
  private readonly convs = new Map<string, Conversation>();
  /**
   * 공개 배포에서 Claude API 비용이 새지 않게 하는 질문 수 상한 (모의 모드는 세지 않는다).
   * 서버 한 대·프로세스 하나를 가정해 메모리에 센다 (재시작하면 비워진다)
   */
  private readonly perHour = limitEnv(process.env.ASSISTANT_MAX_PER_HOUR);
  private readonly perDay = limitEnv(process.env.ASSISTANT_MAX_PER_DAY);
  private readonly hits = new Map<string, number[]>();
  private day = { key: '', n: 0 };

  constructor(
    private readonly tools: AssistantTools,
    private readonly live: LiveService,
    private readonly standards: StandardsIndex,
    private readonly stt: SttService,
  ) {}

  onModuleInit() {
    const s = resolveLlmSettings();
    if (s.mode === 'claude') {
      if (!s.hasKey) this.log.warn('ASSISTANT_PROVIDER=claude인데 ANTHROPIC_API_KEY가 없습니다. 질문하면 인증 오류가 납니다');
      this.provider = new ClaudeProvider(s.model, s.effort, buildSystemPrompt(), this.tools, () => this.live.virtualNow);
      this.log.log(`AI 비서: Claude (${s.model}, effort ${s.effort}, 거절 시 서버 쪽 대체 모델 사용) — 질문과 조회한 공장 데이터가 Claude API로 나갑니다`);
      if (this.perHour || this.perDay) this.log.log(`질문 한도: IP별 시간당 ${this.perHour || '제한 없음'} · 하루 전체 ${this.perDay || '제한 없음'}`);
    } else if (s.mode === 'local') {
      const client = new OpenAiCompatClient(s.local);
      this.provider = new LocalProvider(client, buildSystemPrompt(), this.tools, () => this.live.virtualNow);
      this.endpoint = endpointLabel(s.local.baseUrl);
      void this.probeLocal(client); // 닿는지·모델이 있는지 한 번 보고 로그를 남긴다 (기동은 막지 않는다)
    } else {
      this.provider = new MockProvider(this.tools);
      this.log.log('AI 비서: 모의 모드 (API 키 없음 — 규칙으로 질문을 해석하고 같은 도구로 실제 데이터를 조회)');
    }
  }

  /** 로컬 LLM 서버가 닿는지, 정한 모델이 있는지 시작 로그로 알린다 */
  private async probeLocal(client: OpenAiCompatClient): Promise<void> {
    const where = `${client.host}`;
    try {
      const models = await client.models(3_000);
      const want = client.cfg.model;
      if (want && !models.includes(want)) {
        this.log.warn(`AI 비서: 로컬 LLM (${where}) 연결됨, 그런데 모델 '${want}'이(가) 목록에 없습니다 (있는 모델: ${models.slice(0, 6).join(', ') || '없음'}). LLM_MODEL을 확인해 주세요`);
      } else if (!models.length) {
        this.log.warn(`AI 비서: 로컬 LLM (${where}) 연결됨, 그런데 불러온 모델이 없습니다. LM Studio·Ollama에서 모델을 불러와 주세요`);
      } else {
        this.log.log(`AI 비서: 로컬 LLM (${where}, 모델 ${want ?? `${models[0]} — LLM_MODEL이 없어 첫 모델`}) — 질문·공장 데이터가 이 망 밖으로 나가지 않습니다`);
      }
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'connect') {
        this.log.warn(`AI 비서: 로컬 LLM 서버에 닿지 않음 (${where}). 서버를 켤 때까지 질문은 연결 오류로 답합니다 — ${e.message}`);
      } else {
        this.log.warn(`AI 비서: 로컬 LLM 서버 (${where}) 확인 실패: ${(e as Error).message}`);
      }
    }
  }

  async info(): Promise<AssistantInfo> {
    return {
      mode: this.provider.mode,
      model: this.provider.model,
      external: isExternal(this.provider.mode),
      endpoint: this.endpoint,
      stt: { enabled: await this.stt.available(), model: this.stt.model },
      standards: this.standards.size,
      suggestions: SUGGESTIONS,
    };
  }

  /** 질문 하나를 처리하며 이벤트를 흘려보낸다. 끝나면 done 또는 error를 꼭 한 번 보낸다 */
  async chat(req: AssistantChatRequest, emit: (e: AssistantEvent) => void, signal: AbortSignal, clientIp = 'local'): Promise<void> {
    const message = (req.message ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
    const conv = this.conversation(req.conversationId);
    if (conv.busy) throw new ConflictException('이 대화는 아직 앞 질문에 답하는 중입니다');
    if (message) this.takeQuota(clientIp);
    conv.busy = true;
    conv.updatedAt = Date.now();
    const mark = conv.messages.length;
    const markOai = conv.oai.length;
    const started = Date.now();
    emit({ type: 'start', conversationId: conv.id, mode: this.provider.mode, model: this.provider.model });
    try {
      if (!message) throw new Error('질문이 비어 있습니다');
      const usage = await this.provider.run({
        conv, message, signal, emit,
        context: { page: req.context?.page?.slice(0, 200), station: req.context?.station ?? null },
      });
      emit({ type: 'done', usage, ms: Date.now() - started });
    } catch (err) {
      // 실패한 질문은 대화에서 통째로 뺀다 (짝이 안 맞는 tool_use가 남으면 다음 요청이 거부된다)
      conv.messages.length = mark;
      conv.oai.length = markOai;
      if (signal.aborted) return;
      const msg = friendly(err);
      this.log.warn(`질문 처리 실패: ${msg}${err instanceof Anthropic.APIError && err.requestID ? ` (request-id ${err.requestID})` : ''}`);
      emit({ type: 'error', message: msg });
    } finally {
      conv.busy = false;
      conv.updatedAt = Date.now();
    }
  }

  /** 질문 한도를 넘었으면 429. 둘 다 통과할 때만 센다 */
  private takeQuota(ip: string): void {
    if (this.provider.mode !== 'claude' || (!this.perHour && !this.perDay)) return;
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (this.perHour && recent.length >= this.perHour) {
      const wait = Math.max(1, Math.ceil((HOUR_MS - (now - recent[0])) / 60_000));
      throw new HttpException(`질문 한도(시간당 ${this.perHour}회)를 넘었습니다. 약 ${wait}분 뒤 다시 물어봐 주세요`, HttpStatus.TOO_MANY_REQUESTS);
    }
    // 한국 날짜가 바뀌면 하루 한도를 다시 센다
    const key = new Date(now + 9 * HOUR_MS).toISOString().slice(0, 10);
    if (this.day.key !== key) this.day = { key, n: 0 };
    if (this.perDay && this.day.n >= this.perDay) {
      throw new HttpException('오늘 시연용 질문 한도를 다 썼습니다. 내일 다시 물어봐 주세요', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.day.n++;
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < HOUR_MS)) this.hits.delete(k);
  }

  private conversation(id?: string): Conversation {
    const now = Date.now();
    for (const [k, c] of this.convs) if (!c.busy && now - c.updatedAt > CONV_TTL_MS) this.convs.delete(k);
    const found = id ? this.convs.get(id) : undefined;
    if (found) return found;
    while (this.convs.size >= MAX_CONVS) {
      const oldest = [...this.convs.values()].filter((c) => !c.busy).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      this.convs.delete(oldest.id);
    }
    const conv: Conversation = { id: randomUUID(), createdAt: now, updatedAt: now, busy: false, messages: [], oai: [], memo: {} };
    this.convs.set(conv.id, conv);
    return conv;
  }
}

export { friendly } from './llm.errors';
