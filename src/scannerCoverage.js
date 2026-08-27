export const SCANNER_PHASES = Object.freeze({
  INITIAL_MAPPING: 'INITIAL_MAPPING',
  ADAPTIVE_COVERAGE: 'ADAPTIVE_COVERAGE',
});

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

const HORIZONTAL_FOV_DEGREES = 70;
const VERTICAL_FOV_DEGREES = 45;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(Number(value) || 0, maximum));
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
  const nextTracks = previous.map((track) => ({ ...track, observations: [...(track.observations || [])] }));
  const matchedDistance = finite(context.matchDistance, 0.14);

  points.forEach((point) => {
    let match = null;
    if (point?.trackId) {
      match = available.find((candidate) => !candidate.used && candidate.track.id === point.trackId) || null;
    }
    if (!match) {
      match = available.reduce((closest, candidate) => {
        if (candidate.used) return closest;
        const latest = latestObservationForTrack(candidate.track);
        if (!latest) return closest;
        const distance = Math.hypot(finite(latest.x) - finite(point?.x), finite(latest.y) - finite(point?.y));
        return distance <= matchedDistance && (!closest || distance < closest.distance)
          ? { ...candidate, distance }
          : closest;
      }, null);
    }

    let track;
    if (match) {
      match.used = true;
      track = nextTracks.find((candidate) => candidate.id === match.track.id);
    } else {
      track = {
        id: `ft-${nextTrackId}`,
        observations: [],
        firstFrameIndex: frameIndex,
        lastFrameIndex: frameIndex,
      };
      nextTrackId += 1;
      nextTracks.push(track);
    }
    const observation = {
      frameIndex,
      keyframeId: context.acceptedKeyframeId ?? null,
      x: finite(point?.x, 0.5),
      y: finite(point?.y, 0.5),
    };
    track.observations = [...track.observations, observation].slice(-8);
    track.firstFrameIndex = Math.min(finite(track.firstFrameIndex, frameIndex), frameIndex);
    track.lastFrameIndex = frameIndex;
    track.lastPoint = { x: observation.x, y: observation.y };
    currentTrackIds.push(track.id);
  });

  const activeTracks = nextTracks.filter((track) => frameIndex - finite(track.lastFrameIndex, frameIndex) <= 3);
  const multiFrameTracks = activeTracks.filter((track) => (track.observations || []).length >= 2);
  return {
    tracks: activeTracks.slice(-1200),
    currentTrackIds,
    trackedFeatureCount: currentTrackIds.length,
    multiFrameFeatureTrackCount: multiFrameTracks.length,
  };
}

export function calculateViewpointDiversity(keyframes = []) {
  const frames = Array.isArray(keyframes) ? keyframes : [];
  if (frames.length < 2) return 0;
  const positionBins = new Set();
  const headingBins = new Set();
  frames.forEach((frame) => {
    const pose = frame.pose || frame.estimatedPose;
    const heading = headingFor(frame.orientation, pose);
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
    viewpointDiversity: 0,
    parallaxScore: 0,
    coverageConfidence: clamp((group.points.length / 40) * 0.65, 0, 1),
    lastPose: pose ? { x: finite(pose.x), y: finite(pose.y), z: finite(pose.z) } : null,
    lastOrientation: orientation || null,
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
  const nextViewCount = existing.viewpointCount + 1;
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
    featureDensity: ((existing.featureDensity * existing.viewpointCount) + incoming.featureDensity) / nextViewCount,
    viewpointCount: nextViewCount,
    parallaxScore: Math.max(existing.parallaxScore, clamp(displacement / 0.45, 0, 1)),
    viewpointDiversity: calculateViewpointDiversity([
      ...(existing.viewpoints || []),
      { pose: existing.lastPose, orientation: existing.lastOrientation },
      { pose: incoming.lastPose, orientation: incoming.lastOrientation },
    ]),
    coverageConfidence: clamp(existing.coverageConfidence + (incoming.coverageConfidence * 0.35) + (displacement * 0.15), 0, 1),
    lastPose: incoming.lastPose,
    lastOrientation: incoming.lastOrientation,
    viewpoints: [...(existing.viewpoints || []), { pose: incoming.lastPose, orientation: incoming.lastOrientation }].slice(-12),
  };
  return observations.map((observation, index) => index === matchIndex ? next : observation);
}

export function addSpatialObservations(existingObservations = [], incomingObservations = []) {
  return incomingObservations.reduce((observations, incoming) => mergeObservation(observations, incoming), Array.isArray(existingObservations) ? existingObservations : []);
}

function targetStatus(target) {
  if (target.source === 'INFERRED') return 'INFERABLE';
  if (target.viewpointCount >= observedTargetConfig.sufficientViewpoints && target.parallaxScore >= observedTargetConfig.sufficientParallax) return 'SUFFICIENT';
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
    viewpointCount: observation.viewpointCount,
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
    observations: observation.viewpointCount,
    observationCount: observation.viewpointCount,
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
