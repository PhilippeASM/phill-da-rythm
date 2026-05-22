// gen3.js — Modo Gen 3 (GBA, frame-based).
// Porta fiel de DasAmpharos/EonTimer (src/timers/gen3Timer.ts + frameTimer.ts).
//
// Modelos:
//   Gen3Mode.STANDARD         → preTimer + targetFrame*msPerFrame + calibration
//   Gen3Mode.VARIABLE_TARGET  → preTimer + Infinity (tap pra parar)
//
// model: { mode, preTimer, targetFrame, calibration }
// settings: CalibratorSettings (de calibrator.js)
//
// Calibração: calibrateGen3(model, frameHit) = toMs(targetFrame - frameHit).
// Esse delta em ms vai somar ao calibration atual para a próxima tentativa.

import { toMilliseconds, INFINITY } from '../calibrator.js';

export const Gen3Mode = Object.freeze({
  STANDARD:        'Standard',
  VARIABLE_TARGET: 'Variable Target',
});

export function createFramePhase(settings, targetFrame, calibration) {
  return toMilliseconds(settings, targetFrame) + calibration;
}

export function createFramePhases(settings, preTimer, targetFrame, calibration) {
  return [preTimer, createFramePhase(settings, targetFrame, calibration)];
}

export function createVariableFramePhases(preTimer) {
  return [preTimer, INFINITY];
}

export function createPhases(settings, model) {
  switch (model.mode) {
    case Gen3Mode.STANDARD:
      return createFramePhases(settings, model.preTimer, model.targetFrame, model.calibration);
    case Gen3Mode.VARIABLE_TARGET:
      return createVariableFramePhases(model.preTimer);
    default:
      throw new Error('Gen3: modo desconhecido: ' + model.mode);
  }
}

export function calibrateFrame(settings, targetFrame, frameHit) {
  return toMilliseconds(settings, targetFrame - frameHit);
}

export function calibrate(settings, model, frameHit) {
  return calibrateFrame(settings, model.targetFrame, frameHit);
}

// Labels para UI (a Task 5/UI usa).
export function describePhases(settings, model) {
  switch (model.mode) {
    case Gen3Mode.STANDARD:
      return [
        { label: 'Pre-Timer',    ms: model.preTimer },
        { label: 'Target Frame', ms: createFramePhase(settings, model.targetFrame, model.calibration) },
      ];
    case Gen3Mode.VARIABLE_TARGET:
      return [
        { label: 'Pre-Timer', ms: model.preTimer },
        { label: 'Variable', ms: INFINITY },
      ];
  }
}
