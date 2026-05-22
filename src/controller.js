// controller.js — entrada por gamepad (Switch Pro Controller via USB).
//
// Usa a Web Gamepad API (padrão do navegador, zero dependência extra). Faz polling
// via `setTimeout(tick, 4)` -- ~4 ms de cadência (vs ~16 ms se fôssemos por rAF).
// Detecta rising-edge de QUALQUER botão -- cada press dispara `onTap(actxSec, btnIdx)`.
//
// Tempo do press:
//   Sampleamos `performance.now()` e `audio.getCtx().currentTime` JUNTOS na mesma
//   poll-tick. Calculamos `age = perfNow - gp.timestamp` (= quanto tempo atrás o
//   navegador recebeu o último update do gamepad, em ms; mesma escala/clock de
//   performance.now). Subtraímos `age/1000` do actxNow → `actxSec_at_press`. Como os
//   dois anchors são amostrados no MESMO instante físico, não há alinhamento de
//   clocks: subtraímos um delta de perf time de um valor de actx time. Reduz o jitter
//   de polling de ~p95=27ms (rAF, medido) pra dentro do intervalo do setTimeout.
//
// Histórico (porque o código parece "simples demais"):
//  v1 (rAF + getOutputTimestamp): tentou alinhar perf clock com actx via offset
//      calculado no boot. Bug: offset zerado quando audio context ainda suspended
//      pela política de autoplay → press saía como segundos desde page load (+25 s,
//      +30 s) em vez de tempo de actx. Removido.
//  v2 (rAF + getCtx().currentTime direto): correto, mas com Latency Meter mediu
//      mediana 12 ms / p95 26.6 ms / 23.7% das amostras > 17 ms (frames perdidos do
//      rAF). Cauda problemática.
//  v3 (este): setTimeout(tick, 4) corta a cadência de ~16 ms pra ~4 ms (limite mínimo
//      do setTimeout no Chrome). Back-date via gp.timestamp aplica a correção residual.
//      Custo: ~4 polls/frame = ~250 Hz de CPU em loop trivial (sub-µs por tick) →
//      desprezível. Trade-off: setTimeout é throttled a 1 s em tab background — pra
//      este app (foreground enquanto treinar) é não-issue.
//
// Eventos:
//   onConnect(idString)    -- chamado na 1ª deteção do controle
//   onDisconnect()         -- chamado quando o gamepadconnected fica indisponível
//   onTap(actxSec, btnIdx) -- press detectado
//
// Quirk do Chrome: o evento 'gamepadconnected' pode ficar silenciado até o 1º input
// (privacy gate). Por isso o loop começa imediatamente e também enumera via
// navigator.getGamepads() todo tick -- se um controle aparecer só pelo polling,
// onConnect é chamado também por lá.

import { getCtx } from './audio.js?v=20260515c';

let _s = null;

// Intervalo do setTimeout em ms. Chrome clampa abaixo de 4 ms (também é o mínimo HTML5
// padrão); usar 4 é honesto sobre o que o navegador realmente entrega. Valores menores
// não dão polling mais rápido, só consomem CPU à toa.
const POLL_INTERVAL_MS = 4;
// Sanity bound pra age via gp.timestamp: se vier > 100 ms, é provavelmente o navegador
// reportando algum valor degenerado (zero, epoch errado) -- caímos no fallback.
const MAX_PLAUSIBLE_AGE_MS = 100;

function defaults(onTap, onConnect, onDisconnect) {
  return {
    onTap:          onTap          || (() => {}),
    onConnect:      onConnect      || (() => {}),
    onDisconnect:   onDisconnect   || (() => {}),
    gpIndex:        -1,
    gpId:           '',
    prevButtons:    [],
    timeoutId:      0,
  };
}

export function initController({ onTap, onConnect, onDisconnect } = {}) {
  _s = defaults(onTap, onConnect, onDisconnect);

  // Eventos padrão (quando o navegador entrega):
  window.addEventListener('gamepadconnected', (e) => {
    if (_s.gpIndex >= 0) return;
    _adoptGamepad(e.gamepad);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index !== _s.gpIndex) return;
    _s.gpIndex = -1;
    _s.gpId = '';
    _s.prevButtons = [];
    _s.onDisconnect();
  });

  // Polling sempre rodando -- custo desprezível, e cobre o caso do gamepadconnected
  // não disparar até o 1º input.
  _startLoop();
}

function _adoptGamepad(gp) {
  _s.gpIndex = gp.index;
  _s.gpId = gp.id || ('gamepad ' + gp.index);
  _s.prevButtons = (gp.buttons || []).map((b) => !!b.pressed);
  // v1.12.8: passa o mapping pra detectar non-standard (Pro Controller via BT no
  // Chrome às vezes vem com mapping="" → índices arbitrários por driver). O app
  // usa isso pra logar aviso e o user saber se precisa de override manual.
  _s.onConnect(_s.gpId, gp.mapping || '');
}

function _pollOnce() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  if (_s.gpIndex >= 0) gp = pads[_s.gpIndex];

  // Sem gamepad ainda? Procura o 1º conectado.
  if (!gp) {
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) {
        _adoptGamepad(pads[i]);
        gp = pads[i];
        break;
      }
    }
  }
  if (!gp) return;

  const btns = gp.buttons || [];
  // Garante prevButtons no mesmo tamanho (controle pode reportar nº variável no boot).
  if (_s.prevButtons.length !== btns.length) {
    _s.prevButtons = btns.map((b) => !!b.pressed);
    return;  // ignora este frame; rising-edge a partir do próximo
  }

  // Amostra OS DOIS clocks juntos, no mesmo instante físico, compartilhados entre
  // todos os botões desta tick. Custo total: ~sub-µs. Se actx ainda não existe (não
  // devia, init() já chamou ensureAudio), cai pra 0 -- o press registra mas fica fora
  // de sync com o schedule.
  let anchorsThisTick = null;
  const _grabActxSecForPress = (gpTs) => {
    if (anchorsThisTick == null) {
      const actx = getCtx();
      anchorsThisTick = {
        perfNow:    performance.now(),
        actxNow:    actx ? actx.currentTime : 0,
      };
    }
    // Back-date: se gp.timestamp parecer plausível (não-zero, idade < 100 ms,
    // não-negativa), corrige actxSec pra o instante em que o navegador realmente
    // recebeu o press. Senão, retorna o actxNow direto.
    const age = (typeof gpTs === 'number' && gpTs > 0)
      ? anchorsThisTick.perfNow - gpTs
      : NaN;
    const usable = Number.isFinite(age) && age >= 0 && age < MAX_PLAUSIBLE_AGE_MS;
    return usable ? (anchorsThisTick.actxNow - age / 1000) : anchorsThisTick.actxNow;
  };

  const gpTs = gp.timestamp;
  for (let i = 0; i < btns.length; i++) {
    const now = !!btns[i].pressed;
    const prev = _s.prevButtons[i];
    if (now && !prev) {
      const actxSec = _grabActxSecForPress(gpTs);
      try { _s.onTap(actxSec, i); } catch (err) { console.warn('[controller] onTap threw:', err); }
    }
    _s.prevButtons[i] = now;
  }
}

function _startLoop() {
  if (_s.timeoutId) return;
  const tick = () => {
    _pollOnce();
    _s.timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
  };
  _s.timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopController() {
  if (_s && _s.timeoutId) clearTimeout(_s.timeoutId);
  if (_s) _s.timeoutId = 0;
}

// Diagnóstico: nome do gamepad ativo, ou null.
export function activeGamepadId() {
  return _s && _s.gpIndex >= 0 ? _s.gpId : null;
}
