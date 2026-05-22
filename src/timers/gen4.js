// gen4.js — Modo Gen 4 (NDS, delay-based: dois timers concatenados).
// Porta fiel de DasAmpharos/EonTimer (src/timers/gen4Timer.ts + delayTimer.ts + secondTimer.ts).
//
// Modelo:
//   { targetDelay, targetSecond, calibratedDelay, calibratedSecond }
//
// Fases:
//   1) Phase1 = toMinimumLength(secondPhase[0] - toMs(targetDelay), minLen)
//      onde secondPhase[0] = toMinimumLength(targetSecond*1000 + calibration + 200, minLen)
//      e calibration = createCalibration(calibratedDelay, calibratedSecond)
//   2) Phase2 = toMs(targetDelay) - calibration
//
// Calibração (delayHit informado pelo usuário):
//   delta = toMs(delayHit) - toMs(targetDelay)
//   se |delta| <= 167  → 0.75 * delta   (CLOSE_UPDATE_FACTOR)
//   senão              → 1.00 * delta   (UPDATE_FACTOR)
//   retorna toDelays(delta) — só aplica se delayHit > 0 (senão 0, falha de leitura).

import {
  toMilliseconds, toDelays, createCalibration,
} from '../calibrator.js';

const CLOSE_THRESHOLD       = 167;
const UPDATE_FACTOR         = 1.0;
const CLOSE_UPDATE_FACTOR   = 0.75;

export function createSecondPhases(targetSecond, calibration, minimumLength) {
  // Importado embutido pra evitar dependência circular leve.
  // toMinimumLength: enquanto value < minLen, soma 60000.
  let value = targetSecond * 1000 + calibration + 200;
  while (value < minimumLength) value += 60000;
  return [value];
}

export function calibrateSecond(targetSecond, secondHit) {
  if (secondHit < targetSecond) return (targetSecond - secondHit) * 1000 - 500;
  if (secondHit > targetSecond) return (targetSecond - secondHit) * 1000 + 500;
  return 0;
}

export function createDelayPhases(settings, targetDelay, targetSecond, calibration) {
  const minLen = settings.minimumLength ?? 14000;
  let phase1 = createSecondPhases(targetSecond, calibration, minLen)[0]
             - toMilliseconds(settings, targetDelay);
  while (phase1 < minLen) phase1 += 60000;
  const phase2 = toMilliseconds(settings, targetDelay) - calibration;
  return [phase1, phase2];
}

export function calibrateDelay(settings, targetDelay, delayHit) {
  const delta = toMilliseconds(settings, delayHit) - toMilliseconds(settings, targetDelay);
  if (Math.abs(delta) <= CLOSE_THRESHOLD) return CLOSE_UPDATE_FACTOR * delta;
  return UPDATE_FACTOR * delta;
}

function getCalibration(settings, model) {
  return createCalibration(settings, model.calibratedDelay, model.calibratedSecond);
}

export function createPhases(settings, model) {
  return createDelayPhases(
    settings,
    model.targetDelay,
    model.targetSecond,
    getCalibration(settings, model),
  );
}

export function calibrate(settings, model, delayHit) {
  if (delayHit > 0) {
    return toDelays(settings, calibrateDelay(settings, model.targetDelay, delayHit));
  }
  return 0;
}

export function describePhases(settings, model) {
  const [p1, p2] = createPhases(settings, model);
  return [
    { label: 'Second + offset', ms: p1 },
    { label: 'Delay',           ms: p2 },
  ];
}
