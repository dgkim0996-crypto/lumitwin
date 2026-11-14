// 공장 정의(단일 원본)의 무결성 검사. 시뮬레이터·MES·화면·AI 비서가 모두 이 정의를 믿으므로,
// 잘못된 참조(없는 태그·설비·공정)는 실행 중이 아니라 여기서 걸러야 한다.
// 실행: npm test -w shared (먼저 npm run build -w shared)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FACTORY, OPERATOR_REASONS, PM_PLANS, PM_REASON, STATIONS, VIB_ZONES, defectDefOf, inProductScope } from '../dist/index.mjs';

/**
 * 설비 바닥 크기 [길이(x), 폭(z)] (m). client/src/components/scene/machines/common.tsx의 FOOTPRINT를 옮겨 적었다
 * (화면 쪽 값은 "바꾸지 않는다"로 고정돼 있다). 새 설비 위치가 다른 설비와 겹치지 않는지 보는 데 쓴다
 */
const FOOTPRINT = {
  dryer: [1.6, 1.6], injection: [8, 2.4], 'tunnel-hardcoat': [16, 3.2], metallizer: [5, 3.6], 'assembly-cell': [6, 5], sealer: [5, 3.6],
  'leak-tester': [3.6, 2.6], photometry: [6, 3.2], 'eol-tester': [3.6, 2.6], packer: [4, 3], 'laser-marker': [1.6, 1.7], printer: [1.9, 1.9],
  spi: [1.5, 1.7], mounter: [2.8, 2.3], reflow: [5.4, 1.7], aoi: [1.5, 1.7], 'router-cobot': [3.6, 3], ict: [1.7, 1.9], coater: [2.6, 1.9],
  fct: [2.4, 1.6], 'screw-cell': [3, 3], 'tunnel-paint': [18, 3.6], 'actuator-cell': [5, 4], 'function-tester': [4, 3],
};
const DISPOSITIONS = ['REPAIR', 'REWORK', 'SCRAP', 'MRB'];

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
  it('라인 3개, 설비 40대 (P9: LED SPI·LED 모듈 시험 추가)', () => {
    assert.deepEqual(lines.map((l) => l.code), ['HL', 'EM', 'OSM']);
    assert.equal(allStations.length, 40);
    assert.equal(Object.keys(STATIONS).length, 40);
  });

  it('모든 설비에 고장 모델(MTBF·MTTR)과 계획 보전 기준이 있다', () => {
    for (const s of allStations) {
      assert.ok(s.mtbf > 0 && s.mttr > 0, `${s.code} mtbf·mttr`);
      const pm = PM_PLANS[s.kind];
      assert.ok(pm && pm.every > 0 && pm.minutes > 0 && pm.task, `${s.code}(${s.kind}) 계획 보전 기준`);
    }
    // 작업자가 계획 정지 사유로 고를 수 있어야 계획 보전 실시가 기록된다
    assert.ok(OPERATOR_REASONS.stop.includes(PM_REASON));
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
        if (e.target === 'wear') {
          // 마모 속도 배수: 상태 감시(health)가 있는 설비에만, 즉시(step) 양수 배수로 건다
          assert.ok(st.health, `${sc.id}: ${e.station}에 상태 감시 기준이 없다`);
          assert.ok(e.mode === 'step' && e.amount > 0, `${sc.id} wear는 step·양수 amount`);
        }
        if (e.mode === 'drift') assert.ok(e.rate && e.limit != null, `${sc.id} drift는 rate·limit`);
        if (e.mode === 'step') assert.ok(e.amount != null, `${sc.id} step은 amount`);
        if (e.lot) assert.ok(FACTORY.materials.some((m) => m.code === e.lot), `${sc.id} 자재 ${e.lot}`);
      }
    }
    assert.ok(FACTORY.scenarios.some((sc) => sc.effects.some((e) => e.target === 'wear')), '예지 보전 시연용 마모 시나리오가 없다');
  });

  // ─────────────── P9: 전력·상태 감시·불량 처리 기준·연배 분할·배치 ───────────────

  it('모든 설비에 소비 전력이 있고 가공 ≥ 대기 ≥ 정지 ≥ 0이다', () => {
    for (const s of allStations) {
      const p = s.power;
      assert.ok(p, `${s.code} 전력 없음`);
      assert.ok(p.run > 0 && p.run >= p.idle && p.idle >= p.off && p.off >= 0, `${s.code} 전력 ${p.run}/${p.idle}/${p.off}`);
      assert.ok(p.run < 500, `${s.code} 전력이 너무 크다 (kW 단위인지)`);
      assert.ok(['confirmed', 'weak', 'assumed'].includes(p.grade), `${s.code} 전력 근거 등급`);
    }
  });

  it('상태 감시 기준이 말이 된다 (신품은 진동 A구역, 마모 끝에는 B/C 경고를 넘는다)', () => {
    const watched = allStations.filter((s) => s.health);
    assert.ok(watched.length >= 10, `상태 감시 설비가 ${watched.length}대뿐이다`);
    // 사출기 5대는 모두 감시한다
    assert.equal(allStations.filter((s) => s.kind === 'injection' && s.health).length, allStations.filter((s) => s.kind === 'injection').length);
    for (const s of watched) {
      const h = s.health;
      const z = VIB_ZONES[h.cls];
      assert.ok(z, `${s.code} 진동 등급 ${h.cls}`);
      assert.ok(h.vib > 0 && h.vib < z.ab, `${s.code} 신품 진동 ${h.vib}는 A구역(< ${z.ab})이어야 한다`);
      // 시뮬레이터 모델: 가동 중 진동 ≈ 신품 × (1 + 3·마모²) → 마모 1이면 4배. 마모 끝에는 경고(B/C)를 넘어야 예지 보전이 보인다
      assert.ok(h.vib * 4 > z.bc, `${s.code} 마모 끝 진동 ${h.vib * 4}가 B/C 경계 ${z.bc}를 못 넘는다`);
      assert.ok(h.cur > 0 && h.temp > 0, `${s.code} 전류·온도`);
      assert.ok(h.wearHours >= 10 && h.wearHours <= 1000, `${s.code} wearHours ${h.wearHours} (시연용 가상 시간)`);
      assert.ok(h.part, `${s.code} 마모 부위`);
      assert.ok(!s.aux && s.cycle > 0, `${s.code}: 가공하지 않는 설비에는 마모를 쌓지 않는다`);
    }
  });

  it('보조 설비는 사이클이 0이고, 붙어 있는 공정에 주 설비가 따로 있다', () => {
    const aux = allStations.filter((s) => s.aux);
    assert.ok(aux.some((s) => s.code === 'HL-DR-01'), '건조기는 보조 설비');
    for (const s of aux) {
      assert.equal(s.cycle, 0, `${s.code} 보조 설비 사이클`);
      assert.ok(allStations.some((o) => o.line === s.line && o.step === s.step && !o.aux), `${s.code}: 공정 ${s.step}에 주 설비가 없다`);
    }
  });

  it('연배 분할 공정은 시리얼을 이어 쓰고, 그 설비는 배치를 쓰지 않는다', () => {
    const splits = lines.flatMap((l) => l.steps.filter((st) => st.split != null).map((st) => ({ l, st })));
    assert.ok(splits.some(({ st }) => st.code === 'LED_ROUTE' && st.split === 4), 'LED 라우팅은 4분할');
    for (const { l, st } of splits) {
      assert.ok(Number.isInteger(st.split) && st.split >= 2, `${l.code}.${st.code} split ${st.split}`);
      assert.equal(st.serial, 'keep', `${l.code}.${st.code}: 분할 공정은 입력 시리얼 뒤에 -1, -2 …를 붙인다`);
      assert.ok(st.buffer >= st.split, `${l.code}.${st.code}: 출력 버퍼가 한 번 분할한 개수보다 작다`);
      for (const s of l.stations.filter((x) => x.step === st.code)) assert.ok((s.batch ?? 1) === 1, `${s.code}: 분할(split)과 배치(batch)를 함께 쓰면 개수가 곱해진다`);
    }
  });

  it('이송 출발 공정의 출력은 같은 라인의 다른 공정이 가져가지 않는다 (AMR만 싣는다)', () => {
    for (const t of FACTORY.transfers) {
      const l = lines.find((x) => x.code === t.from.line);
      const takers = l.steps.filter((st) => st.inputs.some((i) => i.step === t.from.step));
      assert.deepEqual(takers.map((x) => x.code), [], `${t.code} 출발 ${t.from.step}`);
    }
  });

  it('설비 바닥 영역이 서로 겹치지 않고 자기 라인 베이 안에 있다, 컨베이어도 베이 안에 있다', () => {
    const box = (s) => {
      const [L, D] = FOOTPRINT[s.kind];
      const rot = (((s.rot ?? 0) % 180) + 180) % 180;
      assert.ok(rot === 0 || rot === 90, `${s.code} 회전은 90° 단위만 검사한다`);
      const [w, d] = rot === 90 ? [D, L] : [L, D];
      return { x0: s.pos[0] - w / 2, x1: s.pos[0] + w / 2, z0: s.pos[1] - d / 2, z1: s.pos[1] + d / 2 };
    };
    const boxes = allStations.map((s) => ({ s, b: box(s) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].b;
        const b = boxes[j].b;
        const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0;
        assert.ok(apart, `${boxes[i].s.code}와 ${boxes[j].s.code}가 겹친다`);
      }
    }
    for (const l of lines) {
      for (const { s, b } of boxes.filter((x) => x.s.line === l.code)) {
        assert.ok(b.x0 >= l.bay.x0 && b.x1 <= l.bay.x1 && b.z0 >= l.bay.z0 && b.z1 <= l.bay.z1, `${s.code}가 ${l.code} 베이 밖에 있다`);
      }
      for (const poly of l.conveyors) {
        for (const [x, z] of poly) assert.ok(x >= l.bay.x0 && x <= l.bay.x1 && z >= l.bay.z0 && z <= l.bay.z1, `${l.code} 컨베이어 점 (${x}, ${z})`);
      }
    }
  });

  it('불량 처리 기준 값이 말이 되고, 같은 불량 코드는 공장 전체에서 기준이 하나다', () => {
    const seen = new Map();
    for (const s of allStations) {
      const srcs = [...(s.defects ?? []).map((d) => ({ code: d.code, d })), ...(s.measures ?? []).map((m) => ({ code: m.defect, d: m }))];
      for (const { code, d } of srcs) {
        if (d.disposition) {
          assert.ok(DISPOSITIONS.includes(d.disposition), `${s.code} ${code} 처리 ${d.disposition}`);
          if (d.disposition !== 'SCRAP') {
            // 수리·재작업과, MRB에서 수리를 고를 때 걸리는 시간·성공률
            assert.ok(d.repairMin > 0 && d.repairMin <= 120, `${s.code} ${code} repairMin`);
            assert.ok(d.repairProb > 0 && d.repairProb <= 1, `${s.code} ${code} repairProb`);
          }
          assert.ok(d.note, `${s.code} ${code}: 처리 기준 근거(note)가 없다`);
        }
        // mes.ts defectDefOf는 코드로 첫 정의를 찾으므로, 같은 코드의 처리 기준이 다르면 뒤 정의는 무시된다
        const key = JSON.stringify([d.disposition ?? null, d.repairMin ?? null, d.repairProb ?? null]);
        if (seen.has(code)) assert.equal(key, seen.get(code).key, `${code}: ${seen.get(code).at}와 ${s.code}의 처리 기준이 다르다`);
        else seen.set(code, { key, at: s.code });
      }
    }
  });

  it('제품 경로에서 날 수 있는 불량은 모두 처리 기준(disposition)이 정해져 있다', () => {
    const missing = [];
    for (const l of lines) {
      for (const s of l.stations.filter((x) => inProductScope(l, x.step))) {
        const codes = [
          ...(s.defects ?? []).filter((d) => !d.latent).map((d) => d.code),
          ...(s.measures ?? []).map((m) => m.defect),
          ...(s.detects ?? []).map((d) => d.defect),
        ];
        for (const c of codes) {
          const { def, measure } = defectDefOf(c);
          if (!(def ?? measure)?.disposition) missing.push(`${s.code} ${c}`);
        }
      }
    }
    assert.deepEqual(missing, []);
    // 품질 판정(MRB)으로 가는 경계성 불량이 라인마다 하나 이상은 있다 (불량 처리 화면 시연용)
    for (const code of ['LUX', 'BUBBLE', 'NOISE']) assert.equal((defectDefOf(code).def ?? defectDefOf(code).measure)?.disposition, 'MRB', code);
  });
});
