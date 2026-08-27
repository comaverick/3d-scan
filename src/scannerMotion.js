export const MOTION_STATES = Object.freeze({
  GOOD: 'GOOD',
  WARNING: 'WARNING',
  TOO_FAST: 'TOO_FAST',
  RECOVERY: 'RECOVERY',
});

// DeviceMotionEvent.rotationRate is specified in degrees per second.
// These are deliberately centralized starting points, not device-specific truths.
export const scannerMotionConfig = {
  smoothingAlpha: 0.15,
  motionWindowMs: 400,
  instructionGraceMs: 700,
  warningPersistenceMs: 150,
  criticalPersistenceMs: 400,
  normalPersistenceMs: 180,
  recoveryAfterCriticalMs: 1600,
  trackingRecoveryThreshold: 0.28,
  warningUiCooldownMs: 1000,
  thresholds: {
    LOOK_UP: {
      warningEnter: 45,
      warningExit: 35,
      criticalEnter: 85,
      criticalExit: 60,
      dominantAxis: 'pitch',
      weights: { pitch: 1, yaw: 0.2, roll: 0.15 },
    },
    LOOK_DOWN: {
      warningEnter: 45,
      warningExit: 35,
      criticalEnter: 85,
      criticalExit: 60,
      dominantAxis: 'pitch',
      weights: { pitch: 1, yaw: 0.2, roll: 0.15 },
    },
    TURN_LEFT: {
      warningEnter: 65,
      warningExit: 45,
      criticalEnter: 110,
      criticalExit: 75,
      dominantAxis: 'yaw',
      weights: { pitch: 0.2, yaw: 1, roll: 0.15 },
    },
    TURN_RIGHT: {
      warningEnter: 65,
      warningExit: 45,
      criticalEnter: 110,
      criticalExit: 75,
      dominantAxis: 'yaw',
      weights: { pitch: 0.2, yaw: 1, roll: 0.15 },
    },
    MOVE_LEFT: {
      warningEnter: 55,
      warningExit: 38,
      criticalEnter: 95,
      criticalExit: 65,
      dominantAxis: 'yaw',
      weights: { pitch: 0.2, yaw: 1, roll: 0.15 },
    },
    MOVE_RIGHT: {
      warningEnter: 55,
      warningExit: 38,
      criticalEnter: 95,
      criticalExit: 65,
      dominantAxis: 'yaw',
      weights: { pitch: 0.2, yaw: 1, roll: 0.15 },
    },
    MOVE_SIDEWAYS: {
      warningEnter: 55,
      warningExit: 38,
      criticalEnter: 95,
      criticalExit: 65,
      dominantAxis: 'yaw',
      weights: { pitch: 0.2, yaw: 1, roll: 0.15 },
    },
    MOVE_AROUND_OBJECT: {
      warningEnter: 55,
      warningExit: 38,
      criticalEnter: 95,
      criticalExit: 65,
      dominantAxis: 'yaw',
      weights: { pitch: 0.2, yaw: 1, roll: 0.15 },
    },
  },
};

const ZERO_VELOCITY = Object.freeze({ pitch: 0, yaw: 0, roll: 0 });

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function copyVector(vector) {
  return {
    pitch: finiteNumber(vector?.pitch),
    yaw: finiteNumber(vector?.yaw),
    roll: finiteNumber(vector?.roll),
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function normalizeAngleDelta(first, second) {
  return ((((finiteNumber(second) - finiteNumber(first)) + 540) % 360) - 180);
}

function getThresholds(config, instructionType) {
  return config.thresholds[instructionType] || config.thresholds.MOVE_AROUND_OBJECT;
}

export function calculateMotionScore(angularVelocity, instructionType, config = scannerMotionConfig) {
  const thresholds = getThresholds(config, instructionType);
  const weights = thresholds.weights || { pitch: 1, yaw: 0.2, roll: 0.15 };
  const velocity = copyVector(angularVelocity);
  return (Math.abs(velocity.pitch) * weights.pitch)
    + (Math.abs(velocity.yaw) * weights.yaw)
    + (Math.abs(velocity.roll) * weights.roll);
}

function hasTarget(target) {
  return Number.isFinite(Number(target?.pitchDegrees)) || Number.isFinite(Number(target?.headingDegrees));
}

function targetErrorFor(instructionType, target, orientation, config = scannerMotionConfig) {
  const thresholds = getThresholds(config, instructionType);
  const currentPitch = finiteNumber(orientation?.pitchDegrees);
  const currentHeading = finiteNumber(orientation?.headingDegrees);
  if (thresholds.dominantAxis === 'pitch' && Number.isFinite(Number(target?.pitchDegrees))) {
    return Math.abs(Number(target.pitchDegrees) - currentPitch);
  }
  if (thresholds.dominantAxis === 'yaw' && Number.isFinite(Number(target?.headingDegrees))) {
    return Math.abs(normalizeAngleDelta(currentHeading, Number(target.headingDegrees)));
  }
  return null;
}

function getTimestamp(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function getTimeWeightedAverage(samples, now, windowMs) {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0].score;
  let weightedScore = 0;
  let totalDuration = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const duration = clamp(current.timestamp - previous.timestamp, 0, windowMs);
    weightedScore += previous.score * duration;
    totalDuration += duration;
  }
  const lastDuration = clamp(now - samples[samples.length - 1].timestamp, 0, windowMs);
  weightedScore += samples[samples.length - 1].score * lastDuration;
  totalDuration += lastDuration;
  return totalDuration > 0 ? weightedScore / totalDuration : samples[samples.length - 1].score;
}

function orientationVelocity(previous, current, deltaSeconds) {
  if (!previous || !current || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return ZERO_VELOCITY;
  const seconds = clamp(deltaSeconds, 0.01, 1.5);
  return {
    pitch: (finiteNumber(current.pitchDegrees) - finiteNumber(previous.pitchDegrees)) / seconds,
    yaw: normalizeAngleDelta(previous.headingDegrees, current.headingDegrees) / seconds,
    roll: (finiteNumber(current.rollDegrees) - finiteNumber(previous.rollDegrees)) / seconds,
  };
}

export function createMotionTracker(config = scannerMotionConfig, options = {}) {
  const debug = Boolean(options.debug);
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (...args) => console.log(...args); // eslint-disable-line no-console
  let instructionType = 'START_SCAN';
  let target = null;
  let motionState = MOTION_STATES.GOOD;
  let graceStartedAt = null;
  let warningStartedAt = null;
  let criticalStartedAt = null;
  let normalStartedAt = null;
  let lastTimestamp = null;
  let lastOrientation = null;
  let latestOrientation = null;
  let rawAngularVelocity = copyVector(ZERO_VELOCITY);
  let smoothedAngularVelocity = copyVector(ZERO_VELOCITY);
  let motionScore = 0;
  let instantaneousMotionScore = 0;
  let samples = [];
  let targetError = null;
  let movingTowardTarget = null;
  let trackingQuality = 0;
  let trackingSampleReceived = false;
  let imageQuality = 0;
  let featureCount = 0;
  let motionBlur = false;
  let recoveryReason = '';

  const logTransition = (nextState, timestamp) => {
    if (motionState === nextState) return;
    if (debug) {
      const thresholds = getThresholds(config, instructionType);
      const duration = nextState === MOTION_STATES.TOO_FAST
        ? Math.round(Math.max(0, timestamp - (criticalStartedAt || timestamp)))
        : Math.round(Math.max(0, timestamp - (warningStartedAt || timestamp)));
      logger(
        `[MOTION] ${instructionType}\n${motionState} → ${nextState} pitch=${rawAngularVelocity.pitch.toFixed(1)} smoothed=${smoothedAngularVelocity.pitch.toFixed(1)} duration=${duration}ms thresholds=${thresholds.warningEnter}/${thresholds.criticalEnter}`,
      );
    }
    motionState = nextState;
  };

  const pruneSamples = (timestamp) => {
    const cutoff = timestamp - config.motionWindowMs;
    samples = samples.filter((sample) => sample.timestamp >= cutoff);
  };

  const updateTargetProgress = (orientation) => {
    if (!hasTarget(target)) {
      targetError = null;
      movingTowardTarget = null;
      return;
    }
    const nextError = targetErrorFor(instructionType, target, orientation, config);
    movingTowardTarget = targetError === null ? null : nextError < targetError - 0.2;
    targetError = nextError;
  };

  const evaluate = (timestamp) => {
    const thresholds = getThresholds(config, instructionType);
    const inGracePeriod = graceStartedAt !== null && timestamp - graceStartedAt < config.instructionGraceMs;
    const criticalDuration = criticalStartedAt === null ? 0 : Math.max(0, timestamp - criticalStartedAt);
    const trackingLost = trackingSampleReceived && trackingQuality < config.trackingRecoveryThreshold;
    const sustainedExtremeMotion = criticalDuration >= config.recoveryAfterCriticalMs;
    const visualFailureDuringExtremeMotion = imageQuality < 0.3 || motionBlur || trackingQuality < 0.4;

    if (trackingLost || (sustainedExtremeMotion && visualFailureDuringExtremeMotion)) {
      recoveryReason = trackingLost ? 'tracking' : 'extreme-motion';
      logTransition(MOTION_STATES.RECOVERY, timestamp);
      return;
    }

    if (motionState === MOTION_STATES.RECOVERY) {
      if (trackingQuality >= 0.4 && motionScore <= thresholds.warningExit) {
        recoveryReason = '';
        logTransition(MOTION_STATES.GOOD, timestamp);
      }
      return;
    }

    if (inGracePeriod) {
      warningStartedAt = null;
      criticalStartedAt = null;
      normalStartedAt = null;
      if (motionState !== MOTION_STATES.GOOD) logTransition(MOTION_STATES.GOOD, timestamp);
      return;
    }

    if (motionScore >= thresholds.criticalEnter) {
      criticalStartedAt = criticalStartedAt === null ? timestamp : criticalStartedAt;
    } else {
      criticalStartedAt = null;
    }

    if (motionState === MOTION_STATES.WARNING || motionState === MOTION_STATES.TOO_FAST) {
      if (motionScore <= thresholds.warningExit) {
        normalStartedAt = normalStartedAt === null ? timestamp : normalStartedAt;
      } else {
        normalStartedAt = null;
      }
    } else if (motionScore >= thresholds.warningEnter) {
      warningStartedAt = warningStartedAt === null ? timestamp : warningStartedAt;
      normalStartedAt = null;
    } else {
      warningStartedAt = null;
      normalStartedAt = null;
    }

    const criticalIsSustained = criticalStartedAt !== null
      && timestamp - criticalStartedAt >= config.criticalPersistenceMs;
    const warningIsSustained = warningStartedAt !== null
      && timestamp - warningStartedAt >= config.warningPersistenceMs;
    const normalIsSustained = normalStartedAt !== null
      && timestamp - normalStartedAt >= config.normalPersistenceMs;

    if (motionState === MOTION_STATES.TOO_FAST) {
      if (motionScore <= thresholds.warningExit && normalIsSustained) {
        logTransition(MOTION_STATES.GOOD, timestamp);
      } else if (motionScore <= thresholds.criticalExit) {
        logTransition(MOTION_STATES.WARNING, timestamp);
      }
    } else if (motionState === MOTION_STATES.GOOD && criticalIsSustained) {
      logTransition(MOTION_STATES.TOO_FAST, timestamp);
    } else if (motionState === MOTION_STATES.GOOD && warningIsSustained) {
      logTransition(MOTION_STATES.WARNING, timestamp);
    } else if (motionState === MOTION_STATES.WARNING && criticalIsSustained) {
      logTransition(MOTION_STATES.TOO_FAST, timestamp);
    } else if (motionState === MOTION_STATES.WARNING && normalIsSustained) {
      logTransition(MOTION_STATES.GOOD, timestamp);
    }
  };

  const updateAngularVelocity = ({ timestamp: providedTimestamp, angularVelocity, orientation } = {}) => {
    const timestamp = getTimestamp(providedTimestamp);
    const currentVelocity = copyVector(angularVelocity);
    const deltaSeconds = lastTimestamp === null ? null : (timestamp - lastTimestamp) / 1000;
    const alpha = clamp(finiteNumber(config.smoothingAlpha, 0.15), 0.01, 1);
    rawAngularVelocity = currentVelocity;
    smoothedAngularVelocity = {
      pitch: (alpha * currentVelocity.pitch) + ((1 - alpha) * smoothedAngularVelocity.pitch),
      yaw: (alpha * currentVelocity.yaw) + ((1 - alpha) * smoothedAngularVelocity.yaw),
      roll: (alpha * currentVelocity.roll) + ((1 - alpha) * smoothedAngularVelocity.roll),
    };
    instantaneousMotionScore = calculateMotionScore(smoothedAngularVelocity, instructionType, config);
    samples.push({ timestamp, score: instantaneousMotionScore });
    pruneSamples(timestamp);
    motionScore = getTimeWeightedAverage(samples, timestamp, config.motionWindowMs);
    if (orientation) {
      latestOrientation = { ...orientation };
      updateTargetProgress(latestOrientation);
    }
    lastTimestamp = timestamp;
    evaluate(timestamp);
    return getSnapshot(timestamp, deltaSeconds);
  };

  const updateOrientationSample = ({ timestamp: providedTimestamp, orientation } = {}) => {
    const timestamp = getTimestamp(providedTimestamp);
    const currentOrientation = orientation ? { ...orientation } : null;
    const velocity = orientationVelocity(lastOrientation, currentOrientation, lastTimestamp === null ? null : (timestamp - lastTimestamp) / 1000);
    lastOrientation = currentOrientation;
    updateOrientation({ timestamp, orientation: currentOrientation });
    return updateAngularVelocity({ timestamp, angularVelocity: velocity, orientation: currentOrientation });
  };

  const updateOrientation = ({ timestamp: providedTimestamp, orientation } = {}) => {
    const timestamp = getTimestamp(providedTimestamp);
    latestOrientation = orientation ? { ...orientation } : null;
    updateTargetProgress(latestOrientation);
    return getSnapshot(timestamp);
  };

  const updateTrackingQuality = ({ timestamp: providedTimestamp, quality, frameQuality: providedImageQuality, featureCount: providedFeatureCount, motionBlur: providedMotionBlur } = {}) => {
    const timestamp = getTimestamp(providedTimestamp);
    trackingSampleReceived = true;
    trackingQuality = clamp(finiteNumber(quality), 0, 1);
    imageQuality = clamp(finiteNumber(providedImageQuality), 0, 1);
    featureCount = Math.max(0, Math.round(finiteNumber(providedFeatureCount)));
    motionBlur = Boolean(providedMotionBlur);
    evaluate(timestamp);
    return getSnapshot(timestamp);
  };

  const setInstruction = (nextInstructionType, nextTarget, timestamp = Date.now()) => {
    const preservingRecovery = motionState === MOTION_STATES.RECOVERY;
    instructionType = nextInstructionType || 'START_SCAN';
    target = nextTarget || null;
    graceStartedAt = preservingRecovery ? null : timestamp;
    warningStartedAt = null;
    criticalStartedAt = null;
    normalStartedAt = null;
    samples = [];
    rawAngularVelocity = copyVector(ZERO_VELOCITY);
    smoothedAngularVelocity = copyVector(ZERO_VELOCITY);
    motionScore = 0;
    instantaneousMotionScore = 0;
    targetError = null;
    movingTowardTarget = null;
    recoveryReason = preservingRecovery ? recoveryReason : '';
    if (!preservingRecovery) motionState = MOTION_STATES.GOOD;
    if (latestOrientation) updateTargetProgress(latestOrientation);
    lastTimestamp = timestamp;
    return getSnapshot(timestamp);
  };

  const getSnapshot = (timestamp = Date.now(), deltaSeconds = null) => {
    const thresholds = getThresholds(config, instructionType);
    const criticalDuration = criticalStartedAt === null ? 0 : Math.max(0, timestamp - criticalStartedAt);
    const warningDuration = warningStartedAt === null ? 0 : Math.max(0, timestamp - warningStartedAt);
    const graceElapsed = graceStartedAt === null ? config.instructionGraceMs : Math.max(0, timestamp - graceStartedAt);
    const gyroQuality = clamp(1 - (motionScore / Math.max(1, thresholds.criticalEnter * 1.2)), 0, 1);
    return {
      instructionType,
      motionState,
      rawAngularVelocity: copyVector(rawAngularVelocity),
      smoothedAngularVelocity: copyVector(smoothedAngularVelocity),
      motionScore,
      instantaneousMotionScore,
      motionQuality: gyroQuality,
      sampleCount: samples.length,
      highSpeedDurationMs: criticalDuration,
      warningDurationMs: warningDuration,
      instructionGraceActive: graceElapsed < config.instructionGraceMs,
      graceRemainingMs: Math.max(0, config.instructionGraceMs - graceElapsed),
      warningThreshold: thresholds.warningEnter,
      warningExitThreshold: thresholds.warningExit,
      criticalThreshold: thresholds.criticalEnter,
      criticalExitThreshold: thresholds.criticalExit,
      dominantAxis: thresholds.dominantAxis || 'yaw',
      targetPitchDegrees: Number.isFinite(Number(target?.pitchDegrees)) ? Number(target.pitchDegrees) : null,
      currentPitchDegrees: latestOrientation ? finiteNumber(latestOrientation.pitchDegrees) : null,
      targetHeadingDegrees: Number.isFinite(Number(target?.headingDegrees)) ? Number(target.headingDegrees) : null,
      currentHeadingDegrees: latestOrientation ? finiteNumber(latestOrientation.headingDegrees) : null,
      targetErrorDegrees: targetError,
      movingTowardTarget,
      trackingQuality,
      imageQuality,
      featureCount,
      motionBlur,
      recoveryReason,
      deltaSeconds,
      updatedAt: timestamp,
    };
  };

  return {
    setInstruction,
    updateAngularVelocity,
    updateOrientationSample,
    updateOrientation,
    updateTrackingQuality,
    getSnapshot,
  };
}
