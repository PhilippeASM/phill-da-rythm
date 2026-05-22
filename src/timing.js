// timing.js — detecção de beat, tiers, estatísticas, warmup.
// Portado da v1.0 + ajustes de tiers (v1.7).
//
// Tiers (ms, distância absoluta |Δ| ao beat mais próximo):
//   hit       : |Δ| ≤ 6           (perfect, frame-perfect target)
//   near_hit  : 6  < |Δ| ≤ 12
//   miss      : 12 < |Δ| ≤ 32
//   bad_miss  : 32 < |Δ| ≤ 48
//   ah_vei    : |Δ| > 48
//
// Bordas: limite inferior exclusivo, limite superior inclusivo.
// Ex.: |Δ|=12 ainda é near_hit; |Δ|=12.0001 já é miss.
//
// Warmup: os primeiros N beats da sessão (default 6) servem para o usuário
// pegar o ritmo. Taps no warmup são marcados com flag warmup=true e ficam
// fora das estatísticas oficiais (mas seguem registrados no log).

// TIERS é mutável pra permitir configuração via Settings (v1.8+). v1.9: hit virou
// "< HIT" (era "≤ HIT") e o default subiu de 6 pra 8 ms pra que o intervalo do
// near_hit fique exatamente [8, 12] -- fronteira inferior INCLUSIVA, superior também.
// O app.js chama setTiers(...) pra trocar pra outro preset (ex.: "frame-aligned")
// ou pra valores custom.
export const TIERS = {
  HIT:      8,
  NEAR_HIT: 12,
  MISS:     32,
  BAD_MISS: 48,
};

// Atualiza os 4 thresholds. Aceita qualquer subconjunto de chaves; campos faltantes
// mantêm o valor atual. Validação básica: cada valor tem que ser > 0 e maior que o
// anterior (HIT < NEAR_HIT < MISS < BAD_MISS).
export function setTiers(partial = {}) {
  const next = { ...TIERS, ...partial };
  if (!(next.HIT > 0 && next.NEAR_HIT > next.HIT && next.MISS > next.NEAR_HIT && next.BAD_MISS > next.MISS)) {
    console.warn('[timing] setTiers ignorado: thresholds não monotônicos', next);
    return TIERS;
  }
  TIERS.HIT = next.HIT;
  TIERS.NEAR_HIT = next.NEAR_HIT;
  TIERS.MISS = next.MISS;
  TIERS.BAD_MISS = next.BAD_MISS;
  return TIERS;
}

// Presets prontos. Frame-aligned usa GBA_MS_PER_FRAME ≈ 16.7427 ms como unidade.
export const TIER_PRESETS = Object.freeze({
  strict:        { HIT: 8,  NEAR_HIT: 12, MISS: 32, BAD_MISS: 48 },  // v1.9: 8 (era 6)
  frame_aligned: { HIT: 8,  NEAR_HIT: 17, MISS: 34, BAD_MISS: 51 },  // 0.5/1/2/3 frames de GBA
});

export const WARMUP_BEATS_DEFAULT = 6;

// Ordem canônica usada para iterar / construir tabelas de UI/relatório.
export const TIER_ORDER = Object.freeze(['hit', 'near_hit', 'miss', 'bad_miss', 'ah_vei']);

export const TIER_LABELS = Object.freeze({
  hit:      'hit',
  near_hit: 'near hit',
  miss:     'miss',
  bad_miss: 'bad miss',
  ah_vei:   'ah vei!',
});

// Paleta inspirada no EonTimer (sóbria, alto contraste sobre fundo gelo/escuro).
export const TIER_COLORS = Object.freeze({
  hit:      '#2f9e6b', // verde
  near_hit: '#a4c93b', // verde-limão
  miss:     '#e89623', // laranja
  bad_miss: '#d04a3b', // vermelho
  ah_vei:   '#7a1f1f', // vinho / vermelho escuro
});

// v1.9: hit usa "<" (estrito), os demais usam "≤". Isso garante a semântica que
// o Philippe pediu: |Δ|<8 = hit, 8≤|Δ|≤12 = near_hit, etc. O ponto exato HIT é o
// limite INFERIOR INCLUSIVO do near_hit.
export function tierOf(diffMs) {
  const a = Math.abs(diffMs);
  if (a <  TIERS.HIT)      return 'hit';
  if (a <= TIERS.NEAR_HIT) return 'near_hit';
  if (a <= TIERS.MISS)     return 'miss';
  if (a <= TIERS.BAD_MISS) return 'bad_miss';
  return 'ah_vei';
}

export function tierColor(t)  { return TIER_COLORS[t] || '#888'; }
export function tierLabel(t)  { return TIER_LABELS[t] || t; }
// Considera "acerto útil" hit + near_hit (usado em "% acerto" do relatório).
export function isGoodTier(t) { return t === 'hit' || t === 'near_hit'; }

// Encontra o beat (passado ou futuro) mais próximo de tapTime.
// Retorna a diferença assinada em ms (tap - beat). Negativo = adiantou; positivo = atrasou.
//
// beatTimes: array com tempos absolutos (s) dos beats já tocados (buffer recente).
// nextBeatTime: tempo absoluto (s) do próximo beat a tocar.
// period: intervalo (s) entre beats. lookaheadCount: quantos beats futuros considerar.
export function closestBeat(tapTime, beatTimes, nextBeatTime, period, lookaheadCount = 3) {
  let bestSigned = Infinity;
  for (const bt of beatTimes) {
    const d = (tapTime - bt) * 1000;
    if (Math.abs(d) < Math.abs(bestSigned)) bestSigned = d;
  }
  let fut = nextBeatTime;
  for (let i = 0; i < lookaheadCount; i++) {
    const d = (tapTime - fut) * 1000;
    if (Math.abs(d) < Math.abs(bestSigned)) bestSigned = d;
    fut += period;
  }
  return bestSigned;
}

// Cria acumulador de estatísticas. Use registerTap() para adicionar um diff,
// snapshot() para ler o estado atual e reset() para zerar.
export function createStats() {
  const all = [];   // todos os diffs (inclui warmup) — para log/debug
  const real = [];  // só os pós-warmup — base das estatísticas oficiais
  const emptyByTier = () => ({ hit:0, near_hit:0, miss:0, bad_miss:0, ah_vei:0 });
  return {
    registerTap(diffMs, { warmup = false } = {}) {
      all.push({ diffMs, warmup });
      if (!warmup) real.push(diffMs);
      return tierOf(diffMs);
    },
    snapshot() {
      const arr = real;
      const n = arr.length;
      if (!n) return { count: 0, avg: 0, std: 0, best: null, byTier: emptyByTier(), goodPct: 0 };
      const avg = arr.reduce((a, b) => a + b, 0) / n;
      const variance = arr.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
      const std = Math.sqrt(variance);
      const best = arr.reduce((m, d) => Math.abs(d) < Math.abs(m) ? d : m, arr[0]);
      const byTier = emptyByTier();
      for (const d of arr) byTier[tierOf(d)]++;
      const good = byTier.hit + byTier.near_hit;
      const goodPct = (100 * good) / n;
      return { count: n, avg, std, best, byTier, goodPct };
    },
    reset() { all.length = 0; real.length = 0; },
    raw() { return { all: all.slice(), real: real.slice() }; }
  };
}

// True se o beat (0-based) está dentro do período de warmup.
export function isWarmupBeat(beatIndex, warmupCount = WARMUP_BEATS_DEFAULT) {
  return beatIndex < warmupCount;
}

// A partir de um tapTime, descobre o beatIndex global do beat mais próximo.
// Útil pra marcar warmup correto mesmo em taps fora de ordem.
export function nearestBeatIndex(tapTime, beatTimes, nextBeatTime, period, beatIndexOfNext, lookaheadCount = 3) {
  let bestAbs = Infinity;
  let bestIdx = -1;
  const baseIdx = beatIndexOfNext - beatTimes.length;
  for (let i = 0; i < beatTimes.length; i++) {
    const d = Math.abs((tapTime - beatTimes[i]) * 1000);
    if (d < bestAbs) { bestAbs = d; bestIdx = baseIdx + i; }
  }
  let fut = nextBeatTime;
  for (let i = 0; i < lookaheadCount; i++) {
    const d = Math.abs((tapTime - fut) * 1000);
    if (d < bestAbs) { bestAbs = d; bestIdx = beatIndexOfNext + i; }
    fut += period;
  }
  return bestIdx;
}

// ─── Pontuação v1.7 ──────────────────────────────────────────
// Sub-modo A (cadência): qualquer hit/near_hit conta.
//   - hit:      1 pt normal | 3 pt em beat de fim de ciclo (ex: 6º, 12º…)
//   - near_hit: 0.5 pt normal | 1.5 pt em beat de fim de ciclo
// Sub-modo B (RNG Hit): só o input no 6º beat (alvo) é registrado.
//   - hit no alvo:      3 pt
//   - near_hit no alvo: 1.5 pt
// miss/bad_miss/ah_vei: 0 pt em qualquer caso.
export function scoreFor(tier, isCycleEndOrTarget) {
  const bonus = !!isCycleEndOrTarget;
  switch (tier) {
    case 'hit':      return bonus ? 3   : 1;
    case 'near_hit': return bonus ? 1.5 : 0.5;
    default:         return 0;
  }
}
