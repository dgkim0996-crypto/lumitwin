"""공장 정의(shared/dist/factory.json) 읽기와 품질 모델 계산식."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_FACTORY = Path(__file__).resolve().parents[2] / 'shared' / 'dist' / 'factory.json'

# 문턱(th) 기본값: 정규화 편차가 1.5σ를 넘는 만큼만 불량률을 올린다
DEFAULT_TH = 1.5
# 한 요인이 올릴 수 있는 logit 상한 (극단값에서 확률이 바로 1이 되지 않게)
MAX_EXCESS = 6.0


def load_factory(path: str | None = None) -> dict:
    p = Path(path) if path else DEFAULT_FACTORY
    if not p.exists():
        raise SystemExit(f'[sim] 공장 정의가 없습니다: {p}\n        먼저 `npm run build -w shared` 를 실행하세요.')
    with open(p, encoding='utf-8') as f:
        return json.load(f)


# 실행 MES 표(factory.json `mes`)가 없거나 빠진 항목이 있을 때 쓰는 기본값. shared/src/mes.ts와 같은 값이다
MES_DEFAULTS: dict = {
    'woLot': {'HL': 96, 'EM': 160, 'OSM': 120},
    'woAhead': 3,
    'repairDefault': {'minutes': 10, 'prob': 0.85},
    'repairTechs': 1,
    'midInspectHours': 4,
    'ilkTimeoutSec': 3,
    'ilkRetrySec': 1,
    'healthIntervalSec': 60,
    'shifts': [
        {'code': 'D', 'name': '주간', 'startHour': 8, 'hours': 12},
        {'code': 'N', 'name': '야간', 'startHour': 20, 'hours': 12},
    ],
    'pmReason': '계획 보전',
    'noPlanReason': '생산 계획 없음',
}


def product_steps(line: dict) -> list[str]:
    """투입 공정(release)부터 시리얼을 이어 쓰는 공정들 (mes.ts productSteps와 같은 규칙)"""
    rel = line.get('release')
    if not rel:
        return []
    out = [rel]
    while True:
        nxt = next((s for s in line['steps'] if s['serial'] == 'keep'
                    and next((i.get('step') for i in s['inputs'] if i.get('step')), None) == out[-1]), None)
        if nxt is None:
            return out
        out.append(nxt['code'])


def mes_table(factory: dict) -> dict:
    """factory.json의 `mes` 표. 없는 항목은 기본값으로, 설비 표는 공장 정의에서 다시 계산해 채운다"""
    src = factory.get('mes') or {}
    m = {**MES_DEFAULTS, **src}
    if 'productSteps' not in src:
        m['productSteps'] = {ln['code']: product_steps(ln) for ln in factory['lines']}
    if 'stations' not in src:
        st = {}
        for ln in factory['lines']:
            scope = set(m['productSteps'].get(ln['code'], ()))
            steps = {s['code']: s for s in ln['steps']}
            for sd in ln['stations']:
                step = steps[sd['step']]
                prev = None if step['serial'] == 'new' else next((i.get('step') for i in step['inputs'] if i.get('step')), None)
                st[sd['code']] = {
                    'faRequired': not sd.get('aux') and bool(sd.get('gate') or sd.get('measures')),
                    'inspection': bool(sd.get('measures') or sd.get('detects')),
                    'productScope': sd['step'] in scope,
                    'prevStep': prev,
                }
        m['stations'] = st
    m.setdefault('ngRule', {})
    m.setdefault('pmMinutes', {})
    return m


def iso(dt: datetime) -> str:
    """UTC ISO 시각, 밀리초까지 (예: 2026-11-12T03:04:05.678Z). 시간대가 없는 값은 UTC로 본다"""
    dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def logit(p: float) -> float:
    p = min(max(p, 1e-9), 1 - 1e-9)
    return math.log(p / (1 - p))


def defect_probability(base: float, drivers: list[dict], zfn) -> float:
    """불량 확률 = sigmoid(logit(기본값) + Σ k × min(상한, max(0, 방향 × z − 문턱)))"""
    x = logit(base)
    for d in drivers:
        z = zfn(d['ref'])
        dz = abs(z) if d['dir'] == 0 else d['dir'] * z
        excess = min(MAX_EXCESS, max(0.0, dz - d.get('th', DEFAULT_TH)))
        x += d['k'] * excess
    return sigmoid(x)


def linear(base: float, terms: list[dict], zfn) -> float:
    """기준값 + Σ 계수 × z(참조)"""
    return base + sum(t['coef'] * zfn(t['ref']) for t in terms)


def round_to(v: float, digits: int | None) -> float:
    if digits is None:
        return round(v, 4)
    return round(v, max(0, digits))
