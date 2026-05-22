// calibrator.js — framerates e conversão frame↔ms (EonTimer-style).
// Porta fiel de DasAmpharos/EonTimer (src/timers/calibrator.ts +
// src/utils/constants.ts + src/utils/types.ts) para JS modular.
//
// Diferença da v1 deste módulo: agora as APIs recebem um `settings` object
// com { console, customFramerate, precisionCalibration, minimumLength },
// igual ao EonTimer. Isso permite que os timers (gen3/4/5/custom) usem a
// mesma assinatura sem propagar parâmetros.

// ─── Console ───
export const Console = Object.freeze({
  GBA:       'GBA',
  NDS_SLOT1: 'NDS - Slot 1',
  NDS_SLOT2: 'NDS - Slot 2',
  DSI:       'DSI',
  THREE_DS:  '3DS',
  CUSTOM:    'Custom',
});

// ─── Framerates oficiais (constants.ts) ───
export const GBA_FRAMERATE       = 16777216 / 280896;  // ≈ 59.7275
export const NDS_SLOT1_FRAMERATE = 59.8261;
export const NDS_SLOT2_FRAMERATE = 59.6555;

export const GBA_MS_PER_FRAME       = 1000 / GBA_FRAMERATE;
export const NDS_SLOT1_MS_PER_FRAME = 1000 / NDS_SLOT1_FRAMERATE;
export const NDS_SLOT2_MS_PER_FRAME = 1000 / NDS_SLOT2_FRAMERATE;

export const INFINITY = Infinity;
export const MINIMUM_LENGTH = 14000;

// ─── Helpers gerais ───

export function toMinimumLength(value, minimumLength = MINIMUM_LENGTH) {
  while (value < minimumLength) value += 60000;
  return value;
}

export function getMinutesBeforeTarget(phases) {
  let total = 0;
  for (const phase of phases) {
    if (phase === INFINITY) continue;
    total += phase;
  }
  return Math.floor(total / 60000);
}

// Banker's rounding (midpoint-to-even). Espelha Math.Round(decimal) do C#
// e o roundHalfToEven do EonTimer.
export function roundHalfToEven(value) {
  if (!Number.isFinite(value)) return Math.round(value);
  const lower = Math.floor(value);
  const upper = Math.ceil(value);
  if (lower === upper) return lower;
  const lowerDistance = value - lower;
  const upperDistance = upper - value;
  const eps = Number.EPSILON * Math.max(1, Math.abs(value));
  if (Math.abs(lowerDistance - upperDistance) <= eps) {
    return Math.abs(lower) % 2 === 0 ? lower : upper;
  }
  return lowerDistance < upperDistance ? lower : upper;
}

// ─── CalibratorSettings ───
//
// settings: {
//   console:             Console.*           // qual aparelho
//   customFramerate:     number              // só usado se console === CUSTOM
//   precisionCalibration boolean             // se true, calibration é em ms direto, sem converter por frame
//   minimumLength:       number              // mínimo de fase 1 do secondTimer (default 14000)
// }
export function defaultSettings(overrides = {}) {
  return {
    console:              Console.NDS_SLOT1,
    customFramerate:      59.8261,
    precisionCalibration: false,
    minimumLength:        MINIMUM_LENGTH,
    ...overrides,
  };
}

export function getMsPerFrame(settings) {
  switch (settings.console) {
    case Console.GBA:       return GBA_MS_PER_FRAME;
    case Console.NDS_SLOT2: return NDS_SLOT2_MS_PER_FRAME;
    case Console.NDS_SLOT1:
    case Console.DSI:
    case Console.THREE_DS:  return NDS_SLOT1_MS_PER_FRAME;
    case Console.CUSTOM: {
      if (!settings.customFramerate || settings.customFramerate <= 0) {
        throw new Error('customFramerate deve ser > 0 para Console.CUSTOM');
      }
      return 1000 / settings.customFramerate;
    }
    default:
      return NDS_SLOT1_MS_PER_FRAME;
  }
}

export function getFps(settings) {
  return 1000 / getMsPerFrame(settings);
}

// frames ↔ ms (com banker's rounding)
export function toDelays(settings, milliseconds) {
  return roundHalfToEven(milliseconds / getMsPerFrame(settings));
}

export function toMilliseconds(settings, delays) {
  return roundHalfToEven(getMsPerFrame(settings) * delays);
}

// Variantes "calibrate-to-*": quando precisionCalibration está ativo,
// a calibração é tratada em ms puro (sem conversão por frame).
export function calibrateToDelays(settings, milliseconds) {
  return settings.precisionCalibration
    ? roundHalfToEven(milliseconds)
    : toDelays(settings, milliseconds);
}

export function calibrateToMilliseconds(settings, delays) {
  return settings.precisionCalibration ? delays : toMilliseconds(settings, delays);
}

// Calibração composta usada pelo Gen4 (delays + segundos).
// Mesma fórmula do EonTimer: toMilliseconds(delays - toDelays(seconds*1000)).
export function createCalibration(settings, delays, seconds) {
  return toMilliseconds(settings, delays - toDelays(settings, seconds * 1000));
}
