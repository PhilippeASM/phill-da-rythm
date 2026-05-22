// gen5.js — Modo Gen 5 (NDS, second-based).
// Porta fiel de DasAmpharos/EonTimer (src/timers/gen5Timer.ts + secondTimer.ts +
// delayTimer.ts + entralinkTimer.ts).
//
// Modos suportados (Gen5Mode):
//   STANDARD        → secondPhases (1 fase, mínima 14s)
//   C_GEAR          → delayPhases  (2 fases, igual Gen4)
//   ENTRALINK       → entralinkPhases (delay phases + correções)
//   ENTRALINK_PLUS  → entralink + targetAdvances*1000/ENTRALINK_FRAME_RATE + frameCal
//
// Modelo Gen5:
//   { mode, calibration, frameCalibration, entralinkCalibration,
//     targetDelay, targetSecond, targetAdvances }
//
// Calibração:
//   STANDARD       : calibrateSecond(target, secondHit)               → ms (depois → delays)
//   C_GEAR         : calibrateDelay(target, delayHit)                 → ms (depois → delays)
//   ENTRALINK(+)   : ambos: calibrationDelta (second) + entralinkDelta (delay)
//   ENTRALINK_PLUS : adicional frameCalibrationDelta (advances)
//
// Retorno de calibrate(): objeto { calibrationDelta, entralinkCalibrationDelta, frameCalibrationDelta }.

import {
  toMilliseconds,
  calibrateToMilliseconds,
  calibrateToDelays,
} from '../calibrator.js';
import {
  createDelayPhases,
  calibrateDelay,
  createSecondPhases,
  calibrateSecond,
} from './gen4.js';

export const Gen5Mode = Object.freeze({
  STANDARD:       'Standard',
  C_GEAR:         'C-Gear',
  ENTRALINK:      'Entralink',
  ENTRALINK_PLUS: 'Entralink+',
});

const ENTRALINK_FRAME_RATE = 0.837148929;

// ─── Entralink ───

export function createEntralinkPhases(settings, targetDelay, targetSecond, calibration, entralinkCalibration) {
  const durations = createDelayPhases(settings, targetDelay, targetSecond, calibration);
  durations[0] += 250;
  durations[1] -= entralinkCalibration;
  return durations;
}

export function createEnhancedEntralinkPhases(settings, targetDelay, targetSecond, targetAdvances, calibration, entralinkCalibration, frameCalibration) {
  const phases = createEntralinkPhases(settings, targetDelay, targetSecond, calibration, entralinkCalibration);
  phases.push((targetAdvances / ENTRALINK_FRAME_RATE) * 1000 + frameCalibration);
  return phases;
}

export function calibrateEntralinkAdvances(targetAdvances, advancesHit) {
  return ((targetAdvances - advancesHit) / ENTRALINK_FRAME_RATE) * 1000;
}

// ─── createPhases (top-level Gen5) ───

export function createPhases(settings, model) {
  const calibration = calibrateToMilliseconds(settings, model.calibration);
  const entralinkCalibration = calibrateToMilliseconds(settings, model.entralinkCalibration);
  const minLen = settings.minimumLength ?? 14000;

  switch (model.mode) {
    case Gen5Mode.STANDARD:
      return createSecondPhases(model.targetSecond, calibration, minLen);
    case Gen5Mode.C_GEAR:
      return createDelayPhases(settings, model.targetDelay, model.targetSecond, calibration);
    case Gen5Mode.ENTRALINK:
      return createEntralinkPhases(settings, model.targetDelay, model.targetSecond, calibration, entralinkCalibration);
    case Gen5Mode.ENTRALINK_PLUS:
      return createEnhancedEntralinkPhases(
        settings,
        model.targetDelay,
        model.targetSecond,
        model.targetAdvances,
        calibration,
        entralinkCalibration,
        model.frameCalibration,
      );
    default:
      throw new Error('Gen5: modo desconhecido: ' + model.mode);
  }
}

// ─── calibrate ───

export function calibrate(settings, model, input) {
  // input: { delayHit, secondHit, advancesHit } (null se não informado)
  let calibrationDelta = 0;
  let entralinkCalibrationDelta = 0;
  let frameCalibrationDelta = 0;

  switch (model.mode) {
    case Gen5Mode.STANDARD:
      if (input.secondHit != null) {
        calibrationDelta = calibrateToDelays(settings, calibrateSecond(model.targetSecond, input.secondHit));
      }
      break;
    case Gen5Mode.C_GEAR:
      if (input.delayHit != null) {
        calibrationDelta = calibrateToDelays(settings, calibrateDelay(settings, model.targetDelay, input.delayHit));
      }
      break;
    case Gen5Mode.ENTRALINK:
    case Gen5Mode.ENTRALINK_PLUS:
      if (input.secondHit != null && input.secondHit !== model.targetSecond) {
        calibrationDelta = calibrateToDelays(settings, calibrateSecond(model.targetSecond, input.secondHit));
      }
      if (input.delayHit != null && input.delayHit !== model.targetDelay) {
        entralinkCalibrationDelta = calibrateToDelays(
          settings,
          calibrateDelay(settings, model.targetDelay, input.delayHit),
        );
      }
      if (model.mode === Gen5Mode.ENTRALINK_PLUS) {
        if (input.advancesHit != null && input.advancesHit !== model.targetAdvances) {
          frameCalibrationDelta = calibrateEntralinkAdvances(model.targetAdvances, input.advancesHit);
        }
      }
      break;
  }

  return { calibrationDelta, entralinkCalibrationDelta, frameCalibrationDelta };
}

export function describePhases(settings, model) {
  const ph = createPhases(settings, model);
  switch (model.mode) {
    case Gen5Mode.STANDARD:
      return [{ label: 'Target second', ms: ph[0] }];
    case Gen5Mode.C_GEAR:
      return [
        { label: 'Second + offset', ms: ph[0] },
        { label: 'Delay',           ms: ph[1] },
      ];
    case Gen5Mode.ENTRALINK:
      return [
        { label: 'Second + offset',  ms: ph[0] },
        { label: 'Entralink delay',  ms: ph[1] },
      ];
    case Gen5Mode.ENTRALINK_PLUS:
      return [
        { label: 'Second + offset',  ms: ph[0] },
        { label: 'Entralink delay',  ms: ph[1] },
        { label: 'Advances',         ms: ph[2] },
      ];
  }
}
