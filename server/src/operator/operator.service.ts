import { BadRequestException, Injectable } from '@nestjs/common';
import { STATIONS, type CheckItem, type CheckRecordView, type CheckRequest } from '@lumitwin/shared';
import type { CheckRecord } from '../generated/prisma/client';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';

const MAX_ITEMS = 30;
const MAX_TEXT = 300;
const MAX_BY = 30;

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function toView(r: CheckRecord): CheckRecordView {
  return { id: r.id, station: r.station, doc: r.doc, items: r.items as unknown as CheckItem[], ngCount: r.ngCount, by: r.by, at: r.at.toISOString() };
}

/**
 * 작업자 태블릿의 입력을 MES 기록으로 남긴다.
 * 작업 전 점검은 설비·가상 시각·항목별 결과로 저장하고, 이상 항목이 있으면 알람(CHECK)을 올려 3D·알람 목록·AI 비서가 같이 본다.
 */
@Injectable()
export class OperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly writer: ProductionWriter,
  ) {}

  private async runId(): Promise<number> {
    const run = this.live.currentRun;
    if (!run) throw new BadRequestException('시뮬레이터가 아직 실행을 알리지 않았습니다. 시뮬레이터를 켜 주세요');
    return this.writer.resolveRun(run);
  }

  async saveCheck(body: CheckRequest): Promise<CheckRecordView> {
    const station = clean(body?.station, 20);
    const st = STATIONS[station];
    if (!st) throw new BadRequestException(`설비 ${station}이(가) 없습니다`);
    if (!Array.isArray(body.items) || body.items.length === 0) throw new BadRequestException('점검 항목이 없습니다');
    if (body.items.length > MAX_ITEMS) throw new BadRequestException(`점검 항목은 ${MAX_ITEMS}개까지입니다`);
    const items: CheckItem[] = body.items.map((x) => ({ text: clean(x?.text, MAX_TEXT), ok: x?.ok === true }));
    if (items.some((x) => !x.text)) throw new BadRequestException('내용이 빈 점검 항목이 있습니다');
    const ng = items.filter((x) => !x.ok);
    const at = this.live.virtualNow ?? new Date().toISOString();
    const row = await this.prisma.checkRecord.create({
      data: { runId: await this.runId(), station, doc: clean(body.doc, 20) || null, items: items as unknown as object, ngCount: ng.length, by: clean(body.by, MAX_BY) || null, at: new Date(at) },
    });
    if (ng.length) {
      const first = ng[0].text.length > 60 ? `${ng[0].text.slice(0, 60)}…` : ng[0].text;
      this.live.raiseFromOperator(station, 'CHECK', `${st.name} 작업 전 점검 이상 ${ng.length}건`, `${first}${ng.length > 1 ? ` 외 ${ng.length - 1}건` : ''}${row.by ? ` · 점검자 ${row.by}` : ''}`);
    }
    return toView(row);
  }

  /** 지금 실행에서 이 설비의 최근 점검 (새것부터) */
  async checks(station?: string, limit = 10): Promise<CheckRecordView[]> {
    if (station && !STATIONS[station]) throw new BadRequestException(`설비 ${station}이(가) 없습니다`);
    const run = this.live.currentRun;
    if (!run) return [];
    const rows = await this.prisma.checkRecord.findMany({
      where: { runId: await this.writer.resolveRun(run), ...(station ? { station } : {}) },
      orderBy: { at: 'desc' },
      take: Math.min(50, Math.max(1, limit)),
    });
    return rows.map(toView);
  }
}
