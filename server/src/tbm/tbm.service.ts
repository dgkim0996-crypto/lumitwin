import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  LINES,
  SHIFT_NAMES,
  TBM_AUDIO_MAX_BYTES,
  TBM_JOB_NAMES,
  TBM_STATUS_NAMES,
  TBM_TEXT_MAX_BYTES,
  lineOf,
  shiftByKey,
  shiftOf,
  tbmSample,
  type ActorInfo,
  type LineCode,
  type TbmChecklistView,
  type TbmCounts,
  type TbmFollowUpInput,
  type TbmFollowUpKind,
  type TbmFollowUpView,
  type TbmInput,
  type TbmItem,
  type TbmItemResult,
  type TbmJobStatus,
  type TbmLine,
  type TbmMeetingDetail,
  type TbmMeetingView,
} from '@lumitwin/shared';
import { friendly } from '../assistant/llm.errors';
import { resolveLlmSettings } from '../assistant/llm.settings';
import { OpenAiCompatClient } from '../assistant/providers/openai-compat';
import { SttError, SttService } from '../assistant/stt.service';
import { ExecutionService } from '../execution/execution.service';
import { Prisma } from '../generated/prisma/client';
import { HealthService } from '../insights/health.service';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';
import { QualitySystemService } from '../quality-system/quality-system.service';
import { buildChecklist, type TbmMesState } from './tbm.checklist';
import { ClaudeJudge, LocalJudge, MockJudge, type TbmJudge } from './tbm.judge';
import { TranscriptError, decodeText, toLines } from './tbm.transcript';
import { chunkLines, mergeResults, parseJudge, validate } from './tbm.validator';

/** 회의 녹음 받아쓰기를 기다리는 시간. CPU에서 도는 Whisper로 20분 녹음을 생각해 넉넉히 (assumed) */
const STT_TIMEOUT_MS = Math.max(60, Number(process.env.TBM_STT_TIMEOUT_SEC) || 900) * 1000;
/** 받아쓰기 서버에 주는 TBM 용어 (정확도를 높인다) */
const TBM_STT_PROMPT = 'TBM, 안전 회의, 보호구, 안전모, 안전화, 보안경, LOTO, 잠금, 지게차, AMR, 변경점, 초물, Hold, 격리, 비상 정지, 대피, 사출기, 증착기, 리플로우, 정전기, 손목띠, 도장, 신너, 폴딩';
const TEXT_EXT = /\.(txt|text|md|vtt|srt)$/i;
const AUDIO_EXT = /\.(webm|weba|ogg|oga|opus|mp3|mpga|m4a|mp4|aac|wav|flac)$/i;
const MAX_NOTE = 200;
const OPEN_STATUSES = new Set(['MISSING', 'UNCERTAIN', 'PARTIAL']);

/** multer가 메모리에 올린 파일 (필요한 필드만) */
export interface TbmUpload {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

type MeetingRow = Awaited<ReturnType<PrismaService['tbmMeeting']['findFirstOrThrow']>>;
type FollowRow = Awaited<ReturnType<PrismaService['tbmFollowUp']['findFirstOrThrow']>>;

const isLine = (v: unknown): v is LineCode => typeof v === 'string' && LINES.some((l) => l.code === v);

/** multer는 파일 이름을 latin1로 읽는다. 한글 이름이 깨졌으면 UTF-8로 다시 읽는다 */
function fileName(raw: string | undefined): string | null {
  if (!raw) return null;
  const fixed = /[À-ÿ]/.test(raw) ? Buffer.from(raw, 'latin1').toString('utf8') : raw;
  return (fixed.includes('�') ? raw : fixed).slice(0, 120);
}

/**
 * TBM(작업 전 안전 회의) 체크리스트 대조.
 * 올린 대화록·녹음을 받아 → (녹음이면 받아쓰기) → 판정기(비서와 같은 설정: Claude·로컬 LLM·모의 규칙) → 서버 검증기 → DB 저장.
 * 받아쓰기·LLM 판정은 길게는 몇 분 걸려 화면 프록시(30초)를 넘기므로 백그라운드로 처리하고, 화면은 회의 기록을 다시 읽어 상태를 본다.
 * 한 번에 하나씩 처리한다 (로컬 LLM·Whisper가 한 대뿐인 사내 서버를 가정)
 */
@Injectable()
export class TbmService implements OnModuleInit {
  private readonly log = new Logger('TBM');
  private judge: TbmJudge = new MockJudge();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly writer: ProductionWriter,
    private readonly exec: ExecutionService,
    private readonly quality: QualitySystemService,
    private readonly health: HealthService,
    private readonly stt: SttService,
  ) {}

  async onModuleInit() {
    this.judge = makeJudge();
    this.log.log(`TBM 대조 판정: ${this.judge.mode === 'mock' ? '모의 모드 (낱말 규칙)' : `${this.judge.mode === 'claude' ? 'Claude' : '로컬 LLM'} (${this.judge.model ?? '서버 첫 모델'})`}`);
    // 처리 중에 서버가 꺼졌던 회의는 이어 할 수 없으므로(음성은 메모리에만 있었다) 실패로 표시한다
    try {
      const n = await this.prisma.tbmMeeting.updateMany({
        where: { status: { in: ['TRANSCRIBING', 'ANALYZING'] } },
        data: { status: 'FAILED', error: '서버가 다시 시작돼 처리가 중단됐습니다. 다시 올려 주세요' },
      });
      if (n.count) this.log.warn(`처리 중이던 TBM 회의 ${n.count}건을 실패로 표시 (서버 재시작)`);
    } catch (e) {
      this.log.warn(`TBM 회의 기록 정리 실패: ${(e as Error).message}`);
    }
  }

  /** 시험용: 판정기를 바꾼다 */
  useJudge(judge: TbmJudge): void {
    this.judge = judge;
  }

  // ───────────── 체크리스트 ─────────────

  /** 지금 MES 상태 (그 라인 것만 쓰이지만 거르는 일은 buildChecklist가 한다) */
  mesState(line: LineCode): TbmMesState {
    const snap = this.live.snapshot();
    const down = Object.values(snap.stations).filter((s) => s.state === 'DOWN').map((s) => s.code);
    const holds = this.exec.holdList('ACTIVE');
    let mrb = 0;
    try {
      mrb = this.exec.ncrList(undefined, line).summary.byStatus.WAIT_MRB ?? 0;
    } catch {
      mrb = 0;
    }
    return { downStations: down, holds: holds.holds, quarantine: holds.quarantine, fa: this.quality.faStatus(), health: this.health.view().stations, mrbWaiting: { [line]: mrb } };
  }

  private nowShift(): string {
    return shiftOf(this.live.virtualNow ?? Date.now()).key;
  }

  async checklist(line: LineCode): Promise<TbmChecklistView> {
    return {
      line,
      shift: this.nowShift(),
      t: this.live.virtualNow,
      items: buildChecklist(line, this.mesState(line)),
      mode: this.judge.mode,
      model: this.judge.model,
      stt: await this.stt.available(),
    };
  }

  sample(line: LineCode): { line: LineCode; fileName: string; text: string } {
    return { line, fileName: `예시 TBM 대화록 (${lineOf(line).name}).txt`, text: tbmSample(line) };
  }

  // ───────────── 회의 올리기 ─────────────

  /**
   * 회의 하나를 받는다. 대화록은 바로 줄로 나눠(형식 오류는 400으로 바로 알린다) 대조를 예약하고,
   * 녹음은 받아쓰기부터 예약한다. 처리는 뒤에서 하고 회의 기록을 바로 돌려준다
   */
  async create(body: { line?: unknown; shift?: unknown; text?: unknown; fileName?: unknown }, file: TbmUpload | undefined, who: ActorInfo): Promise<TbmMeetingView> {
    if (!isLine(body.line)) throw new BadRequestException('라인(HL·EM·OSM)을 골라 주세요');
    const line = body.line;
    let shift = this.nowShift();
    if (typeof body.shift === 'string' && body.shift.trim()) {
      const s = shiftByKey(body.shift.trim());
      if (!s) throw new BadRequestException('교대는 2026-11-14-D 같은 모양이어야 합니다');
      shift = s.key;
    }

    let input: TbmInput;
    let lines: TbmLine[] = [];
    let audio: TbmUpload | null = null;
    let name: string | null;
    if (file?.buffer?.length) {
      name = fileName(file.originalname);
      const isText = TEXT_EXT.test(name ?? '') || /^text\//.test(file.mimetype);
      const isAudio = !isText && (AUDIO_EXT.test(name ?? '') || /^(audio|video)\//.test(file.mimetype));
      if (isText) {
        if (file.size > TBM_TEXT_MAX_BYTES) throw new BadRequestException(`대화록 파일은 ${TBM_TEXT_MAX_BYTES / 1024}KB 이하여야 합니다`);
        input = 'TEXT';
        lines = this.lines(decodeText(file.buffer));
      } else if (isAudio) {
        if (file.size > TBM_AUDIO_MAX_BYTES) throw new BadRequestException(`음성 파일은 ${TBM_AUDIO_MAX_BYTES / 1024 / 1024}MB 이하여야 합니다 (받아쓰기 서버 한도). 녹음을 나눠 올려 주세요`);
        if (!(await this.stt.available())) {
          throw new BadRequestException('받아쓰기 서버가 꺼져 있어 음성을 올릴 수 없습니다. 대화록 텍스트 파일(.txt)로 올리거나 받아쓰기 서버(npm run whisper)를 켜 주세요');
        }
        input = 'AUDIO';
        audio = file;
      } else {
        throw new BadRequestException('대화록(.txt·.vtt·.srt) 또는 음성(.webm·.m4a·.mp3·.wav 등) 파일만 올릴 수 있습니다');
      }
    } else if (typeof body.text === 'string' && body.text.trim()) {
      if (Buffer.byteLength(body.text) > TBM_TEXT_MAX_BYTES) throw new BadRequestException(`대화록은 ${TBM_TEXT_MAX_BYTES / 1024}KB 이하여야 합니다`);
      input = 'TEXT';
      name = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 120) : null;
      lines = this.lines(body.text);
    } else {
      throw new BadRequestException('대화록 파일, 음성 파일 또는 대화록 글이 필요합니다');
    }

    const checklist = buildChecklist(line, this.mesState(line));
    const v = this.live.virtualNow;
    const row = await this.prisma.tbmMeeting.create({
      data: {
        runId: this.writer.currentRunId,
        line,
        shift,
        input,
        fileName: name,
        status: input === 'AUDIO' ? 'TRANSCRIBING' : 'ANALYZING',
        mode: this.judge.mode,
        model: this.judge.model,
        createdBy: who.name,
        vAt: v ? new Date(v) : null,
        checklist: checklist as unknown as Prisma.InputJsonValue,
        lines: lines as unknown as Prisma.InputJsonValue,
      },
    });
    const job = { id: row.id, line, shift, checklist, lines, audio, started: Date.now() };
    this.chain = this.chain.then(() => this.process(job)).catch(() => undefined);
    return this.view(row, []);
  }

  private lines(text: string): TbmLine[] {
    try {
      return toLines(text);
    } catch (e) {
      if (e instanceof TranscriptError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** 받아쓰기 → 판정 → 검증 → 저장 → (안 다룸·불확실이 있으면) 알람 */
  private async process(job: { id: number; line: LineCode; shift: string; checklist: TbmItem[]; lines: TbmLine[]; audio: TbmUpload | null; started: number }): Promise<void> {
    let { lines } = job;
    try {
      if (job.audio) {
        const a = job.audio;
        const out = await this.stt.transcribeSegments(a.buffer, a.mimetype, fileName(a.originalname) ?? 'tbm.webm', { prompt: TBM_STT_PROMPT, timeoutMs: STT_TIMEOUT_MS });
        if (!out.segments.length) throw new TranscriptError('녹음에서 말소리를 찾지 못했습니다. 녹음이 들리는지 확인해 주세요');
        lines = toLines(out.segments.join('\n'));
        job.audio = null; // 음성은 저장하지 않는다 (받아쓴 글만 남긴다)
        await this.prisma.tbmMeeting.update({ where: { id: job.id }, data: { status: 'ANALYZING', lines: lines as unknown as Prisma.InputJsonValue } });
      }

      const judge = this.judge;
      const chunks = chunkLines(lines, judge.chunkChars, judge.overlap);
      const shiftSlot = shiftByKey(job.shift);
      const ctx = { lineName: lineOf(job.line).name, shiftLabel: shiftSlot ? `${shiftSlot.date} ${SHIFT_NAMES[shiftSlot.code]}` : job.shift };
      const parts: TbmItemResult[][] = [];
      const changes: string[] = [];
      for (const [i, chunk] of chunks.entries()) {
        const raw = await judge.judge(job.checklist, chunk, { ...ctx, part: { index: i + 1, total: chunks.length } });
        const parsed = parseJudge(raw);
        const checked = validate(job.checklist, lines, parsed.items, parsed.dropped);
        parts.push(checked.results);
        changes.push(...checked.changes.map((c) => (chunks.length > 1 ? `조각 ${i + 1}: ${c}` : c)));
      }
      const items = mergeResults(parts);
      const counts = countOf(items);
      const alarmed = counts.missing + counts.uncertain > 0;
      await this.prisma.tbmMeeting.update({
        where: { id: job.id },
        data: {
          status: 'DONE',
          error: null,
          mode: judge.mode,
          model: judge.model,
          analyzedAt: new Date(),
          ms: Date.now() - job.started,
          items: items as unknown as Prisma.InputJsonValue,
          changes: changes.slice(0, 100),
          chunks: chunks.length,
          ...counts,
          alarmed,
        },
      });
      if (alarmed) this.alarm(job.line, ctx.shiftLabel, items, counts);
      this.log.log(`TBM 대조 완료 #${job.id} ${job.line}: 다룸 ${counts.covered} · 부분 ${counts.partial} · 안 다룸 ${counts.missing} · 불확실 ${counts.uncertain} (${judge.mode}, ${chunks.length}조각)`);
    } catch (e) {
      const msg = e instanceof TranscriptError || e instanceof SttError ? e.message : friendlyJudgeError(e);
      this.log.warn(`TBM 처리 실패 #${job.id}: ${msg}`);
      await this.prisma.tbmMeeting.update({ where: { id: job.id }, data: { status: 'FAILED', error: msg.slice(0, 300), ms: Date.now() - job.started } }).catch(() => undefined);
    }
  }

  /** 라인 알람: 그 라인 투입 공정 설비에 건다 (작업지시 알람과 같은 방식) */
  private alarm(line: LineCode, shiftLabel: string, items: TbmItemResult[], c: TbmCounts): void {
    const def = lineOf(line);
    const station = def.stations.find((s) => s.step === def.release)?.code ?? def.stations[0].code;
    const miss = items.filter((i) => i.status === 'MISSING' || i.status === 'UNCERTAIN').map((i) => `${i.title}(${TBM_STATUS_NAMES[i.status]})`);
    const title = `TBM 미흡 · ${def.name} ${shiftLabel}: 안 다룸 ${c.missing}${c.uncertain ? ` · 불확실 ${c.uncertain}` : ''}`;
    this.live.raiseAlarm(station, 'warn', 'TBM', title, `${miss.slice(0, 4).join(', ')}${miss.length > 4 ? ` 외 ${miss.length - 4}건` : ''} — TBM 화면에서 조장이 보완·확인해 주세요`);
  }

  // ───────────── 조회 ─────────────

  async list(line?: string, limit = 20): Promise<TbmMeetingView[]> {
    const rows = await this.prisma.tbmMeeting.findMany({
      where: isLine(line) ? { line } : {},
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(1, Math.floor(limit) || 20), 100),
    });
    const follows = rows.length ? await this.prisma.tbmFollowUp.findMany({ where: { meetingId: { in: rows.map((r) => r.id) } } }) : [];
    return rows.map((r) => this.view(r, follows.filter((f) => f.meetingId === r.id)));
  }

  async detail(id: number): Promise<TbmMeetingDetail> {
    const row = await this.prisma.tbmMeeting.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`TBM 회의 #${id}이(가) 없습니다`);
    const follows = await this.prisma.tbmFollowUp.findMany({ where: { meetingId: id } });
    const byCode = new Map(follows.map((f) => [f.code, followView(f)]));
    const items = (row.items as unknown as TbmItemResult[]).map((i) => ({ ...i, followUp: byCode.get(i.code) ?? null }));
    return { ...this.view(row, follows), lines: row.lines as unknown as TbmLine[], items, changes: row.changes, chunks: row.chunks };
  }

  private view(r: MeetingRow, follows: FollowRow[]): TbmMeetingView {
    const done = new Set(follows.map((f) => f.code));
    const items = (r.items as unknown as TbmItemResult[]) ?? [];
    return {
      id: r.id,
      line: r.line as LineCode,
      shift: r.shift,
      input: r.input as TbmInput,
      fileName: r.fileName,
      status: r.status as TbmJobStatus,
      error: r.error,
      mode: r.mode as TbmMeetingView['mode'],
      model: r.model,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      vAt: r.vAt?.toISOString() ?? null,
      analyzedAt: r.analyzedAt?.toISOString() ?? null,
      ms: r.ms,
      counts: { covered: r.covered, partial: r.partial, missing: r.missing, uncertain: r.uncertain },
      open: items.filter((i) => OPEN_STATUSES.has(i.status) && !done.has(i.code)).length,
      lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
      alarmed: r.alarmed,
    };
  }

  // ───────────── 조장 후속 조치 ─────────────

  /** 빠진 항목(안 다룸·불확실·부분)에 보완 전달·확인을 남긴다. 같은 항목에 다시 하면 고친다 */
  async followUp(id: number, body: TbmFollowUpInput, who: ActorInfo): Promise<{ detail: TbmMeetingDetail; followUp: TbmFollowUpView; title: string }> {
    const row = await this.prisma.tbmMeeting.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`TBM 회의 #${id}이(가) 없습니다`);
    if (row.status !== 'DONE') throw new BadRequestException(`대조가 끝난 회의에만 후속 조치를 남길 수 있습니다 (지금: ${TBM_JOB_NAMES[row.status as TbmJobStatus] ?? row.status})`);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const item = (row.items as unknown as TbmItemResult[]).find((i) => i.code === code);
    if (!item) throw new BadRequestException(`이 회의에 없는 항목입니다: ${code.slice(0, 40)}`);
    if (!OPEN_STATUSES.has(item.status)) throw new BadRequestException('이미 다룬 항목입니다');
    const kind = body?.kind as TbmFollowUpKind;
    if (kind !== 'SUPPLEMENTED' && kind !== 'CONFIRMED') throw new BadRequestException('후속 조치는 보완 전달(SUPPLEMENTED) 또는 확인(CONFIRMED)입니다');
    const note = typeof body?.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NOTE) || null : null;
    if (kind === 'CONFIRMED' && !note && item.status !== 'PARTIAL') throw new BadRequestException('안 다룸·불확실 항목을 확인으로 닫으려면 이유를 메모로 남겨 주세요 (예: 오늘 해당 작업 없음)');
    const v = this.live.virtualNow;
    const data = { kind, note, by: who.name, role: who.role, at: new Date(), vAt: v ? new Date(v) : null };
    const f = await this.prisma.tbmFollowUp.upsert({ where: { meetingId_code: { meetingId: id, code } }, create: { meetingId: id, code, ...data }, update: data });
    return { detail: await this.detail(id), followUp: followView(f), title: item.title };
  }

  // ───────────── AI 비서 ─────────────

  /** 비서 도구(tbm_status): 라인별 가장 최근 회의 또는 고른 회의의 빠진 항목 */
  async assistantStatus(input: { line?: LineCode; meetingId?: number }) {
    if (input.meetingId != null) return { meetings: [this.brief(await this.detail(input.meetingId))] };
    const lines = input.line ? [input.line] : LINES.map((l) => l.code);
    const out = [];
    for (const l of lines) {
      const last = await this.prisma.tbmMeeting.findFirst({ where: { line: l }, orderBy: { id: 'desc' } });
      out.push(last ? this.brief(await this.detail(last.id)) : { line: l, lineName: lineOf(l).name, meeting: null });
    }
    return { mode: this.judge.mode, meetings: out };
  }

  private brief(d: TbmMeetingDetail) {
    return {
      line: d.line,
      lineName: lineOf(d.line).name,
      meeting: { id: d.id, shift: d.shift, status: TBM_JOB_NAMES[d.status], error: d.error, createdBy: d.createdBy, createdAt: d.createdAt, judgedBy: d.mode, model: d.model, counts: d.counts, open: d.open },
      notCovered: d.items
        .filter((i) => i.status !== 'COVERED')
        .map((i) => ({ code: i.code, title: i.title, status: TBM_STATUS_NAMES[i.status], note: i.note, followUp: i.followUp ? `${i.followUp.kind === 'SUPPLEMENTED' ? '보완 전달' : '확인'} (${i.followUp.by})` : null })),
    };
  }
}

function makeJudge(): TbmJudge {
  const s = resolveLlmSettings();
  if (s.mode === 'claude') return new ClaudeJudge(s.model, s.effort);
  if (s.mode === 'local') return new LocalJudge(new OpenAiCompatClient(s.local));
  return new MockJudge();
}

function countOf(items: TbmItemResult[]): TbmCounts {
  return {
    covered: items.filter((i) => i.status === 'COVERED').length,
    partial: items.filter((i) => i.status === 'PARTIAL').length,
    missing: items.filter((i) => i.status === 'MISSING').length,
    uncertain: items.filter((i) => i.status === 'UNCERTAIN').length,
  };
}

function followView(f: FollowRow): TbmFollowUpView {
  return { id: f.id, code: f.code, kind: f.kind as TbmFollowUpKind, note: f.note, by: f.by, at: f.at.toISOString() };
}

/** 판정기 오류를 현장 문장으로 (비서와 같은 문장. API 키는 들어가지 않는다) */
function friendlyJudgeError(e: unknown): string {
  return `대조 실패: ${friendly(e)}`;
}
