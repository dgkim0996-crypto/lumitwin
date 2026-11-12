// 공장 정의(단일 원본)의 무결성 검사. 시뮬레이터·MES·화면·AI 비서가 모두 이 정의를 믿으므로,
// 잘못된 참조(없는 태그·설비·공정)는 실행 중이 아니라 여기서 걸러야 한다.
// 실행: npm test -w shared (먼저 npm run build -w shared)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FACTORY, STATIONS } from '../dist/index.mjs';

const lines = FACTORY.lines;
const allStations = lines.flatMap((l) => l.stations.map((s) => ({ ...s, line: l.code })));
const attrKeys = new Set(allStations.flatMap((s) => (s.attrs ?? []).map((a) => a.key)));

/** 'tag:key' · 'tag:CODE.key' · 'attr:key' 참조가 실제로 있는지 */
function refExists(ref, here) {
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const name = ref.slice(i + 1);
  if (kind === 'attr') return attrKeys.has(name);
  if (kind === 'tag') {
    const [code, key] = name.includes('.') ? name.split('.', 2) : [here.code, name];
    return !!STATIONS[code]?.tags.some((t) => t.key === key);
  }
  return false;
}

describe('공장 정의', () => {
  it('라인 3개, 설비 38대', () => {
    assert.deepEqual(lines.map((l) => l.code), ['HL', 'EM', 'OSM']);
    assert.equal(allStations.length, 38);
    assert.equal(Object.keys(STATIONS).length, 38);
  });

  it('설비 코드가 겹치지 않는다', () => {
    const codes = allStations.map((s) => s.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  it('설비는 자기 라인의 공정에 속하고, 라인의 마지막 공정이 있다', () => {
    for (const l of lines) {
      const steps = new Set(l.steps.map((s) => s.code));
      assert.ok(steps.has(l.finalStep), `${l.code} finalStep ${l.finalStep}`);
      for (const s of l.stations) assert.ok(steps.has(s.step), `${s.code} → 공정 ${s.step}`);
      for (const st of l.steps) assert.ok(l.stations.some((s) => s.step === st.code), `${l.code} 공정 ${st.code}에 설비가 없다`);
    }
  });

  it('공정 입력은 같은 라인 공정·이송·구매 자재 중 하나를 가리킨다', () => {
    const transfers = new Set(FACTORY.transfers.map((t) => t.code));
    const materials = new Set(FACTORY.materials.map((m) => m.code));
    for (const l of lines) {
      const steps = new Set(l.steps.map((s) => s.code));
      for (const st of l.steps) {
        for (const inp of st.inputs) {
          const n = [inp.step, inp.transfer, inp.material].filter(Boolean).length;
          assert.equal(n, 1, `${l.code}.${st.code} 입력은 하나만 가리킨다`);
          if (inp.step) assert.ok(steps.has(inp.step), `${l.code}.${st.code} ← ${inp.step}`);
          if (inp.transfer) assert.ok(transfers.has(inp.transfer), `${l.code}.${st.code} ← 이송 ${inp.transfer}`);
          if (inp.material) assert.ok(materials.has(inp.material), `${l.code}.${st.code} ← 자재 ${inp.material}`);
          assert.ok(inp.qty > 0);
        }
      }
    }
  });

  it('이송은 실제 라인 공정이나 창고를 잇고, AMR이 있다', () => {
    const amrs = new Set(FACTORY.amrs.map((a) => a.code));
    const warehouses = new Set(FACTORY.warehouses.map((w) => w.code));
    for (const t of FACTORY.transfers) {
      for (const end of [t.from, t.to]) {
        if (end.warehouse) {
          assert.ok(warehouses.has(end.warehouse), `${t.code} 창고 ${end.warehouse}`);
          continue;
        }
        const l = lines.find((x) => x.code === end.line);
        assert.ok(l?.steps.some((s) => s.code === end.step), `${t.code} ${end.line}.${end.step}`);
      }
      assert.ok(amrs.has(t.amr), `${t.code} AMR ${t.amr}`);
    }
  });

  it('태그·부품 속성·측정값·불량 원인이 가리키는 신호가 모두 있다 (불량 인과 사슬이 끊기지 않는다)', () => {
    const broken = [];
    for (const s of allStations) {
      const terms = [
        ...s.tags.flatMap((t) => t.terms ?? []),
        ...(s.attrs ?? []).flatMap((a) => a.terms ?? []),
        ...(s.measures ?? []).flatMap((m) => m.terms ?? []),
        ...(s.defects ?? []).flatMap((d) => d.drivers),
      ];
      for (const t of terms) if (!refExists(t.ref, s)) broken.push(`${s.code}: ${t.ref}`);
    }
    assert.deepEqual(broken, []);
  });

  it('검사 공정이 찾는 잠재 불량은 어딘가에서 잠재 불량으로 정의돼 있다', () => {
    const latent = new Set(allStations.flatMap((s) => (s.defects ?? []).filter((d) => d.latent).map((d) => d.code)));
    for (const s of allStations) {
      for (const d of s.detects ?? []) {
        assert.ok(latent.has(d.defect), `${s.code} 검출 ${d.defect}`);
        assert.ok(d.prob > 0 && d.prob <= 1);
      }
    }
  });

  it('설비 값이 말이 된다 (사이클·MTBF·MTTR·기본 불량률)', () => {
    for (const s of allStations) {
      assert.ok(s.cycle >= 0, `${s.code} cycle`);
      assert.ok(s.mtbf > 0 && s.mttr > 0, `${s.code} MTBF·MTTR`);
      for (const d of s.defects ?? []) assert.ok(d.base >= 0 && d.base < 0.2, `${s.code} ${d.code} base ${d.base}`);
      for (const t of s.tags) if (t.lsl != null && t.usl != null) assert.ok(t.lsl < t.usl, `${s.code}.${t.key} 규격`);
    }
  });

  it('재가동 초품 규칙은 그 설비의 불량 코드를 쓰고 값이 말이 된다', () => {
    const withWarmup = allStations.filter((s) => s.warmup);
    assert.ok(withWarmup.length >= 1, '초기 수율 로스를 만들 설비가 하나도 없다');
    for (const s of withWarmup) {
      const w = s.warmup;
      assert.ok((s.defects ?? []).some((d) => d.code === w.defect && !d.latent), `${s.code} 초품 불량 ${w.defect}이 즉시 판정 불량에 없다`);
      assert.ok(w.shots >= 1 && Number.isInteger(w.shots), `${s.code} shots`);
      assert.ok(w.prob > 0 && w.prob <= 1, `${s.code} prob`);
      assert.ok(w.minHalt > 0, `${s.code} minHalt`);
      assert.ok(s.cycle > 0, `${s.code}: 사이클 없는 설비에는 초품이 없다`);
    }
  });

  it('시나리오 효과가 실제 설비·신호를 건드린다', () => {
    const ids = FACTORY.scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const sc of FACTORY.scenarios) {
      assert.ok(sc.effects.length > 0, sc.id);
      for (const e of sc.effects) {
        const st = STATIONS[e.station];
        assert.ok(st, `${sc.id} 설비 ${e.station}`);
        if (e.target === 'tag') assert.ok(st.tags.some((t) => t.key === e.key), `${sc.id} 태그 ${e.key}`);
        if (e.target === 'attr') assert.ok(attrKeys.has(e.key), `${sc.id} 속성 ${e.key}`);
        if (e.target === 'measure') assert.ok(st.measures?.some((m) => m.key === e.key), `${sc.id} 측정 ${e.key}`);
        if (e.mode === 'drift') assert.ok(e.rate && e.limit != null, `${sc.id} drift는 rate·limit`);
        if (e.mode === 'step') assert.ok(e.amount != null, `${sc.id} step은 amount`);
        if (e.lot) assert.ok(FACTORY.materials.some((m) => m.code === e.lot), `${sc.id} 자재 ${e.lot}`);
      }
    }
  });
});
