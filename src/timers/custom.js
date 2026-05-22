// custom.js — Modo Custom (multi-fase, unidades configuráveis).
// Porta fiel de DasAmpharos/EonTimer (src/timers/customTimer.ts).
//
// CustomPhase: { unit: CustomUnit.*, target: number, calibration: number }
//
// Conversões para ms:
//   MILLISECONDS : value = target               + calibration
//   ADVANCES     : value = toMs(target)         + calibration
//   HEX (seeds)  : value = toMs(target)         + calibration   (mesma regra de advances)
//
// Calibração por fase: dado o hit informado pelo usuário,
//   MILLISECONDS : delta = target - hit
//   ADVANCES/HEX : delta = toMs(target - hit)

import { toMilliseconds } from '../calibrator.js';

export const CustomUnit = Object.freeze({
  MILLISECONDS: 'ms',
  ADVANCES:     'Advances',
  HEX:          'Seed (Hex)',
});

// v1.12.6: normaliza unit case-insensitive. gen-panels.js usa 'ms'/'advances'
// (lowercase), enquanto CustomUnit constantes são 'ms'/'Advances'/'Seed (Hex)'.
// Sem isso, 'advances' não casava nada e caía no fallback de ms (= número era
// interpretado como ms cru sem conversão por frame).
function _isNonMsUnit(unit) {
  const u = String(unit || '').toLowerCase();
  return u === 'advances' || u === 'hex' || u === 'seed (hex)';
}

function phaseToMs(settings, phase) {
  let value = Number(phase.target) || 0;
  if (_isNonMsUnit(phase.unit)) {
    value = toMilliseconds(settings, value);
  }
  return value + (Number(phase.calibration) || 0);
}

// createPhases recebe um array de CustomPhase (não um "model" como os outros).
export function createPhases(settings, phases) {
  return phases.map((p) => phaseToMs(settings, p));
}

export function calibrate(settings, phase, hit) {
  // Mesma normalização case-insensitive aqui: se unit não for ms (qualquer outra),
  // converte o delta por frame.
  if (_isNonMsUnit(phase.unit)) {
    return toMilliseconds(settings, Number(phase.target) - Number(hit));
  }
  return Number(phase.target) - Number(hit);
}

export function describePhases(settings, phases) {
  return phases.map((p, i) => ({
    label: 'Fase ' + (i + 1) + ' (' + p.unit + ')',
    ms:    phaseToMs(settings, p),
  }));
}
