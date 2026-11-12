"""공장 정의(shared/dist/factory.json) 읽기와 품질 모델 계산식."""
from __future__ import annotations

import json
import math
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
