/* ============================================================
   app.js — cola do Treino de Ritmo v1.7
   Junta: audio, timing, calibrator, timers/*, ui/*
   - Tabs: Treino / Gen 5 / Gen 4 / Gen 3 / Custom
   - Modo Treino: sub-modos A (cadência contínua) e B (RNG hit 6º beat)
   - Tecla espaço: input + start/stop
   ============================================================ */

import { ensureAudio, loadSounds, play, beep, Sound, now as actxNow, cancelAllScheduled, getCtx } from './audio.js?v=20260515c';
import { tierOf, tierLabel, scoreFor, setTiers, TIER_PRESETS, TIERS } from './timing.js?v=20260514a';
import { initModeSwitcher } from './ui/mode-switcher.js?v=20260513b';
import { initController } from './controller.js?v=20260515b';
import { startMic, stopMic, isMicRunning, micStats } from './mic.js?v=20260515b';
// v1.12: timers da EonTimer (Gen3/4/5/Custom) -- math toda portada nesses módulos.
import { defaultSettings, Console } from './calibrator.js?v=20260514a';
import * as gen3      from './timers/gen3.js?v=20260514g';
import * as gen4      from './timers/gen4.js?v=20260514g';
import * as gen5      from './timers/gen5.js?v=20260514g';
import * as customMod from './timers/custom.js?v=20260514g';

// ─── Error handlers visíveis ────────────────────────────────
// Se qualquer coisa der throw fora de um try/catch (incluindo import errors num módulo
// dependente, erros em event handlers, promise rejections), mostra na status bar do app
// + console. Evita o caso de "página parece pronta mas init() abortou silenciosamente".
window.addEventListener('error', (event) => {
  try {
    const el = document.getElementById('status');
    if (el) el.textContent = 'ERRO: ' + (event.message || '?') + ' @ ' +
                              (event.filename || '?').split('/').pop() + ':' + (event.lineno || '?');
  } catch (_e) { /* swallow -- já estamos em estado de erro */ }
});
window.addEventListener('unhandledrejection', (event) => {
  try {
    const el = document.getElementById('status');
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
    if (el) el.textContent = 'ERRO promise: ' + reason;
  } catch (_e) {}
});

// ─── Constantes ──────────────────────────────────────────────
const GBA_FRAME_MS = 16.7427;

// ─── Settings do Treino — defaults + load/save ──────────────
// Persistido em localStorage entre sessões. Acessado via state.training.
//
// v1.10 (2026-05-14): warmupBeats foi REMOVIDO como campo configurável -- agora ele
// é DERIVADO de beatsPerCycle (warmupBeats = beatsPerCycle - 1, no modo B). Isso
// evita o bug em que warmupBeats=0 quebrava a sessão (cycleLen virava 1 beat).
// Para mudar o tamanho do ciclo no modo B, o usuário ajusta `beatsPerCycle`
// (default 6 = 5 warm-ups + 1 alvo).
const TRAINING_DEFAULTS = Object.freeze({
  submode:        'A',          // 'A' (cadência contínua) | 'B' (RNG hit no último beat do ciclo)
  bpm:            120,
  beatsPerCycle:  6,            // tamanho do ciclo (em A é referência visual; em B é fixo do ciclo)
  numCycles:      1,            // só modo B + durationMode='cycles': quantos ciclos rodar
  sound:          'beep',
  targetSound:    'ding',       // beep do beat-alvo no modo B
  // durationMode válido depende do submode:
  //   modo A: 'continuous' | 'time' | 'beats' | 'simulate_hunt'
  //   modo B: 'cycles' | 'time' | 'continuous'
  durationMode:   'continuous',
  durationSec:    60,            // usado se durationMode='time'
  durationBeats:  64,            // usado se durationMode='beats' (só A)
  // v1.12.3: 'simulate_hunt' usa a config de uma aba hunt como fonte de fases,
  // mas roda DENTRO do treino (cadência + feedback do submode A).
  simulateHuntFrom: 'custom',    // 'gen3' | 'gen4' | 'gen5' | 'custom'
  deltaUnit:      'both',        // 'ms' | 'frames' | 'both'
  tierPreset:     'strict',
  tierHit:        8,
  tierNearHit:    12,
  tierMiss:       32,
  tierBadMiss:    48,
  queue:          [],
  // v1.12.5: EonTimer-style action settings. Aplica a hunt tabs (useCadence=OFF) e
  // simulate_hunt no Treino. Defaults idênticos aos do EonTimer:
  //   interval=500ms, count=6 → 6 beeps a cada 500ms terminando NO instante exato
  //   do fim de cada fase (= último beep é frame-perfect com o fim; os 5 anteriores
  //   ocupam os 2.5s antecedentes). Antes desses 2.5s = silêncio.
  actionInterval: 500,
  actionCount:    6,
  // v1.11: ao apertar Esc/B (= fechar sessão), default é pausar + confirmar.
  // Se marcado, ignora a confirmação e fecha direto descartando dados.
  skipCloseConfirm: false,
});

// Helper: nº de warm-up beats (= beats antes do alvo) no modo B. Derivado de
// beatsPerCycle pra evitar inconsistência entre dois campos.
function modeBWarmups(t)  { return Math.max(0, (t.beatsPerCycle ?? 6) - 1); }
function modeBCycleLen(t) { return Math.max(2, t.beatsPerCycle ?? 6); }

const SETTINGS_LS_KEY = 'phill_da_rythm_training';

// v1.12.7: settings GLOBAIS de timer (Console + Som dos beeps). Aplicam-se a
// todas as abas (exceto Custom que é hardcoded GBA — ver _huntContext). Por
// pedido do user, foram separados do estado de treino: agora as configs de
// treino só aparecem no Settings se a aba ativa for Treino OU se a hunt tem
// "Usar cadência do Treino" ON.
const TIMER_DEFAULTS = Object.freeze({
  console: 'GBA',        // GBA | NDS - Slot 1 | NDS - Slot 2 | DSI | 3DS
  sound:   'beep',       // som global dos beeps de countdown e cadência
  // v1.12.9: compensação ADICIONAL pra latência do controller (separada do
  // outputLatency do áudio, que já é compensado em onTap). Positivo = "press
  // físico veio N ms ANTES do que medimos" → adianta o tap N ms (= reduz o Δ).
  // Calibra empiricamente: rode 20 taps em hit perfeito, veja o Δ médio, soma ao
  // offset atual. Default 0 (= sem compensation). Range típico do Pro Controller
  // via USB no Windows: 10–40ms; via Bluetooth: 20–60ms.
  controllerOffsetMs: 0,
  // v1.13: offset fixo pro input via touch/teclado (análogo ao controllerOffsetMs).
  // Absorve o resíduo fixo: latência do digitizer touch + sub-compensação da
  // outputLatency no iOS Safari (que costuma reportar outputLatency=0). Positivo =
  // adianta o tap N ms. Calibrar pelo Δ médio das stats (no iOS tende a ser positivo).
  touchOffsetMs: 0,
});
const TIMER_LS_KEY = 'phill_da_rythm_timer';

function loadTimerSettings() {
  try {
    const raw = localStorage.getItem(TIMER_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...TIMER_DEFAULTS, ...parsed };
    }
    // Migration: se não existe ainda, herda `sound` do training (que era global de facto).
    let migrated = { ...TIMER_DEFAULTS };
    try {
      const tRaw = localStorage.getItem(SETTINGS_LS_KEY);
      if (tRaw) {
        const t = JSON.parse(tRaw);
        if (t && typeof t.sound === 'string') migrated.sound = t.sound;
      }
    } catch {}
    return migrated;
  } catch (e) {
    console.warn('[timer settings] falha load:', e);
    return { ...TIMER_DEFAULTS };
  }
}

function saveTimerSettings() {
  try {
    localStorage.setItem(TIMER_LS_KEY, JSON.stringify(state.timer));
  } catch (e) {
    console.warn('[timer settings] falha save:', e);
  }
}

function resetTimerSettings() {
  state.timer = { ...TIMER_DEFAULTS };
  saveTimerSettings();
}

function loadTrainingSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (!raw) return { ...TRAINING_DEFAULTS };
    const parsed = JSON.parse(raw);
    // Migration v1.8 → v1.9: o preset 'strict' mudou de tierHit=6 pra 8 + tierOf
    // passou a usar < em vez de ≤ pro HIT. Se o usuário tinha 'strict' salvo com
    // o valor antigo, atualiza pra novo. (Quem customizou os thresholds não migra.)
    if (parsed.tierPreset === 'strict' && parsed.tierHit === 6) {
      parsed.tierHit = 8;
    }
    // Merge defaults com salvo: campos novos (ex: durationMode) ganham default se faltarem.
    return { ...TRAINING_DEFAULTS, ...parsed };
  } catch (e) {
    console.warn('[settings] falha load:', e);
    return { ...TRAINING_DEFAULTS };
  }
}

function saveTrainingSettings() {
  try {
    localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(state.training));
  } catch (e) {
    console.warn('[settings] falha save:', e);
  }
}

function resetTrainingSettings() {
  state.training = { ...TRAINING_DEFAULTS };
  saveTrainingSettings();
  applyTierThresholds();
}

// Aplica os tier thresholds atuais no módulo timing.js. Chamado no init e sempre
// que os valores mudam no Settings.
function applyTierThresholds() {
  const t = state.training;
  setTiers({
    HIT:      Number(t.tierHit)     || 6,
    NEAR_HIT: Number(t.tierNearHit) || 12,
    MISS:     Number(t.tierMiss)    || 32,
    BAD_MISS: Number(t.tierBadMiss) || 48,
  });
}

// ─── Estado global do app ────────────────────────────────────
const state = {
  activeMode: 'training',
  running: false,
  paused:    false,         // v1.11: sessão pausada (mantém estado, congela schedule)
  startedAt: 0,
  beatCount: 0,
  schedule: [],
  nextBeatIdx: 0,
  score: 0,
  history: [],
  training: loadTrainingSettings(),
  timer:    loadTimerSettings(),     // v1.12.7: global (Console + Som dos beeps)
  // Visual reward (zerados no resetRound):
  streakCount:           0,   // hits/near_hits consecutivos atuais
  maxStreakThisSession:  0,   // pico da sessão (vai pro CSV e modal de resultados)
  milestonesShown:       {},  // legacy; mantido por compat com export CSV (v1.10 não usa mais toasts)
  beatVisualTimers:      [],  // IDs de setTimeout pendentes pra sync visual com áudio
  // v1.12: hunt mode state (gen3/4/5/custom).
  huntActive:    false,
  huntMode:      null,
  huntPhases:    null,
  huntCtx:       null,
  huntHits:      [],
  huntSettings:  null,
  // v1.12.7: qual sub-tab do dialog Settings está ativa. Não persistido.
  activeSettingsTab: 'action',
};

// Capturado de initModeSwitcher pra poder re-renderizar a aba ativa (= a aba Treino
// vai mostrar config "stale" depois que o usuário muda settings; refrescar via activate).
let _modeSwitcher = null;

// v1.12.9: debug do gamepad. Toggle no console com `window.gpDebug()`. Quando ON,
// loga cada press com actxRaw, ctlOffset aplicado, audioLatency — pra calibrar
// empiricamente o "Offset do controller" em Settings → Timer.
let _gpDebug = false;

// ─── Cadence visual feedback (v1.10: tudo nos beat-dots) ───
// v1.9 tinha pulse-ring e phase-bar como elementos separados, mas o Philippe relatou
// que isso polui e dispersa o olhar. v1.10 unifica TUDO nos próprios beat-dots:
// pulse no instante do beat, anticipate-glow no próximo, target-anim no alvo do
// modo B. Beat-dots ficam MAIORES (28px). Sync com áudio via setTimeout per-beat
// agendado em scheduleAllBeats (precisão ~5ms vs ~16ms do rAF).
let _styleInjected = false;
// Elementos persistentes -- criados uma vez por sessão e atualizados via classList,
// nunca recriados (pra não interromper animações CSS em curso).
let _dotEls = [];
let _sessionChipsEl = null;
let _streakChipEl = null;   // dentro de _sessionChipsEl
let _cycleChipEl = null;    // dentro de _sessionChipsEl

function injectCadenceStyles() {
  if (_styleInjected) return;
  const s = document.createElement('style');
  s.textContent = `
    /* v1.10: pulse-ring e phase-bar REMOVIDOS. Toda animação de cadência roda DENTRO
       dos beat-dots, sincronizada com o áudio via setTimeout (precisão ~5ms vs ~16ms
       do rAF). Dots ficam MAIORES (28px), são o foco principal do olhar. */
    .beat-dots { gap: 16px !important; padding: 16px 0 12px !important; }
    .beat-dot {
      width: 28px !important; height: 28px !important;
      transition: transform 130ms ease, background 200ms ease, box-shadow 200ms ease, border-color 200ms ease !important;
      will-change: transform;
    }
    /* v1.11.1: visual de antecipação REMOVIDO. Motivos cientificamente sustentados:
       (a) Timing rítmico humano é primariamente AUDITIVO -- visual em loops cria
       distrator que compete com o estímulo auditivo (Repp 2003; Patel et al. 2005).
       (b) Animações crescentes ANTES do beat induzem predição visual que diverge
       da predição auditiva e amplifica o Negative Mean Asynchrony (= tocar antes
       do beat). (c) Eventos DISCRETOS no momento do beat são mais informativos pro
       sistema motor que tracking contínuo (Spencer et al. 2003).
       Decisão: '.next' agora é apenas borda fina (referência espacial, sem
       atrair olhar); '.target' é cor estática (identifica o alvo); todo o
       feedback ativo acontece NO MOMENTO do beat (.pulsing) e APÓS o tap
       (.tap-feedback-{tier}). Nada cresce antes do beat. */
    .beat-dot.next {
      box-shadow: inset 0 0 0 2px rgba(159, 122, 234, .55) !important;
    }
    /* Pulse quando o beat toca -- disparado no INSTANTE EXATO do beat via setTimeout
       pré-agendado (= sincronizado com o som AUDÍVEL via outputLatency offset). */
    .beat-dot.pulsing {
      animation: dot-pulse 220ms ease-out;
    }
    @keyframes dot-pulse {
      0%   { transform: scale(1.65); background: rgba(159,122,234,.98); box-shadow: 0 0 24px 9px rgba(159,122,234,.65); }
      100% { transform: scale(1.0);  box-shadow: 0 0 0 0 rgba(159,122,234,0); }
    }
    /* Pulse INTENSO quando o beat tocado é um alvo do modo B. */
    .beat-dot.pulsing-target {
      animation: dot-pulse-target 360ms ease-out;
    }
    @keyframes dot-pulse-target {
      0%   { transform: scale(2.15); background: rgba(252,100,100,1); box-shadow: 0 0 36px 14px rgba(252,100,100,.7); }
      100% { transform: scale(1.0);  box-shadow: 0 0 0 0 rgba(252,100,100,0); }
    }
    /* TAP FEEDBACK -- pulsa o dot do beat-de-referência do tap, na cor do tier.
       Curto (180ms), retrospectivo: confirma que registrou + comunica precisão.
       Feedback APÓS o evento, não antes -- não polui a predição rítmica. */
    .beat-dot.tap-feedback-hit       { animation: tap-fb-hit       180ms ease-out; }
    .beat-dot.tap-feedback-near_hit  { animation: tap-fb-near      180ms ease-out; }
    .beat-dot.tap-feedback-miss      { animation: tap-fb-miss      220ms ease-out; }
    .beat-dot.tap-feedback-bad_miss  { animation: tap-fb-bad       220ms ease-out; }
    .beat-dot.tap-feedback-ah_vei    { animation: tap-fb-ahvei     220ms ease-out; }
    @keyframes tap-fb-hit       { 0% { transform: scale(1.0); outline: 4px solid rgba(47,158,107,.95);  outline-offset: 4px; } 100% { transform: scale(1.0); outline: 4px solid rgba(47,158,107,0);  outline-offset: 0; } }
    @keyframes tap-fb-near      { 0% { transform: scale(1.0); outline: 4px solid rgba(164,201,59,.95); outline-offset: 4px; } 100% { transform: scale(1.0); outline: 4px solid rgba(164,201,59,0); outline-offset: 0; } }
    @keyframes tap-fb-miss      { 0% { transform: scale(1.0); outline: 4px solid rgba(232,150,35,.95); outline-offset: 4px; } 100% { transform: scale(1.0); outline: 4px solid rgba(232,150,35,0); outline-offset: 0; } }
    @keyframes tap-fb-bad       { 0% { transform: scale(1.0); outline: 4px solid rgba(208,74,59,.95);  outline-offset: 4px; } 100% { transform: scale(1.0); outline: 4px solid rgba(208,74,59,0);  outline-offset: 0; } }
    @keyframes tap-fb-ahvei     { 0% { transform: scale(1.0); outline: 4px solid rgba(122,31,31,.95);  outline-offset: 4px; } 100% { transform: scale(1.0); outline: 4px solid rgba(122,31,31,0);  outline-offset: 0; } }
    /* Reward burst no dot do alvo quando o usuário acerta hit/near_hit nele. */
    .beat-dot.target-hit-burst  { animation: dot-target-burst 560ms ease-out; }
    .beat-dot.target-near-burst { animation: dot-target-near  560ms ease-out; }
    @keyframes dot-target-burst {
      0%   { transform: scale(1.0); background: rgba(47,158,107,1); box-shadow: 0 0 0 0 rgba(47,158,107,1); }
      40%  { transform: scale(2.6); background: rgba(47,158,107,1); box-shadow: 0 0 40px 16px rgba(47,158,107,.75); }
      100% { transform: scale(1.0); box-shadow: 0 0 0 0 rgba(47,158,107,0); }
    }
    @keyframes dot-target-near {
      0%   { transform: scale(1.0); background: rgba(164,201,59,1); box-shadow: 0 0 0 0 rgba(164,201,59,.85); }
      40%  { transform: scale(2.25); background: rgba(164,201,59,1); box-shadow: 0 0 32px 14px rgba(164,201,59,.65); }
      100% { transform: scale(1.0); box-shadow: 0 0 0 0 rgba(164,201,59,0); }
    }
    .tier-badge.flash {
      animation: tierflash 380ms ease-out;
    }
    .tier-badge.target-hit-flash {
      animation: target-hit-flash 540ms ease-out;
    }
    @keyframes tierflash {
      0%   { transform: scale(1.0); filter: brightness(1.0); }
      30%  { transform: scale(1.18); filter: brightness(1.35); }
      100% { transform: scale(1.0); filter: brightness(1.0); }
    }
    @keyframes target-hit-flash {
      0%   { transform: scale(1.0); filter: brightness(1.0); }
      25%  { transform: scale(1.6); filter: brightness(1.8) drop-shadow(0 0 10px currentColor); }
      100% { transform: scale(1.0); filter: brightness(1.0); }
    }
    /* v1.12.5: zone-action no progress bar (= últimos (count-1)*interval ms da fase
       atual). Fica laranja/vermelho pra avisar visualmente que a countdown está rodando. */
    .timer-progress-bar.zone-action .timer-progress-fill {
      background: linear-gradient(90deg, #f49a3c, #fc4444) !important;
    }
    .timer-progress-bar.zone-complete .timer-progress-fill {
      background: rgba(47, 158, 107, 0.85) !important;
    }
    /* Chips de sessão (streak + cycle) consolidados ABAIXO dos beat-dots, em linha,
       discretos. Não competem com os dots por atenção. */
    .session-chips {
      display: flex; gap: 8px; justify-content: center; align-items: center;
      padding: 2px 0 4px; min-height: 22px;
    }
    .session-chip {
      padding: 2px 9px; border-radius: 10px;
      font-size: .8em; font-weight: 600;
      opacity: 0; transition: opacity 180ms ease;
    }
    .session-chip.show { opacity: 1; }
    .session-chip.streak { background: rgba(244,154,60,.18); border: 1px solid rgba(244,154,60,.4); color: #f49a3c; }
    .session-chip.cycle  { background: rgba(91,155,255,.18); border: 1px solid rgba(91,155,255,.4); color: #5b9bff; }
  `;
  document.head.appendChild(s);
  _styleInjected = true;
}

function ensureCadenceVisuals() {
  injectCadenceStyles();
  // v1.10: pulse-ring e phase-bar foram REMOVIDOS -- toda animação acontece nos
  // próprios beat-dots agora. Esta função fica como no-op pra compatibilidade com
  // chamadas existentes (init, etc).
  ensureSessionChips();
}

// Container de chips de sessão (streak + cycle), em LINHA abaixo dos beat-dots.
function ensureSessionChips() {
  if (_sessionChipsEl && _sessionChipsEl.isConnected) return _sessionChipsEl;
  const beatDots = document.getElementById('beatDots');
  if (!beatDots || !beatDots.parentNode) return null;
  _sessionChipsEl = document.createElement('div');
  _sessionChipsEl.className = 'session-chips';
  _streakChipEl = document.createElement('span');
  _streakChipEl.className = 'session-chip streak';
  _cycleChipEl = document.createElement('span');
  _cycleChipEl.className = 'session-chip cycle';
  _sessionChipsEl.appendChild(_cycleChipEl);
  _sessionChipsEl.appendChild(_streakChipEl);
  beatDots.parentNode.insertBefore(_sessionChipsEl, beatDots.nextSibling);
  return _sessionChipsEl;
}

// Dispara o pulse visual no DOT do beat que acabou de tocar. Chamada pelo
// setTimeout pré-agendado em scheduleAllBeats -- garante sync exato com o áudio.
function triggerDotPulse(globalBeatIdx, isTargetBeat) {
  const t = state.training;
  const n = t.beatsPerCycle || 6;
  const posInCycle = globalBeatIdx % n;
  const dot = _dotEls && _dotEls[posInCycle];
  if (!dot) return;
  // Remove + force reflow + re-add pra retriggar a animação CSS.
  dot.classList.remove('pulsing', 'pulsing-target', 'target-hit-burst', 'target-near-burst');
  void dot.offsetWidth;
  dot.classList.add(isTargetBeat ? 'pulsing-target' : 'pulsing');
  // Limpa a classe ao fim pra próxima vez retriggar limpo.
  setTimeout(() => dot && dot.classList.remove('pulsing', 'pulsing-target'),
             isTargetBeat ? 380 : 240);
}

// Burst no DOT do alvo quando o usuário acerta hit/near_hit (modo B).
// Anima o dot do alvo (= posição N-1 no ciclo visual) com o tier-color burst.
function triggerTargetHitBurst(tier) {
  const t = state.training;
  const n = t.beatsPerCycle || 6;
  const targetPos = n - 1;
  const dot = _dotEls && _dotEls[targetPos];
  if (dot) {
    dot.classList.remove('pulsing', 'pulsing-target', 'target-hit-burst', 'target-near-burst');
    void dot.offsetWidth;
    dot.classList.add(tier === 'hit' ? 'target-hit-burst' : 'target-near-burst');
    setTimeout(() => dot && dot.classList.remove('target-hit-burst', 'target-near-burst'), 600);
  }
  if (dom.rdTierBadge) {
    dom.rdTierBadge.classList.remove('flash', 'target-hit-flash');
    void dom.rdTierBadge.offsetWidth;
    dom.rdTierBadge.classList.add('target-hit-flash');
    setTimeout(() => dom.rdTierBadge && dom.rdTierBadge.classList.remove('target-hit-flash'), 540);
  }
}

// Indica se o próximo beat a tocar é um alvo (modo B). Usado pra acender o
// "target-approaching" visual.
function isNextBeatTarget() {
  if (!state.targetIndices || state.targetIndices.length === 0) return false;
  return state.targetIndices.indexOf(state.nextBeatIdx) >= 0;
}

// v1.10: cycle chip + streak chip foram CONSOLIDADOS num único container
// (.session-chips) ABAIXO dos beat-dots, em linha horizontal. Não competem mais
// com os dots por atenção. Os elementos _cycleChipEl e _streakChipEl são criados
// em ensureSessionChips() acima.

function renderCycleChip() {
  ensureSessionChips();
  if (!_cycleChipEl) return;
  const t = state.training;
  if (state.running && t.submode === 'B' && state.targetIndices && state.targetIndices.length > 0) {
    const cycleLen = modeBCycleLen(t);
    const cyc = state.targetIndices.length;
    const curCycle = Math.max(1, Math.min(cyc, Math.ceil(Math.max(1, state.beatCount) / cycleLen)));
    _cycleChipEl.textContent = 'Ciclo ' + curCycle + ' / ' + cyc;
    _cycleChipEl.classList.add('show');
  } else {
    _cycleChipEl.classList.remove('show');
  }
}

function setPhaseProgress() {
  // v1.10: phase-bar removida. No-op pra compat.
}

function renderStreakChip() {
  ensureSessionChips();
  if (!_streakChipEl) return;
  if (state.streakCount >= 3) {
    _streakChipEl.textContent = '🔥 ' + state.streakCount + ' streak';
    _streakChipEl.classList.add('show');
  } else {
    _streakChipEl.classList.remove('show');
  }
}

// v1.10: removido o milestone toast que aparecia flutuando no centro da tela --
// poluía visualmente e tirava o foco da cadência. O streak chip abaixo dos dots
// já comunica progresso (cresce conforme sobe; some quando quebra).
function updateStreakAndReward(tier) {
  const isGood = (tier === 'hit' || tier === 'near_hit');
  if (isGood) {
    state.streakCount += 1;
    if (state.streakCount > state.maxStreakThisSession) {
      state.maxStreakThisSession = state.streakCount;
    }
  } else {
    state.streakCount = 0;
  }
  renderStreakChip();
}

// Flash no badge do tier (animation curta) — feedback visual barato em cada tap.
function flashTierBadge() {
  if (!dom.rdTierBadge) return;
  dom.rdTierBadge.classList.remove('flash');
  void dom.rdTierBadge.offsetWidth;
  dom.rdTierBadge.classList.add('flash');
  setTimeout(() => dom.rdTierBadge && dom.rdTierBadge.classList.remove('flash'), 400);
}

// ─── Formatação do Δ (depende do deltaUnit configurado) ─────
function formatDelta(dms) {
  const sign = dms >= 0 ? '+' : '';
  const ms = sign + dms.toFixed(1);
  const frames = sign + (dms / GBA_FRAME_MS).toFixed(2);
  const unit = state.training.deltaUnit || 'both';
  if (unit === 'ms')     return ms + ' ms';
  if (unit === 'frames') return frames + ' fr';
  return ms + ' ms (' + frames + ' fr)';
}

// ─── DOM refs ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dom = {
  display:        $('display'),
  phaseValue:     $('phaseValue'),
  progressFill:   $('progressFill'),
  metaPhase:      $('metaPhase'),
  metaNext:       $('metaNext'),
  metaTotal:      $('metaTotal'),
  metaMins:       $('metaMins'),
  training:       $('trainingReadout'),
  rdScore:        $('rdScore'),
  rdDelta:        $('rdDelta'),
  rdTierBadge:    $('rdTierBadge'),
  beatDots:       $('beatDots'),
  btnPlay:        $('btnPlay'),
  btnReset:       $('btnReset'),
  btnUpdate:      $('btnUpdate'),
  btnSettings:    $('btnSettings'),
  btnMic:         $('btnMic'),
  status:         $('status'),
  tabBar:         $('tabBar'),
  panels:         $('panels'),
  overlay:        $('settingsOverlay'),
  settingsContent:$('settingsContent'),
  settingsOk:     $('settingsOk'),
  settingsCancel: $('settingsCancel'),
  settingsReset:  $('settingsReset'),
  resultsOverlay: $('resultsOverlay'),
  resultsContent: $('resultsContent'),
  resultsClose:   $('resultsClose'),
  resultsAgain:   $('resultsAgain'),
  closeConfirmOverlay: $('closeConfirmOverlay'),
  closeConfirmYes:     $('closeConfirmYes'),
  closeConfirmNo:      $('closeConfirmNo'),
};

// Chave do localStorage onde guardamos snapshot da sessão anterior pra comparar.
const LAST_SESSION_LS_KEY = 'phill_da_rythm_last_session';

// ─── Inicialização ───────────────────────────────────────────
async function init() {
  ensureAudio();
  // Aplica os tier thresholds carregados do localStorage (ou defaults) no módulo
  // timing.js ANTES de qualquer onTap acontecer.
  applyTierThresholds();
  // Cria os elementos visuais de cadência (pulse + phase bar) e injeta CSS.
  ensureCadenceVisuals();
  try {
    const loaded = await loadSounds();
    setStatus('Sons carregados: ' + Array.from(loaded).join(', '));
  } catch (e) {
    setStatus('Sons indisponíveis — fallback sintetizado');
  }
  _modeSwitcher = initModeSwitcher({
    tabBarEl: dom.tabBar,
    panelsEl: dom.panels,
    state,
    onChange: onModeChange,
  });
  bindControls();
  bindKeyboard();
  bindController();
  bindMic();
  // Diagnóstico via console: window.micStats() devolve { running, noiseEma, ... }
  if (typeof window !== 'undefined') window.micStats = micStats;
  // v1.12.9: toggle de log do gamepad. Liga: imprime actxRaw + ctlOffset + audioLatency
  // pra cada press. Use pra calibrar "Offset do controller" empiricamente.
  if (typeof window !== 'undefined') {
    window.gpDebug = () => { _gpDebug = !_gpDebug; console.log('[gp] debug', _gpDebug ? 'ON' : 'OFF'); return _gpDebug; };
  }
  // v1.12.6: gen-panels.js usa esse hook pra avisar o app quando inputs mudam ou
  // a queue é editada, pra atualizar o display do timer em tempo real (NÃO-running).
  if (typeof window !== 'undefined') window.__phillRequestHuntPreview = requestHuntPreview;
  setStatus('Pronto.');
}

// v1.12.8: mapeamento correto Web Gamepad standard mapping pro Pro Controller.
//   Antes (errado): 0=A, 1=B, 6=+ → na verdade era 0=south=B físico, 1=east=A físico,
//     6=ZL (gatilho). Por isso "A não tapava" e "+ não dava play".
//   Agora: 1=A (east), 0=B (south), 9=+ (right-center). Switch Pro Controller via USB
//     no Chrome reporta mapping="standard" → estes índices são canônicos.
//   Fallback: se mapping !== "standard" (Bluetooth/driver não-conforme), warning no
//     status bar + console.log de cada press com btnIdx → user pode pedir override
//     manual.
//
// Quando o modal de confirmação está aberto:
//   A → confirma (= discartar)
//   B → cancela (volta pra pausa)
function bindController() {
  const BTN_A          = 1;   // east  no cluster direito = A físico
  const BTN_B          = 0;   // south no cluster direito = B físico
  const BTN_PLUS_START = 9;   // right-center            = + (Start)
  let _nonStandardWarned = false;
  initController({
    onTap: (actxSecRaw, btnIdx) => {
      // v1.12.9: controllerOffsetMs (Settings → Timer) compensa latência adicional
      // do controller (HID buffer + sync interna do Chrome). Aplicado AQUI, NÃO no
      // onTap principal, porque só o input via gamepad sofre esse atraso — teclado
      // não. Positivo = adianta o tap.
      const ctlOffsetSec = ((state.timer && state.timer.controllerOffsetMs) || 0) / 1000;
      const actxSec = actxSecRaw - ctlOffsetSec;
      // Log pareado com mic se a Fase A do mic estiver rodando (legado).
      if (isMicRunning()) {
        console.log('[gp press ] t=' + (actxSec * 1000).toFixed(1) + 'ms  btn=' + btnIdx);
        _eventLog.push({ source: 'gp', t_ms: actxSec * 1000, rms: '', floor: '', ratio: '', btn_idx: btnIdx });
        _updateMicStatus();
      }
      // v1.12.8: em mapping non-standard, loga cada press pra você ver no F12 qual
      // btnIdx cada botão dispara. Aí me chama com a tabela e refaço o re-mapping.
      if (_nonStandardWarned) console.log('[gp press btn=' + btnIdx + ']');
      // v1.12.9: debug toggle global pra calibrar offset (window.gpDebug() liga/desliga).
      // v1.12.10: agora também loga out + base separados pra ver qual o driver não preenche.
      if (_gpDebug) {
        const lat = _audioLatencyParts();
        console.log('[gp] btn=' + btnIdx
          + ' actxRaw=' + (actxSecRaw * 1000).toFixed(1) + 'ms'
          + ' ctlOffset=' + (ctlOffsetSec * 1000).toFixed(1) + 'ms'
          + ' actxAdj=' + (actxSec * 1000).toFixed(1) + 'ms'
          + ' audioLatency=' + (lat.out + lat.base).toFixed(1) + 'ms'
          + ' (out=' + lat.out.toFixed(1) + ' base=' + lat.base.toFixed(1) + ')');
      }
      // ─── Modal de confirmação aberto: A=confirma, B=cancela ───
      if (isCloseConfirmOpen()) {
        if (btnIdx === BTN_A) discardAndCloseSession();
        else if (btnIdx === BTN_B) cancelCloseAndStayPaused();
        return;
      }
      // ─── Operação normal ───
      if (btnIdx === BTN_PLUS_START) {
        toggleRun();
      } else if (btnIdx === BTN_A) {
        // Tap só vale se rodando e não pausado.
        if (state.running && !state.paused) onTap(actxSec);
      } else if (btnIdx === BTN_B) {
        if (state.running) closeSession();
      }
      // Outros botões ignorados de propósito.
    },
    onConnect: (id, mapping) => {
      const tag = (mapping === 'standard') ? '' : ' (mapping="' + (mapping || 'vazio') + '" — não-standard, btn-idx pode estar errado)';
      setStatus('Controle conectado: ' + id + tag);
      if (mapping !== 'standard') {
        _nonStandardWarned = true;
        console.warn('[controller] mapping não-standard: "' + (mapping || 'vazio') + '". ' +
          'Aperte cada botão (A, B, +) com o console aberto pra ver qual btnIdx cada um dispara.');
      }
    },
    onDisconnect: () => setStatus('Controle desconectado.'),
  });
}

// ─── Mic POC (Fase A1) ──────────────────────────────────────
// O botão "Mic" liga/desliga a captura do microfone. Enquanto rodando, cada onset
// (= pico de RMS acima do floor de ruído) E cada press do gamepad são acumulados
// num buffer. Ao desligar o Mic, o buffer é exportado como `mic_log_DATA.csv` no
// Downloads — mesmo padrão do Latency Meter que você já usa.
const _eventLog = [];

function _updateMicStatus() {
  if (!isMicRunning()) return;
  const nMic = _eventLog.filter(e => e.source === 'mic').length;
  const nGp  = _eventLog.filter(e => e.source === 'gp').length;
  setStatus('Mic ativo. ' + nGp + ' presses do controle + ' + nMic + ' onsets de áudio capturados.');
}

function _exportEventLogCsv() {
  if (_eventLog.length === 0) return null;
  const cols = ['index', 'source', 't_actx_ms', 'rms', 'floor', 'ratio', 'btn_idx'];
  const lines = [cols.join(',')];
  _eventLog.forEach((e, i) => {
    lines.push([
      i,
      e.source,
      typeof e.t_ms === 'number' ? e.t_ms.toFixed(2) : '',
      typeof e.rms === 'number' ? e.rms.toFixed(4) : e.rms,
      typeof e.floor === 'number' ? e.floor.toFixed(5) : e.floor,
      typeof e.ratio === 'number' ? e.ratio.toFixed(2) : e.ratio,
      e.btn_idx,
    ].join(','));
  });
  const csv = lines.join('\n');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'mic_log_' + ts + '.csv';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

async function toggleMic() {
  if (isMicRunning()) {
    stopMic();
    dom.btnMic.textContent = 'Mic';
    dom.btnMic.classList.remove('btn-primary');
    const filename = _exportEventLogCsv();
    if (filename) {
      setStatus('Mic parado. Baixado: ' + filename + ' (' + _eventLog.length + ' eventos).');
    } else {
      setStatus('Mic parado. Nenhum evento capturado.');
    }
    return;
  }
  // Reset do buffer no início de cada sessão
  _eventLog.length = 0;
  setStatus('Pedindo permissão de microfone…');
  const stop = await startMic({
    onOnset: (actxSec, info) => {
      // info = { rms, floor, ratio } — pra você ver porque o evento disparou
      console.log(
        '[mic onset] t=' + (actxSec * 1000).toFixed(1) + 'ms' +
        '  rms=' + info.rms.toFixed(4) +
        '  floor=' + info.floor.toFixed(5) +
        '  ratio=' + info.ratio.toFixed(1) + 'x'
      );
      _eventLog.push({
        source: 'mic',
        t_ms: actxSec * 1000,
        rms: info.rms,
        floor: info.floor,
        ratio: info.ratio,
        btn_idx: '',
      });
      _updateMicStatus();
    },
    onError: (err) => {
      dom.btnMic.textContent = 'Mic';
      dom.btnMic.classList.remove('btn-primary');
      setStatus('Mic erro: ' + (err && err.message ? err.message : err));
    },
  });
  if (stop) {
    dom.btnMic.textContent = 'Mic ●';
    dom.btnMic.classList.add('btn-primary');
    setStatus('Mic ativo. Aperte o A no controle e/ou faça ruídos de teste. Apertar Mic de novo baixa o CSV.');
  }
}

function bindMic() {
  if (!dom.btnMic) return;  // defensivo: se o HTML for antigo sem o botão
  dom.btnMic.addEventListener('click', () => { toggleMic(); });
}

function onModeChange(name) {
  // v1.12.3: trainingReadout (Score/Δ/Tier) e beat-dots ficam visíveis EM TODAS as abas.
  // Em hunt mode também, pra que a cadência (se ON) pulse os dots e os taps mostrem
  // tier/Δ no readout (útil pra "praticar timing de fim de fase").
  dom.training.hidden = false;
  dom.beatDots.hidden = false;
  renderBeatDots();
  renderSessionStats();
  // v1.12.6: ao trocar pra hunt mode (não-running), mostra preview do timing
  // baseado nos inputs atuais. Sem isso, o display fica '--.---' até dar Play.
  if (!state.running && name !== 'training') requestHuntPreview();
}

// ─── Controles ───────────────────────────────────────────────
function bindControls() {
  dom.btnPlay.addEventListener('click', toggleRun);
  dom.btnReset.addEventListener('click', resetRound);
  dom.btnUpdate.addEventListener('click', onUpdate);
  dom.btnSettings.addEventListener('click', openSettings);
  dom.settingsCancel.addEventListener('click', closeSettings);
  dom.settingsOk.addEventListener('click', closeSettings);
  if (dom.settingsReset) {
    dom.settingsReset.addEventListener('click', () => {
      // v1.12.7: reset opera no TAB ATUAL (Action → training, Timer → global).
      const tab = state.activeSettingsTab || 'action';
      const label = tab === 'timer' ? 'Timer (Console + Som)' : 'Treino';
      if (confirm('Resetar settings de ' + label + ' pros defaults?')) {
        if (tab === 'timer') resetTimerSettings();
        else                 resetTrainingSettings();
        dom.settingsContent.innerHTML = '';
        dom.settingsContent.appendChild(buildSettingsForm());
      }
    });
  }
  dom.overlay.addEventListener('click', (e) => {
    if (e.target === dom.overlay) closeSettings();
  });

  // ─── Modal de Resultados ───
  if (dom.resultsClose) dom.resultsClose.addEventListener('click', closeResults);
  if (dom.resultsAgain) dom.resultsAgain.addEventListener('click', () => {
    closeResults();
    resetRound();
    startRound();
  });
  if (dom.resultsOverlay) dom.resultsOverlay.addEventListener('click', (e) => {
    if (e.target === dom.resultsOverlay) closeResults();
  });

  // ─── Modal de confirmação de fechar sessão (v1.11) ───
  if (dom.closeConfirmYes) dom.closeConfirmYes.addEventListener('click', discardAndCloseSession);
  if (dom.closeConfirmNo)  dom.closeConfirmNo .addEventListener('click', cancelCloseAndStayPaused);
  if (dom.closeConfirmOverlay) dom.closeConfirmOverlay.addEventListener('click', (e) => {
    // Clicar fora da dialog = mesma coisa que "Não" (cancela, sessão fica pausada).
    if (e.target === dom.closeConfirmOverlay) cancelCloseAndStayPaused();
  });
}

// v1.11: mapeamento de teclas claramente separado:
//   Enter     → toggleRun (start / pause / resume)
//   Space     → tap (só se running && !paused)
//   Esc       → closeSession (= pausa + confirma fechamento, se aplicável)
//
// Quando o modal de confirmação de fechar está aberto:
//   Enter     → confirma o fechamento (= discartar)
//   Esc       → cancela (fica na sessão pausada)
//   Space     → ignorado
function bindKeyboard() {
  // iOS: o AudioContext do Safari nasce 'suspended' e só liga DENTRO de um gesto do
  // usuário. Destrava no 1º toque/tecla (resume + beep silencioso) e depois se remove.
  const _unlockAudio = () => {
    try { ensureAudio(); beep(null, { peak: 0.0001, decay: 0.01 }); } catch (e) {}
    window.removeEventListener('pointerdown', _unlockAudio, true);
    window.removeEventListener('keydown', _unlockAudio, true);
    window.removeEventListener('touchend', _unlockAudio, true);
  };
  window.addEventListener('pointerdown', _unlockAudio, true);
  window.addEventListener('keydown', _unlockAudio, true);
  window.addEventListener('touchend', _unlockAudio, true);

  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    // ─── Modal de confirmação aberto: keys roteadas pro modal ───
    if (isCloseConfirmOpen()) {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        discardAndCloseSession();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        cancelCloseAndStayPaused();
      } else if (e.code === 'Space') {
        e.preventDefault();   // bloqueia tap durante o modal
      }
      return;
    }
    // ─── Operação normal ───
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      toggleRun();
    } else if (e.code === 'Space') {
      e.preventDefault();
      // Tap só vale se rodando e não pausado. v1.13: back-data via event.timeStamp.
      if (state.running && !state.paused) onTap(_eventToAudioTime(e));
    } else if (e.code === 'Escape') {
      e.preventDefault();
      if (state.running) closeSession();
    }
  });

  // ─── Touch (mobile/PWA): tocar a tela conta como tap, igual o Espaço. ───
  // Só pointerType 'touch' (mouse/desktop seguem no Espaço/gamepad/botões).
  // Ignora toques em elementos de UI (botões, abas, dialogs) pra não roubar o clique deles.
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (isCloseConfirmOpen()) return;
    if (e.target.closest('button, a, input, select, [role="tab"], .dialog, .dialog-overlay')) return;
    // v1.13: back-data o instante do toque via event.timeStamp (mata o jitter de dispatch).
    if (state.running && !state.paused) { e.preventDefault(); onTap(_eventToAudioTime(e)); }
  }, { passive: false });
}

// ─── Start / Pause / Resume / Close ──────────────────────────
// v1.11: toggleRun é o ÚNICO entry-point pra Enter/Plus. Decide entre:
//   - !running       → startRound (nova sessão)
//   - running & !paused → pauseRound (congela)
//   - running &  paused → resumeRound (reagenda restante a partir de agora+0.2s)
//
// stopRound continua sendo "fim natural" (CSV + modal results).
// closeSession (Esc/B) é caminho separado -- pausa + confirmação + descarte.
function toggleRun() {
  if (!state.running) { startRound(); return; }
  if (state.paused)   { resumeRound(); return; }
  pauseRound();
}

function pauseRound() {
  if (!state.running || state.paused) return;
  cancelAllScheduled();
  cancelBeatVisualTimers();
  state.paused = true;
  state.pausedAt = actxNow();
  dom.btnPlay.textContent = '▶';
  // v1.12.9: SEM mensagens explícitas de pausa no display nem status bar — o display
  // congela mostrando timing/Fase/Next no instante exato do freeze (último valor que
  // o tick pintou). Mudança do botão ▶/■ é a única indicação visual ativa de pause.
  // (Vale pra todos os modos: training, gen3/4/5, custom.)
}

function resumeRound() {
  if (!state.running || !state.paused) return;
  const t = state.training;
  const bpm = Math.max(30, Math.min(300, t.bpm || 120));
  const intervalSec = 60 / bpm;
  // Beats que ainda faltavam quando pausamos.
  const remaining = state.schedule.length - state.nextBeatIdx;
  if (remaining <= 0) {
    // Nada pra continuar; encerra a sessão.
    state.paused = false;
    stopRound();
    return;
  }
  // Recompõe os timestamps dos beats restantes a partir de agora+0.2s.
  const t0 = actxNow() + 0.2;
  for (let i = 0; i < remaining; i++) {
    state.schedule[state.nextBeatIdx + i] = t0 + i * intervalSec;
  }
  // startedAt é ajustado pra a progress bar manter coerência.
  state.startedAt = t0 - state.nextBeatIdx * intervalSec;
  state.paused = false;
  dom.btnPlay.textContent = '■';
  // Reagenda áudio + visuais SÓ pros beats restantes.
  const warmupSoundName = soundNameFor(t);
  const targetSet = new Set(state.targetIndices || []);
  const targetSoundName = soundNameForTarget(t);
  const wallNow = actxNow();
  const audioLatencyMs = getAudioOutputLatencyMs();
  for (let i = state.nextBeatIdx; i < state.schedule.length; i++) {
    const when = state.schedule[i];
    const isTarget = targetSet.has(i);
    const name = isTarget ? targetSoundName : warmupSoundName;
    try { play(name, when); } catch { try { beep(when); } catch {} }
    const delayMs = Math.max(0, (when - wallNow) * 1000 + audioLatencyMs);
    const beatIdx = i;
    const beatIsTarget = isTarget;
    state.beatVisualTimers.push(setTimeout(() => onBeatTriggered(beatIdx, beatIsTarget), delayMs));
  }
  // v1.12.9: sem setStatus('Retomado') — consistente com pauseRound (silêncio na UI,
  // mudança do botão ▶/■ é o único feedback).
}

// closeSession = Esc no teclado ou B no controle.
// Pausa primeiro, depois ABRE MODAL de confirmação. Se Sim → discarta tudo.
// Se Não → fica pausada, player retoma com Enter/+.
function closeSession() {
  if (!state.running) return;     // nada pra fechar
  if (!state.paused) pauseRound();
  // Se o usuário desligou a confirmação nas settings, fecha direto.
  if (state.training.skipCloseConfirm) {
    discardAndCloseSession();
    return;
  }
  showCloseConfirmModal();
}

function discardAndCloseSession() {
  hideCloseConfirmModal();
  // Cancela tudo, descarta dados, NÃO mostra modal de resultados, NÃO exporta CSV,
  // NÃO continua a queue de stages.
  state.running = false;
  state.paused = false;
  state.queueActive = false;
  state.queueRemaining = [];
  cancelAllScheduled();
  cancelBeatVisualTimers();
  resetRound();
  dom.btnPlay.textContent = '▶';
  setStatus('Sessão fechada. Dados descartados.');
}

function cancelCloseAndStayPaused() {
  hideCloseConfirmModal();
  // v1.12.9: sem setStatus — sessão fica pausada silenciosamente, display congelado.
  // Enter / + retoma.
}

function showCloseConfirmModal() {
  if (dom.closeConfirmOverlay) dom.closeConfirmOverlay.hidden = false;
}
function hideCloseConfirmModal() {
  if (dom.closeConfirmOverlay) dom.closeConfirmOverlay.hidden = true;
}
function isCloseConfirmOpen() {
  return dom.closeConfirmOverlay && !dom.closeConfirmOverlay.hidden;
}

// v1.12: startRound vira dispatcher. Modo Treino mantém o fluxo antigo; as abas
// Gen3/Gen4/Gen5/Custom usam startHuntRound, que monta phases via timers/*.js.
function startRound() {
  if (state.activeMode === 'training') {
    return startTrainingRound();
  }
  if (state.activeMode === 'gen3' || state.activeMode === 'gen4' ||
      state.activeMode === 'gen5' || state.activeMode === 'custom') {
    return startHuntRound(state.activeMode);
  }
  setStatus('Modo "' + state.activeMode + '" desconhecido.');
}

function startTrainingRound() {
  resetRound();
  // Inicializa a queue: snapshot da fila atual de stages (cópias). Após esse stage,
  // stopRound aplica overrides do próximo e reinicia via startStageOnly.
  const queueSnap = Array.isArray(state.training.queue) ? state.training.queue.map(x => ({ ...x })) : [];
  state.queueActive = queueSnap.length > 0;
  state.queueRemaining = queueSnap;
  const t = state.training;
  const bpm = Math.max(30, Math.min(300, t.bpm || 120));
  const intervalSec = 60 / bpm;

  // ─── Cálculo do totalBeats em função do submode + durationMode ───
  // Modo B (RNG Hit): numCycles ciclos de (warmupBeats + 1) beats. Alvo no final de cada ciclo.
  // Modo A (cadência): depende do durationMode.
  //   - 'time':       totalBeats = ceil(durationSec * bpm / 60). Para automático.
  //   - 'beats':      totalBeats = durationBeats. Para automático.
  //   - 'continuous': arranca com 64 e estende em scheduleLoop. Só para com Stop.
  let totalBeats;
  let durationLabel;
  // Reset dos alvos da sessão (usado em scheduleAllBeats e onTap).
  state.targetIndices = [];
  if (t.submode === 'B') {
    const wb = modeBWarmups(t);
    const cycleLen = modeBCycleLen(t);
    const mode = t.durationMode || 'cycles';
    let cyc;
    if (mode === 'time') {
      const sec = Math.max(1, t.durationSec || 60);
      totalBeats = Math.max(cycleLen, Math.ceil(sec * bpm / 60));
      cyc = Math.ceil(totalBeats / cycleLen);
      durationLabel = sec + 's (~' + cyc + ' ciclos / ' + totalBeats + ' beats)';
    } else if (mode === 'continuous') {
      // Arranca com 8 ciclos de buffer; estende em onBeatTriggered.
      cyc = 8;
      totalBeats = cyc * cycleLen;
      durationLabel = 'contínua (estende infinito)';
    } else {  // 'cycles' (default)
      cyc = Math.max(1, t.numCycles || 1);
      totalBeats = cyc * cycleLen;
      durationLabel = cyc + ' ciclo' + (cyc > 1 ? 's' : '') + ' (' + totalBeats + ' beats · ' + cyc + ' alvo' + (cyc > 1 ? 's' : '') + ')';
    }
    // Alvos: último beat de cada ciclo (= índice wb, wb+cycleLen, ...).
    for (let i = 0; i < totalBeats; i++) {
      if (i % cycleLen === wb) state.targetIndices.push(i);
    }
  } else {
    const mode = t.durationMode || 'continuous';
    if (mode === 'simulate_hunt') {
      // Estrutura de fases vem de uma aba hunt; cadência+feedback do treino aplicam normal.
      const from = t.simulateHuntFrom || 'custom';
      const ctx = _huntContext(from);
      if (!ctx) { setStatus('Simulate Hunt: aba "' + from + '" inválida.'); return; }
      let phases;
      try {
        const settings = defaultSettings({ console: ctx.consoleSetting });
        phases = ctx.timer.createPhases(settings, ctx.model);
      } catch (e) {
        setStatus('Simulate Hunt: erro ao computar fases (' + (e.message || e) + ')');
        return;
      }
      const finitePhases = (phases || []).filter(p => Number.isFinite(p));
      if (finitePhases.length === 0) {
        setStatus('Simulate Hunt: a aba ' + ctx.label + ' não tem fases finitas configuradas.');
        return;
      }
      state.huntPhases = finitePhases;   // pra display _updateHuntDisplay
      const totalMs = buildScheduleFromPhases(finitePhases, true /* cadence sempre ON em simulate_hunt */);
      state.nextBeatIdx = 0;
      state.beatCount = 0;
      state.running = true;
      dom.btnPlay.textContent = '■';
      setStatus('Simulate Hunt (' + ctx.label + ') · ' + finitePhases.length + ' fase' + (finitePhases.length > 1 ? 's' : '') + ' · total ' + (totalMs / 1000).toFixed(2) + 's · cadência ON · feedback do Treino');
      scheduleAllBeats(t);
      scheduleLoop(t, intervalSec);
      renderBeatDots();
      return;
    } else if (mode === 'time') {
      const sec = Math.max(1, t.durationSec || 60);
      totalBeats = Math.max(1, Math.ceil(sec * bpm / 60));
      durationLabel = sec + 's (' + totalBeats + ' beats)';
    } else if (mode === 'beats') {
      totalBeats = Math.max(1, t.durationBeats || 64);
      durationLabel = totalBeats + ' beats';
    } else {
      totalBeats = 64;  // valor inicial; scheduleLoop estende em modo 'continuous'
      durationLabel = 'contínua (estende infinito)';
    }
  }

  const t0 = actxNow() + 0.2;
  state.startedAt = t0;
  state.schedule = [];
  for (let i = 0; i < totalBeats; i++) {
    state.schedule.push(t0 + i * intervalSec);
  }
  state.nextBeatIdx = 0;
  state.beatCount = 0;
  state.running = true;
  dom.btnPlay.textContent = '■';
  setStatus((t.submode === 'A' ? 'Cadência A — ' : 'RNG Hit B — ') + durationLabel);
  scheduleAllBeats(t);
  scheduleLoop(t, intervalSec);
  renderBeatDots();
}

function stopRound() {
  state.running = false;
  // Cancela todos os beats agendados (áudio E timers visuais).
  cancelAllScheduled();
  cancelBeatVisualTimers();
  dom.btnPlay.textContent = '▶';
  renderCycleChip();
  // ─── Hunt mode: sem queue, sem session-results de Treino ───
  if (state.huntActive) {
    state.huntActive = false;
    const label = state.huntCtx && state.huntCtx.label || 'Hunt';
    const phaseCount = Array.isArray(state.huntPhases) ? state.huntPhases.length : 0;
    setStatus(label + ' parada · ' + phaseCount + ' fases agendadas · ' + state.huntHits.length + ' tap(s) registrado(s). Preencha Frame/Delay/Second Hit e clique Update pra atualizar a calibração.');
    return;
  }
  // ─── Multi-stage chaining ───
  // Se a queue tem stages pendentes, aplica o próximo e reinicia. O CSV/results
  // modal só aparecem ao FIM da queue inteira (último stage). Isso evita
  // ficar interrompendo o fluxo entre stages.
  if (state.queueActive && state.queueRemaining && state.queueRemaining.length > 0) {
    const next = state.queueRemaining.shift();
    // Aplica overrides no training atual sem perder defaults dos campos não-mencionados.
    Object.assign(state.training, next);
    saveTrainingSettings();
    // Pequeno delay (350ms) entre stages pra dar respiro visual + permitir o pulse
    // do último beat decair antes do próximo arrancar.
    setStatus('Próximo timer da sequência em 0.35s…');
    setTimeout(() => {
      if (state.queueActive) {
        // Note: resetRound zera score/history. Mas talvez seja desejável MANTER os
        // history acumulados pra um relatório consolidado no fim da queue. Decisão:
        // mantém score e history ENTRE stages (acumulado) -- só reseta no Stop manual
        // ou no botão Reset.
        const t = state.training;
        const bpm = Math.max(30, Math.min(300, t.bpm || 120));
        const intervalSec = 60 / bpm;
        startStageOnly(t, bpm, intervalSec);
      }
    }, 350);
    return;
  }
  // Fim natural da sessão (sem queue, ou queue terminou): exporta + modal.
  state.queueActive = false;
  state.queueRemaining = [];
  setStatus('Parado. Score: ' + state.score.toFixed(1) + ' (' + state.history.length + ' taps)');
  if (state.history.length >= 3) {
    showSessionResults();
  }
}

// ─── HUNT MODE (Gen3 / Gen4 / Gen5 / Custom) ──────────────────────
// Usa a math portada do EonTimer (timers/*.js) pra computar phases em ms. Monta
// schedule com:
//   - Cadência de fundo (BPM do Treino) durante toda a sessão -- te dá referência
//     rítmica enquanto a fase corre, igual o "lead-in beep" do EonTimer.
//   - Alarm (targetSound) no FIM EXATO de cada fase -- ponto de input crítico.
// Pause/Esc/Stop reusam a infra existente. Botão Update aplica calibration delta
// baseado no Frame/Delay/Second Hit do form (mesmíssima lógica do EonTimer).

// v1.12.5: helper compartilhado entre startHuntRound e startTrainingRound (modo
// simulate_hunt). Construído à imagem do EonTimer (workers/timerWorker.ts:
// buildActions). Fases são SEMPRE contíguas (zero gap, frame-perfect).
//
// useCadence = FALSE (default, EonTimer-style countdown):
//   Pra cada fase, `count` beeps espaçados por `interval` ms terminando NO instante
//   exato do fim da fase. Pattern: { phase_end, phase_end - interval, phase_end - 2*interval,
//   ..., phase_end - (count-1)*interval }, descartando os que caem antes do início
//   da fase (= early start). Default: count=6, interval=500ms → "countdown zone" de
//   2.5s ao fim de cada fase, com 6 beeps. Antes da zone = silêncio total.
//   Beat final (= phase_end) é o alarm (`targetSound`); os 5 precedentes são lead-up
//   com `sound` regular.
//
// useCadence = TRUE (cadência do Treino contínua):
//   Cadência fixa no BPM do Treino atravessa a sessão inteira + alarms nos fins
//   de fase. Beats que caem dentro de ~30ms de um alarm são descartados (sem stomp).
//
// Modifica state.schedule, state.targetIndices, state.startedAt. Retorna totalMs.
function buildScheduleFromPhases(finitePhases, useCadence) {
  const t0 = actxNow() + 0.2;
  state.startedAt = t0;
  state.schedule = [];
  state.targetIndices = [];
  const t = state.training;
  const events = [];
  let cumMs = 0;

  if (useCadence) {
    const trainingBpm = Math.max(30, Math.min(300, t.bpm || 120));
    const intervalMs = (60 / trainingBpm) * 1000;
    for (const phaseMs of finitePhases) {
      cumMs += phaseMs;
      events.push({ atMs: cumMs, isTarget: true });
    }
    const totalMs = cumMs;
    for (let cMs = intervalMs; cMs < totalMs; cMs += intervalMs) {
      const tooClose = events.some(e => Math.abs(e.atMs - cMs) < 30);
      if (!tooClose) events.push({ atMs: cMs, isTarget: false });
    }
  } else {
    // EonTimer pattern: por fase, `count` beeps espaçados por `interval` ms,
    // último em phase_end (= alarm), precedentes em phase_end - k*interval.
    const actionInterval = Math.max(50, Math.min(5000, t.actionInterval || 500));
    const actionCount    = Math.max(1, Math.min(20, t.actionCount    || 6));
    let phaseStart = 0;
    for (const phaseMs of finitePhases) {
      const phaseEnd = phaseStart + phaseMs;
      // i=0 → phase_end (= target). i=count-1 → phase_end - (count-1)*interval.
      for (let i = 0; i < actionCount; i++) {
        const atMs = phaseEnd - i * actionInterval;
        if (atMs < phaseStart - 1) break;   // sai do começo da fase = pula
        events.push({ atMs, isTarget: (i === 0) });
      }
      phaseStart = phaseEnd;
    }
    cumMs = phaseStart;
  }

  events.sort((a, b) => a.atMs - b.atMs);
  for (const e of events) {
    state.schedule.push(t0 + e.atMs / 1000);
    if (e.isTarget) state.targetIndices.push(state.schedule.length - 1);
  }
  return cumMs;
}

// Helper: normaliza model.mode pros valores que createPhases() do timer espera.
// gen-panels.js usa 'STANDARD'/'C_GEAR'/'ENTRALINK'/'ENTRALINK_PLUS' (uppercase),
// mas Gen3Mode/Gen5Mode constantes são 'Standard'/'C-Gear'/'Entralink'/'Entralink+'.
function _normalizeMode(mode) {
  if (!mode) return mode;
  const map = {
    'STANDARD':        'Standard',
    'VARIABLE_TARGET': 'Variable Target',
    'C_GEAR':          'C-Gear',
    'ENTRALINK':       'Entralink',
    'ENTRALINK_PLUS':  'Entralink+',
  };
  return map[String(mode).toUpperCase()] || mode;
}

// Defaults pra cada aba caso o panel ainda não tenha sido renderizado (= state
// ainda não inicializado). Espelham os defaults em gen-panels.js.
function _ensureGenState(activeMode) {
  if (activeMode === 'gen3' && !state.gen3) {
    state.gen3 = { mode: 'STANDARD', preTimer: 5000, targetFrame: 1500, calibration: 0, frameHit: null, useCadence: false };
  }
  if (activeMode === 'gen4' && !state.gen4) {
    state.gen4 = { calibratedDelay: 500, calibratedSecond: 14, targetDelay: 600, targetSecond: 50, delayHit: null, useCadence: false };
  }
  if (activeMode === 'gen5' && !state.gen5) {
    state.gen5 = { mode: 'STANDARD', targetSecond: 0, calibration: 0, targetDelay: 1200, targetAdvances: 100, entralinkCalibration: 0, frameCalibration: 0, secondHit: null, useCadence: false };
  }
  if (activeMode === 'custom' && !state.custom) {
    state.custom = { phases: [{ unit: 'ms', target: 5000, calibration: 0, hit: null }], useCadence: false };
  }
}

function _huntContext(activeMode) {
  _ensureGenState(activeMode);
  // v1.12.7: console GLOBAL (Settings → Timer) define o framerate de conversão
  // pra todos os hunt modes EXCETO Custom — que é hardcoded GBA por design
  // (= use case principal do Custom é FRLG/Emerald, mesma plataforma do GBA).
  const globalConsole = (state.timer && state.timer.console) || Console.GBA;
  switch (activeMode) {
    case 'gen3':
      return {
        timer: gen3,
        model: { ...state.gen3, mode: _normalizeMode(state.gen3.mode) },
        consoleSetting: globalConsole,
        label: 'Gen 3',
      };
    case 'gen4':
      return {
        timer: gen4,
        model: { ...state.gen4 },
        consoleSetting: globalConsole,
        label: 'Gen 4',
      };
    case 'gen5':
      return {
        timer: gen5,
        model: { ...state.gen5, mode: _normalizeMode(state.gen5.mode) },
        consoleSetting: globalConsole,
        label: 'Gen 5',
      };
    case 'custom':
      return {
        timer: customMod,
        model: (state.custom && state.custom.phases) || [],   // custom usa array
        consoleSetting: Console.GBA,                          // FIXED — não usa o global
        label: 'Custom',
      };
    default:
      return null;
  }
}

// v1.12.6: queue de targets em Gen3/4/5. Cada item é um snapshot dos campos do
// target naquele momento (ver targetQueueSection em gen-panels.js). Custom não
// tem queue separado (a aba já é uma lista de phases).
function _getTargetQueue(activeMode) {
  if (activeMode === 'gen3') return Array.isArray(state.gen3 && state.gen3.targetQueue) ? state.gen3.targetQueue : [];
  if (activeMode === 'gen4') return Array.isArray(state.gen4 && state.gen4.targetQueue) ? state.gen4.targetQueue : [];
  if (activeMode === 'gen5') return Array.isArray(state.gen5 && state.gen5.targetQueue) ? state.gen5.targetQueue : [];
  return [];
}

// Reconstrói um "model" pra timer.createPhases a partir de um snapshot da queue.
// Não modifica o state global (snap é só lido).
function _modelFromSnapshot(activeMode, snap) {
  if (activeMode === 'gen3') return { ...snap, mode: _normalizeMode(snap.mode) };
  if (activeMode === 'gen4') return { ...snap };
  if (activeMode === 'gen5') return { ...snap, mode: _normalizeMode(snap.mode) };
  return snap;
}

// Coleta TODAS as phases pra rodar um hunt: primary (stage 1) + cada item da
// queue (stages 2..N). Devolve {phases, stageStartIndices, settings}, onde
// stageStartIndices[k] = índice em `phases` da primeira phase do stage k+1
// (= delimitador visual; útil pro display "Fase X (Stage K)").
//
// Stages com Infinity são respeitados (Infinity entra na lista — o caller filtra).
function _collectAllHuntPhases(activeMode) {
  const ctx = _huntContext(activeMode);
  if (!ctx) return { phases: [], stageStartIndices: [], settings: null, label: '' };
  const settings = defaultSettings({ console: ctx.consoleSetting });
  const phases = [];
  const stageStartIndices = [];

  stageStartIndices.push(0);
  let primary;
  try {
    primary = ctx.timer.createPhases(settings, ctx.model);
  } catch (e) {
    console.error('[hunt collect primary]', e);
    return { phases: [], stageStartIndices: [], settings, label: ctx.label };
  }
  for (const p of (primary || [])) phases.push(p);

  if (activeMode !== 'custom') {
    const queue = _getTargetQueue(activeMode);
    for (const snap of queue) {
      stageStartIndices.push(phases.length);
      const model = _modelFromSnapshot(activeMode, snap);
      let phasesK;
      try {
        phasesK = ctx.timer.createPhases(settings, model);
      } catch (e) {
        console.error('[hunt collect queue stage]', e);
        continue;
      }
      for (const p of (phasesK || [])) phases.push(p);
    }
  }

  return { phases, stageStartIndices, settings, label: ctx.label };
}

function startHuntRound(activeMode) {
  const ctx = _huntContext(activeMode);
  if (!ctx) { setStatus(activeMode + ' não suportado.'); return; }
  let phases, stageStartIndices, settings;
  try {
    const collected = _collectAllHuntPhases(activeMode);
    phases = collected.phases;
    stageStartIndices = collected.stageStartIndices;
    settings = collected.settings;
    state.huntSettings = settings;   // guardado pra calibrate() depois
  } catch (e) {
    setStatus(ctx.label + ' erro: ' + (e && e.message ? e.message : e));
    console.error('[hunt]', e);
    return;
  }
  if (!Array.isArray(phases) || phases.length === 0) {
    setStatus(ctx.label + ' sem fases configuradas.');
    return;
  }
  // Filtra fases não-finitas (Variable Target = Infinity). Se a primeira ou alguma
  // fase é Infinity, vamos rodar só até a fase anterior (= "para aqui e espera tap").
  // Trunca stageStartIndices pra remover stages que começam após o corte.
  const finitePhases = [];
  let hasInfinite = false;
  for (const p of phases) {
    if (!Number.isFinite(p)) { hasInfinite = true; break; }
    finitePhases.push(p);
  }
  if (finitePhases.length === 0) {
    setStatus(ctx.label + ' todas fases são Infinity -- nada pra agendar.');
    return;
  }
  const finiteStageStarts = stageStartIndices.filter((idx) => idx < finitePhases.length);

  resetRound();
  state.huntActive  = true;
  state.huntMode    = activeMode;
  state.huntPhases  = finitePhases;       // só as finitas (pra display + cálculo de total)
  state.huntStageStarts = finiteStageStarts;
  state.huntCtx     = ctx;
  state.huntHits    = [];
  state.queueActive = false;
  state.queueRemaining = [];

  // useCadence vem do state.gen{X}.useCadence (default false = EonTimer puro).
  let useCadence = false;
  if (activeMode === 'gen3') useCadence = !!state.gen3.useCadence;
  else if (activeMode === 'gen4') useCadence = !!state.gen4.useCadence;
  else if (activeMode === 'gen5') useCadence = !!state.gen5.useCadence;
  else if (activeMode === 'custom') useCadence = !!(state.custom && state.custom.useCadence);
  state.huntUseCadence = useCadence;

  buildScheduleFromPhases(finitePhases, useCadence);

  state.nextBeatIdx = 0;
  state.beatCount = 0;
  state.running = true;
  state.paused = false;
  dom.btnPlay.textContent = '■';

  const huntBpm = Math.max(30, Math.min(300, state.training.bpm || 120));
  const huntIntervalSec = 60 / huntBpm;
  const totalMsActual = finitePhases.reduce((a, b) => a + b, 0);
  const totalSec = (totalMsActual / 1000).toFixed(2);
  // Phase desc mostra "S1.F1=… · S1.F2=… · S2.F1=…" quando tem queue multi-stage,
  // ou "F1=… · F2=…" simples quando é só primary.
  const stageCount = finiteStageStarts.length;
  const _stageOfPhase = (i) => {
    for (let s = finiteStageStarts.length - 1; s >= 0; s--) {
      if (i >= finiteStageStarts[s]) return s;
    }
    return 0;
  };
  const phaseDescs = (stageCount > 1)
    ? finitePhases.map((ms, i) => {
        const s = _stageOfPhase(i);
        const phaseInStage = i - finiteStageStarts[s] + 1;
        return 'S' + (s + 1) + '.F' + phaseInStage + '=' + (ms / 1000).toFixed(2) + 's';
      }).join(' · ')
    : finitePhases.map((ms, i) => 'F' + (i + 1) + '=' + (ms / 1000).toFixed(2) + 's').join(' · ');
  const infTail = hasInfinite ? ' · (+Infinity ignorada)' : '';
  const cadTail = useCadence
    ? ' · cadência BPM=' + huntBpm + ' ON'
    : ' · 6 beats por fase';
  setStatus(ctx.label + ' · ' + phaseDescs + ' · total ' + totalSec + 's' + cadTail + infTail);

  scheduleAllBeats(state.training);
  scheduleLoop(state.training, huntIntervalSec);
  renderBeatDots();
}

// startStageOnly inicia um stage SEM resetar history/score. Usado pelo auto-chain
// da queue. É a parte do startRound que monta o schedule novo e dispara o tick.
function startStageOnly(t, bpm, intervalSec) {
  let totalBeats;
  state.targetIndices = [];
  if (t.submode === 'B') {
    const wb = modeBWarmups(t);
    const cycleLen = modeBCycleLen(t);
    const mode = t.durationMode || 'cycles';
    let cyc;
    if (mode === 'time') {
      totalBeats = Math.max(cycleLen, Math.ceil((t.durationSec || 60) * bpm / 60));
      cyc = Math.ceil(totalBeats / cycleLen);
    } else if (mode === 'continuous') {
      cyc = 8;
      totalBeats = cyc * cycleLen;
    } else {
      cyc = Math.max(1, t.numCycles || 1);
      totalBeats = cyc * cycleLen;
    }
    for (let i = 0; i < totalBeats; i++) {
      if (i % cycleLen === wb) state.targetIndices.push(i);
    }
  } else {
    const mode = t.durationMode || 'continuous';
    if (mode === 'time') totalBeats = Math.max(1, Math.ceil((t.durationSec || 60) * bpm / 60));
    else if (mode === 'beats') totalBeats = Math.max(1, t.durationBeats || 64);
    else totalBeats = 64;
  }
  const t0 = actxNow() + 0.2;
  state.startedAt = t0;
  state.schedule = [];
  for (let i = 0; i < totalBeats; i++) state.schedule.push(t0 + i * intervalSec);
  state.nextBeatIdx = 0;
  state.beatCount = 0;
  state.running = true;
  dom.btnPlay.textContent = '■';
  setStatus('Stage: ' + (t.submode === 'A' ? 'Cadência A' : 'RNG Hit B') + ' · ' + bpm + ' BPM');
  scheduleAllBeats(t);
  scheduleLoop(t, intervalSec);
  renderBeatDots();
  renderCycleChip();
  // Re-render aba Treino pra refletir o stage atual.
  if (_modeSwitcher && state.activeMode === 'training') {
    _modeSwitcher.activate('training');
  }
}

function resetRound() {
  // Cancela qualquer beat ainda enfileirado antes de zerar -- áudio E timers visuais.
  cancelAllScheduled();
  cancelBeatVisualTimers();
  state.score = 0;
  state.history = [];
  state.beatCount = 0;
  state.nextBeatIdx = 0;
  state.schedule = [];
  state.streakCount = 0;
  state.maxStreakThisSession = 0;
  state.milestonesShown = {};
  state.targetIndices = [];
  state.queueActive = false;
  state.queueRemaining = [];
  state.paused = false;
  // v1.12.3: limpa hunt/simulate-hunt phases pra o próximo round arrancar limpo.
  state.huntPhases = null;
  state.huntActive = false;
  dom.rdScore.textContent = '0';
  dom.rdDelta.textContent = '—';
  dom.rdTierBadge.textContent = '—';
  dom.rdTierBadge.className = 'tier-badge';
  // v1.11.1: limpa o display do timer pra não ficar mostrando valores stale após
  // stop/close. Sem isso, "Phase: 12/64" e "Next: 0.42s" ficavam congelados na tela.
  if (dom.phaseValue) dom.phaseValue.textContent = '--.---';
  if (dom.metaPhase)  dom.metaPhase.textContent  = '— / —';
  if (dom.metaNext)   dom.metaNext.textContent   = '—';
  if (dom.metaTotal)  dom.metaTotal.textContent  = '—';
  if (dom.progressFill) dom.progressFill.style.transform = 'scaleX(1)';
  renderBeatDots();
  renderSessionStats();
  renderStreakChip();
  renderCycleChip();
  setPhaseProgress(0);
  // v1.12.6: após reset/stop em hunt mode, repõe preview pra não ficar '--.---'.
  if (state.activeMode && state.activeMode !== 'training') {
    // adiar 1 frame pra deixar o reset acima "tomar" antes do preview pintar.
    requestAnimationFrame(() => { if (!state.running) requestHuntPreview(); });
  }
}

// ─── Beat scheduling ────────────────────────────────────────
function soundNameFor(t) {
  // v1.12.7: Som dos beeps virou GLOBAL (state.timer.sound, vai pra Settings → Timer).
  // `t.sound` legacy só é fallback se o state.timer ainda não foi inicializado.
  const fromGlobal = (state.timer && state.timer.sound) || null;
  const k = (fromGlobal || (t && t.sound) || 'beep').toUpperCase();
  return Sound[k] ?? Sound.BEEP;
}

function soundNameForTarget(t) {
  // targetSound (modo B do treino) continua sendo per-training. Só faz sentido lá.
  const k = (t.targetSound || 'ding').toUpperCase();
  return Sound[k] ?? Sound.DING;
}

// v1.11.1: helper que devolve quanto tempo (em ms) o áudio leva pra realmente sair
// do speaker após o `when` agendado. Default ~40ms em laptops com WASAPI. Usado pra
// alinhar o pulse visual com o som AUDÍVEL (não com o tempo do agendamento).
// v1.12.10: BUG FIXED. Antes usava `typeof getCtx === 'function'` mas `getCtx` nunca
// tinha sido importado de audio.js → sempre fallback pra 0 → compensação desligada.
function getAudioOutputLatencyMs() {
  const actx = getCtx();
  if (!actx) return 0;
  // outputLatency = delay até sair do device (driver-side). Pode ser 0 se driver não preenche.
  // baseLatency   = buffer interno do AudioContext (~10ms tipicamente em WASAPI).
  const out  = (typeof actx.outputLatency === 'number') ? actx.outputLatency : 0;
  const base = (typeof actx.baseLatency   === 'number') ? actx.baseLatency   : 0;
  return Math.max(0, (out + base) * 1000);
}

// v1.12.10: helper de diagnóstico — devolve out e base separados, usado pelo gpDebug
// pra você saber QUAL dos dois o driver não preenche.
function _audioLatencyParts() {
  const actx = getCtx();
  if (!actx) return { out: 0, base: 0 };
  return {
    out:  ((typeof actx.outputLatency === 'number') ? actx.outputLatency : 0) * 1000,
    base: ((typeof actx.baseLatency   === 'number') ? actx.baseLatency   : 0) * 1000,
  };
}

// scheduleAllBeats agenda ÁUDIO + TIMERS VISUAIS. O áudio é agendado em `when`
// (Web Audio sample-accurate), mas SAI do speaker em `when + outputLatency` por
// causa do buffer do device. Pra o pulse visual bater JUNTO com o som ouvido, o
// setTimeout é agendado pra `when + outputLatency`. Sem isso o visual chega antes
// (= sensação de "fora de sincronia" reportada pelo usuário).
function scheduleAllBeats(t) {
  const warmupSoundName = soundNameFor(t);
  const targetSet = new Set(state.targetIndices || []);
  const targetSoundName = soundNameForTarget(t);
  cancelBeatVisualTimers();
  const wallNow = actxNow();
  const audioLatencyMs = getAudioOutputLatencyMs();
  for (let i = 0; i < state.schedule.length; i++) {
    const when = state.schedule[i];
    const isTarget = targetSet.has(i);
    const name = isTarget ? targetSoundName : warmupSoundName;
    try { play(name, when); } catch { try { beep(when); } catch {} }
    // Visual delay = quando o som chega no speaker.
    const delayMs = Math.max(0, (when - wallNow) * 1000 + audioLatencyMs);
    const beatIdx = i;
    const beatIsTarget = isTarget;
    state.beatVisualTimers.push(setTimeout(() => onBeatTriggered(beatIdx, beatIsTarget), delayMs));
  }
}

function cancelBeatVisualTimers() {
  if (state.beatVisualTimers && state.beatVisualTimers.length > 0) {
    for (const id of state.beatVisualTimers) clearTimeout(id);
  }
  state.beatVisualTimers = [];
}

// Chamada NO INSTANTE do beat (via setTimeout pré-agendado). Atualiza estado de
// contagem, dispara o pulse visual no dot, e gerencia continuous extension.
function onBeatTriggered(globalIdx, isTarget) {
  if (!state.running) return;
  state.beatCount = globalIdx + 1;
  state.nextBeatIdx = globalIdx + 1;
  triggerDotPulse(globalIdx, isTarget);
  updateBeatDotClasses();
  renderCycleChip();
  // Fim da fila: estende em continuous OU para a sessão.
  if (globalIdx === state.schedule.length - 1) {
    // Hunt mode: fim das fases finitas, nunca estende.
    if (state.huntActive) {
      setTimeout(() => { if (state.running) stopRound(); }, 120);
      return;
    }
    const t = state.training;
    const mode = t.durationMode || 'continuous';
    if (mode === 'continuous') {
      extendScheduleContinuous();
    } else {
      setTimeout(() => { if (state.running) stopRound(); }, 100);
    }
  }
}

function extendScheduleContinuous() {
  const t = state.training;
  const bpm = Math.max(30, Math.min(300, t.bpm || 120));
  const intervalSec = 60 / bpm;
  const lastWhen = state.schedule[state.schedule.length - 1];
  const N_EXT = 32;
  const oldLen = state.schedule.length;
  const warmupSoundName = soundNameFor(t);
  const targetSoundName = soundNameForTarget(t);
  const isModeB = (t.submode === 'B');
  const cycleLen = isModeB ? modeBCycleLen(t) : null;
  const wb       = isModeB ? modeBWarmups(t)  : null;
  const wallNow = actxNow();
  const audioLatencyMs = getAudioOutputLatencyMs();
  for (let k = 1; k <= N_EXT; k++) {
    const idx = oldLen - 1 + k;
    const when = lastWhen + k * intervalSec;
    state.schedule.push(when);
    let isTarget = false;
    if (isModeB && idx % cycleLen === wb) {
      state.targetIndices.push(idx);
      isTarget = true;
    }
    const name = isTarget ? targetSoundName : warmupSoundName;
    try { play(name, when); } catch { try { beep(when); } catch {} }
    const delayMs = Math.max(0, (when - wallNow) * 1000 + audioLatencyMs);
    const beatIdx = idx;
    const beatIsTarget = isTarget;
    state.beatVisualTimers.push(setTimeout(() => onBeatTriggered(beatIdx, beatIsTarget), delayMs));
  }
}

// v1.11.1+v1.12: scheduleLoop continua em rAF mas SÓ atualiza UI quando !paused.
// v1.12: em hunt mode, o display mostra dados das FASES (não dos beats de cadência):
//   phaseValue/metaNext = tempo até o próximo ALVO (= fim da próxima fase)
//   metaPhase           = "Fase X / N"
//   metaTotal           = duração total real (= sum(huntPhases) em ms)
function scheduleLoop(t, intervalSec) {
  function tick() {
    if (!state.running) return;
    if (state.paused) {
      requestAnimationFrame(tick);
      return;
    }
    const tNow = actxNow();
    // v1.12.3: dispatch baseado em huntPhases (não huntActive). simulate_hunt no
    // Treino também tem huntPhases e usa display de fases.
    if (state.huntPhases && state.huntPhases.length > 0) {
      _updateHuntDisplay(tNow);
    } else {
      _updateTrainingDisplay(tNow, intervalSec);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function _updateTrainingDisplay(tNow, intervalSec) {
  const total = state.schedule.length;
  if (state.nextBeatIdx >= total) return;
  const nextAt = state.schedule[state.nextBeatIdx];
  const dt = (nextAt - tNow) * 1000;
  dom.phaseValue.textContent = (dt / 1000).toFixed(3);
  const elapsed = tNow - state.startedAt;
  const totalDur = total * intervalSec;
  const pct = Math.max(0, Math.min(1, elapsed / totalDur));
  dom.progressFill.style.transform = 'scaleX(' + (1 - pct) + ')';
  dom.metaPhase.textContent = (state.nextBeatIdx + 1) + ' / ' + total;
  dom.metaNext.textContent  = (dt / 1000).toFixed(2) + 's';
  dom.metaTotal.textContent = totalDur.toFixed(2) + 's';
}

// v1.12.5: formato fiel ao EonTimer's TimerDisplay.tsx.
//   phaseValue = "5.000" (remaining_s.MMM da FASE atual, conta 0)
//   metaPhase  = "Fase 1 de 2"
//   metaNext   = "25.114s" (duração da próxima fase) ou "—" se for a última
//   metaTotal  = "0m 30.114s" (soma das fases)
// Progress bar tem 3 "zones":
//   normal   = mais que (count-1)*interval ms até o fim da fase
//   action   = últimos (count-1)*interval ms da fase atual (= countdown ativo)
//   complete = remaining <= 0
function _formatPhaseTotal(phases) {
  const totalMs = phases.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const totalS = totalMs / 1000;
  const mins = Math.floor(totalS / 60);
  const secs = totalS - mins * 60;
  return mins + 'm ' + secs.toFixed(3) + 's';
}

function _updateHuntDisplay(tNow) {
  const targets = state.targetIndices || [];
  const phases = state.huntPhases || [];
  const stageStarts = state.huntStageStarts || [0];
  const totalMs = phases.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  // Próximo alvo = primeiro target index >= nextBeatIdx.
  let nextTargetIdx = -1;
  let phaseIdx = -1;
  for (let i = 0; i < targets.length; i++) {
    if (targets[i] >= state.nextBeatIdx) {
      nextTargetIdx = targets[i];
      phaseIdx = i;
      break;
    }
  }

  const _stageOfPhase = (i) => {
    for (let s = stageStarts.length - 1; s >= 0; s--) {
      if (i >= stageStarts[s]) return s;
    }
    return 0;
  };
  const _phaseTag = (i) => {
    if (stageStarts.length <= 1) return 'Fase ' + (i + 1) + ' de ' + targets.length;
    const s = _stageOfPhase(i);
    const phaseInStage = i - stageStarts[s] + 1;
    return 'S' + (s + 1) + '/' + stageStarts.length + ' · F' + phaseInStage + ' (' + (i + 1) + '/' + targets.length + ')';
  };

  if (nextTargetIdx < 0) {
    dom.phaseValue.textContent = '0.000';
    dom.metaPhase.textContent  = stageStarts.length > 1
      ? 'S' + stageStarts.length + '/' + stageStarts.length + ' completo'
      : 'Fase ' + targets.length + ' de ' + targets.length;
    dom.metaNext.textContent   = '—';
    dom.metaTotal.textContent  = _formatPhaseTotal(phases);
    dom.progressFill.style.transform = 'scaleX(0)';
    _setProgressZone('complete');
    return;
  }

  const nextAt = state.schedule[nextTargetIdx];
  const remainingMs = (nextAt - tNow) * 1000;   // tempo até fim da fase atual
  const elapsedMs = (tNow - state.startedAt) * 1000;
  const pct = totalMs > 0 ? Math.max(0, Math.min(1, elapsedMs / totalMs)) : 0;

  dom.phaseValue.textContent = (Math.max(0, remainingMs) / 1000).toFixed(3);
  dom.progressFill.style.transform = 'scaleX(' + (1 - pct) + ')';
  dom.metaPhase.textContent  = _phaseTag(phaseIdx);

  // Próxima fase: duração da fase phaseIdx+1 + tag de stage (avisa quando muda de stage).
  if (phaseIdx + 1 < phases.length) {
    const nextPhaseMs = phases[phaseIdx + 1];
    const nextStr = (nextPhaseMs / 1000).toFixed(3) + 's';
    if (stageStarts.length > 1) {
      const currStage = _stageOfPhase(phaseIdx);
      const nextStage = _stageOfPhase(phaseIdx + 1);
      const stageHint = (nextStage !== currStage) ? '  → S' + (nextStage + 1) : '';
      dom.metaNext.textContent = nextStr + stageHint;
    } else {
      dom.metaNext.textContent = nextStr;
    }
  } else {
    dom.metaNext.textContent = '—';
  }
  dom.metaTotal.textContent = _formatPhaseTotal(phases);

  // Zone do progress bar: action zone = últimos (count-1)*interval ms da fase atual.
  const t = state.training;
  const actionInterval = Math.max(50, Math.min(5000, t.actionInterval || 500));
  const actionCount    = Math.max(1, Math.min(20, t.actionCount    || 6));
  const actionZoneMs = actionInterval * Math.max(0, actionCount - 1);
  if (remainingMs <= 0) _setProgressZone('complete');
  else if (actionZoneMs > 0 && remainingMs <= actionZoneMs) _setProgressZone('action');
  else _setProgressZone('normal');
}

// v1.12.6: preview do display quando NÃO está rodando. Chamado:
//   1. ao trocar de aba pra um hunt mode (em onModeChange → activate panel),
//   2. quando qualquer input dos painéis muda (gen-panels.js → _requestPreview()).
// Computa phases (primary + queue) e popula phaseValue/metaPhase/metaNext/metaTotal
// com os valores que seriam usados se desse Play agora. NÃO toca em audio nem schedule.
function requestHuntPreview() {
  if (state.running) return;                              // não mexer enquanto roda
  if (state.activeMode === 'training') return;            // training tem outro display
  const collected = _collectAllHuntPhases(state.activeMode);
  const phases = (collected.phases || []).filter(p => Number.isFinite(p));
  if (phases.length === 0) {
    if (dom.phaseValue) dom.phaseValue.textContent = '--.---';
    if (dom.metaPhase)  dom.metaPhase.textContent  = '— / —';
    if (dom.metaNext)   dom.metaNext.textContent   = '—';
    if (dom.metaTotal)  dom.metaTotal.textContent  = '—';
    if (dom.progressFill) dom.progressFill.style.transform = 'scaleX(1)';
    return;
  }
  const stageStarts = (collected.stageStartIndices || [0]).filter((idx) => idx < phases.length);
  const totalMs = phases.reduce((a, b) => a + b, 0);
  const firstMs = phases[0];

  if (dom.phaseValue) dom.phaseValue.textContent = (firstMs / 1000).toFixed(3);
  if (dom.progressFill) dom.progressFill.style.transform = 'scaleX(1)';

  if (dom.metaPhase) {
    if (stageStarts.length > 1) {
      dom.metaPhase.textContent = 'S1/' + stageStarts.length + ' · F1 (1/' + phases.length + ')';
    } else {
      dom.metaPhase.textContent = 'Fase 1 de ' + phases.length;
    }
  }
  if (dom.metaNext) {
    if (phases.length > 1) {
      const nextStr = (phases[1] / 1000).toFixed(3) + 's';
      if (stageStarts.length > 1) {
        const stageOfOne = (() => {
          for (let s = stageStarts.length - 1; s >= 0; s--) {
            if (1 >= stageStarts[s]) return s;
          }
          return 0;
        })();
        const stageHint = (stageOfOne !== 0) ? '  → S' + (stageOfOne + 1) : '';
        dom.metaNext.textContent = nextStr + stageHint;
      } else {
        dom.metaNext.textContent = nextStr;
      }
    } else {
      dom.metaNext.textContent = '—';
    }
  }
  if (dom.metaTotal) dom.metaTotal.textContent = _formatPhaseTotal(phases);
}

// Aplica classe zone-{name} no .timer-progress-bar. Usa CSS injetado pra estilizar.
function _setProgressZone(name) {
  const bar = dom.progressFill && dom.progressFill.parentElement;
  if (!bar) return;
  bar.classList.remove('zone-normal', 'zone-action', 'zone-complete');
  bar.classList.add('zone-' + name);
}

// v1.13: converte o instante de um evento (pointerdown/keydown) pro clock do
// AudioContext via event.timeStamp (gravado QUANDO o evento ocorreu, mesma base de
// performance.now()) em vez de ler actxNow() no momento em que o handler roda. Remove
// o jitter VARIÁVEL de dispatch (event-loop sob carga de animação) que fazia o Δ
// "oscilar" mesmo com taps fisicamente consistentes. O resíduo FIXO (digitizer touch
// + sub-compensação da outputLatency no iOS) é calibrado via touchOffsetMs.
function _eventToAudioTime(e) {
  const base = actxNow();
  const offSec = ((state.timer && state.timer.touchOffsetMs) || 0) / 1000;
  const ts = (e && typeof e.timeStamp === 'number') ? e.timeStamp : NaN;
  if (Number.isFinite(ts) && ts > 0) {
    const ageMs = performance.now() - ts;
    // Guard: evento deve estar no passado recente (0–1000ms). Fora disso (epoch
    // diferente / evento sintético / relógio bizarro) → fallback pro clock atual.
    if (ageMs >= 0 && ageMs < 1000) return base - ageMs / 1000 - offSec;
  }
  return base - offSec;
}

// ─── Tap (entrada do usuário) ───────────────────────────────
// `tNowOverride`: tempo do tap (clock do AudioContext, em segundos). Vindo de
// touch/teclado, o handler passa _eventToAudioTime(e) (back-datado via event.timeStamp).
// Vindo do gamepad, o controller.js já calcula o instante exato do rising-edge
// (back-datado pelo gp.timestamp) e passa pra cá -- evita 1 frame de polling jitter.
function onTap(tNowOverride) {
  const t = state.training;
  const tNow = (typeof tNowOverride === 'number') ? tNowOverride : actxNow();
  if (state.schedule.length === 0) return;

  // v1.12.8: compensação de latência de saída de áudio. state.schedule[i] guarda
  // QUANDO o áudio foi AGENDADO (timeline do Web Audio), mas o som SAI pelo speaker
  // só em `schedule[i] + outputLatency` (~40ms em laptops WASAPI). O user sincroniza
  // com o som que OUVE, não com o agendamento — então o "instante de referência" pro
  // tap é o som-no-ar, ie schedule[i] + audioLatencySec. Sem isso, Δ vinha
  // sistematicamente +40ms (parecia "sempre tarde") mesmo em hit perfeito.
  const audioLatencySec = getAudioOutputLatencyMs() / 1000;
  const refOf = (idx) => state.schedule[idx] + audioLatencySec;

  // ─── Modo A: tap medido vs beat mais próximo ───
  // ─── Modo B: tap medido vs ALVO mais próximo (qualquer alvo, em qualquer ciclo) ───
  //   Atrás dessa unificação está a regra que o Philippe pediu: no modo B, qualquer
  //   pressionamento é VÁLIDO e classificado pela distância em ms ao alvo mais próximo,
  //   em vez de ser ignorado se cair longe.
  let referenceIdx;
  if (t.submode === 'B' && state.targetIndices && state.targetIndices.length > 0) {
    let best = Infinity;
    referenceIdx = state.targetIndices[0];
    for (const idx of state.targetIndices) {
      const d = Math.abs(tNow - refOf(idx)) * 1000;
      if (d < best) { best = d; referenceIdx = idx; }
    }
  } else {
    let best = Infinity;
    referenceIdx = 0;
    for (let i = 0; i < state.schedule.length; i++) {
      const d = Math.abs(tNow - refOf(i)) * 1000;
      if (d < best) { best = d; referenceIdx = i; }
      if (refOf(i) - tNow > 1) break;
    }
  }
  const dms  = (tNow - refOf(referenceIdx)) * 1000;  // + = atrasou, − = adiantou
  const tier = tierOf(dms);
  const beatN = referenceIdx + 1;
  const beatsPerCycle = t.beatsPerCycle || 6;
  const isCycleEnd = (beatN % beatsPerCycle) === 0;
  const isTargetHit = (t.submode === 'B');   // todo tap em modo B é "vs alvo"

  const pts = scoreFor(tier, isCycleEnd || isTargetHit);
  state.score += pts;
  state.history.push({ tier, dms, beatN, atCycle: isCycleEnd, target: isTargetHit });
  // Hunt mode: registra tempo do tap relativo ao início da sessão -- pode servir
  // pra análise pós-hunt (ainda não usado pra auto-calibração, só pra log).
  if (state.huntActive) {
    state.huntHits.push({ t_ms: (tNow - state.startedAt) * 1000, beatN, tier, dms });
  }
  dom.rdScore.textContent     = state.score.toFixed(1);
  dom.rdDelta.textContent     = formatDelta(dms);
  dom.rdTierBadge.textContent = tierLabel(tier);
  dom.rdTierBadge.className   = 'tier-badge tier-' + tier;
  flashTierBadge();
  // Feedback retrospectivo no dot do beat-alvo do tap (outline na cor do tier).
  triggerTapFeedback(referenceIdx, tier);
  updateStreakAndReward(tier);
  // Em modo B com hit/near_hit no alvo, reward visual mais intenso.
  if (isTargetHit && (tier === 'hit' || tier === 'near_hit')) {
    triggerTargetHitBurst(tier);
  }
  renderSessionStats();
}

// ─── Session stats (acumulado durante a sessão atual, ao vivo) ───
// Mostra: N total, mean Δ (sinal = se você é sistematicamente cedo/tardio),
// σ Δ (= consistência: o número-chave de "to me melhorando?"), % good
// (hit + near_hit), e contagem por tier. Aparece logo abaixo do beat-dots
// quando há dados na sessão e o modo ativo é training. Some quando reseta.
// v1.10: stats são renderizadas DENTRO da aba Treino (em #trainingPanelStats),
// não mais flutuando abaixo dos beat-dots. Header compacto no topo da aba mostra
// "Modo X · BPM Y · Duração Z"; este slot mostra os stats vivos.
function renderSessionStats() {
  const slot = document.getElementById('trainingPanelStats');
  if (!slot) return;  // aba Treino ainda não foi montada
  const isTraining = state.activeMode === 'training';
  const arr = state.history;
  const n = arr.length;
  if (!isTraining || n === 0) {
    slot.innerHTML = '<div style="opacity:.55;font-style:italic;text-align:center;padding:14px;font-size:.9em">Stats da sessão aparecem aqui durante o treino (após o 1º tap).</div>';
    return;
  }
  // Stats sobre Δ.
  let sum = 0, sumSq = 0;
  for (const h of arr) { sum += h.dms; sumSq += h.dms * h.dms; }
  const mean = sum / n;
  const variance = (sumSq / n) - (mean * mean);
  const std = Math.sqrt(Math.max(0, variance));
  const counts = { hit: 0, near_hit: 0, miss: 0, bad_miss: 0, ah_vei: 0 };
  for (const h of arr) counts[h.tier] = (counts[h.tier] || 0) + 1;
  const good = counts.hit + counts.near_hit;
  const goodPct = (100 * good) / n;
  const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  const tierColors = { hit: '#2f9e6b', near_hit: '#a4c93b', miss: '#e89623', bad_miss: '#d04a3b', ah_vei: '#7a1f1f' };

  slot.innerHTML = '';

  // Linha 1: headline stats (N, mean, σ, good%, streak se aplicável).
  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;font-size:.95em;padding:6px 0;border-bottom:1px solid rgba(127,127,127,.15)';
  const stat = (label, val, color) => {
    const s = document.createElement('span');
    s.style.cssText = 'display:inline-flex;gap:5px;align-items:baseline' + (color ? ';color:' + color : '');
    s.innerHTML = '<span style="opacity:.6">' + label + ':</span><span class="mono" style="font-weight:600">' + val + '</span>';
    return s;
  };
  row1.appendChild(stat('N',    String(n)));
  row1.appendChild(stat('mean', sgn(mean) + ' ms'));
  row1.appendChild(stat('σ',    std.toFixed(1) + ' ms'));
  row1.appendChild(stat('good', goodPct.toFixed(0) + '%'));
  if (state.streakCount >= 3) row1.appendChild(stat('streak', '🔥 ' + state.streakCount, '#f49a3c'));
  slot.appendChild(row1);

  // Breakdown por tier com barras proporcionais.
  for (const tier of ['hit', 'near_hit', 'miss', 'bad_miss', 'ah_vei']) {
    const c = counts[tier] || 0;
    if (c === 0) continue;
    const pct = (100 * c / n);
    const tierRow = document.createElement('div');
    tierRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px;font-size:.85em';
    const tlabel = document.createElement('span');
    tlabel.style.cssText = 'min-width:72px;color:' + tierColors[tier] + ';font-weight:500';
    tlabel.textContent = tierLabel(tier);
    const bar = document.createElement('div');
    bar.style.cssText = 'flex:1;height:10px;background:rgba(127,127,127,.12);border-radius:2px;overflow:hidden';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;background:' + tierColors[tier] + ';width:' + pct.toFixed(1) + '%';
    bar.appendChild(fill);
    const cval = document.createElement('span');
    cval.className = 'mono';
    cval.style.cssText = 'min-width:62px;text-align:right;opacity:.8';
    cval.textContent = c + ' (' + pct.toFixed(0) + '%)';
    tierRow.appendChild(tlabel);
    tierRow.appendChild(bar);
    tierRow.appendChild(cval);
    slot.appendChild(tierRow);
  }

  // History strip: últimas 16 tentativas como blocos coloridos pequenos.
  const stripWrap = document.createElement('div');
  stripWrap.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;align-items:center;padding-top:8px;border-top:1px solid rgba(127,127,127,.15);margin-top:6px;font-size:.8em';
  const stripLabel = document.createElement('span');
  stripLabel.style.cssText = 'opacity:.55;margin-right:6px';
  stripLabel.textContent = 'Últimos ' + Math.min(16, n) + ':';
  stripWrap.appendChild(stripLabel);
  const last = arr.slice(-16);
  for (const h of last) {
    const b = document.createElement('span');
    b.style.cssText = 'display:inline-block;width:13px;height:13px;border-radius:2px;background:' + tierColors[h.tier];
    b.title = tierLabel(h.tier) + ' · ' + sgn(h.dms) + ' ms';
    stripWrap.appendChild(b);
  }
  slot.appendChild(stripWrap);
}

// ─── Modal de Resultados (mostrado ao fim de cada sessão) ────
// Snapshot serializável de uma sessão pra salvar no localStorage e usar como
// referência de comparação na PRÓXIMA sessão.
function summarizeSessionForStorage() {
  const arr = state.history;
  const n = arr.length;
  if (n === 0) return null;
  let sum = 0, sumSq = 0;
  for (const h of arr) { sum += h.dms; sumSq += h.dms * h.dms; }
  const mean = sum / n;
  const variance = (sumSq / n) - (mean * mean);
  const std = Math.sqrt(Math.max(0, variance));
  const counts = { hit: 0, near_hit: 0, miss: 0, bad_miss: 0, ah_vei: 0 };
  for (const h of arr) counts[h.tier] = (counts[h.tier] || 0) + 1;
  return {
    timestamp:  new Date().toISOString(),
    n, mean, std,
    score:      state.score,
    counts,
    goodPct:    (100 * (counts.hit + counts.near_hit)) / n,
    submode:    state.training.submode,
    bpm:        state.training.bpm,
    maxStreak:  state.maxStreakThisSession || 0,
  };
}

function saveLastSession(snap) {
  try { localStorage.setItem(LAST_SESSION_LS_KEY, JSON.stringify(snap)); }
  catch (e) { console.warn('[results] falha save:', e); }
}
function loadLastSession() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function showSessionResults() {
  const snap = summarizeSessionForStorage();
  if (!snap) return;  // sessão vazia, nada a mostrar
  const prev = loadLastSession();

  // Helper: compara A vs B numericamente, devolve diff + ícone semântico.
  // betterIsLower=true → menor é melhor (ex: σ); false → maior é melhor (ex: goodPct).
  function diff(cur, prev, betterIsLower, unit, decimals = 1) {
    if (prev == null || cur == null || !Number.isFinite(prev) || !Number.isFinite(cur)) {
      return _el('span', { style: 'opacity:.5' }, '— (sem ref. anterior)');
    }
    const d = cur - prev;
    if (Math.abs(d) < (decimals === 0 ? 0.5 : Math.pow(10, -decimals) * 5)) {
      return _el('span', { style: 'opacity:.6' }, '= ' + cur.toFixed(decimals) + unit);
    }
    const improving = betterIsLower ? (d < 0) : (d > 0);
    const arrow = improving ? '▲' : '▼';
    const color = improving ? '#2f9e6b' : '#d04a3b';
    const sign = d >= 0 ? '+' : '';
    return _el('span', { style: 'color:' + color },
      arrow + ' ' + cur.toFixed(decimals) + unit + ' (' + sign + d.toFixed(decimals) + ' vs anterior)'
    );
  }

  const root = _el('div', { class: 'panel-form-group', style: 'gap:8px;display:flex;flex-direction:column' });
  const row = (label, value, hint) => _el('div', {
    style: 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:4px 0;border-bottom:1px solid rgba(127,127,127,.15)'
  },
    _el('span', { class: 'timer-info-label', style: 'min-width:140px' }, label),
    _el('span', { class: 'mono', style: 'text-align:right' }, value),
    hint ? _el('span', { style: 'opacity:.55;font-size:.8em;flex-basis:100%;text-align:right;margin-top:-2px' }, hint) : null
  );

  // Cabeçalho com config da sessão
  root.appendChild(_el('div', { style: 'opacity:.65;font-size:.85em;margin-bottom:4px' },
    'Modo ' + snap.submode + ' · ' + snap.bpm + ' BPM · ' + snap.n + ' taps'));

  // Stats principais (com comparação à sessão anterior se houver)
  const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  root.appendChild(row('Score',     snap.score.toFixed(1),                              prev ? 'anterior: ' + (prev.score?.toFixed(1) ?? '—') : null));
  root.appendChild(row('Mean Δ',    sgn(snap.mean) + ' ms',                              prev ? 'anterior: ' + sgn(prev.mean ?? 0) + ' ms' : null));
  root.appendChild(_el('div', {
    style: 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:4px 0;border-bottom:1px solid rgba(127,127,127,.15)'
  },
    _el('span', { class: 'timer-info-label', style: 'min-width:140px' }, 'σ Δ (consistência)'),
    diff(snap.std, prev?.std, true, ' ms', 1),
  ));
  root.appendChild(_el('div', {
    style: 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:4px 0;border-bottom:1px solid rgba(127,127,127,.15)'
  },
    _el('span', { class: 'timer-info-label', style: 'min-width:140px' }, 'Good % (hit+near)'),
    diff(snap.goodPct, prev?.goodPct, false, '%', 0),
  ));
  if (snap.maxStreak > 0) {
    root.appendChild(row('Maior streak', snap.maxStreak + ' hits', prev ? 'anterior: ' + (prev.maxStreak ?? 0) : null));
  }

  // Breakdown por tier
  root.appendChild(_el('div', { class: 'form-field-label', style: 'font-weight:600;margin-top:8px' }, 'Distribuição por tier'));
  const tierColors = { hit: '#2f9e6b', near_hit: '#a4c93b', miss: '#e89623', bad_miss: '#d04a3b', ah_vei: '#7a1f1f' };
  for (const t of ['hit', 'near_hit', 'miss', 'bad_miss', 'ah_vei']) {
    const c = snap.counts[t] || 0;
    const pct = snap.n > 0 ? (100 * c / snap.n) : 0;
    const bar = _el('div', { style: 'flex:1;height:14px;background:rgba(127,127,127,.12);border-radius:3px;overflow:hidden;margin:0 8px' },
      _el('div', { style: 'height:100%;width:' + pct.toFixed(1) + '%;background:' + tierColors[t] }));
    root.appendChild(_el('div', { style: 'display:flex;align-items:center;gap:6px;padding:2px 0' },
      _el('span', { style: 'min-width:80px;color:' + tierColors[t] + ';font-weight:500;font-size:.9em' }, tierLabel(t)),
      bar,
      _el('span', { class: 'mono', style: 'min-width:60px;text-align:right;font-size:.9em' }, c + ' (' + pct.toFixed(0) + '%)'),
    ));
  }

  // Renderiza
  dom.resultsContent.innerHTML = '';
  dom.resultsContent.appendChild(root);
  dom.resultsOverlay.hidden = false;

  // Persiste pro próximo modal poder comparar.
  saveLastSession(snap);
}

function closeResults() {
  if (dom.resultsOverlay) dom.resultsOverlay.hidden = true;
}

// v1.11.2: exportSessionCsv removido. Stats da sessão vivem só na memória + no
// snapshot last-session do localStorage (pra comparação no modal de resultados).

// ─── Beat dots ──────────────────────────────────────────────
// v1.10: dots PERSISTENTES — criados uma vez (quando o número muda), atualizados
// via classList. Isso preserva animações CSS em curso e elimina jitter de re-render.
function rebuildBeatDots() {
  // v1.12.3: dots visíveis em TODAS as abas (training E hunt). Em hunt mode, eles
  // pulsam com a cadência (se useCadence ON) e os alarms de fim de fase.
  dom.beatDots.hidden = false;
  const t = state.training ?? { beatsPerCycle: 6, submode: 'A' };
  // Modo A e B mostram beatsPerCycle dots como o ciclo visual.
  const n = t.beatsPerCycle || 6;
  // Recria APENAS se a quantidade mudou (= mudou o config). Caso contrário, mantém.
  if (_dotEls.length !== n || !_dotEls.every(d => d && d.isConnected)) {
    dom.beatDots.innerHTML = '';
    _dotEls = [];
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'beat-dot';
      dom.beatDots.appendChild(d);
      _dotEls.push(d);
    }
  }
  // Atualiza --beat-interval-ms na CSS variable do container, pra a animação
  // .next-target sincronizar com o intervalo real entre beats.
  const bpm = Math.max(30, Math.min(300, t.bpm || 120));
  const intervalMs = Math.round(60000 / bpm);
  dom.beatDots.style.setProperty('--beat-interval-ms', intervalMs + 'ms');
  // Aplica estado atual.
  updateBeatDotClasses();
}

// v1.11.1: removido .next-target. Os dots ganham apenas:
//   .active = beat que acabou de tocar (= último incrementado)
//   .next   = beat que vai tocar EM SEGUIDA, com borda fina (sem animação)
//   .target = beat-alvo do ciclo (modo B), cor/borda estática
function updateBeatDotClasses() {
  if (!_dotEls || _dotEls.length === 0) return;
  // Em hunt/simulate-hunt modes, ainda usamos training.beatsPerCycle como referência
  // visual (= quantos dots mostrar). Cadência pulsa esses dots normalmente.
  const t = state.training ?? { beatsPerCycle: 6, submode: 'A' };
  const n = _dotEls.length;
  const beatPos = ((state.beatCount - 1) % n + n) % n;
  const nextPos = (beatPos + 1) % n;
  const targetPosInCycle = n - 1;
  for (let i = 0; i < n; i++) {
    const d = _dotEls[i];
    if (!d) continue;
    d.classList.toggle('active',
      state.beatCount > 0 && i === beatPos);
    d.classList.toggle('next',
      state.running && state.beatCount > 0 && i === nextPos && state.nextBeatIdx < state.schedule.length);
    d.classList.toggle('target', i === targetPosInCycle);
  }
}

// v1.11.1: feedback retrospectivo do TAP do usuário. Pulsa o dot do beat-de-referência
// (= o beat mais próximo que o tap "tentou acertar") com a cor do tier. Curto, NÃO
// induz predição -- só confirma "registrei + foi assim de bom".
function triggerTapFeedback(referenceIdx, tier) {
  if (!_dotEls || _dotEls.length === 0) return;
  const t = state.training;
  const n = t.beatsPerCycle || 6;
  const posInCycle = ((referenceIdx % n) + n) % n;
  const dot = _dotEls[posInCycle];
  if (!dot) return;
  // Remove qualquer tap-feedback anterior, força reflow, adiciona o novo.
  const cls = 'tap-feedback-' + tier;
  for (const c of ['tap-feedback-hit','tap-feedback-near_hit','tap-feedback-miss','tap-feedback-bad_miss','tap-feedback-ah_vei']) {
    dot.classList.remove(c);
  }
  void dot.offsetWidth;
  dot.classList.add(cls);
  setTimeout(() => { if (dot) dot.classList.remove(cls); }, 260);
}

// Compat alias: outros lugares chamam renderBeatDots(). Roteia pra rebuildBeatDots.
function renderBeatDots() { rebuildBeatDots(); }

// ─── Update / Settings ──────────────────────────────────────
// v1.12: o botão Update aplica calibração do hunt-mode ativo (Gen3/4/5/Custom),
// lendo Frame Hit / Delay Hit / Second Hit do form e atualizando state.gen*.calibration.
// Mesma matemática do EonTimer (delegada pros módulos timers/*.calibrate).
function onUpdate() {
  if (state.activeMode === 'training') {
    setStatus('Botão Update só tem efeito nas abas Gen3/4/5/Custom.');
    return;
  }
  const ctx = _huntContext(state.activeMode);
  if (!ctx) { setStatus('Sem hunt mode ativo.'); return; }
  const settings = state.huntSettings || defaultSettings({ console: ctx.consoleSetting });
  try {
    if (state.activeMode === 'gen3') {
      const m = state.gen3;
      if (m.frameHit == null || m.frameHit === '') {
        setStatus('Gen3: preencha "Frame Hit" no form pra atualizar calibração.');
        return;
      }
      const normalized = { ...m, mode: _normalizeMode(m.mode) };
      const delta = gen3.calibrate(settings, normalized, Number(m.frameHit));
      const prev = m.calibration || 0;
      m.calibration = prev + delta;
      setStatus('Gen3 calibration: ' + prev + ' → ' + m.calibration + ' (Δ ' + (delta >= 0 ? '+' : '') + delta.toFixed(0) + ' ms)');
    } else if (state.activeMode === 'gen4') {
      const m = state.gen4;
      if (m.delayHit == null || m.delayHit === '') {
        setStatus('Gen4: preencha "Delay Hit" no form pra atualizar calibração.');
        return;
      }
      const delta = gen4.calibrate(settings, m, Number(m.delayHit));
      const prev = m.calibratedDelay || 0;
      m.calibratedDelay = prev + delta;
      setStatus('Gen4 calibratedDelay: ' + prev + ' → ' + m.calibratedDelay + ' (Δ ' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' delays)');
    } else if (state.activeMode === 'gen5') {
      const m = state.gen5;
      const normalized = { ...m, mode: _normalizeMode(m.mode) };
      const deltas = gen5.calibrate(settings, normalized, {
        secondHit:   (m.secondHit   == null || m.secondHit   === '') ? null : Number(m.secondHit),
        delayHit:    (m.delayHit    == null || m.delayHit    === '') ? null : Number(m.delayHit),
        advancesHit: (m.advancesHit == null || m.advancesHit === '') ? null : Number(m.advancesHit),
      });
      const changes = [];
      if (deltas.calibrationDelta) {
        const prev = m.calibration || 0;
        m.calibration = prev + deltas.calibrationDelta;
        changes.push('calibration: ' + prev + ' → ' + m.calibration);
      }
      if (deltas.entralinkCalibrationDelta) {
        const prev = m.entralinkCalibration || 0;
        m.entralinkCalibration = prev + deltas.entralinkCalibrationDelta;
        changes.push('entralinkCal: ' + prev + ' → ' + m.entralinkCalibration);
      }
      if (deltas.frameCalibrationDelta) {
        const prev = m.frameCalibration || 0;
        m.frameCalibration = prev + deltas.frameCalibrationDelta;
        changes.push('frameCal: ' + prev + ' → ' + m.frameCalibration);
      }
      if (changes.length === 0) {
        setStatus('Gen5: nenhum hit preenchido ou hit == target (sem ajuste).');
      } else {
        setStatus('Gen5 atualizado: ' + changes.join(' · '));
      }
    } else if (state.activeMode === 'custom') {
      const phases = (state.custom && state.custom.phases) || [];
      let updates = 0;
      for (const p of phases) {
        if (p.hit != null && p.hit !== '') {
          const delta = customMod.calibrate(settings, p, Number(p.hit));
          p.calibration = (p.calibration || 0) + delta;
          updates++;
        }
      }
      if (updates === 0) {
        setStatus('Custom: nenhuma fase com "Hit" preenchido.');
      } else {
        setStatus('Custom: ' + updates + ' fase(s) com calibração atualizada.');
      }
    }
    // Re-render aba pra mostrar valores novos.
    if (_modeSwitcher && state.activeMode) _modeSwitcher.activate(state.activeMode);
    // Preview do display reflete nova calibração imediatamente.
    if (!state.running) requestHuntPreview();
  } catch (e) {
    setStatus('Erro calibração: ' + (e && e.message ? e.message : e));
    console.error('[update]', e);
  }
}

// ─── Builders DOM do form de settings (usados no openSettings) ────
// Helpers locais -- inline pra não importar de gen-panels.js (que mantém os seus
// próprios privados). Pequenos suficientes pra não valer um módulo compartilhado.
function _el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  attrs = attrs || {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v === false || v == null) {}
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return e;
}
function _field(label, input, hint) {
  return _el('div', { class: 'form-field' },
    _el('label', { class: 'form-field-label' }, label),
    input,
    hint ? _el('div', { class: 'form-field-label', style: 'opacity:.6;font-size:.85em;margin-top:2px' }, hint) : null
  );
}
function _intInput(value, onInput, attrs) {
  attrs = attrs || {};
  const i = _el('input', { type: 'number', class: 'int-input', step: '1', ...attrs });
  i.value = value ?? '';
  i.addEventListener('input', () => onInput(i.value === '' ? null : parseInt(i.value, 10)));
  return i;
}
function _radioGroup(name, options, currentValue, onChange) {
  const wrap = _el('div', { class: 'panel-form-group', style: 'gap:4px;display:flex;flex-direction:column' });
  for (const opt of options) {
    const id = 'rg_' + name + '_' + opt.value;
    const radio = _el('input', { type: 'radio', name, id, value: opt.value });
    if (opt.value === currentValue) radio.checked = true;
    radio.addEventListener('change', () => { if (radio.checked) onChange(opt.value); });
    const row = _el('label', { for: id, style: 'display:flex;gap:8px;align-items:center;cursor:pointer' }, radio,
      _el('span', null, opt.label),
      opt.extra ?? null
    );
    wrap.appendChild(row);
  }
  return wrap;
}
function _select(opts, value, onChange) {
  const s = _el('select', { class: 'enum-select' });
  for (const o of opts) {
    const opt = _el('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    s.appendChild(opt);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// v1.12.7: dispatcher. Action = training-only (sub-modo, cadência, duração, tiers,
// queue de timers, etc). Timer = global (Console + Som dos beeps).
function buildSettingsForm() {
  const tab = state.activeSettingsTab || 'action';
  return tab === 'timer' ? buildTimerTab() : buildActionTab();
}

function _trainingSettingsAvailable() {
  // Action é "real" só na aba Treino OU em hunt com cadência ON.
  if (state.activeMode === 'training') return true;
  if (state.activeMode === 'gen3'   && state.gen3   && state.gen3.useCadence)   return true;
  if (state.activeMode === 'gen4'   && state.gen4   && state.gen4.useCadence)   return true;
  if (state.activeMode === 'gen5'   && state.gen5   && state.gen5.useCadence)   return true;
  if (state.activeMode === 'custom' && state.custom && state.custom.useCadence) return true;
  return false;
}

function buildTimerTab() {
  const tm = state.timer;
  const root = _el('div', { class: 'panel-form-group', style: 'gap:14px;display:flex;flex-direction:column' });
  const sectionTitle = (txt) => _el('div', { class: 'form-field-label', style: 'font-weight:600;margin-top:8px' }, txt);

  root.appendChild(sectionTitle('Console (= framerate global)'));
  root.appendChild(_field('Console',
    _select([
      { value: 'GBA',           label: 'GBA (59.7275 Hz)' },
      { value: 'NDS - Slot 1',  label: 'NDS Slot 1 / DSi / 3DS (59.8261 Hz)' },
      { value: 'NDS - Slot 2',  label: 'NDS Slot 2 (59.6555 Hz)' },
    ], tm.console, v => {
      tm.console = v;
      saveTimerSettings();
      // Re-renderiza display em hunt (preview do timer pode mudar com framerate).
      if (!state.running) requestHuntPreview();
    }),
    'Determina a conversão de unidades não-ms (Advances / Hex / Seed) pra ms no timer. ' +
    'Aplica a Gen 3/4/5; Custom é fixed em GBA por design.'));

  root.appendChild(sectionTitle('Som dos beeps (cadência e countdown)'));
  root.appendChild(_field('Som',
    _select([
      { value: 'beep', label: 'Beep' },
      { value: 'ding', label: 'Ding' },
      { value: 'pop',  label: 'Pop'  },
      { value: 'tick', label: 'Tick' },
    ], tm.sound, v => { tm.sound = v; saveTimerSettings(); }),
    'Som dos beeps em todos os modos (warm-ups do treino, countdown da hunt, cadência). ' +
    'No modo B do Treino o beat-alvo tem som próprio — Settings → Action.'));

  // v1.12.9: compensação fina de latência do controller (separada do outputLatency
  // do áudio, que é compensado automaticamente em onTap).
  root.appendChild(sectionTitle('Offset do controller (ms)'));
  root.appendChild(_field('Offset',
    _intInput(tm.controllerOffsetMs || 0, v => {
      tm.controllerOffsetMs = v ?? 0;
      saveTimerSettings();
    }, { min: -200, max: 200, step: 1 }),
    'Compensação ADICIONAL pra latência do Pro Controller (USB ou Bluetooth). ' +
    'Positivo = "controller atrasado, adianta o tap N ms" → desloca Δ pra menos. ' +
    'Calibração: rode 20 taps em ritmo perfeito, anote o Δ médio que aparece, soma ao offset. ' +
    'Default 0. Range típico: USB 10–40ms, Bluetooth 20–60ms. ' +
    'Pra diagnóstico fino: F12 + window.gpDebug() liga log per-press com actxRaw + audioLatency.'));

  // v1.13: offset de input pra touch/teclado (análogo ao do controller). Junto com
  // a captura via event.timeStamp, fecha o problema de "delay/oscilação" no tap touch.
  root.appendChild(sectionTitle('Offset de input — touch/teclado (ms)'));
  root.appendChild(_field('Offset',
    _intInput(tm.touchOffsetMs || 0, v => {
      tm.touchOffsetMs = v ?? 0;
      saveTimerSettings();
    }, { min: -200, max: 200, step: 1 }),
    'Compensação fixa pro tap via tela/teclado (separada do offset do controller). ' +
    'Positivo = "input chegou atrasado, adianta N ms" → desloca Δ pra menos. ' +
    'Calibração: rode ~20 taps em ritmo perfeito, anote o Δ médio das stats, soma ao offset. ' +
    'Default 0. No iPhone/iPad o iOS reporta outputLatency=0, então costuma precisar de um valor positivo.'));

  return root;
}

function buildActionTab() {
  const t = state.training;
  const root = _el('div', { class: 'panel-form-group', style: 'gap:14px;display:flex;flex-direction:column' });

  // Banner explicando quando o Action vale.
  if (!_trainingSettingsAvailable()) {
    root.appendChild(_el('div', {
      style: 'padding:8px 10px;background:rgba(255,180,0,.10);border:1px solid rgba(255,180,0,.35);border-radius:4px;font-size:.88em;line-height:1.4',
    },
      _el('strong', null, 'Configurações de Treino indisponíveis para esta aba. '),
      _el('span', null, 'Pra usá-las, ative "Usar cadência do Treino" no painel da aba atual (Gen 3/4/5/Custom), ou troque pra aba Treino.'),
    ));
  }

  const sectionTitle = (txt) => _el('div', { class: 'form-field-label', style: 'font-weight:600;margin-top:8px' }, txt);

  // ─── Sub-modo ─────────────────────────────────
  root.appendChild(sectionTitle('Sub-modo'));
  const submodeIn = _radioGroup('submode', [
    { value: 'A', label: 'Cadência contínua — bate em cada beat (modo A)' },
    { value: 'B', label: 'RNG Hit no último beat do ciclo — warm-ups + alvo (modo B)' },
  ], t.submode, (v) => {
    t.submode = v;
    // Auto-normaliza durationMode pro novo submode (valores válidos diferem):
    //   modo A → 'continuous' | 'time' | 'beats'
    //   modo B → 'cycles' | 'time' | 'continuous'
    if (v === 'A' && t.durationMode === 'cycles') t.durationMode = 'continuous';
    if (v === 'B' && t.durationMode === 'beats')  t.durationMode = 'cycles';
    saveTrainingSettings();
    rerender();
  });
  root.appendChild(submodeIn);

  // ─── Cadência ─────────────────────────────────
  root.appendChild(sectionTitle('Cadência'));
  root.appendChild(_field('BPM (30-300)',
    _intInput(t.bpm, v => { t.bpm = v ?? t.bpm; saveTrainingSettings(); }, { min: 30, max: 300 })));
  root.appendChild(_field('Beats por ciclo',
    _intInput(t.beatsPerCycle, v => {
      // mínimo 2 (= 1 warm-up + 1 alvo); senão o modo B fica degenerado.
      const next = (v == null) ? t.beatsPerCycle : Math.max(2, v);
      t.beatsPerCycle = next;
      saveTrainingSettings();
    }, { min: 2, max: 32 }),
    t.submode === 'B'
      ? 'Modo B: cada ciclo = ' + ((t.beatsPerCycle ?? 6) - 1) + ' warm-ups + 1 alvo no último beat. Mínimo 2.'
      : null));
  // v1.12.7: "Som do beep" (warm-up/cadência) virou GLOBAL — vê Settings → Timer.
  // Aqui no Action só fica o targetSound do modo B (= beat-alvo, treino-only).
  root.appendChild(_el('div', { class: 'form-field-label', style: 'opacity:.65;font-size:.85em;font-style:italic;margin-top:-4px' },
    'Som dos beeps (cadência/warm-up) → Settings → Timer (= global).'));

  if (t.submode === 'B') {
    root.appendChild(_field('Som do beat-alvo (6º beat — diferente dos warm-ups)',
      _select([
        { value: 'beep', label: 'Beep' },
        { value: 'ding', label: 'Ding' },
        { value: 'pop',  label: 'Pop'  },
        { value: 'tick', label: 'Tick' },
      ], t.targetSound, v => { t.targetSound = v; saveTrainingSettings(); }),
      'Default: Ding. Cue auditivo distinto pro alvo ajuda calibragem.'));
  }

  // ─── Duração ──────────────────────────────────
  if (t.submode === 'A') {
    root.appendChild(sectionTitle('Duração da sessão (modo A)'));
    const timeInput  = _intInput(t.durationSec,   v => { t.durationSec   = v ?? t.durationSec;   saveTrainingSettings(); }, { min: 1, max: 3600 });
    const beatsInput = _intInput(t.durationBeats, v => { t.durationBeats = v ?? t.durationBeats; saveTrainingSettings(); }, { min: 1, max: 9999 });
    timeInput.style.width = '80px';
    beatsInput.style.width = '80px';
    // Dropdown pra Simulate Hunt: qual aba é a fonte das fases.
    const huntSrcSel = _select([
      { value: 'gen3',   label: 'Gen 3' },
      { value: 'gen4',   label: 'Gen 4' },
      { value: 'gen5',   label: 'Gen 5' },
      { value: 'custom', label: 'Custom' },
    ], t.simulateHuntFrom || 'custom', v => { t.simulateHuntFrom = v; saveTrainingSettings(); });
    huntSrcSel.style.width = '95px';
    const durIn = _radioGroup('durationMode', [
      { value: 'continuous', label: 'Contínua — só para com Stop' },
      { value: 'time',       label: 'Tempo fixo —', extra: _el('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, timeInput, _el('span', null, 'segundos')) },
      { value: 'beats',      label: 'Nº de beats —', extra: _el('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, beatsInput) },
      { value: 'simulate_hunt', label: 'Simulate Hunt — fases da aba',
        extra: _el('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, huntSrcSel,
          _el('span', { style: 'opacity:.65;font-size:.85em' }, '(usa cadência+feedback do Treino)')) },
    ], t.durationMode, (v) => { t.durationMode = v; saveTrainingSettings(); });
    root.appendChild(durIn);
    root.appendChild(_el('div', { class: 'form-field-label', style: 'opacity:.6;font-size:.85em;margin-top:4px' },
      'Simulate Hunt: roda a sequência de fases da aba escolhida (com a calibração atual) como duração da sessão. Cadência do Treino aplicada por cima; tier feedback no fim de cada fase.'));
  } else {
    // Modo B: duração escolhível entre ciclos / tempo / contínua.
    root.appendChild(sectionTitle('Duração da sessão (modo B)'));
    const cyclesInput = _intInput(t.numCycles, v => { t.numCycles = v ?? t.numCycles; saveTrainingSettings(); }, { min: 1, max: 100 });
    const timeInputB  = _intInput(t.durationSec, v => { t.durationSec = v ?? t.durationSec; saveTrainingSettings(); }, { min: 1, max: 3600 });
    cyclesInput.style.width = '70px';
    timeInputB.style.width = '70px';
    // Normaliza valor inválido pro modo B (modo A pode ter durationMode='beats').
    const curMode = (t.durationMode === 'time' || t.durationMode === 'continuous') ? t.durationMode : 'cycles';
    const cycleLen = (t.beatsPerCycle ?? 6);
    root.appendChild(_radioGroup('durationModeB', [
      { value: 'cycles',     label: 'Por ciclos —',  extra: _el('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, cyclesInput, _el('span', { style: 'opacity:.7' }, 'ciclos (cada um = ' + cycleLen + ' beats)')) },
      { value: 'time',       label: 'Tempo fixo —',  extra: _el('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, timeInputB, _el('span', { style: 'opacity:.7' }, 'segundos')) },
      { value: 'continuous', label: 'Contínua — só para com Stop (estende infinitos ciclos)' },
    ], curMode, (v) => { t.durationMode = v; saveTrainingSettings(); }));
    root.appendChild(_el('div', { class: 'form-field-label', style: 'opacity:.65;font-size:.85em;margin-top:4px' },
      'Qualquer tap durante a sessão é medido vs o ALVO mais próximo (não é ignorado por estar longe).'));
  }

  // ─── Beeps de countdown (Hunt e Simulate Hunt) ─────
  // EonTimer-style: pra cada fase, `count` beeps a cada `interval` ms terminando NO
  // instante exato do fim da fase. Default: 6 beeps × 500ms = "countdown zone" de 2.5s.
  root.appendChild(sectionTitle('Beeps de countdown (modo Hunt e Simulate Hunt)'));
  root.appendChild(_field('Intervalo entre beeps (ms)',
    _intInput(t.actionInterval, v => { t.actionInterval = v ?? t.actionInterval; saveTrainingSettings(); }, { min: 50, max: 5000 }),
    'Default 500 ms. Tempo entre cada beep da countdown.'));
  root.appendChild(_field('Número de beeps',
    _intInput(t.actionCount, v => { t.actionCount = v ?? t.actionCount; saveTrainingSettings(); }, { min: 1, max: 20 }),
    'Default 6. Inclui o beep final (frame-perfect com fim da fase). Total da countdown: (count-1) × interval ms.'));

  // ─── Unidade do Δ ─────────────────────────────
  root.appendChild(sectionTitle('Unidade do Δ no display'));
  root.appendChild(_radioGroup('deltaUnit', [
    { value: 'ms',     label: 'Milissegundos (ex: +17.3 ms)' },
    { value: 'frames', label: 'Frames de GBA (ex: +1.03 fr)' },
    { value: 'both',   label: 'ms + frames juntos (ex: +17.3 ms (+1.03 fr))' },
  ], t.deltaUnit, (v) => { t.deltaUnit = v; saveTrainingSettings(); }));

  // ─── Limiares de tier ─────────────────────────
  // 4 limites em ms (sempre |Δ|): hit ≤ HIT < near_hit ≤ NEAR_HIT < miss ≤ MISS
  // < bad_miss ≤ BAD_MISS < ah_vei. Presets:
  //   - Estrito (6/12/32/48 ms): default histórico, alvo de metrônomo.
  //   - Frame-aligned (8/17/34/51 ms ≈ 0.5/1/2/3 frames de GBA): operacionalmente
  //     relevante pra RNG manip, onde o VBlank do GBA quantiza input em 1 frame.
  root.appendChild(sectionTitle('Limiares dos tiers (|Δ| em ms)'));
  const applyPreset = (name) => {
    const p = TIER_PRESETS[name];
    if (!p) return;
    t.tierPreset  = name;
    t.tierHit     = p.HIT;
    t.tierNearHit = p.NEAR_HIT;
    t.tierMiss    = p.MISS;
    t.tierBadMiss = p.BAD_MISS;
    saveTrainingSettings();
    applyTierThresholds();
    rerender();
  };
  const presetBar = _el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px' },
    _el('button', { class: 'btn' + (t.tierPreset === 'strict' ? ' btn-primary' : ''),
      onclick: () => applyPreset('strict') },
      'Estrito (8/12/32/48)'),
    _el('button', { class: 'btn' + (t.tierPreset === 'frame_aligned' ? ' btn-primary' : ''),
      onclick: () => applyPreset('frame_aligned') },
      'Frame-aligned (8/17/34/51)'),
  );
  root.appendChild(presetBar);
  const onTierEdit = () => {
    t.tierPreset = 'custom';
    saveTrainingSettings();
    applyTierThresholds();
    rerender();
  };
  root.appendChild(_field('hit ≤',
    _intInput(t.tierHit, v => { t.tierHit = v ?? t.tierHit; onTierEdit(); }, { min: 1, max: 1000 })));
  root.appendChild(_field('near_hit ≤',
    _intInput(t.tierNearHit, v => { t.tierNearHit = v ?? t.tierNearHit; onTierEdit(); }, { min: 1, max: 1000 })));
  root.appendChild(_field('miss ≤',
    _intInput(t.tierMiss, v => { t.tierMiss = v ?? t.tierMiss; onTierEdit(); }, { min: 1, max: 1000 })));
  root.appendChild(_field('bad_miss ≤',
    _intInput(t.tierBadMiss, v => { t.tierBadMiss = v ?? t.tierBadMiss; onTierEdit(); }, { min: 1, max: 1000 })));
  if (t.tierPreset === 'custom') {
    root.appendChild(_el('div', { class: 'form-field-label', style: 'opacity:.6;font-size:.85em' },
      '(Valores customizados. Use os botões acima pra voltar a um preset.)'));
  }

  // ─── Comportamento de fechar sessão (Esc / B) ───
  root.appendChild(sectionTitle('Fechar sessão (Esc / B)'));
  const skipCb = _el('input', { type: 'checkbox' });
  skipCb.checked = !!t.skipCloseConfirm;
  skipCb.addEventListener('change', () => {
    t.skipCloseConfirm = skipCb.checked;
    saveTrainingSettings();
  });
  const skipRow = _el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;padding:4px 0' },
    skipCb,
    _el('span', null, 'Pular confirmação ao fechar sessão (fecha direto, descartando dados)'),
  );
  root.appendChild(skipRow);
  root.appendChild(_el('div', { class: 'form-field-label', style: 'opacity:.6;font-size:.85em' },
    'Default: ao apertar Esc/B durante a sessão, ela pausa e abre confirmação. Marcado: pula confirmação e fecha direto.'));

  // ─── Sequência de timers (multi-stage queue) ───
  // Cada stage = snapshot dos campos relevantes (submode, bpm, duração/ciclos).
  // Quando você clica Play, roda o stage atual; ao terminar, dispara automaticamente
  // o próximo da fila, sem precisar tocar em nada.
  root.appendChild(sectionTitle('Sequência de timers (rodam em ordem após o atual)'));
  root.appendChild(_el('div', { class: 'form-field-label', style: 'opacity:.7;font-size:.85em;margin-bottom:6px' },
    'O timer ATUAL acima é o stage 1. Adicione abaixo pra encadear stages 2, 3, …'));

  const queue = Array.isArray(t.queue) ? t.queue : (t.queue = []);
  const queueList = _el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:8px' });

  const stageLabel = (s) => {
    const sm = s.submode || t.submode;
    const bpm = s.bpm || t.bpm;
    let dur;
    if (sm === 'B') {
      const cyc = s.numCycles ?? t.numCycles ?? 1;
      const wb  = s.warmupBeats ?? t.warmupBeats ?? 5;
      dur = cyc + ' ciclo' + (cyc > 1 ? 's' : '') + ' × ' + (wb + 1) + ' beats';
    } else {
      const dm = s.durationMode || t.durationMode || 'continuous';
      if (dm === 'time')   dur = (s.durationSec   ?? t.durationSec   ?? 60) + 's';
      else if (dm === 'beats') dur = (s.durationBeats ?? t.durationBeats ?? 64) + ' beats';
      else dur = 'contínua';
    }
    return 'Modo ' + sm + ' · ' + bpm + ' BPM · ' + dur;
  };

  if (queue.length === 0) {
    queueList.appendChild(_el('div', { style: 'opacity:.55;font-size:.85em;font-style:italic' },
      '(Nenhum stage seguinte — sessão para no fim do timer atual.)'));
  } else {
    queue.forEach((s, idx) => {
      const removeBtn = _el('button', {
        class: 'btn btn-icon',
        style: 'background:rgba(208,74,59,.18);color:#d04a3b;border:1px solid rgba(208,74,59,.4)',
        title: 'Remover este stage',
        onclick: () => { queue.splice(idx, 1); saveTrainingSettings(); rerender(); },
      }, '×');
      const row = _el('div', {
        style: 'display:flex;gap:8px;align-items:center;padding:6px 8px;background:rgba(127,127,127,.08);border-radius:4px'
      },
        _el('span', { style: 'min-width:24px;font-weight:600;opacity:.7' }, String(idx + 2) + '.'),
        _el('span', { style: 'flex:1;font-size:.92em' }, stageLabel(s)),
        removeBtn,
      );
      queueList.appendChild(row);
    });
  }
  root.appendChild(queueList);

  // Botão pra adicionar o stage ATUAL como próximo na fila.
  // (Snapshot apenas dos campos relevantes — não copia a queue inteira pra evitar recursão.)
  const addBtn = _el('button', {
    class: 'btn btn-primary',
    onclick: () => {
      const snap = {
        submode:       t.submode,
        bpm:           t.bpm,
        beatsPerCycle: t.beatsPerCycle,
        warmupBeats:   t.warmupBeats,
        numCycles:     t.numCycles,
        sound:         t.sound,
        targetSound:   t.targetSound,
        durationMode:  t.durationMode,
        durationSec:   t.durationSec,
        durationBeats: t.durationBeats,
      };
      queue.push(snap);
      saveTrainingSettings();
      rerender();
    },
  }, '+ Adicionar config atual como próximo timer');
  root.appendChild(addBtn);

  if (queue.length > 0) {
    const clearBtn = _el('button', {
      class: 'btn',
      style: 'margin-top:4px;background:rgba(208,74,59,.12);color:#d04a3b',
      onclick: () => {
        if (confirm('Limpar toda a fila de ' + queue.length + ' stage' + (queue.length > 1 ? 's' : '') + '?')) {
          t.queue = [];
          saveTrainingSettings();
          rerender();
        }
      },
    }, 'Limpar fila inteira');
    root.appendChild(clearBtn);
  }

  return root;
}

// Re-render do form (chamado quando uma radio muda que afeta o layout, ex: submode A vs B).
function rerender() {
  if (dom.overlay && !dom.overlay.hidden) {
    dom.settingsContent.innerHTML = '';
    dom.settingsContent.appendChild(buildSettingsForm());
  }
  // O training panel principal também depende do submode -- re-rendera.
  if (state.activeMode === 'training' && dom.panels) {
    // O mode-switcher controla os panels. Não temos uma re-render API exposta;
    // a próxima troca de aba ou abertura do settings rebuilda. Skip por ora.
  }
}

function openSettings() {
  // v1.12.7: sub-tabs Action/Timer agora são ATIVAS. Action é gateado: só clicável
  // se aba ativa for Treino OU se hunt tem useCadence ON. Timer é sempre clicável.
  const stabs = document.getElementById('settingsTabs');
  if (stabs) {
    stabs.style.display = '';
    const buttons = Array.from(stabs.querySelectorAll('.dialog-tab'));
    const actionAvail = _trainingSettingsAvailable();
    // Se Action não tá disponível e tab atual é action → força pra timer.
    if (!actionAvail && state.activeSettingsTab === 'action') state.activeSettingsTab = 'timer';
    // Default em hunt = timer (config global é o que faz sentido).
    if (state.activeMode !== 'training' && !actionAvail) state.activeSettingsTab = 'timer';
    buttons.forEach((b) => {
      const target = b.dataset.stab;
      const isActive = (target === state.activeSettingsTab);
      b.classList.toggle('active', isActive);
      // Gate visual: Action fica desabilitada se não disponível.
      if (target === 'action' && !actionAvail) {
        b.classList.add('disabled');
        b.style.opacity = '0.45';
        b.style.cursor = 'not-allowed';
        b.title = 'Disponível apenas em Treino ou Hunt c/ "Usar cadência do Treino"';
      } else {
        b.classList.remove('disabled');
        b.style.opacity = '';
        b.style.cursor = '';
        b.title = '';
      }
      // Re-wires (idempotente, sem dupes — recria o handler).
      b.onclick = () => {
        if (target === 'action' && !_trainingSettingsAvailable()) return;
        state.activeSettingsTab = target;
        // Re-render visual das tabs + conteúdo.
        buttons.forEach((bb) => bb.classList.toggle('active', bb.dataset.stab === target));
        dom.settingsContent.innerHTML = '';
        dom.settingsContent.appendChild(buildSettingsForm());
      };
    });
  }
  dom.settingsContent.innerHTML = '';
  dom.settingsContent.appendChild(buildSettingsForm());
  dom.overlay.hidden = false;
}
function closeSettings() {
  dom.overlay.hidden = true;
  // Atualiza o resumo da aba Treino com os settings novos (re-ativa a aba ativa).
  if (_modeSwitcher && state.activeMode) {
    _modeSwitcher.activate(state.activeMode);
  }
  // v1.12.7: trocar Console global no Timer tab muda os valores em ms dos hunt
  // modes — atualiza o preview do display pra refletir.
  if (!state.running) requestHuntPreview();
}

function setStatus(msg) { dom.status.textContent = msg; }

// ─── go ─────────────────────────────────────────────────────
init().catch(err => {
  console.error(err);
  setStatus('Erro init: ' + err.message);
});
