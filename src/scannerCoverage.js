export const SCANNER_PHASES = Object.freeze({
  INITIAL_TRACKING: 'INITIAL_TRACKING',
  CONTINUOUS_MAPPING: 'CONTINUOUS_MAPPING',
  READY: 'READY',
  // Backward-compatible names for exported scan sessions and existing tests.
  INITIAL_MAPPING: 'INITIAL_TRACKING',
  ADAPTIVE_COVERAGE: 'CONTINUOUS_MAPPING',
});

export function normalizeScannerPhase(phase) {
  if (phase === SCANNER_PHASES.INITIAL_TRACKING || phase === 'INITIAL_MAPPING') return SCANNER_PHASES.INITIAL_TRACKING;
  if (phase === SCANNER_PHASES.CONTINUOUS_MAPPING || phase === 'ADAPTIVE_COVERAGE') return SCANNER_PHASES.CONTINUOUS_MAPPING;
  if (phase === SCANNER_PHASES.READY) return SCANNER_PHASES.READY;
  return phase;
}

export function isInitialTrackingPhase(phase) {
  return normalizeScannerPhase(phase) === SCANNER_PHASES.INITIAL_TRACKING;
}

export function isContinuousMappingPhase(phase) {
  const normalized = normalizeScannerPhase(phase);
  return normalized === SCANNER_PHASES.CONTINUOUS_MAPPING || normalized === SCANNER_PHASES.READY;
}

export const mappingReadinessConfig = Object.freeze({
  minimumAcceptedKeyframes: 6,
  minimumTrackedFeatures: 30,
  minimumMultiFrameFeatureTracks: 12,
  minimumOrientationCoverage: 0.45,
  minimumViewpointDiversity: 0.22,
  minimumSuccessfulRelativePoses: 3,
});

export const observedTargetConfig = Object.freeze({
  minimumUsefulFeatures: 3,
  minimumTargetFeatures: 6,
  maximumTargets: 24,
  targetMergeAngleDegrees: 16,
  targetMergeDistanceMeters: 0.9,
  minimumTargetConfidence: 0.08,
  lowTextureAttempts: 3,
  lowTextureFeatureDensity: 0.12,
  sufficientViewpoints: 3,
  sufficientParallax: 0.32,
});

export const coverageOverlayConfig = Object.freeze({
  maxVisibleRegions: 24,
  maxBlueOpacity: 0.6,
  completionThreshold: 0.7,
});

export const directionalCoverageConfig = Object.freeze({
  yawBins: 18,
  yawBinDegrees: 20,
  pitchBands: Object.freeze([
    Object.freeze({ id: 'upper', pitch: 0.48, height: 0.3 }),
    Object.freeze({ id: 'middle', pitch: 0, height: 0.34 }),
    Object.freeze({ id: 'lower', pitch: -0.48, height: 0.3 }),
  ]),
  minimumTranslationMeters: 0.18,
  minimumAngleDegrees: 12,
  minimumParallax: 0.18,
  duplicateTranslationMeters: 0.08,
  duplicateAngleDegrees: 5,
  duplicateParallax: 0.06,
  maxViewpointsPerCell: 12,
  maxVisibleCells: 54,
  clearCoverage: 0.78,
  clearConfidence: 0.86,
});

export const sparseMapConfig = Object.freeze({
  maxPoints: 500,
  minimumBaselineMeters: 0.12,
  maximumReprojectionErrorDegrees: 12,
  minimumTrackObservations: 2,
  planeToleranceMeters: 0.08,
  minimumPlaneInliers: 6,
  minimumPlaneConfidence: 0.42,
});

// Lower numbers are structural priorities. Furniture is intentionally last
// so heuristic furniture/frame classifications cannot steer the room pass.
export const scannerTargetPriority = Object.freeze({
  WALL_CORNER: 1,
  WALL_CEILING_JUNCTION: 2,
  WALL_FLOOR_JUNCTION: 3,
  STRUCTURAL_EDGE: 4,
  DOOR_FRAME: 5,
  WINDOW_FRAME: 6,
  OBSERVED_REGION: 7,
  FURNITURE_OR_FRAME_EDGE: 8,
});

const HORIZONTAL_FOV_DEGREES = 70;
const VERTICAL_FOV_DEGREES = 45;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(Number(value) || 0, maximum));
}

export function blueCoverageOpacity(region, config = coverageOverlayConfig) {
  if (!region || region.skipped || ['SUFFICIENT', 'INFERABLE'].includes(region.status)) return 0;
  const settings = { ...coverageOverlayConfig, ...(config || {}) };
  const coverageValue = Number.isFinite(Number(region.coverage))
    ? Number(region.coverage)
    : Number(region.coverageConfidence) || 0;
  const coverage = clamp(coverageValue, 0, 1);
  const maxOpacity = clamp(settings.maxBlueOpacity, 0, 1);
  const hasDistinctViewEvidence = Number.isFinite(Number(region.distinctViewCount))
    || Number.isFinite(Number(region.physicalViewCount));
  const completionThreshold = clamp(
    hasDistinctViewEvidence && Number.isFinite(Number(settings.clearCoverage))
      ? settings.clearCoverage
      : settings.completionThreshold,
    0.01,
    1,
  );
  const distinctViews = Number(region.distinctViewCount ?? region.viewpointCount) || 0;
  const physicalViews = Number(region.physicalViewCount ?? region.translationViewCount) || 0;
  const confidence = Number(region.coverageConfidence ?? region.confidence) || 0;
  const clearConfidence = Number(settings.clearConfidence) || directionalCoverageConfig.clearConfidence;
  const geometryCanClear = !hasDistinctViewEvidence
    || (distinctViews >= 2 && physicalViews >= 1)
    || (!Number.isFinite(Number(region.physicalViewCount))
      && !Number.isFinite(Number(region.translationViewCount))
      && distinctViews >= 2
      && confidence >= clearConfidence);
  if (coverage >= completionThreshold && geometryCanClear) return 0;
  if (coverage <= 0.15) return maxOpacity;
  if (coverage <= 0.4) return maxOpacity + ((0.35 - maxOpacity) * ((coverage - 0.15) / 0.25));
  const upperOpacity = geometryCanClear ? 0.12 : 0.18;
  return 0.35 + ((upperOpacity - 0.35) * ((coverage - 0.4) / (completionThreshold - 0.4)));
}

function normalizedHeading(value) {
  return ((finite(value, 0) % 360) + 360) % 360;
}

function directionFromYawPitch(yaw, pitch) {
  const yawRadians = (normalizedHeading(yaw) * Math.PI) / 180;
  const pitchRadians = finite(pitch) * (Math.PI / 2);
  return normalize({
    x: Math.sin(yawRadians) * Math.cos(pitchRadians),
    y: Math.sin(pitchRadians),
    z: -Math.cos(yawRadians) * Math.cos(pitchRadians),
  });
}

function featureSignature(featureTrackIds = []) {
  return [...new Set((Array.isArray(featureTrackIds) ? featureTrackIds : []).filter(Boolean))].slice(0, 16);
}

function viewRecordFrom({ keyframeId, pose, orientation, featureTrackIds, translationDelta = 0, angleDelta = 0, parallax = 0, visualParallax = 0 }) {
  return {
    keyframeId: keyframeId ?? null,
    position: pose ? { x: finite(pose.x), y: finite(pose.y), z: finite(pose.z) } : null,
    pose: pose ? { x: finite(pose.x), y: finite(pose.y), z: finite(pose.z) } : null,
    heading: headingFor(orientation, pose),
    pitch: pitchFor(orientation),
    timestamp: Date.now(),
    featureSignature: featureSignature(featureTrackIds),
    translationDelta,
    angleDelta,
    parallax,
    visualParallax,
  };
}

export function viewpointNovelty(previousViewpoints = [], nextView, config = directionalCoverageConfig) {
  const previous = Array.isArray(previousViewpoints) ? previousViewpoints.filter(Boolean) : [];
  if (!nextView) return {
    isNovel: false,
    translationDelta: 0,
    angleDelta: 0,
    parallax: 0,
    physicalMovement: false,
    reason: 'MISSING_VIEW',
  };
  if (previous.length === 0) return {
    isNovel: true,
    translationDelta: 0,
    angleDelta: 0,
    parallax: 0,
    physicalMovement: false,
    reason: 'FIRST_VIEW',
  };
  const nextHeading = headingFor({ heading: nextView.heading }, nextView.pose || nextView.position);
  const nextPitch = finite(nextView.pitch);
  const comparisons = previous.map((view) => {
    const translationDelta = poseDistance(view.position || view.pose, nextView.position || nextView.pose);
    const angleDelta = Math.max(
      angleDistance(view.heading, nextHeading),
      Math.abs(finite(view.pitch) - nextPitch) * 90,
    );
    const poseParallax = clamp(translationDelta / 0.45, 0, 1);
    const visualParallax = clamp(nextView.visualParallax, 0, 1);
    const parallax = Math.max(poseParallax, visualParallax);
    return { translationDelta, angleDelta, parallax, visualParallax };
  });
  const closest = comparisons.reduce((best, current) => (!best || current.translationDelta + (current.angleDelta / 180) < best.translationDelta + (best.angleDelta / 180) ? current : best), null);
  const last = comparisons[comparisons.length - 1] || closest;
  const meaningful = comparisons.some((comparison) => comparison.translationDelta >= config.minimumTranslationMeters
    || comparison.angleDelta >= config.minimumAngleDegrees
    || comparison.parallax >= config.minimumParallax);
  const duplicate = closest.translationDelta < config.duplicateTranslationMeters
    && closest.angleDelta < config.duplicateAngleDegrees
    && closest.parallax < config.duplicateParallax;
  const physicalMovement = comparisons.some((comparison) => comparison.translationDelta >= config.minimumTranslationMeters);
  return {
    isNovel: meaningful && !duplicate,
    translationDelta: physicalMovement ? Math.max(...comparisons.map((comparison) => comparison.translationDelta)) : last.translationDelta,
    angleDelta: last.angleDelta,
    parallax: last.parallax,
    visualParallax: last.visualParallax,
    physicalMovement,
    reason: duplicate ? 'DUPLICATE_VIEW' : meaningful ? null : 'LOW_NOVELTY',
  };
}

export function createDirectionalCoverageGrid(referenceHeading = 0, config = directionalCoverageConfig) {
  const settings = { ...directionalCoverageConfig, ...(config || {}) };
  const pitchBands = Array.isArray(settings.pitchBands) ? settings.pitchBands : directionalCoverageConfig.pitchBands;
  return pitchBands.flatMap((band) => Array.from({ length: settings.yawBins }, (_, index) => {
    const yaw = normalizedHeading(referenceHeading + (index * settings.yawBinDegrees));
    return {
      id: `cell-${band.id}-${index}`,
      kind: 'DIRECTIONAL_CELL',
      band: band.id,
      yaw,
      pitch: band.pitch,
      yawWidth: settings.yawBinDegrees,
      pitchHeight: band.height,
      estimatedDirection: directionFromYawPitch(yaw, band.pitch),
      coverage: 0,
      observationCount: 0,
      distinctViewCount: 0,
      viewpointCount: 0,
      physicalViewCount: 0,
      translationViewCount: 0,
      angularViewCount: 0,
      viewpoints: [],
      confidence: 0,
      coverageConfidence: 0,
      parallaxScore: 0,
      status: 'UNSEEN',
      referenceHeading: normalizedHeading(referenceHeading),
      lastSeenAt: 0,
    };
  }));
}

export function summarizeDirectionalCoverage(cells = []) {
  const validCells = (Array.isArray(cells) ? cells : []).filter((cell) => !cell.skipped);
  if (validCells.length === 0) return {
    coverage: 0,
    confidence: 0,
    observedCellCount: 0,
    activeCellCount: 0,
    distinctViewCount: 0,
    physicalViewCount: 0,
    viewpointDiversity: 0,
  };
  const average = (key) => validCells.reduce((sum, cell) => sum + (Number(cell[key]) || 0), 0) / validCells.length;
  const observed = validCells.filter((cell) => (Number(cell.observationCount) || 0) > 0);
  const multiView = validCells.filter((cell) => (Number(cell.distinctViewCount ?? cell.viewpointCount) || 0) >= 2);
  return {
    coverage: average('coverage'),
    confidence: average('coverageConfidence'),
    observedCellCount: observed.length,
    activeCellCount: validCells.filter((cell) => cell.status !== 'SUFFICIENT').length,
    distinctViewCount: Math.max(0, ...validCells.map((cell) => Number(cell.distinctViewCount ?? cell.viewpointCount) || 0)),
    physicalViewCount: Math.max(0, ...validCells.map((cell) => Number(cell.physicalViewCount ?? cell.translationViewCount) || 0)),
    viewpointDiversity: clamp((observed.length / validCells.length) * 0.55 + (multiView.length / validCells.length) * 0.45, 0, 1),
  };
}

export function targetPriorityForScan(target, furniturePassActive = false) {
  if (target?.semanticType === 'FURNITURE_OR_FRAME_EDGE') return furniturePassActive ? 0 : Number.POSITIVE_INFINITY;
  return scannerTargetPriority[target?.semanticType] || scannerTargetPriority.OBSERVED_REGION;
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : (Number.isFinite(Number(fallback)) ? Number(fallback) : 0);
}

function angleDistance(first, second) {
  return Math.abs((((finite(first) - finite(second)) + 540) % 360) - 180);
}

function signedAngleDistance(first, second) {
  return ((((finite(second) - finite(first)) + 540) % 360) - 180);
}

function vectorLength(vector) {
  return Math.sqrt((finite(vector?.x) ** 2) + (finite(vector?.y) ** 2) + (finite(vector?.z) ** 2));
}

function normalize(vector, fallback = { x: 0, y: 0, z: -1 }) {
  const length = vectorLength(vector);
  if (length < 0.0001) return fallback;
  return { x: finite(vector.x) / length, y: finite(vector.y) / length, z: finite(vector.z) / length };
}

function poseDistance(first, second) {
  if (!first || !second) return 0;
  return Math.sqrt(
    ((finite(first.x) - finite(second.x)) ** 2)
    + ((finite(first.y) - finite(second.y)) ** 2)
    + ((finite(first.z) - finite(second.z)) ** 2),
  );
}

function headingFor(orientation, pose) {
  if (Number.isFinite(Number(orientation?.heading))) return Number(orientation.heading);
  if (Number.isFinite(Number(pose?.yaw))) return Number(pose.yaw);
  return null;
}

function pitchFor(orientation) {
  return finite(orientation?.pitch, 0);
}

function forwardFor(orientation, pose) {
  const heading = ((headingFor(orientation, pose) || 0) * Math.PI) / 180;
  const pitch = pitchFor(orientation) * (Math.PI / 2);
  return normalize({
    x: Math.sin(heading) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(heading) * Math.cos(pitch),
  });
}

function rightFor(orientation, pose) {
  const heading = ((headingFor(orientation, pose) || 0) * Math.PI) / 180;
  return { x: Math.cos(heading), y: 0, z: Math.sin(heading) };
}

export function directionForImagePoint(point, orientation, pose) {
  const x = finite(point?.x, 0.5);
  const y = finite(point?.y, 0.5);
  const horizontal = Math.tan((HORIZONTAL_FOV_DEGREES * Math.PI) / 360) * ((x - 0.5) * 2);
  const vertical = Math.tan((VERTICAL_FOV_DEGREES * Math.PI) / 360) * ((0.5 - y) * 2);
  const forward = forwardFor(orientation, pose);
  const right = rightFor(orientation, pose);
  return normalize({
    x: forward.x + (right.x * horizontal),
    y: forward.y + vertical,
    z: forward.z + (right.z * horizontal),
  });
}

function targetYawPitch(direction) {
  const safe = normalize(direction);
  return {
    yaw: ((Math.atan2(safe.x, -safe.z) * 180) / Math.PI + 360) % 360,
    pitch: Math.asin(clamp(safe.y, -1, 1)) / (Math.PI / 2),
  };
}

function directionAngle(first, second) {
  const dot = clamp((finite(first?.x) * finite(second?.x)) + (finite(first?.y) * finite(second?.y)) + (finite(first?.z) * finite(second?.z)), -1, 1);
  return (Math.acos(dot) * 180) / Math.PI;
}

function mergeUnique(first = [], second = []) {
  return [...new Set([...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])])];
}

function latestObservationForTrack(track) {
  return Array.isArray(track?.observations) ? track.observations[track.observations.length - 1] : null;
}

function patchDifference(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length === 0 || second.length === 0) return 0.5;
  const length = Math.min(first.length, second.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += Math.abs(finite(first[index]) - finite(second[index]));
  return clamp(total / length, 0, 1);
}

function blendPatchSignature(previous, current, weight = 0.22) {
  if (!Array.isArray(current) || current.length === 0) return previous || null;
  if (!Array.isArray(previous) || previous.length === 0) return current.slice(0, 16);
  const length = Math.min(previous.length, current.length, 16);
  return Array.from({ length }, (_, index) => (finite(previous[index]) * (1 - weight)) + (finite(current[index]) * weight));
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((first, second) => first - second);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Maintains stable IDs for the lightweight browser feature detector. This is
 * deliberately independent of target geometry: features are tracked first,
 * then accepted keyframes turn those tracks into spatial observations.
 */
export function updateFeatureTracks(previousTracks = [], featurePoints = [], context = {}) {
  const previous = Array.isArray(previousTracks) ? previousTracks : [];
  const points = (Array.isArray(featurePoints) ? featurePoints : []).slice(0, 650);
  const frameIndex = finite(context.frameIndex, 0);
  let nextTrackId = Math.max(0, ...previous.map((track) => Number(String(track.id || '').replace('ft-', '')) || 0)) + 1;
  const available = previous
    .filter((track) => frameIndex - finite(track.lastFrameIndex, frameIndex) <= 3)
    .map((track) => ({ track, used: false }));
  const currentTrackIds = [];
  const nextTracks = previous.map((track) => ({
    ...track,
    observations: [...(track.observations || [])],
    velocityEstimate: track.velocityEstimate || { x: 0, y: 0 },
    quality: Number.isFinite(Number(track.quality)) ? Number(track.quality) : 0.5,
    confidence: Number.isFinite(Number(track.confidence)) ? Number(track.confidence) : 0.5,
  }));
  const matchedDistance = finite(context.matchDistance, 0.14);
  const appearanceThreshold = finite(context.appearanceThreshold, 0.52);
  const displacementSamples = [];

  const associationFor = (candidate, point) => {
    const latest = latestObservationForTrack(candidate.track);
    if (!latest) return null;
    const frameDelta = Math.max(1, frameIndex - finite(latest.frameIndex, frameIndex));
    const velocity = candidate.track.velocityEstimate || { x: 0, y: 0 };
    const predicted = {
      x: finite(latest.x) + (finite(velocity.x) * frameDelta),
      y: finite(latest.y) + (finite(velocity.y) * frameDelta),
    };
    const current = { x: finite(point?.x, 0.5), y: finite(point?.y, 0.5) };
    const predictedDistance = Math.hypot(predicted.x - current.x, predicted.y - current.y);
    const lastDistance = Math.hypot(finite(latest.x) - current.x, finite(latest.y) - current.y);
    const appearance = patchDifference(candidate.track.averagePatchSignature, point?.patchSignature);
    const movement = Math.hypot(current.x - finite(latest.x), current.y - finite(latest.y));
    const expectedMovement = Math.hypot(finite(velocity.x), finite(velocity.y)) * frameDelta;
    const motionError = Math.abs(movement - expectedMovement);
    const score = (predictedDistance * 0.62) + (lastDistance * 0.18) + (appearance * 0.15) + (motionError * 0.05);
    const distanceLimit = matchedDistance + Math.min(0.08, expectedMovement * 0.5);
    if (predictedDistance > distanceLimit && lastDistance > matchedDistance) return null;
    if (appearance > appearanceThreshold
      && (predictedDistance > (matchedDistance * 0.35) || appearance > 0.72)) return null;
    return { candidate, predictedDistance, lastDistance, appearance, motionError, score };
  };

  points.forEach((point) => {
    let match = null;
    if (point?.trackId) {
      const direct = available.find((candidate) => !candidate.used && candidate.track.id === point.trackId) || null;
      const directAssociation = direct ? associationFor(direct, point) : null;
      match = directAssociation;
    }
    if (!match) {
      match = available.reduce((closest, candidate) => {
        if (candidate.used) return closest;
        const association = associationFor(candidate, point);
        return association && (!closest || association.score < closest.score)
          ? association
          : closest;
      }, null);
    }

    let track;
    if (match) {
      match.candidate.used = true;
      track = nextTracks.find((candidate) => candidate.id === match.candidate.track.id);
    } else {
      track = {
        id: `ft-${nextTrackId}`,
        observations: [],
        firstFrameIndex: frameIndex,
        lastFrameIndex: frameIndex,
        velocityEstimate: { x: 0, y: 0 },
        averagePatchSignature: Array.isArray(point?.patchSignature) ? point.patchSignature.slice(0, 16) : null,
        quality: 0.45,
        confidence: 0.4,
      };
      nextTrackId += 1;
      nextTracks.push(track);
    }
    const latest = latestObservationForTrack(track);
    const frameDelta = latest ? Math.max(1, frameIndex - finite(latest.frameIndex, frameIndex)) : 1;
    const observation = {
      frameIndex,
      keyframeId: context.acceptedKeyframeId ?? null,
      x: finite(point?.x, 0.5),
      y: finite(point?.y, 0.5),
      patchSignature: Array.isArray(point?.patchSignature) ? point.patchSignature.slice(0, 16) : null,
    };
    if (latest && match) {
      const displacement = Math.hypot(observation.x - finite(latest.x), observation.y - finite(latest.y));
      displacementSamples.push(displacement);
      const observedVelocity = {
        x: (observation.x - finite(latest.x)) / frameDelta,
        y: (observation.y - finite(latest.y)) / frameDelta,
      };
      track.velocityEstimate = {
        x: (finite(track.velocityEstimate?.x) * 0.65) + (observedVelocity.x * 0.35),
        y: (finite(track.velocityEstimate?.y) * 0.65) + (observedVelocity.y * 0.35),
      };
      track.quality = clamp((finite(track.quality) * 0.76) + ((1 - finite(match.appearance, 0.5)) * 0.24), 0, 1);
      track.confidence = clamp((finite(track.confidence) * 0.7) + (track.quality * 0.3), 0, 1);
    }
    track.observations = [...track.observations, observation].slice(-8);
    track.firstFrameIndex = Math.min(finite(track.firstFrameIndex, frameIndex), frameIndex);
    track.lastFrameIndex = frameIndex;
    track.lastPoint = { x: observation.x, y: observation.y };
    track.averagePatchSignature = blendPatchSignature(track.averagePatchSignature, observation.patchSignature);
    currentTrackIds.push(track.id);
  });

  const activeTracks = nextTracks.filter((track) => frameIndex - finite(track.lastFrameIndex, frameIndex) <= 3);
  const multiFrameTracks = activeTracks.filter((track) => (track.observations || []).length >= 2);
  return {
    tracks: activeTracks.slice(-1200),
    currentTrackIds,
    trackedFeatureCount: currentTrackIds.length,
    multiFrameFeatureTrackCount: multiFrameTracks.length,
    medianFeatureDisplacement: median(displacementSamples),
    visualParallax: clamp(median(displacementSamples) / 0.14, 0, 1),
  };
}

function dot(first, second) {
  return (finite(first?.x) * finite(second?.x))
    + (finite(first?.y) * finite(second?.y))
    + (finite(first?.z) * finite(second?.z));
}

function cross(first, second) {
  return {
    x: (finite(first?.y) * finite(second?.z)) - (finite(first?.z) * finite(second?.y)),
    y: (finite(first?.z) * finite(second?.x)) - (finite(first?.x) * finite(second?.z)),
    z: (finite(first?.x) * finite(second?.y)) - (finite(first?.y) * finite(second?.x)),
  };
}

function scaleVector(vector, scale) {
  return { x: finite(vector?.x) * scale, y: finite(vector?.y) * scale, z: finite(vector?.z) * scale };
}

function addVectors(first, second) {
  return { x: finite(first?.x) + finite(second?.x), y: finite(first?.y) + finite(second?.y), z: finite(first?.z) + finite(second?.z) };
}

function cameraRayForObservation(observation, keyframe) {
  const origin = keyframe?.pose || keyframe?.estimatedPose;
  if (!origin) return null;
  return {
    origin: { x: finite(origin.x), y: finite(origin.y), z: finite(origin.z) },
    direction: directionForImagePoint(observation, keyframe.orientation, origin),
  };
}

function triangulateRays(first, second) {
  if (!first || !second) return null;
  const baseline = poseDistance(first.origin, second.origin);
  if (baseline < sparseMapConfig.minimumBaselineMeters) return null;
  const w0 = {
    x: first.origin.x - second.origin.x,
    y: first.origin.y - second.origin.y,
    z: first.origin.z - second.origin.z,
  };
  const a = dot(first.direction, first.direction);
  const b = dot(first.direction, second.direction);
  const c = dot(second.direction, second.direction);
  const d = dot(first.direction, w0);
  const e = dot(second.direction, w0);
  const denominator = (a * c) - (b * b);
  if (Math.abs(denominator) < 0.015) return null;
  const firstDistance = ((b * e) - (c * d)) / denominator;
  const secondDistance = ((a * e) - (b * d)) / denominator;
  if (firstDistance <= 0 || secondDistance <= 0) return null;
  const firstPoint = addVectors(first.origin, scaleVector(first.direction, firstDistance));
  const secondPoint = addVectors(second.origin, scaleVector(second.direction, secondDistance));
  const position = scaleVector(addVectors(firstPoint, secondPoint), 0.5);
  const rayError = poseDistance(firstPoint, secondPoint);
  const reprojectionError = Math.atan2(rayError, Math.max(0.05, (firstDistance + secondDistance) / 2)) * (180 / Math.PI);
  return { position, baseline, reprojectionError };
}

export function triangulateSparsePoints(keyframes = [], config = sparseMapConfig) {
  const settings = { ...sparseMapConfig, ...(config || {}) };
  const tracks = new Map();
  (Array.isArray(keyframes) ? keyframes : []).forEach((keyframe) => {
    const observations = Array.isArray(keyframe?.featureObservations) ? keyframe.featureObservations : [];
    observations.forEach((observation) => {
      if (!observation?.trackId || !Number.isFinite(Number(observation.x)) || !Number.isFinite(Number(observation.y))) return;
      if (!tracks.has(observation.trackId)) tracks.set(observation.trackId, []);
      tracks.get(observation.trackId).push({ observation, keyframe });
    });
  });
  const points = [];
  tracks.forEach((observations, trackId) => {
    if (observations.length < settings.minimumTrackObservations) return;
    let bestPair = null;
    for (let firstIndex = 0; firstIndex < observations.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < observations.length; secondIndex += 1) {
        const firstRay = cameraRayForObservation(observations[firstIndex].observation, observations[firstIndex].keyframe);
        const secondRay = cameraRayForObservation(observations[secondIndex].observation, observations[secondIndex].keyframe);
        const candidate = triangulateRays(firstRay, secondRay);
        if (candidate && (!bestPair || candidate.baseline > bestPair.baseline)) bestPair = candidate;
      }
    }
    if (!bestPair || bestPair.reprojectionError > settings.maximumReprojectionErrorDegrees) return;
    const trackConfidence = clamp(
      (clamp((observations.length - 1) / 4, 0, 1) * 0.4)
        + (clamp(bestPair.baseline / 0.6, 0, 1) * 0.35)
        + (clamp(1 - (bestPair.reprojectionError / settings.maximumReprojectionErrorDegrees), 0, 1) * 0.25),
      0,
      1,
    );
    points.push({
      id: `sparse-${trackId}`,
      sourceTrackIds: [trackId],
      estimatedPosition: bestPair.position,
      confidence: trackConfidence,
      observationCount: observations.length,
      baseline: bestPair.baseline,
      reprojectionError: bestPair.reprojectionError,
    });
  });
  return points
    .sort((first, second) => second.confidence - first.confidence || second.observationCount - first.observationCount)
    .slice(0, settings.maxPoints);
}

function planeFromPoints(first, second, third) {
  const firstEdge = {
    x: finite(second.x) - finite(first.x),
    y: finite(second.y) - finite(first.y),
    z: finite(second.z) - finite(first.z),
  };
  const secondEdge = {
    x: finite(third.x) - finite(first.x),
    y: finite(third.y) - finite(first.y),
    z: finite(third.z) - finite(first.z),
  };
  const rawNormal = cross(firstEdge, secondEdge);
  if (vectorLength(rawNormal) < 0.01) return null;
  const normal = normalize(rawNormal);
  return { normal, distance: dot(normal, first) };
}

export function estimateSupportedPlanes(sparsePoints = [], config = sparseMapConfig) {
  const settings = { ...sparseMapConfig, ...(config || {}) };
  const points = (Array.isArray(sparsePoints) ? sparsePoints : [])
    .filter((point) => point?.estimatedPosition && Number(point.confidence) >= 0.4)
    .slice(0, 500);
  if (points.length < settings.minimumPlaneInliers) return [];
  const planes = [];
  const candidateCount = Math.min(120, points.length * 2);
  for (let index = 0; index < candidateCount; index += 1) {
    const first = points[index % points.length];
    const second = points[(index + 3) % points.length];
    const third = points[(index + 7) % points.length];
    const candidate = planeFromPoints(first.estimatedPosition, second.estimatedPosition, third.estimatedPosition);
    if (!candidate) continue;
    const inliers = points.filter((point) => Math.abs(dot(candidate.normal, point.estimatedPosition) - candidate.distance) <= settings.planeToleranceMeters);
    if (inliers.length < settings.minimumPlaneInliers) continue;
    const meanConfidence = inliers.reduce((sum, point) => sum + (Number(point.confidence) || 0), 0) / inliers.length;
    const confidence = clamp(
      (clamp(inliers.length / 24, 0, 1) * 0.5)
        + (meanConfidence * 0.35)
        + (clamp(1 - (settings.planeToleranceMeters / 0.16), 0, 1) * 0.15),
      0,
      1,
    );
    if (confidence < settings.minimumPlaneConfidence) continue;
    const duplicate = planes.some((plane) => Math.abs(dot(plane.normal, candidate.normal)) > 0.94
      && Math.abs(Math.abs(plane.distance) - Math.abs(candidate.distance)) < (settings.planeToleranceMeters * 1.5));
    if (duplicate) continue;
    planes.push({
      id: `plane-${planes.length + 1}`,
      normal: candidate.normal,
      distance: candidate.distance,
      inlierCount: inliers.length,
      confidence,
      sourcePointIds: inliers.map((point) => point.id),
      orientation: Math.abs(candidate.normal.y) >= 0.75 ? 'HORIZONTAL' : 'VERTICAL',
    });
  }
  return planes.sort((first, second) => second.confidence - first.confidence).slice(0, 8);
}

export function intersectSupportedPlanes(first, second) {
  if (!first || !second) return null;
  const direction = cross(first.normal, second.normal);
  const directionLength = vectorLength(direction);
  if (directionLength < 0.08) return null;
  const normalizedDirection = scaleVector(direction, 1 / directionLength);
  const firstCross = cross(second.normal, normalizedDirection);
  const secondCross = cross(normalizedDirection, first.normal);
  const denominator = directionLength ** 2;
  const point = scaleVector(addVectors(scaleVector(firstCross, first.distance), scaleVector(secondCross, second.distance)), 1 / denominator);
  return {
    point,
    direction: normalizedDirection,
    confidence: Math.min(Number(first.confidence) || 0, Number(second.confidence) || 0),
    sourcePlaneIds: [first.id, second.id],
    sourcePointIds: [...new Set([...(first.sourcePointIds || []), ...(second.sourcePointIds || [])])],
  };
}

export function structuralEdgesFromPlanes(planes = [], config = {}) {
  const minimumConfidence = Number(config.minimumConfidence) || 0.7;
  const strongPlanes = (Array.isArray(planes) ? planes : []).filter((plane) => (Number(plane.confidence) || 0) >= minimumConfidence);
  const edges = [];
  for (let firstIndex = 0; firstIndex < strongPlanes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < strongPlanes.length; secondIndex += 1) {
      const intersection = intersectSupportedPlanes(strongPlanes[firstIndex], strongPlanes[secondIndex]);
      if (!intersection) continue;
      edges.push({
        id: `plane-edge-${edges.length + 1}`,
        ...intersection,
      });
    }
  }
  return edges.slice(0, 24);
}

export function distinctViewpointsFromFrames(keyframes = [], config = directionalCoverageConfig) {
  const frames = Array.isArray(keyframes) ? keyframes : [];
  return frames.reduce((viewpoints, frame) => {
    const view = viewRecordFrom({
      keyframeId: frame.keyframeId ?? frame.id,
      pose: frame.pose || frame.estimatedPose,
      orientation: frame.orientation,
      featureTrackIds: frame.featureTrackIds,
      visualParallax: frame.visualParallax,
    });
    const novelty = viewpointNovelty(viewpoints, view, config);
    return novelty.isNovel ? [...viewpoints, {
      ...view,
      translationDelta: novelty.translationDelta,
      angleDelta: novelty.angleDelta,
      parallax: novelty.parallax,
      visualParallax: novelty.visualParallax,
      physicalMovement: novelty.physicalMovement,
    }] : viewpoints;
  }, []);
}

export function calculateViewpointDiversity(keyframes = []) {
  const frames = distinctViewpointsFromFrames(keyframes);
  if (frames.length < 2) return 0;
  const positionBins = new Set();
  const headingBins = new Set();
  frames.forEach((frame) => {
    const pose = frame.pose || frame.estimatedPose;
    const heading = Number.isFinite(Number(frame.heading)) ? Number(frame.heading) : headingFor(frame.orientation, pose);
    if (pose) positionBins.add(`${Math.round(finite(pose.x) / 0.18)},${Math.round(finite(pose.z) / 0.18)}`);
    if (heading !== null) headingBins.add(Math.round(heading / 20));
  });
  const positionCoverage = clamp(positionBins.size / 5, 0, 1);
  const headingCoverage = clamp(headingBins.size / 9, 0, 1);
  return clamp((positionCoverage * 0.65) + (headingCoverage * 0.35), 0, 1);
}

export function calculateOrientationCoverage(keyframes = []) {
  const frames = Array.isArray(keyframes) ? keyframes : [];
  const headings = new Set();
  const pitches = new Set();
  frames.forEach((frame) => {
    const heading = headingFor(frame.orientation, frame.pose);
    if (heading !== null) headings.add(Math.round(heading / 30));
    if (frame.orientation && Number.isFinite(Number(frame.orientation.pitch))) pitches.add(Math.round(Number(frame.orientation.pitch) / 0.2));
  });
  return clamp((clamp(headings.size / 8, 0, 1) * 0.75) + (clamp(pitches.size / 3, 0, 1) * 0.25), 0, 1);
}

export function calculateInitialMappingReadiness(state) {
  const mapping = state?.mapping || state || {};
  const acceptedKeyframes = finite(mapping.acceptedKeyframes ?? state?.acceptedFrames);
  const trackedFeatures = finite(mapping.trackedFeatureCount ?? state?.trackedFeatureCount);
  const multiFrameFeatureTracks = finite(mapping.multiFrameFeatureTrackCount ?? state?.multiFrameFeatureTrackCount);
  const orientationCoverage = finite(mapping.orientationCoverage);
  const viewpointDiversity = finite(mapping.viewpointDiversity ?? state?.viewpointDiversity);
  const successfulRelativePoses = finite(mapping.successfulRelativePoseCount ?? state?.successfulRelativePoseCount);
  const checks = [
    ['accepted keyframes', acceptedKeyframes >= mappingReadinessConfig.minimumAcceptedKeyframes],
    ['tracked features', trackedFeatures >= mappingReadinessConfig.minimumTrackedFeatures],
    ['multi-frame feature tracks', multiFrameFeatureTracks >= mappingReadinessConfig.minimumMultiFrameFeatureTracks],
    ['orientation coverage', orientationCoverage >= mappingReadinessConfig.minimumOrientationCoverage],
    ['viewpoint diversity', viewpointDiversity >= mappingReadinessConfig.minimumViewpointDiversity],
    ['successful relative poses', successfulRelativePoses >= mappingReadinessConfig.minimumSuccessfulRelativePoses],
  ];
  const missing = checks.filter(([, pass]) => !pass).map(([label]) => label);
  return {
    ready: missing.length === 0,
    reason: missing.length ? `Waiting for ${missing.join(', ')}.` : 'Enough keyframes, tracks, orientation, viewpoints, and relative poses.',
    acceptedKeyframes,
    trackedFeatures,
    multiFrameFeatureTracks,
    orientationCoverage,
    viewpointDiversity,
    successfulRelativePoses,
  };
}

function structuralImportanceFor(analysis, points, screenBounds) {
  const explicit = Array.isArray(analysis?.structuralFeatures)
    ? analysis.structuralFeatures.filter((feature) => points.some((point) => Math.hypot(finite(point.x) - finite(feature.x), finite(point.y) - finite(feature.y)) < 0.05)).length
    : 0;
  const edgeBand = points.filter((point) => finite(point.x) < 0.12 || finite(point.x) > 0.88 || finite(point.y) < 0.16 || finite(point.y) > 0.84).length;
  const grid = analysis?.sceneUnderstanding?.grid;
  const centerX = finite(screenBounds?.x, 0.5) + (finite(screenBounds?.width, 0.1) / 2);
  const centerY = finite(screenBounds?.y, 0.5) + (finite(screenBounds?.height, 0.1) / 2);
  const gridDetail = Array.isArray(grid)
    ? finite(grid[Math.min(2, Math.floor(centerY * 3))]?.[Math.min(2, Math.floor(centerX * 3))]?.detail)
    : 0;
  // Screen borders and high-detail junction hints are useful structural
  // proxies in the browser detector; neither is a semantic room label.
  return clamp(0.5 + (Math.min(1, (explicit * 0.25) + (edgeBand / Math.max(1, points.length)) + (gridDetail * 0.5))), 0.35, 1);
}

function structuralTypeFor(analysis, points) {
  const explicit = Array.isArray(analysis?.structuralFeatures)
    ? analysis.structuralFeatures.find((feature) => points.some((point) => Math.hypot(finite(point.x) - finite(feature.x), finite(point.y) - finite(feature.y)) < 0.05))
    : null;
  if (explicit?.type) return explicit.type;
  const averageY = points.reduce((sum, point) => sum + finite(point.y, 0.5), 0) / Math.max(1, points.length);
  const spreadX = Math.max(...points.map((point) => finite(point.x, 0.5))) - Math.min(...points.map((point) => finite(point.x, 0.5)));
  if (averageY < 0.18) return 'WALL_CEILING_JUNCTION';
  if (averageY > 0.82) return 'WALL_FLOOR_JUNCTION';
  if (spreadX > 0.18) return 'FURNITURE_OR_FRAME_EDGE';
  return 'OBSERVED_REGION';
}

function observationGroups(analysis) {
  const points = Array.isArray(analysis?.featurePointsDisplay) && analysis.featurePointsDisplay.length
    ? analysis.featurePointsDisplay
    : Array.isArray(analysis?.featurePoints) ? analysis.featurePoints : [];
  const trackIds = Array.isArray(analysis?.featureTrackIds) ? analysis.featureTrackIds : [];
  const groups = new Map();
  points.forEach((point, index) => {
    const key = `${Math.min(2, Math.max(0, Math.floor(finite(point?.x, 0.5) * 3)))}-${Math.min(2, Math.max(0, Math.floor(finite(point?.y, 0.5) * 3)))}`;
    if (!groups.has(key)) groups.set(key, { points: [], trackIds: [] });
    groups.get(key).points.push(point);
    if (trackIds[index]) groups.get(key).trackIds.push(trackIds[index]);
  });
  return [...groups.values()].filter((group) => group.points.length >= observedTargetConfig.minimumUsefulFeatures || trackIds.length === 0);
}

function observationFromGroup(group, analysis, orientation, pose, keyframeId, depth = 1.6) {
  const direction = normalize(group.points.reduce((sum, point) => {
    const next = directionForImagePoint(point, orientation, pose);
    return { x: sum.x + next.x, y: sum.y + next.y, z: sum.z + next.z };
  }, { x: 0, y: 0, z: 0 }));
  const center = {
    x: finite(pose?.x) + (direction.x * depth),
    y: finite(pose?.y) + (direction.y * depth),
    z: finite(pose?.z) + (direction.z * depth),
  };
  const screenBounds = {
    x: Math.min(...group.points.map((point) => finite(point.x, 0.5))),
    y: Math.min(...group.points.map((point) => finite(point.y, 0.5))),
    width: Math.max(0.08, Math.max(...group.points.map((point) => finite(point.x, 0.5))) - Math.min(...group.points.map((point) => finite(point.x, 0.5)))),
    height: Math.max(0.08, Math.max(...group.points.map((point) => finite(point.y, 0.5))) - Math.min(...group.points.map((point) => finite(point.y, 0.5)))),
  };
  return {
    source: 'OBSERVED',
    featureTrackIds: mergeUnique([], group.trackIds),
    observedFromKeyframes: [keyframeId],
    estimatedDirection: direction,
    estimatedWorldCenter: center,
    structuralImportance: structuralImportanceFor(analysis, group.points, screenBounds),
    structuralType: structuralTypeFor(analysis, group.points),
    featureDensity: clamp(group.points.length / 40, 0, 1),
    screenBounds,
    viewpointCount: 1,
    distinctViewCount: 1,
    observationCount: 1,
    physicalViewCount: 0,
    viewpointDiversity: 0.2,
    parallaxScore: 0,
    coverageConfidence: clamp((group.points.length / 40) * 0.65, 0, 1),
    lastPose: pose ? { x: finite(pose.x), y: finite(pose.y), z: finite(pose.z) } : null,
    lastOrientation: orientation || null,
    viewpoints: [viewRecordFrom({ keyframeId, pose, orientation, featureTrackIds: group.trackIds })],
  };
}

export function createSpatialObservationsFromFrame({ analysis, orientation, pose, keyframeId }) {
  return observationGroups(analysis).map((group) => observationFromGroup(group, analysis, orientation, pose, keyframeId));
}

function mergeObservation(observations, incoming) {
  const matchIndex = observations.findIndex((existing) => {
    const sharedTrack = incoming.featureTrackIds.some((id) => existing.featureTrackIds.includes(id));
    const sameDirection = directionAngle(existing.estimatedDirection, incoming.estimatedDirection) <= observedTargetConfig.targetMergeAngleDegrees;
    const samePosition = poseDistance(existing.estimatedWorldCenter, incoming.estimatedWorldCenter) <= observedTargetConfig.targetMergeDistanceMeters;
    return sharedTrack || (sameDirection && samePosition);
  });
  if (matchIndex < 0) return [...observations, { ...incoming, id: `obs-${observations.length + 1}` }];
  const existing = observations[matchIndex];
  const existingViewpoints = Array.isArray(existing.viewpoints) && existing.viewpoints.length > 0
    ? existing.viewpoints
    : [viewRecordFrom({
      keyframeId: existing.observedFromKeyframes?.[0],
      pose: existing.lastPose,
      orientation: existing.lastOrientation,
      featureTrackIds: existing.featureTrackIds,
    })];
  const incomingView = viewRecordFrom({
    keyframeId: incoming.observedFromKeyframes?.[incoming.observedFromKeyframes.length - 1],
    pose: incoming.lastPose,
    orientation: incoming.lastOrientation,
    featureTrackIds: incoming.featureTrackIds,
    visualParallax: incoming.visualParallax,
  });
  const novelty = viewpointNovelty(existingViewpoints, incomingView);
  const nextViewCount = (Number(existing.distinctViewCount ?? existing.viewpointCount) || 0) + (novelty.isNovel ? 1 : 0);
  const nextObservationCount = (Number(existing.observationCount ?? existing.observations) || 0) + (Number(incoming.observationCount) || 1);
  const nextViewpoints = novelty.isNovel
    ? [...existingViewpoints, { ...incomingView, translationDelta: novelty.translationDelta, angleDelta: novelty.angleDelta, parallax: novelty.parallax }].slice(-directionalCoverageConfig.maxViewpointsPerCell)
    : existingViewpoints;
  const nextDirection = normalize({
    x: existing.estimatedDirection.x + incoming.estimatedDirection.x,
    y: existing.estimatedDirection.y + incoming.estimatedDirection.y,
    z: existing.estimatedDirection.z + incoming.estimatedDirection.z,
  });
  const displacement = poseDistance(existing.lastPose, incoming.lastPose);
  const next = {
    ...existing,
    featureTrackIds: mergeUnique(existing.featureTrackIds, incoming.featureTrackIds),
    observedFromKeyframes: mergeUnique(existing.observedFromKeyframes, incoming.observedFromKeyframes),
    estimatedDirection: nextDirection,
    estimatedWorldCenter: {
      x: (existing.estimatedWorldCenter.x + incoming.estimatedWorldCenter.x) / 2,
      y: (existing.estimatedWorldCenter.y + incoming.estimatedWorldCenter.y) / 2,
      z: (existing.estimatedWorldCenter.z + incoming.estimatedWorldCenter.z) / 2,
    },
    structuralImportance: Math.max(existing.structuralImportance, incoming.structuralImportance),
    structuralType: existing.structuralType === 'OBSERVED_REGION' ? incoming.structuralType : existing.structuralType,
    featureDensity: ((existing.featureDensity * Math.max(1, Number(existing.observationCount) || 1)) + incoming.featureDensity) / Math.max(1, nextObservationCount),
    viewpointCount: nextViewCount,
    distinctViewCount: nextViewCount,
    observationCount: nextObservationCount,
    physicalViewCount: (Number(existing.physicalViewCount) || 0) + (novelty.physicalMovement ? 1 : 0),
    parallaxScore: Math.max(existing.parallaxScore, clamp(displacement / 0.45, 0, 1), novelty.parallax),
    viewpointDiversity: calculateViewpointDiversity(nextViewpoints),
    coverageConfidence: clamp(Math.max(Number(existing.coverageConfidence) || 0, Number(incoming.coverageConfidence) || 0), 0, 1),
    lastPose: incoming.lastPose,
    lastOrientation: incoming.lastOrientation,
    viewpoints: nextViewpoints,
  };
  next.observations = nextObservationCount;
  next.coverage = clamp((nextViewCount / 3) * 0.42 + (next.parallaxScore * 0.33) + (next.featureDensity * 0.25), 0, 1);
  return observations.map((observation, index) => index === matchIndex ? next : observation);
}

export function addSpatialObservations(existingObservations = [], incomingObservations = []) {
  return incomingObservations.reduce((observations, incoming) => mergeObservation(observations, incoming), Array.isArray(existingObservations) ? existingObservations : []);
}

function targetStatus(target) {
  if (target.source === 'INFERRED') return 'INFERABLE';
  if ((target.distinctViewCount ?? target.viewpointCount) >= observedTargetConfig.sufficientViewpoints
    && target.parallaxScore >= observedTargetConfig.sufficientParallax) return 'SUFFICIENT';
  if (target.attempts >= observedTargetConfig.lowTextureAttempts && target.featureDensity < observedTargetConfig.lowTextureFeatureDensity) return 'LOW_TEXTURE';
  return target.viewpointCount > 0 ? 'PARTIAL' : 'UNSEEN';
}

function targetPriority(target) {
  const missingCoverage = clamp(1 - finite(target.coverage), 0, 1);
  const expectedParallax = clamp(1 - finite(target.parallaxScore), 0, 1);
  return missingCoverage * finite(target.structuralImportance, 0.5) * finite(target.featureDensity) * expectedParallax;
}

function rotateNormalizedPoint(point, rotation) {
  if (rotation === 90) return { x: 1 - point.y, y: point.x };
  if (rotation === 180) return { x: 1 - point.x, y: 1 - point.y };
  if (rotation === 270) return { x: point.y, y: 1 - point.x };
  return point;
}

function normalizedToDisplay(point, transform) {
  if (!transform) return point;
  let oriented = rotateNormalizedPoint(point, Number(transform.rotation) || 0);
  if (transform.mirrored) oriented = { x: 1 - oriented.x, y: oriented.y };
  return {
    x: ((oriented.x * finite(transform.renderedWidth, transform.displayWidth) - finite(transform.cropX)) / Math.max(1, finite(transform.displayWidth, 1))),
    y: ((oriented.y * finite(transform.renderedHeight, transform.displayHeight) - finite(transform.cropY)) / Math.max(1, finite(transform.displayHeight, 1))),
  };
}

function displayBoundsForNormalizedBounds(bounds, transform) {
  if (!transform) return bounds;
  const corners = [
    normalizedToDisplay({ x: bounds.x, y: bounds.y }, transform),
    normalizedToDisplay({ x: bounds.x + bounds.width, y: bounds.y }, transform),
    normalizedToDisplay({ x: bounds.x, y: bounds.y + bounds.height }, transform),
    normalizedToDisplay({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, transform),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function clipDisplayBounds(bounds) {
  if (!bounds) return null;
  const left = Math.max(0, finite(bounds.x));
  const top = Math.max(0, finite(bounds.y));
  const right = Math.min(1, finite(bounds.x) + finite(bounds.width));
  const bottom = Math.min(1, finite(bounds.y) + finite(bounds.height));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function boundsOverlap(bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return 0;
  const width = Math.max(0, Math.min(1, bounds.x + bounds.width) - Math.max(0, bounds.x));
  const height = Math.max(0, Math.min(1, bounds.y + bounds.height) - Math.max(0, bounds.y));
  return clamp((width * height) / (bounds.width * bounds.height), 0, 1);
}

function targetFromObservation(observation, index) {
  const angle = targetYawPitch(observation.estimatedDirection);
  const observationBounds = observation.screenBounds || { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  const target = {
    id: `observed-${observation.id || index + 1}`,
    source: 'OBSERVED',
    definitionSource: 'OBSERVED_SPATIAL',
    structuralImportance: observation.structuralImportance,
    semanticType: observation.structuralType || (observation.structuralImportance >= 0.78 ? 'STRUCTURAL_EDGE' : 'OBSERVED_REGION'),
    featureTrackIds: observation.featureTrackIds,
    observedFromKeyframes: observation.observedFromKeyframes,
    estimatedDirection: observation.estimatedDirection,
    estimatedWorldCenter: observation.estimatedWorldCenter,
    estimatedNormal: observation.estimatedDirection,
    viewpointCount: observation.distinctViewCount ?? observation.viewpointCount,
    distinctViewCount: observation.distinctViewCount ?? observation.viewpointCount,
    viewpointDiversity: observation.viewpointDiversity,
    parallaxScore: observation.parallaxScore,
    featureDensity: observation.featureDensity,
    coverageConfidence: observation.coverageConfidence,
    coverage: clamp((observation.viewpointCount / 3) * 0.42 + (observation.parallaxScore * 0.33) + (observation.featureDensity * 0.25), 0, 1),
    yaw: angle.yaw,
    pitch: angle.pitch,
    screenBounds: observationBounds,
    screenPosition: { x: observationBounds.x + (observationBounds.width / 2), y: observationBounds.y + (observationBounds.height / 2) },
    currentlyVisible: false,
    observations: observation.observationCount ?? observation.viewpointCount,
    observationCount: observation.observationCount ?? observation.viewpointCount,
    physicalViewCount: observation.physicalViewCount || 0,
    translationViewCount: observation.physicalViewCount || 0,
    acceptedKeyframeIds: observation.observedFromKeyframes,
    cameraPoses: [],
    usefulViews: 0,
    targetCaptureState: 'LOCATING',
    targetViewCandidates: 0,
    targetViewRejectionReasons: {},
    lastTargetViewPose: null,
    lastObservedAt: 0,
    attempts: 0,
    captureSource: 'OBSERVED',
    status: 'PARTIAL',
    skipped: false,
    observationHistory: [observation],
  };
  return { ...target, priority: targetPriority(target), label: targetDescription(target) };
}

export function targetDescription(target) {
  const direction = target?.estimatedDirection || { x: 0, y: 0, z: -1 };
  const horizontal = Math.abs(finite(direction.x)) < 0.18 ? 'ahead' : finite(direction.x) < 0 ? 'left' : 'right';
  const vertical = Math.abs(finite(direction.y)) < 0.18 ? '' : finite(direction.y) > 0 ? 'above' : 'below';
  const structuralLabels = {
    WALL_CORNER: 'corner',
    WALL_CEILING_JUNCTION: 'wall-ceiling junction',
    WALL_FLOOR_JUNCTION: 'wall-floor junction',
    DOOR_FRAME: 'door frame',
    WINDOW_FRAME: 'window frame',
    FURNITURE_OR_FRAME_EDGE: 'furniture edge',
    STRUCTURAL_EDGE: 'structural edge',
  };
  const structural = structuralLabels[target?.semanticType] || 'observed area';
  return vertical ? `${structural} ${vertical} ${horizontal}` : `${structural} ${horizontal}`;
}

export function generateObservedTargets(observations = [], previousTargets = []) {
  const previous = Array.isArray(previousTargets) ? previousTargets : [];
  const targets = (Array.isArray(observations) ? observations : [])
    .filter((observation) => observation && observation.source !== 'INFERRED')
    .map((observation, index) => {
      const old = previous.find((target) => target.id === `observed-${observation.id || index + 1}`);
      const next = targetFromObservation(observation, index);
      return old ? {
        ...next,
        ...(old.source === 'INFERRED' ? { source: 'INFERRED', captureSource: 'INFERRED', status: 'INFERABLE' } : {}),
        usefulViews: old.usefulViews || 0,
        targetCaptureState: old.targetCaptureState || 'LOCATING',
        targetViewCandidates: old.targetViewCandidates || 0,
        targetViewRejectionReasons: old.targetViewRejectionReasons || {},
        lastTargetViewPose: old.lastTargetViewPose || null,
        attempts: old.attempts || 0,
        skipped: Boolean(old.skipped),
        status: old.status === 'INFERABLE' ? 'INFERABLE' : next.status,
      } : next;
    });
  return targets
    .map((target) => ({ ...target, priority: targetPriority(target) }))
    .sort((first, second) => second.priority - first.priority || second.structuralImportance - first.structuralImportance)
    .slice(0, observedTargetConfig.maximumTargets);
}

function displayBoundsForTarget(target, orientation, pose, displayTransform) {
  const direction = normalize(target.estimatedDirection);
  const current = forwardFor(orientation, pose);
  const right = rightFor(orientation, pose);
  const horizontal = signedAngleDistance(
    ((Math.atan2(current.x, -current.z) * 180) / Math.PI + 360) % 360,
    ((Math.atan2(direction.x, -direction.z) * 180) / Math.PI + 360) % 360,
  );
  const pitch = Math.asin(clamp(direction.y, -1, 1)) / (Math.PI / 2);
  const pitchDelta = pitch - pitchFor(orientation);
  const x = 0.5 + (horizontal / HORIZONTAL_FOV_DEGREES);
  const y = 0.5 - (pitchDelta / (VERTICAL_FOV_DEGREES / 90));
  const width = clamp(0.12 + (finite(target.featureDensity) * 0.12), 0.1, 0.3);
  const height = clamp(0.12 + (finite(target.featureDensity) * 0.12), 0.1, 0.3);
  const bounds = { x: x - (width / 2), y: y - (height / 2), width, height };
  const visible = Math.abs(horizontal) <= (HORIZONTAL_FOV_DEGREES / 2) + 8
    && Math.abs(pitchDelta) <= ((VERTICAL_FOV_DEGREES / 90) / 2) + 0.12;
  const screenBounds = displayBoundsForNormalizedBounds(bounds, displayTransform);
  const screenOverlap = visible ? boundsOverlap(screenBounds) : 0;
  return {
    screenBounds,
    screenPosition: normalizedToDisplay({ x, y }, displayTransform),
    currentlyVisible: visible && screenOverlap > 0,
    screenOverlap,
    visibilityScore: visible ? clamp(1 - ((Math.abs(horizontal) / 45) * 0.55) - (Math.abs(pitchDelta) * 0.45), 0, 1) : 0,
    visibilityReason: visible ? null : 'OUTSIDE_FRUSTUM',
    // Referencing right here keeps the projection explicitly tied to the
    // current pose/orientation and avoids accidental semantic sectors.
    targetRightDot: (direction.x * right.x) + (direction.z * right.z),
  };
}

export function projectObservedTargets(targets = [], orientation, pose, displayTransform = null) {
  return (Array.isArray(targets) ? targets : []).map((target) => ({
    ...target,
    ...displayBoundsForTarget(target, orientation, pose, displayTransform),
  }));
}

/**
 * Projects measured spatial regions into the current camera display. This is
 * the only source for the blue scan overlay; it never stores screen pixels.
 */
export function projectCoverageOverlayRegions(regions = [], orientation, pose, displayTransform = null, config = coverageOverlayConfig) {
  const settings = { ...coverageOverlayConfig, ...(config || {}) };
  return projectObservedTargets(regions, orientation, pose, displayTransform)
    .filter((region) => region.currentlyVisible && region.screenBounds)
    .map((region) => ({
      ...region,
      screenBounds: clipDisplayBounds(region.screenBounds),
      blueOpacity: blueCoverageOpacity(region, settings),
    }))
    .filter((region) => region.screenBounds?.width > 0 && region.screenBounds?.height > 0
      && (settings.includeClear || region.blueOpacity > 0))
    .sort((first, second) => ((second.screenBounds.width * second.screenBounds.height) - (first.screenBounds.width * first.screenBounds.height))
      || second.blueOpacity - first.blueOpacity)
    .slice(0, settings.maxVisibleRegions);
}

function displayBoundsForDirectionalCell(cell, orientation, pose, displayTransform, config) {
  const currentHeading = headingFor(orientation, pose) ?? 0;
  const horizontal = signedAngleDistance(currentHeading, cell.yaw);
  const pitchDelta = finite(cell.pitch) - pitchFor(orientation);
  const width = clamp(finite(cell.yawWidth, config.yawBinDegrees) / HORIZONTAL_FOV_DEGREES, 0.16, 0.42);
  const height = clamp(finite(cell.pitchHeight, 0.32) / (VERTICAL_FOV_DEGREES / 90), 0.18, 0.7);
  const bounds = {
    x: 0.5 + (horizontal / HORIZONTAL_FOV_DEGREES) - (width / 2),
    y: 0.5 - (pitchDelta / (VERTICAL_FOV_DEGREES / 90)) - (height / 2),
    width,
    height,
  };
  const visible = Math.abs(horizontal) <= ((HORIZONTAL_FOV_DEGREES / 2) + (finite(cell.yawWidth, config.yawBinDegrees) / 2))
    && Math.abs(pitchDelta) <= (((VERTICAL_FOV_DEGREES / 90) / 2) + (finite(cell.pitchHeight, 0.32) / 2));
  return {
    screenBounds: displayBoundsForNormalizedBounds(bounds, displayTransform),
    screenPosition: normalizedToDisplay({ x: bounds.x + (bounds.width / 2), y: bounds.y + (bounds.height / 2) }, displayTransform),
    currentlyVisible: visible,
    screenOverlap: visible ? boundsOverlap(bounds) : 0,
    visibilityReason: visible ? null : 'OUTSIDE_FRUSTUM',
  };
}

export function projectDirectionalCoverageCells(cells = [], orientation, pose, displayTransform = null, config = directionalCoverageConfig) {
  const settings = { ...directionalCoverageConfig, ...coverageOverlayConfig, ...(config || {}) };
  return (Array.isArray(cells) ? cells : [])
    .map((cell) => {
      const projection = displayBoundsForDirectionalCell(cell, orientation, pose, displayTransform, settings);
      const screenBounds = clipDisplayBounds(projection.screenBounds);
      return {
        ...cell,
        ...projection,
        screenBounds,
        blueOpacity: blueCoverageOpacity(cell, settings),
      };
    })
    .filter((cell) => cell.currentlyVisible && cell.screenBounds?.width > 0 && cell.screenBounds?.height > 0)
    // Keep the most incomplete visible sectors first so guidance placement and
    // debug inspection both follow the strongest real coverage gap.
    .sort((first, second) => second.blueOpacity - first.blueOpacity
      || ((second.screenBounds.width * second.screenBounds.height) - (first.screenBounds.width * first.screenBounds.height))
      || first.id.localeCompare(second.id))
    .slice(0, settings.maxVisibleCells);
}

function featureDensityForBounds(analysis, bounds) {
  const points = Array.isArray(analysis?.featurePointsDisplay) ? analysis.featurePointsDisplay : [];
  if (!bounds || points.length === 0) return clamp((Number(analysis?.featureCount) || 0) / 850, 0, 1);
  const inside = points.filter((point) => point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height).length;
  return clamp(inside / 24, 0, 1);
}

function directionalCellStatus(cell, config) {
  const distinctViews = Number(cell.distinctViewCount ?? cell.viewpointCount) || 0;
  const physicalViews = Number(cell.physicalViewCount ?? cell.translationViewCount) || 0;
  if (distinctViews >= 2
    && physicalViews >= 1
    && Number(cell.coverage) >= config.clearCoverage) return 'SUFFICIENT';
  return distinctViews > 0 ? 'PARTIAL' : 'UNSEEN';
}

function directionalCoverageScore(cell, confidence) {
  const distinctViews = Number(cell.distinctViewCount ?? cell.viewpointCount) || 0;
  const physicalViews = Number(cell.physicalViewCount ?? cell.translationViewCount) || 0;
  const viewScore = clamp(distinctViews / 3, 0, 1) * 0.45;
  const physicalScore = clamp(physicalViews / 2, 0, 1) * 0.25;
  const parallaxScore = clamp(Number(cell.parallaxScore) || 0, 0, 1) * 0.15;
  const confidenceScore = clamp(confidence, 0, 1) * 0.15;
  return clamp(viewScore + physicalScore + parallaxScore + confidenceScore, 0, 1);
}

export function updateDirectionalCoverageGrid(previousCells = [], {
  referenceHeading = 0,
  orientation,
  pose,
  analysis,
  keyframeId,
  accepted = false,
  observedAt = Date.now(),
  featureTrackIds = [],
  config = directionalCoverageConfig,
} = {}) {
  const settings = { ...directionalCoverageConfig, ...(config || {}) };
  const cells = Array.isArray(previousCells) && previousCells.length > 0
    ? previousCells
    : createDirectionalCoverageGrid(referenceHeading, settings);
  const projected = projectDirectionalCoverageCells(cells, orientation, pose, analysis?.displayTransform, settings);
  if (!accepted || !analysis) return {
    cells,
    visibleCellIds: projected.filter((cell) => cell.currentlyVisible).map((cell) => cell.id),
    acceptedDistinctViewCount: 0,
    novelty: [],
  };

  const visibleIds = new Set(projected.filter((cell) => cell.currentlyVisible).map((cell) => cell.id));
  const novelty = [];
  const nextCells = cells.map((cell) => {
    if (!visibleIds.has(cell.id)) return cell;
    const projectedCell = projected.find((candidate) => candidate.id === cell.id);
    const localDensity = featureDensityForBounds(analysis, projectedCell?.screenBounds);
    const confidence = clamp(
      (Number(analysis.qualityScore) || 0) * 0.35
        + (Number(analysis.featureTrackingQuality) || 0) * 0.25
        + localDensity * 0.3
        + (Number(analysis.trackedFeatureCount) || 0) / 850 * 0.1,
      0,
      1,
    );
    const previousViewpoints = Array.isArray(cell.viewpoints) ? cell.viewpoints : [];
    const nextView = viewRecordFrom({
      keyframeId,
      pose,
      orientation,
      featureTrackIds,
      visualParallax: analysis?.visualParallax,
      translationDelta: 0,
      angleDelta: 0,
      parallax: 0,
    });
    const viewNovelty = viewpointNovelty(previousViewpoints, nextView, settings);
    novelty.push({ cellId: cell.id, ...viewNovelty });
    const nextObservationCount = (Number(cell.observationCount) || 0) + 1;
    if (!viewNovelty.isNovel) {
      return {
        ...cell,
        observationCount: nextObservationCount,
        confidence: Math.max(Number(cell.confidence) || 0, confidence),
        coverageConfidence: Math.max(Number(cell.coverageConfidence) || 0, confidence),
        lastSeenAt: observedAt,
      };
    }
    const nextViewRecord = {
      ...nextView,
      translationDelta: viewNovelty.translationDelta,
      angleDelta: viewNovelty.angleDelta,
      parallax: viewNovelty.parallax,
      visualParallax: viewNovelty.visualParallax,
      timestamp: observedAt,
    };
    const viewpoints = [...previousViewpoints, nextViewRecord].slice(-settings.maxViewpointsPerCell);
    const distinctViewCount = (Number(cell.distinctViewCount ?? cell.viewpointCount) || 0) + 1;
    const physicalViewCount = (Number(cell.physicalViewCount ?? cell.translationViewCount) || 0) + (viewNovelty.physicalMovement ? 1 : 0);
    const nextCell = {
      ...cell,
      observationCount: nextObservationCount,
      distinctViewCount,
      viewpointCount: distinctViewCount,
      physicalViewCount,
      translationViewCount: physicalViewCount,
      angularViewCount: (Number(cell.angularViewCount) || 0) + (viewNovelty.physicalMovement ? 0 : 1),
      viewpoints,
      confidence: Math.max(Number(cell.confidence) || 0, confidence),
      coverageConfidence: Math.max(Number(cell.coverageConfidence) || 0, confidence),
      parallaxScore: Math.max(Number(cell.parallaxScore) || 0, viewNovelty.parallax),
      lastSeenAt: observedAt,
    };
    const coverage = directionalCoverageScore(nextCell, confidence);
    const scoredCell = { ...nextCell, coverage };
    return { ...scoredCell, status: directionalCellStatus(scoredCell, settings) };
  });
  return {
    cells: nextCells,
    visibleCellIds: [...visibleIds],
    acceptedDistinctViewCount: nextCells.reduce((sum, cell, index) => sum + (cell.distinctViewCount > (cells[index].distinctViewCount || 0) ? 1 : 0), 0),
    novelty,
  };
}

export function hasObservedNeighborEvidence(targets = [], target) {
  if (!target) return false;
  return targets.some((candidate) => candidate.id !== target.id
    && candidate.source === 'OBSERVED'
    && candidate.status === 'SUFFICIENT'
    && (directionAngle(candidate.estimatedDirection, target.estimatedDirection) < 35
      || poseDistance(candidate.estimatedWorldCenter, target.estimatedWorldCenter) < 1.4));
}

export function deriveTargetStatuses(targets = []) {
  return targets.map((target) => {
    const status = targetStatus(target);
    const inferable = status === 'LOW_TEXTURE' && hasObservedNeighborEvidence(targets, target);
    if (inferable) {
      return { ...target, source: 'INFERRED', captureSource: 'INFERRED', status: 'INFERABLE', priority: 0 };
    }
    return { ...target, status, priority: targetPriority({ ...target, status }) };
  });
}

export function relativePoseEstimate(previousKeyframe, nextFrame, featureTrackCount = 0) {
  if (!previousKeyframe || !nextFrame || finite(featureTrackCount) < 4) return null;
  const translation = poseDistance(previousKeyframe.pose, nextFrame.pose);
  const previousHeading = headingFor(previousKeyframe.orientation, previousKeyframe.pose);
  const nextHeading = headingFor(nextFrame.orientation, nextFrame.pose);
  const rotation = previousHeading === null || nextHeading === null ? 0 : angleDistance(previousHeading, nextHeading);
  if (translation < 0.03 && rotation < 3) return null;
  return {
    fromKeyframeId: previousKeyframe.id,
    toKeyframeId: nextFrame.id,
    translation,
    rotation,
    success: true,
  };
}
