export const MOTION_STATES = Object.freeze({
  // Backward-compatible aliases. Scan state names now describe the session,
  // not the verdict for one camera frame.
  SCANNING: 'SCANNING',
  SCANNING_WITH_WARNING: 'SCANNING_WITH_WARNING',
  TRACKING_LOST: 'TRACKING_LOST',
  GOOD: 'SCANNING',
  WARNING: 'SCANNING_WITH_WARNING',
  TOO_FAST: 'SCANNING_WITH_WARNING',
  RECOVERY: 'TRACKING_LOST',
});

// These are broad starting points. Motion is calibrated per device and per
// instruction so normal hand movement is not treated as a scan failure.
export const scannerMotionConfig = {
  smoothingAlpha: 0.15,
  motionWindowMs: 500,
  instructionGraceMs: 700,
  calibrationMs: 2000,
  adaptiveWarningMultiplier: 2.4,
  adaptiveCriticalMultiplier: 3.6,
  warningPersistenceMs: 260,
  normalPersistenceMs: 320,
  trackingWeakThreshold: 0.42,
  trackingLostQualityThreshold: 0.18,
  trackingLostFeatureThreshold: 18,
  trackingLostFrameQualityThreshold: 0.22,
  trackingLostAfterMs: 3200,
  relocalizationSampleWindowMs: 2500,
  warningUiCooldownMs: 3200,
  thresholds: {
    LOOK_UP: { warningEnter: 45, warningExit: 35, criticalEnter: 85, criticalExit: 60, dominantAxis: 'pitch', weights: { pitch: 1, yaw: 0.2, roll: 0.15 } },
    LOOK_DOWN: { warningEnter: 45, warningExit: 35, criticalEnter: 85, criticalExit: 60, dominantAxis: 'pitch', weights: { pitch: 1, yaw: 0.2, roll: 0.15 } },
    TURN_LEFT: { warningEnter: 65, warningExit: 45, criticalEnter: 110, criticalExit: 75, dominantAxis: 'yaw', weights: { pitch: 0.2, yaw: 1, roll: 0.15 } },
    TURN_RIGHT: { warningEnter: 65, warningExit: 45, criticalEnter: 110, criticalExit: 75, dominantAxis: 'yaw', weights: { pitch: 0.2, yaw: 1, roll: 0.15 } },
    MOVE_LEFT: { warningEnter: 55, warningExit: 38, criticalEnter: 95, criticalExit: 65, dominantAxis: 'yaw', weights: { pitch: 0.2, yaw: 1, roll: 0.15 } },
    MOVE_RIGHT: { warningEnter: 55, warningExit: 38, criticalEnter: 95, criticalExit: 65, dominantAxis: 'yaw', weights: { pitch: 0.2, yaw: 1, roll: 0.15 } },
    MOVE_SIDEWAYS: { warningEnter: 55, warningExit: 38, criticalEnter: 95, criticalExit: 65, dominantAxis: 'yaw', weights: { pitch: 0.2, yaw: 1, roll: 0.15 } },
    MOVE_AROUND_OBJECT: { warningEnter: 55, warningExit: 38, criticalEnter: 95, criticalExit: 65, dominantAxis: 'yaw', weights: { pitch: 0.2, yaw: 1, roll: 0.15 } },
  },
};

const ZERO_VELOCITY = Object.freeze({ pitch: 0, yaw: 0, roll: 0 });

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function copyVector(vector) {
  return { pitch: finiteNumber(vector?.pitch), yaw: finiteNumber(vector?.yaw), roll: finiteNumber(vector?.roll) };
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
  if (thresholds.dominantAxis === 'pitch' && Number.isFinite(Number(target?.pitchDegrees))) return Math.abs(Number(target.pitchDegrees) - currentPitch);
  if (thresholds.dominantAxis === 'yaw' && Number.isFinite(Number(target?.headingDegrees))) return Math.abs(normalizeAngleDelta(currentHeading, Number(target.headingDegrees)));
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

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

export function createMotionTracker(config = scannerMotionConfig, options = {}) {
  const debug = Boolean(options.debug);
  const logger = typeof options.logger === 'function' ? options.logger : (...args) => console.log(...args); // eslint-disable-line no-console
  let instructionType = 'START_SCAN';
  let target = null;
  let motionState = MOTION_STATES.SCANNING;
  let graceStartedAt = null;
  let warningStartedAt = null;
  let normalStartedAt = null;
  let fastMotionStartedAt = null;
  let trackingDegradedAt = null;
  let lastTimestamp = null;
  let lastOrientation = null;
  let latestOrientation = null;
  let rawAngularVelocity = copyVector(ZERO_VELOCITY);
  let smoothedAngularVelocity = copyVector(ZERO_VELOCITY);
  let motionScore = 0;
  let instantaneousMotionScore = 0;
  let samples = [];
  let calibrationSamples = [];
  let targetError = null;
  let movingTowardTarget = null;
  let trackingQuality = 0;
  let trackingStatus = 'TRACKING';
  let trackingSampleReceived = false;
  let imageQuality = 0;
  let featureTrackingQuality = 0;
  let featureCount = 0;
  let detectedFeatureCount = 0;
  let motionBlur = false;
  let recoveryReason = '';
  let relocalizationAttempts = 0;
  let lastRelocalizationAt = 0;
  let lastUsableFrameAt = null;
  let lastRelocalizationFailed = false;
  let lastUsableFramesRecently = true;

  const logTransition = (nextState) => {
    if (motionState === nextState) return;
    if (debug) {
      const thresholds = getThresholds(config, instructionType);
      logger(`[SCAN STATE] ${instructionType}\n${motionState} -> ${nextState} pitch=${rawAngularVelocity.pitch.toFixed(1)} smoothed=${smoothedAngularVelocity.pitch.toFixed(1)} motion=${motionScore.toFixed(1)} thresholds=${thresholds.warningEnter}/${thresholds.criticalEnter}`);
    }
    motionState = nextState;
  };

  const pruneSamples = (timestamp) => {
    samples = samples.filter((sample) => sample.timestamp >= timestamp - config.motionWindowMs);
    calibrationSamples = calibrationSamples.filter((sample) => sample.timestamp >= timestamp - Math.max(config.calibrationMs, config.relocalizationSampleWindowMs));
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

  const adaptiveThresholds = () => {
    const thresholds = getThresholds(config, instructionType);
    if (calibrationSamples.length < 3) return thresholds;
    const values = calibrationSamples.map((sample) => sample.score);
    const baselineMean = average(values);
    const baselineStdDev = standardDeviation(values, baselineMean);
    const warningFloor = Math.max(24, thresholds.warningEnter * 0.7);
    const warningEnter = clamp(Math.max(warningFloor, baselineMean + (baselineStdDev * config.adaptiveWarningMultiplier) + 8), warningFloor, thresholds.warningEnter * 1.55);
    const criticalEnter = clamp(Math.max(thresholds.criticalEnter * 0.75, warningEnter + (baselineStdDev * config.adaptiveCriticalMultiplier) + 25), thresholds.criticalEnter * 0.75, thresholds.criticalEnter * 1.55);
    return { ...thresholds, warningEnter, warningExit: Math.min(thresholds.warningExit, warningEnter * 0.78), criticalEnter, criticalExit: Math.min(thresholds.criticalExit, criticalEnter * 0.7) };
  };

  const updateTrackingState = (timestamp) => {
    const weak = trackingSampleReceived && trackingQuality < config.trackingWeakThreshold;
    const severeSignalsAgree = trackingSampleReceived
      && trackingQuality < config.trackingLostQualityThreshold
      && featureCount < config.trackingLostFeatureThreshold
      && imageQuality < config.trackingLostFrameQualityThreshold;

    if (!severeSignalsAgree) {
      trackingDegradedAt = null;
      trackingStatus = weak ? 'WEAK' : 'TRACKING';
      if (motionState === MOTION_STATES.TRACKING_LOST && trackingStatus === 'TRACKING') {
        recoveryReason = '';
        logTransition(MOTION_STATES.SCANNING);
      }
      return;
    }

    if (trackingDegradedAt === null) trackingDegradedAt = timestamp;
    trackingStatus = 'WEAK';
    if (timestamp - lastRelocalizationAt >= 450) {
      relocalizationAttempts += 1;
      lastRelocalizationAt = timestamp;
    }
    const trackingLost = timestamp - trackingDegradedAt >= config.trackingLostAfterMs
      && lastRelocalizationFailed
      && !lastUsableFramesRecently;
    if (trackingLost) {
      trackingStatus = 'LOST';
      recoveryReason = 'tracking';
      logTransition(MOTION_STATES.TRACKING_LOST);
    }
  };

  const evaluate = (timestamp) => {
    const thresholds = adaptiveThresholds();
    const inGracePeriod = graceStartedAt !== null && timestamp - graceStartedAt < config.instructionGraceMs;
    const normalIsSustained = normalStartedAt !== null && timestamp - normalStartedAt >= config.normalPersistenceMs;
    updateTrackingState(timestamp);

    if (motionScore >= thresholds.criticalEnter) fastMotionStartedAt = fastMotionStartedAt === null ? timestamp : fastMotionStartedAt;
    else fastMotionStartedAt = null;

    // Only sustained, multi-signal tracking failure can block guidance.
    // Fast motion and poor frames remain quality properties.
    if (motionState === MOTION_STATES.TRACKING_LOST) return;
    if (inGracePeriod) {
      warningStartedAt = null;
      normalStartedAt = null;
      if (motionState !== MOTION_STATES.SCANNING) logTransition(MOTION_STATES.SCANNING);
      return;
    }

    if (motionScore >= thresholds.warningEnter) {
      warningStartedAt = warningStartedAt === null ? timestamp : warningStartedAt;
      normalStartedAt = null;
    } else if (motionState === MOTION_STATES.SCANNING_WITH_WARNING) {
      normalStartedAt = normalStartedAt === null ? timestamp : normalStartedAt;
      warningStartedAt = null;
    } else {
      warningStartedAt = null;
      normalStartedAt = null;
    }

    const warningIsSustained = warningStartedAt !== null && timestamp - warningStartedAt >= config.warningPersistenceMs;
    if (motionState === MOTION_STATES.SCANNING_WITH_WARNING && normalIsSustained) logTransition(MOTION_STATES.SCANNING);
    else if (motionState === MOTION_STATES.SCANNING && warningIsSustained) logTransition(MOTION_STATES.SCANNING_WITH_WARNING);
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
    if (graceStartedAt !== null && timestamp - graceStartedAt < config.calibrationMs && instantaneousMotionScore <= getThresholds(config, instructionType).warningEnter) calibrationSamples.push({ timestamp, score: instantaneousMotionScore });
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

  const updateTrackingQuality = ({ timestamp: providedTimestamp, quality, frameQuality: providedImageQuality, featureCount: providedFeatureCount, detectedFeatureCount: providedDetectedFeatureCount, featureTrackingQuality: providedFeatureTrackingQuality, motionBlur: providedMotionBlur, relocalizationFailed = false, usableFramesRecently = true } = {}) => {
    const timestamp = getTimestamp(providedTimestamp);
    trackingSampleReceived = true;
    trackingQuality = clamp(finiteNumber(quality), 0, 1);
    imageQuality = clamp(finiteNumber(providedImageQuality), 0, 1);
    featureCount = Math.max(0, Math.round(finiteNumber(providedFeatureCount)));
    detectedFeatureCount = Math.max(0, Math.round(finiteNumber(providedDetectedFeatureCount)));
    featureTrackingQuality = clamp(finiteNumber(providedFeatureTrackingQuality), 0, 1);
    motionBlur = Boolean(providedMotionBlur);
    lastRelocalizationFailed = Boolean(relocalizationFailed);
    lastUsableFramesRecently = Boolean(usableFramesRecently);
    if (trackingQuality >= config.trackingWeakThreshold && imageQuality >= config.trackingLostFrameQualityThreshold) lastUsableFrameAt = timestamp;
    evaluate(timestamp);
    return getSnapshot(timestamp);
  };

  const setInstruction = (nextInstructionType, nextTarget, timestamp = Date.now()) => {
    instructionType = nextInstructionType || 'START_SCAN';
    target = nextTarget || null;
    if (instructionType === 'START_SCAN') {
      trackingDegradedAt = null;
      trackingStatus = 'TRACKING';
      trackingSampleReceived = false;
      relocalizationAttempts = 0;
      lastRelocalizationAt = 0;
      lastUsableFrameAt = null;
      lastRelocalizationFailed = false;
      lastUsableFramesRecently = true;
    }
    graceStartedAt = timestamp;
    warningStartedAt = null;
    normalStartedAt = null;
    fastMotionStartedAt = null;
    samples = [];
    calibrationSamples = [];
    rawAngularVelocity = copyVector(ZERO_VELOCITY);
    smoothedAngularVelocity = copyVector(ZERO_VELOCITY);
    motionScore = 0;
    instantaneousMotionScore = 0;
    targetError = null;
    movingTowardTarget = null;
    if (trackingStatus !== 'LOST') {
      recoveryReason = '';
      motionState = MOTION_STATES.SCANNING;
    }
    if (latestOrientation) updateTargetProgress(latestOrientation);
    lastTimestamp = timestamp;
    return getSnapshot(timestamp);
  };

  const getSnapshot = (timestamp = Date.now(), deltaSeconds = null) => {
    const thresholds = adaptiveThresholds();
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
      highSpeedDurationMs: fastMotionStartedAt === null ? 0 : Math.max(0, timestamp - fastMotionStartedAt),
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
      trackingStatus,
      trackingLostDurationMs: trackingDegradedAt === null ? 0 : Math.max(0, timestamp - trackingDegradedAt),
      relocalizationAttempts,
      lastUsableFrameAt,
      imageQuality,
      featureTrackingQuality,
      featureCount,
      detectedFeatureCount,
      motionBlur,
      recoveryReason,
      adaptiveBaseline: calibrationSamples.length > 0 ? average(calibrationSamples.map((sample) => sample.score)) : 0,
      calibrationSampleCount: calibrationSamples.length,
      deltaSeconds,
      updatedAt: timestamp,
    };
  };

  return { setInstruction, updateAngularVelocity, updateOrientationSample, updateOrientation, updateTrackingQuality, getSnapshot };
}
