import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import './App.css';
import { createMotionTracker, MOTION_STATES, scannerMotionConfig } from './scannerMotion';

const RECONSTRUCTION_API = process.env.REACT_APP_RECONSTRUCTION_API || '';

function scannerDebugEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.REACT_APP_SCANNER_DEBUG === 'true') return true;
  try {
    return new URLSearchParams(window.location.search).get('scannerDebug') === '1'
      || window.localStorage?.getItem('buildwise:scanner-debug') === 'true';
  } catch (error) {
    return false;
  }
}

const SCANNER_DEBUG = scannerDebugEnabled();

/* Legacy fixed-route guidance is intentionally disabled. Adaptive guidance below uses live scan state.
const GUIDANCE_STEPS = [
  {
    kind: 'origin',
    direction: '^',
    label: 'STARTING VIEW',
    eyebrow: 'Set your starting view',
    title: 'Face the open side of the room',
    instruction: 'Hold your phone chest-high and aim at a clear wall or corner.',
    helper: 'Choose a well-lit view with fixed edges. This is the reference for the room loop.',
    target: 'Reference view',
    coverage: 0,
  },
  {
    kind: 'movement',
    direction: '↑',
    label: 'DEPTH PASS',
    eyebrow: 'Move through the room',
    title: 'Move forward slowly',
    instruction: 'Walk a few steady steps into the open space.',
    helper: 'Keep the phone level and leave the walls, floor, and ceiling edges in view.',
    target: 'Movement cues',
    progressUnit: 'movement cues',
    requiredPulses: 4,
    coverage: 16,
  },
  {
    kind: 'turn',
    direction: '>',
    label: 'NEXT WALL',
    eyebrow: 'Change direction',
    title: 'Turn toward the next wall',
    instruction: 'Keep your feet planted and rotate until the next wall is centered.',
    helper: 'Turn slowly so neighboring views overlap.',
    target: 'Turn',
    progressUnit: 'deg',
    turnDegrees: 75,
    coverage: 28,
  },
  {
    kind: 'surface',
    direction: '>',
    label: 'WALL PASS',
    eyebrow: 'Capture this side',
    title: 'Sweep across the wall',
    instruction: 'Pan from one side to the other at a steady pace.',
    helper: 'Keep part of the previous view visible as you sweep.',
    target: 'Surface cues',
    progressUnit: 'surface cues',
    requiredPulses: 3,
    coverage: 47,
  },
  {
    kind: 'movement',
    direction: '<',
    label: 'ROOM PASS',
    eyebrow: 'Follow the room edge',
    title: 'Move along the open side',
    instruction: 'Take a few slow steps along the room perimeter.',
    helper: 'Aim for the next corner and keep the floor line visible.',
    target: 'Movement cues',
    progressUnit: 'movement cues',
    requiredPulses: 4,
    coverage: 61,
  },
  {
    kind: 'surface',
    direction: '←',
    label: 'OPPOSITE PASS',
    eyebrow: 'Capture the far side',
    title: 'Sweep across the opposite wall',
    instruction: 'Pan across the far side of the room.',
    helper: 'Include corners and the floor line before moving on.',
    target: 'Surface cues',
    progressUnit: 'surface cues',
    requiredPulses: 3,
    coverage: 78,
  },
  {
    kind: 'return',
    direction: '<',
    label: 'CLOSE LOOP',
    eyebrow: 'Align the scan',
    title: 'Return to the starting view',
    instruction: 'Walk back to your starting point and face the original direction.',
    helper: 'Closing the loop helps the native scanner align the room mesh.',
    target: 'Movement cues',
    progressUnit: 'movement cues',
    requiredPulses: 4,
    coverage: 91,
  },
  {
    kind: 'complete',
    direction: '✓',
    label: 'SCAN READY',
    eyebrow: 'Review your room',
    title: 'Your room scan is ready',
    instruction: 'Open the simulator to inspect the real room mesh.',
    helper: 'If a wall or corner is missing, return to the native LiDAR scan and capture that area again.',
    target: 'Ready',
    coverage: 100,
  },
];

const FINAL_SCAN_STEP_INDEX = GUIDANCE_STEPS.length - 1;

const TELEMETRY = [
  { x: '0.00', y: '1.42', z: '0.00', yaw: '0', speed: '0.00', quality: 'Ready' },
  { x: '0.08', y: '1.42', z: '-0.31', yaw: '1', speed: '0.22', quality: 'Good' },
  { x: '0.96', y: '1.42', z: '-0.88', yaw: '46', speed: '0.12', quality: 'Good' },
  { x: '0.98', y: '1.42', z: '-0.88', yaw: '90', speed: '0.06', quality: 'Good' },
  { x: '0.77', y: '1.42', z: '-0.91', yaw: '92', speed: '0.18', quality: 'Good' },
  { x: '0.14', y: '1.42', z: '-0.96', yaw: '178', speed: '0.10', quality: 'Good' },
  { x: '0.02', y: '1.42', z: '-0.18', yaw: '267', speed: '0.16', quality: 'Good' },
  { x: '0.01', y: '1.42', z: '-0.02', yaw: '2', speed: '0.01', quality: 'Locked' },
];
*/

const COVERAGE_COLUMNS = 12;
const COVERAGE_HORIZONTAL_FOV_DEGREES = 70;
const COVERAGE_VERTICAL_FOV = 0.78;
const COVERAGE_ROWS = [
  { id: 'ceiling', label: 'Ceiling', pitch: 0.62 },
  { id: 'upper', label: 'Upper walls', pitch: 0.28 },
  { id: 'middle', label: 'Walls', pitch: 0 },
  { id: 'floor', label: 'Floor', pitch: -0.52 },
];

export const scannerQualityConfig = Object.freeze({
  acceptableFrameScore: 0.28,
  minimumFeatureCount: 10,
  duplicateDistanceMeters: 0.08,
  duplicateHeadingDegrees: 8,
  duplicateSceneChange: 0.16,
  insufficientMoveDistanceMeters: 0.03,
  insufficientMoveHeadingDegrees: 3,
  insufficientMoveSceneChange: 0.08,
  captureIntervalMs: 750,
  targetStallMs: 10000,
  minimumMeaningfulTargetGain: 0.04,
  lowTextureAttempts: 3,
  lowTextureFeatureDensity: 0.12,
});

// Target-view measurements use meters, degrees, normalized screen overlap,
// and normalized [0, 1] image/parallax scores respectively.  These are
// deliberately separate from the frame-acceptance thresholds above.
export const targetViewConfig = Object.freeze({
  requiredUsefulViews: 3,
  minimumScreenOverlap: 0.35,
  minimumTargetFeatures: 8,
  minimumFeatureMatches: 4,
  minimumTranslationMeters: 0.15,
  minimumAngleDegrees: 8,
  minimumParallax: 0.08,
  duplicateTranslationMeters: 0.04,
  duplicateAngleDegrees: 3,
  duplicateParallax: 0.03,
  usefulViewUtilityThreshold: 0.35,
});

function createTargetViewRejectionReasons() {
  return {
    TARGET_NOT_VISIBLE: 0,
    LOW_SCREEN_OVERLAP: 0,
    LOW_TRANSLATION: 0,
    LOW_ANGLE_CHANGE: 0,
    LOW_PARALLAX: 0,
    LOW_FEATURES: 0,
    POSE_MISSING: 0,
    TARGET_ID_MISMATCH: 0,
    DUPLICATE_VIEW: 0,
    FRAME_REJECTED: 0,
    UNKNOWN: 0,
  };
}

export const scannerReadinessConfig = Object.freeze({
  // Ready means useful structural coverage, not every view-sector cell.
  readyAcceptedKeyframes: 24,
  manualFinishAcceptedKeyframes: 18,
  readyStructuralCoverage: 0.56,
  manualFinishStructuralCoverage: 0.32,
  readyWallCoverage: 0.5,
  manualFinishWallCoverage: 0.28,
  readyFloorCoverage: 0.28,
  manualFinishFloorCoverage: 0.12,
  readyViewpointDiversity: 0.22,
  manualFinishViewpointDiversity: 0.12,
  readyReconstructionConfidence: 0.35,
});

const EMPTY_POSE = { x: '0.00', y: '0.00', z: '0.00', yaw: '—', speed: '0.00', quality: 'Waiting' };

function createCoverageRegions() {
  return COVERAGE_ROWS.flatMap((row) => Array.from({ length: COVERAGE_COLUMNS }, (_, column) => ({
    id: `${row.id}-${column}`,
    surfaceId: `${row.id}-surface-${column}`,
    semanticType: row.id === 'floor' ? 'FLOOR' : row.id === 'ceiling' ? 'CEILING' : 'WALL',
    label: row.label,
    row: row.id,
    column,
    yaw: (column / COVERAGE_COLUMNS) * 360,
    pitch: row.pitch,
    estimatedWorldCenter: null,
    estimatedNormal: null,
    currentlyVisible: false,
    screenBounds: null,
    coverage: 0,
    observations: 0,
    acceptedKeyframeIds: [],
    cameraPoses: [],
    parallax: 0,
    observationCount: 0,
    uniqueViewAngles: 0,
    viewpointDiversity: 0,
    averageQuality: 0,
    parallaxScore: 0,
    featureDensity: 0,
    featureMatchCount: 0,
    quality: 0,
    usefulViews: 0,
    targetCaptureState: 'LOCATING',
    targetViewCandidates: 0,
    targetViewRejectionReasons: createTargetViewRejectionReasons(),
    lastTargetViewPose: null,
    lastTargetViewDecision: null,
    captureSource: 'OBSERVED',
    attempts: 0,
    lastObservedAt: 0,
    coverageScore: 0,
    status: 'UNSEEN',
    skipped: false,
  })));
}

function createInitialScanState() {
  const regions = createCoverageRegions();
  return {
    cameraPose: EMPTY_POSE,
    currentOrientation: { alpha: null, beta: null, gamma: null, heading: null, pitch: 0 },
    trackedFeatureCount: 0,
    detectedFeatureCount: 0,
    trackingQuality: 0,
    frameQuality: 0,
    sharpness: 0,
    brightness: 0,
    movementSpeed: 0,
    motionState: MOTION_STATES.GOOD,
    motionScore: 0,
    motionQuality: 1,
    imageQuality: 0,
    featureTrackingQuality: 0,
    featureCount: 0,
    smoothedAngularVelocity: { pitch: 0, yaw: 0, roll: 0 },
    rawAngularVelocity: { pitch: 0, yaw: 0, roll: 0 },
    highSpeedDurationMs: 0,
    warningDurationMs: 0,
    instructionGraceActive: false,
    targetErrorDegrees: null,
    movingTowardTarget: null,
    rotationOnly: false,
    motionBlur: false,
    poorLighting: false,
    estimatedRoomBounds: null,
    detectedPlanes: [],
    detectedObjects: [],
    coverageRegions: regions,
    lowCoverageRegions: regions,
    floorCoverage: 0,
    wallCoverage: 0,
    ceilingCoverage: 0,
    totalCoverage: 0,
    viewpointDiversity: 0,
    acceptedFrames: 0,
    rejectedFrames: 0,
    framesEvaluated: 0,
    rejectionReasons: { blur: 0, duplicate: 0, poorExposure: 0, highExposure: 0, lowFeatures: 0, lowQuality: 0, insufficientMove: 0, tracking: 0, other: 0 },
    lastCaptureAt: 0,
    lastAcceptedAt: 0,
    trackingStatus: 'TRACKING',
    trackingLostDurationMs: 0,
    relocalizationAttempts: 0,
    structuralCoverage: 0,
    scanProgress: 0,
    reconstructionConfidence: 0,
    visibleRegionIds: [],
    sceneUnderstanding: null,
    activeTargetId: null,
    lastTargetViewDecision: null,
    skippedRegionIds: [],
    targetStalled: false,
    scanReadiness: {
      coverage: 0,
      viewpointDiversity: 0,
      acceptedKeyframes: 0,
      structuralCoverage: 0,
      reconstructionConfidence: 0,
      ready: false,
    },
    scanReady: false,
  };
}

function angleDistance(first, second) {
  return Math.abs((((Number(first) - Number(second)) + 540) % 360) - 180);
}

function normalizedAngleDelta(first, second) {
  return ((((Number(second) - Number(first)) + 540) % 360) - 180);
}

function poseDistance(first, second) {
  if (!first || !second) return 0;
  return Math.sqrt(
    ((Number(first.x) || 0) - (Number(second.x) || 0)) ** 2
    + ((Number(first.y) || 0) - (Number(second.y) || 0)) ** 2
    + ((Number(first.z) || 0) - (Number(second.z) || 0)) ** 2,
  );
}

function trackingQualityLabel(value) {
  if (value >= 0.78) return 'Excellent';
  if (value >= 0.55) return 'Good';
  if (value >= 0.3) return 'Weak';
  return 'Lost';
}

function orientationPitch(beta) {
  if (!Number.isFinite(Number(beta))) return 0;
  return clamp((90 - Number(beta)) / 90, -1, 1);
}

function nearestCoverageRegion(regions, orientation) {
  const heading = Number.isFinite(Number(orientation?.heading))
    ? Number(orientation.heading)
    : Number.isFinite(Number(orientation?.alpha)) ? Number(orientation.alpha) : 0;
  const pitch = Number(orientation?.pitch) || 0;
  return regions.reduce((nearest, region) => {
    const yawDistance = angleDistance(region.yaw, heading) / 180;
    const pitchDistance = Math.abs(region.pitch - pitch);
    const score = yawDistance + pitchDistance;
    return !nearest || score < nearest.score ? { region, score } : nearest;
  }, null)?.region;
}

function coverageRowBounds(row) {
  if (row === 'ceiling') return { y: 0.02, height: 0.25 };
  if (row === 'upper') return { y: 0.2, height: 0.28 };
  if (row === 'floor') return { y: 0.68, height: 0.3 };
  return { y: 0.4, height: 0.3 };
}

function projectCoverageRegions(regions, orientation) {
  const heading = Number.isFinite(Number(orientation?.heading))
    ? Number(orientation.heading)
    : Number.isFinite(Number(orientation?.alpha)) ? Number(orientation.alpha) : 0;
  const pitch = Number(orientation?.pitch) || 0;
  return regions.map((region) => {
    const yawDelta = normalizedAngleDelta(heading, region.yaw);
    const pitchDelta = region.pitch - pitch;
    const xCenter = clamp(0.5 + (yawDelta / COVERAGE_HORIZONTAL_FOV_DEGREES), 0.02, 0.98);
    const yCenter = clamp(0.5 - (pitchDelta / COVERAGE_VERTICAL_FOV), 0.03, 0.97);
    const width = clamp(0.18 + (0.06 * (1 - Math.min(1, Math.abs(yawDelta) / 45))), 0.12, 0.24);
    const rowBounds = coverageRowBounds(region.row);
    const height = rowBounds.height * 0.78;
    const horizontalVisible = Math.abs(yawDelta) <= (COVERAGE_HORIZONTAL_FOV_DEGREES / 2) + 8;
    const verticalVisible = Math.abs(pitchDelta) <= (COVERAGE_VERTICAL_FOV / 2) + 0.12;
    const screenBounds = {
      x: clamp(xCenter - (width / 2), 0, 1 - width),
      y: clamp(yCenter - (height / 2), 0, 1 - height),
      width,
      height,
    };
    const visibleScore = clamp(
      (1 - (Math.abs(yawDelta) / ((COVERAGE_HORIZONTAL_FOV_DEGREES / 2) + 8))) * 0.55
      + (1 - (Math.abs(pitchDelta) / ((COVERAGE_VERTICAL_FOV / 2) + 0.12))) * 0.45,
      0,
      1,
    );
    return {
      ...region,
      currentlyVisible: horizontalVisible && verticalVisible,
      screenBounds,
      // This is a normalized estimate of how much of the projected target is
      // inside the usable camera frustum, not a pixel measurement.
      screenOverlap: horizontalVisible && verticalVisible ? visibleScore : 0,
      visibilityScore: visibleScore,
      screenPosition: { x: xCenter, y: yCenter },
    };
  });
}

function orientationForFrame(orientation, pose, previousState) {
  if (Number.isFinite(Number(orientation?.heading))) return orientation;
  const previousPose = previousState?.cameraPose;
  if (!previousPose || !pose || poseDistance(previousPose, pose) < 0.05) return orientation;
  const dx = (Number(pose.x) || 0) - (Number(previousPose.x) || 0);
  const dz = (Number(pose.z) || 0) - (Number(previousPose.z) || 0);
  if (Math.abs(dx) + Math.abs(dz) < 0.05) return orientation;
  return { ...orientation, heading: (((Math.atan2(dz, dx) * 180) / Math.PI) + 360) % 360 };
}

function cameraPoseForRegion(region, pose, orientation) {
  return {
    position: pose ? { x: Number(pose.x) || 0, y: Number(pose.y) || 0, z: Number(pose.z) || 0 } : null,
    heading: Number.isFinite(Number(orientation?.heading)) ? Number(orientation.heading) : null,
    pitch: Number(orientation?.pitch) || 0,
    regionId: region.id,
  };
}

function isMeaningfullyDifferentView(previousView, nextView) {
  if (!previousView || !nextView) return true;
  const translation = poseDistance(previousView.position, nextView.position);
  const headingChange = previousView.heading === null || nextView.heading === null
    ? 0
    : angleDistance(previousView.heading, nextView.heading);
  const pitchChange = Math.abs((Number(previousView.pitch) || 0) - (Number(nextView.pitch) || 0));
  return translation >= 0.1 || headingChange >= 10 || pitchChange >= 0.14;
}

function targetAngleDelta(previousView, nextView) {
  if (!previousView || !nextView) return 0;
  const headingChange = previousView.heading === null || nextView.heading === null
    ? 0
    : angleDistance(previousView.heading, nextView.heading);
  // pitch is normalized to approximately [-1, 1], so convert it to degrees
  // before comparing it with heading, which is already in degrees.
  const pitchChangeDegrees = Math.abs((Number(previousView.pitch) || 0) - (Number(nextView.pitch) || 0)) * 90;
  return Math.max(headingChange, pitchChangeDegrees);
}

function regionFeatureDensity(region, analysis) {
  const globalDensity = clamp((Number(analysis?.featureCount) || 0) / 850, 0, 1);
  const grid = analysis?.sceneUnderstanding?.grid;
  if (!Array.isArray(grid) || !region.screenBounds) return globalDensity;
  const centerX = region.screenBounds.x + (region.screenBounds.width / 2);
  const centerY = region.screenBounds.y + (region.screenBounds.height / 2);
  const column = clamp(Math.floor(centerX * 3), 0, 2);
  const row = clamp(Math.floor(centerY * 3), 0, 2);
  const localDensity = Number(grid[row]?.[column]?.detail) || 0;
  return clamp((globalDensity * 0.45) + (localDensity * 0.55), 0, 1);
}

function targetViewMetrics(targetRegion, analysis, pose, orientation, previousView, fallbackParallax = 0) {
  const currentView = targetRegion ? cameraPoseForRegion(targetRegion, pose, orientation) : null;
  const poseAvailable = Boolean(currentView?.position)
    && Object.values(currentView.position).every((value) => Number.isFinite(Number(value)));
  const translationDelta = previousView && poseAvailable
    ? poseDistance(previousView.position, currentView.position)
    : 0;
  const angleDelta = targetAngleDelta(previousView, currentView);
  const rawParallaxMeters = previousView && poseAvailable ? translationDelta : Number(fallbackParallax) || 0;
  const parallax = clamp(rawParallaxMeters / 0.45, 0, 1);
  const screenOverlap = clamp(Number(targetRegion?.screenOverlap ?? targetRegion?.visibilityScore) || 0, 0, 1);
  const targetFeatureDensity = regionFeatureDensity(targetRegion, analysis);
  const targetFeatureCount = Math.round(targetFeatureDensity * 850);
  const targetMatchedFeatureCount = Math.round((Number(analysis?.trackedFeatureCount) || 0) * screenOverlap);
  // sceneChange is the existing normalized feature-displacement proxy from
  // the frame analyzer. It supplements pose when browser translation is noisy.
  const featureDisplacement = clamp(Number(analysis?.sceneChange) || 0, 0, 1);
  const visualParallax = featureDisplacement >= 0.18 && targetMatchedFeatureCount >= targetViewConfig.minimumFeatureMatches
    ? clamp(featureDisplacement / 0.28, 0, 1)
    : 0;
  const parallaxEvidence = Math.max(parallax, visualParallax);
  const translationScore = clamp(translationDelta / targetViewConfig.minimumTranslationMeters, 0, 1);
  const angleScore = clamp(angleDelta / targetViewConfig.minimumAngleDegrees, 0, 1);
  const parallaxUtilityScore = clamp(parallaxEvidence / targetViewConfig.minimumParallax, 0, 1);
  const featureScore = clamp(targetFeatureCount / 40, 0, 1);
  const utilityScore = clamp(
    (translationScore * 0.30)
      + (angleScore * 0.30)
      + (parallaxUtilityScore * 0.25)
      + (featureScore * 0.15),
    0,
    1,
  );
  return {
    currentView,
    poseAvailable,
    translationDelta,
    angleDelta,
    parallax,
    visualParallax,
    featureDisplacement,
    parallaxEvidence,
    parallaxUtilityScore,
    screenOverlap,
    targetFeatureCount,
    targetMatchedFeatureCount,
    utilityScore,
  };
}

export function qualifyTargetView({ targetRegion, activeTargetId, analysis, pose, orientation, previousView, parallaxDistance = 0, frameAccepted = true }) {
  const base = targetViewMetrics(targetRegion, analysis, pose, orientation, previousView, parallaxDistance);
  const result = {
    targetRegionId: activeTargetId || targetRegion?.id || null,
    targetType: targetRegion?.semanticType || null,
    visible: Boolean(targetRegion?.currentlyVisible),
    qualified: false,
    reason: 'UNKNOWN',
    ...base,
  };
  if (!frameAccepted) return { ...result, reason: 'FRAME_REJECTED' };
  if (!activeTargetId || !targetRegion || targetRegion.id !== activeTargetId) return { ...result, reason: 'TARGET_ID_MISMATCH' };
  if (!targetRegion.currentlyVisible) return { ...result, reason: 'TARGET_NOT_VISIBLE' };
  if (base.screenOverlap < targetViewConfig.minimumScreenOverlap) return { ...result, reason: 'LOW_SCREEN_OVERLAP' };
  if (base.targetFeatureCount < targetViewConfig.minimumTargetFeatures) return { ...result, reason: 'LOW_FEATURES' };
  if (previousView && !base.poseAvailable && base.angleDelta === 0) return { ...result, reason: 'POSE_MISSING' };

  if (!previousView) {
    return { ...result, qualified: true, reason: null };
  }

  const translationEnough = base.translationDelta >= targetViewConfig.minimumTranslationMeters;
  const angleEnough = base.angleDelta >= targetViewConfig.minimumAngleDegrees;
  const parallaxEnough = base.parallaxEvidence >= targetViewConfig.minimumParallax;
  const duplicate = previousView
    && base.translationDelta < targetViewConfig.duplicateTranslationMeters
    && base.angleDelta < targetViewConfig.duplicateAngleDegrees
    && base.parallaxEvidence < targetViewConfig.duplicateParallax
    && base.featureDisplacement < 0.08;
  if (duplicate) return { ...result, reason: 'DUPLICATE_VIEW' };
  if (!translationEnough && !angleEnough && !parallaxEnough) {
    if (base.translationDelta < targetViewConfig.minimumTranslationMeters) return { ...result, reason: 'LOW_TRANSLATION' };
    if (base.angleDelta < targetViewConfig.minimumAngleDegrees) return { ...result, reason: 'LOW_ANGLE_CHANGE' };
    return { ...result, reason: 'LOW_PARALLAX' };
  }
  // The first accepted view establishes the target baseline. Every later view
  // must provide at least one independent source of geometric evidence.
  if (base.utilityScore >= targetViewConfig.usefulViewUtilityThreshold) {
    return { ...result, qualified: true, reason: null };
  }
  return { ...result, reason: 'LOW_PARALLAX' };
}

function hasNeighborEvidence(regions, region) {
  const neighbors = regions.filter((candidate) => {
    const sameRow = candidate.row === region.row && Math.abs(candidate.column - region.column) === 1;
    const sameColumn = candidate.column === region.column && Math.abs(COVERAGE_ROWS.findIndex((row) => row.id === candidate.row) - COVERAGE_ROWS.findIndex((row) => row.id === region.row)) === 1;
    return sameRow || sameColumn;
  });
  const strongNeighbors = neighbors.filter((candidate) => candidate.coverage >= 0.62 || candidate.status === 'SUFFICIENT');
  return strongNeighbors.length >= 2;
}

function updateRegionStatuses(regions) {
  return regions.map((region) => {
    if (region.skipped) return { ...region, status: region.status === 'UNSEEN' ? 'INFERABLE' : region.status };
    const lowTexture = region.attempts >= scannerQualityConfig.lowTextureAttempts
      && region.featureDensity < scannerQualityConfig.lowTextureFeatureDensity;
    const sufficient = region.targetCaptureState === 'COMPLETE'
      || region.coverage >= 0.72
      || (region.uniqueViewAngles >= 3 && region.parallaxScore >= 0.32 && region.observations >= 3);
    let status = region.status;
    if (sufficient) status = 'SUFFICIENT';
    else if (lowTexture) status = hasNeighborEvidence(regions, region) ? 'INFERABLE' : 'LOW_TEXTURE';
    else if (region.observations > 0) status = 'PARTIAL';
    else status = 'UNSEEN';
    return { ...region, status };
  });
}

function summarizeCoverage(regions) {
  const average = (items) => items.length > 0 ? items.reduce((sum, region) => sum + region.coverage, 0) / items.length : 0;
  const floor = regions.filter((region) => region.row === 'floor');
  const ceiling = regions.filter((region) => region.row === 'ceiling');
  const walls = regions.filter((region) => region.row === 'upper' || region.row === 'middle');
  const floorCoverage = average(floor);
  const wallCoverage = average(walls);
  const ceilingCoverage = average(ceiling);
  // A room scan is not four equally important rows of pixels. Walls carry the
  // most structure, with floor and ceiling as supporting evidence.
  const totalCoverage = (wallCoverage * 0.6) + (floorCoverage * 0.25) + (ceilingCoverage * 0.15);
  const lowCoverageRegions = [...regions]
    .filter((region) => !region.skipped && !['SUFFICIENT', 'INFERABLE'].includes(region.status))
    .map((region) => ({ ...region, priority: (1 - region.coverage) + (region.coverage > 0.15 && region.parallax < 0.35 ? 0.28 : 0) }))
    .sort((first, second) => second.priority - first.priority);
  return {
    floorCoverage,
    wallCoverage,
    ceilingCoverage,
    totalCoverage,
    lowCoverageRegions,
  };
}

// eslint-disable-next-line no-unused-vars
function determineNextActionLegacy(scanState) {
  return null;
  /*
  const quality = Number(scanState?.trackingQuality) || 0;
  const frameQuality = Number(scanState?.frameQuality) || 0;
  const currentOrientation = scanState?.currentOrientation || {};
  const targetRegion = scanState?.lowCoverageRegions?.[0];
  const currentHeading = Number.isFinite(Number(currentOrientation.heading)) ? Number(currentOrientation.heading) : null;
  const targetHeading = targetRegion ? Number(targetRegion.yaw) : null;
  const yawDelta = currentHeading === null || targetHeading === null ? 0 : normalizedAngleDelta(currentHeading, targetHeading);

  if (scanState?.trackingQuality === 0 && scanState?.acceptedFrames === 0) {
    return { type: 'START_SCAN', direction: '◎', label: 'READY TO SCAN', eyebrow: 'Build coverage from your movement', title: 'Aim at the room and start moving', instruction: 'Keep the camera level, move slowly, and let the scanner choose the next best view.', helper: 'The coverage map updates from measured camera frames, motion, and orientation.', target: 'Waiting for camera', priority: 1, confidence: 1 };
  }
  if (quality < 0.28) {
    return { type: 'RETURN_TO_TRACKED_AREA', direction: '↺', label: 'TRACKING LOST', eyebrow: 'Recover visual tracking', title: 'Return toward the last tracked area', instruction: 'Move slowly back toward the last stable view and keep textured room edges in frame.', helper: 'The current image has too few reliable visual features for a safe pose estimate.', target: `${scanState.trackedFeatureCount || 0} visual features`, priority: 1, confidence: 0.92 };
  }
  if (scanState?.poorLighting) {
    return { type: 'IMPROVE_LIGHTING', direction: '☼', label: 'LOW LIGHT', eyebrow: 'Improve frame quality', title: 'Add light before moving on', instruction: 'This area is too dark for reliable feature matching. Increase the room lighting.', helper: 'Dark frames are rejected so they do not weaken reconstruction.', target: `${Math.round((scanState.brightness || 0) * 100)}% brightness`, priority: 0.96, confidence: 0.9 };
  }
  if (scanState?.motionBlur || frameQuality < 0.3) {
    return { type: 'SLOW_DOWN', direction: '⏸', label: 'LOW QUALITY', eyebrow: 'Stabilize the camera', title: 'Slow down so the room can be tracked', instruction: 'Hold the phone steadier for a moment, then continue with overlapping views.', helper: 'Blurry or poorly exposed frames are rejected instead of being uploaded.', target: `${Math.round(frameQuality * 100)}% frame quality`, priority: 0.95, confidence: 0.88 };
  }
  if (scanState?.rotationOnly) {
    return { type: 'MOVE_SIDEWAYS', direction: '↔', label: 'NEED PARALLAX', eyebrow: 'Create depth from movement', title: 'Move sideways while scanning', instruction: 'Rotation alone cannot estimate reliable depth here. Take a few steps sideways and keep this area visible.', helper: 'The scanner detected orientation change without enough camera translation.', target: 'Translation needed', priority: 0.86, confidence: 0.86 };
  }
  if (scanState?.totalCoverage >= 0.86 && scanState?.viewpointDiversity >= 0.62 && scanState?.acceptedFrames >= 12) {
    return { type: 'SCAN_COMPLETE', direction: '✓', label: 'SCAN READY', eyebrow: 'Coverage is sufficient', title: 'The room has enough measured coverage', instruction: 'You can finish now, or continue to improve areas marked yellow on the coverage map.', helper: 'Completion is based on coverage, viewpoint diversity, image quality, and tracking.', target: `${Math.round(scanState.totalCoverage * 100)}% coverage`, priority: 0.4, confidence: 0.84 };
  }
  if (!targetRegion) {
    return { type: 'SCAN_LOW_COVERAGE_REGION', direction: '◎', label: 'SCAN AREA', eyebrow: 'Build overlapping views', title: 'Continue moving through the room', instruction: 'Keep walking slowly and collect overlapping views from different positions.', helper: 'The next view is selected from the current coverage map.', target: `${Math.round((scanState?.totalCoverage || 0) * 100)}% coverage`, priority: 0.5, confidence: 0.6 };
  }
  if (targetRegion.parallax < 0.35 && targetRegion.coverage > 0.15) {
    return { type: 'MOVE_SIDEWAYS', direction: '↔', label: 'MORE ANGLES NEEDED', eyebrow: `Improve ${targetRegion.label.toLowerCase()} depth`, title: 'Move sideways around this area', instruction: 'This section has been seen, but not from enough angles. Translate the camera instead of rotating in place.', helper: 'Additional parallax makes the recovered geometry more reliable.', target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.82, targetRegion };
  }
  if (targetRegion.row === 'floor' && (currentOrientation.pitch || 0) > -0.25) {
    return { type: 'LOOK_DOWN', direction: '↓', label: 'FLOOR GAP', eyebrow: 'Capture the missing surface', title: 'Point slightly downward', instruction: 'Angle the camera toward the floor while continuing forward slowly.', helper: 'The floor coverage is lower than the other observed regions.', target: `${Math.round((scanState.floorCoverage || 0) * 100)}% floor coverage`, priority: targetRegion.priority, confidence: 0.86, targetRegion };
  }
  if (targetRegion.row === 'ceiling' && (currentOrientation.pitch || 0) < 0.25) {
    return { type: 'LOOK_UP', direction: '↑', label: 'CEILING GAP', eyebrow: 'Capture the upper connection', title: 'Point slightly upward', instruction: 'Angle the camera toward the ceiling-wall connection while moving slowly.', helper: 'The ceiling coverage is lower than the other observed regions.', target: `${Math.round((scanState.ceilingCoverage || 0) * 100)}% ceiling coverage`, priority: targetRegion.priority, confidence: 0.86, targetRegion };
  }
  if (Math.abs(yawDelta) > 20) {
    const turnDirection = yawDelta > 0 ? 'right' : 'left';
    return { type: yawDelta > 0 ? 'MOVE_RIGHT' : 'MOVE_LEFT', direction: yawDelta > 0 ? '→' : '←', label: 'LOW COVERAGE AREA', eyebrow: 'Follow the coverage map', title: `Move toward the ${turnDirection}`, instruction: `Move toward the ${turnDirection} into the unscanned view sector, keeping the current area overlapping the next frame.`, helper: `That sector has ${Math.round(targetRegion.coverage * 100)}% measured coverage and needs more overlap.`, target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.78, targetRegion };
  }
  return { type: 'SCAN_LOW_COVERAGE_REGION', direction: '◎', label: 'LOW COVERAGE AREA', eyebrow: 'Hold overlap and translate', title: `Move through the ${targetRegion.label.toLowerCase()}`, instruction: 'Continue moving slowly through this area so the next frames overlap the geometry already seen.', helper: `The coverage map marks this sector as the next best view.`, target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.76, targetRegion };
}

  */
}
export function calculateScanReadiness(scanState) {
  const coverage = Number(scanState?.totalCoverage) || 0;
  const wallCoverage = Number(scanState?.wallCoverage) || 0;
  const floorCoverage = Number(scanState?.floorCoverage) || 0;
  const viewpointDiversity = Number(scanState?.viewpointDiversity) || 0;
  const acceptedKeyframes = Number(scanState?.acceptedFrames) || 0;
  const imageQuality = Number(scanState?.imageQuality) || 0;
  const featureTrackingQuality = Number(scanState?.featureTrackingQuality) || 0;
  const reconstructionConfidence = clamp(
    (coverage * 0.38) + (wallCoverage * 0.28) + (featureTrackingQuality * 0.18) + (imageQuality * 0.1) + (viewpointDiversity * 0.06),
    0,
    1,
  );
  const ready = acceptedKeyframes >= scannerReadinessConfig.readyAcceptedKeyframes
    && coverage >= scannerReadinessConfig.readyStructuralCoverage
    && wallCoverage >= scannerReadinessConfig.readyWallCoverage
    && floorCoverage >= scannerReadinessConfig.readyFloorCoverage
    && viewpointDiversity >= scannerReadinessConfig.readyViewpointDiversity
    && reconstructionConfidence >= scannerReadinessConfig.readyReconstructionConfidence;
  return {
    coverage,
    viewpointDiversity,
    acceptedKeyframes,
    structuralCoverage: coverage,
    reconstructionConfidence,
    ready,
  };
}

export function canManuallyFinishScan(scanState) {
  return (Number(scanState?.acceptedFrames) || 0) >= scannerReadinessConfig.manualFinishAcceptedKeyframes
    && (Number(scanState?.totalCoverage) || 0) >= scannerReadinessConfig.manualFinishStructuralCoverage
    && (Number(scanState?.wallCoverage) || 0) >= scannerReadinessConfig.manualFinishWallCoverage
    && (Number(scanState?.floorCoverage) || 0) >= scannerReadinessConfig.manualFinishFloorCoverage
    && (Number(scanState?.viewpointDiversity) || 0) >= scannerReadinessConfig.manualFinishViewpointDiversity;
}

export function calculateScanProgress(scanState) {
  const structuralCoverage = clamp(Number(scanState?.structuralCoverage ?? scanState?.totalCoverage) || 0, 0, 1);
  const viewpointCoverage = clamp(Number(scanState?.viewpointDiversity) || 0, 0, 1);
  const usefulKeyframeProgress = clamp((Number(scanState?.acceptedFrames) || 0) / 36, 0, 1);
  const reconstructionConfidence = clamp(Number(scanState?.reconstructionConfidence) || 0, 0, 1);
  return clamp(
    (structuralCoverage * 0.45)
    + (viewpointCoverage * 0.25)
    + (usefulKeyframeProgress * 0.15)
    + (reconstructionConfidence * 0.15),
    0,
    1,
  );
}

export function isTargetStalled(watchdog, targetRegion, now = Date.now()) {
  return Boolean(
    targetRegion
    && watchdog?.startedAt > 0
    && now - watchdog.startedAt >= scannerQualityConfig.targetStallMs
    && (targetRegion.coverage - (Number(watchdog.startingCoverage) || 0)) < scannerQualityConfig.minimumMeaningfulTargetGain,
  );
}

export function createGuidanceController({ minHoldMs = 2800 } = {}) {
  let current = null;
  let currentSince = 0;
  return {
    update(nextInstruction, now = Date.now()) {
      if (!current) {
        current = nextInstruction;
        currentSince = now;
        return current;
      }
      const criticalInstruction = ['TRACKING_LOST', 'SCAN_COMPLETE'].includes(nextInstruction?.type);
      const targetChanged = current.targetRegion?.id !== nextInstruction?.targetRegion?.id;
      const targetBecameVisible = current.targetRegion?.currentlyVisible !== true && nextInstruction?.targetRegion?.currentlyVisible === true;
      const guidanceModeChanged = current.adaptiveGuidance?.movementInstruction?.type !== nextInstruction?.adaptiveGuidance?.movementInstruction?.type
        || current.adaptiveGuidance?.aimInstruction?.direction !== nextInstruction?.adaptiveGuidance?.aimInstruction?.direction;
      const higherPriority = (Number(nextInstruction?.priority) || 0) > (Number(current.priority) || 0) + 0.25
        && (Number(nextInstruction?.confidence) || 0) >= 0.7;
      const holdExpired = now - currentSince >= minHoldMs;
      const trackingRecovered = current.type === 'TRACKING_LOST' && nextInstruction?.type !== 'TRACKING_LOST';
      const targetCompleted = ['SUFFICIENT', 'INFERABLE'].includes(current.targetRegion?.status);
      if (criticalInstruction || trackingRecovered || nextInstruction?.type === 'START_SCAN' || targetBecameVisible || (targetChanged && (holdExpired || targetCompleted)) || (guidanceModeChanged && holdExpired) || (higherPriority && holdExpired)) {
        current = nextInstruction;
        currentSince = now;
      } else if (current.targetRegion?.id && current.targetRegion.id === nextInstruction?.targetRegion?.id) {
        // Keep the message stable while refreshing the target's current visibility
        // and measurements for the overlay and debug panel.
        const stableTargetRegion = {
          ...nextInstruction.targetRegion,
          screenBounds: nextInstruction.targetRegion.currentlyVisible && current.targetRegion.currentlyVisible !== true
            ? nextInstruction.targetRegion.screenBounds
            : current.targetRegion.screenBounds,
          screenPosition: nextInstruction.targetRegion.currentlyVisible && current.targetRegion.currentlyVisible !== true
            ? nextInstruction.targetRegion.screenPosition
            : current.targetRegion.screenPosition,
        };
        current = { ...current, targetRegion: stableTargetRegion, adaptiveGuidance: nextInstruction.adaptiveGuidance };
      }
      return current;
    },
    reset() {
      current = null;
      currentSince = 0;
    },
  };
}

// eslint-disable-next-line no-unused-vars
function determineNextActionLegacySpatial(scanState) {
  const currentOrientation = scanState?.currentOrientation || {};
  const targetRegion = scanState?.lowCoverageRegions?.[0];
  const currentHeading = Number.isFinite(Number(currentOrientation.heading)) ? Number(currentOrientation.heading) : null;
  const targetHeading = targetRegion ? Number(targetRegion.yaw) : null;
  const yawDelta = currentHeading === null || targetHeading === null ? 0 : normalizedAngleDelta(currentHeading, targetHeading);

  if ((scanState?.framesEvaluated || 0) === 0 && (scanState?.acceptedFrames || 0) === 0) {
    return { type: 'START_SCAN', direction: 'O', label: 'READY TO SCAN', eyebrow: 'Build coverage from your movement', title: 'Aim at the room and start moving', instruction: 'Keep the camera level and move naturally. The scanner will keep the useful views.', helper: 'Follow the highlighted area when you are ready for another part of the room.', target: 'Waiting for camera', priority: 1, confidence: 1 };
  }
  if (scanState?.trackingStatus === 'LOST' || scanState?.motionState === MOTION_STATES.TRACKING_LOST) {
    return { type: 'TRACKING_LOST', direction: 'O', label: 'STAY WITH THE SCAN', eyebrow: 'Automatic relocalization is still running', title: 'I lost track of the room', instruction: "Slowly point the camera toward an area you've already scanned.", helper: 'Your captured coverage is safe. Once the room comes back into view, keep scanning.', target: 'Finding the room again', priority: 1.2, confidence: 0.95 };
  }
  const readiness = scanState?.scanReadiness || calculateScanReadiness(scanState);
  if (scanState?.scanReady || readiness.ready) {
    return { type: 'SCAN_COMPLETE', direction: 'OK', label: 'SCAN READY', eyebrow: 'Enough data collected', title: 'Your room scan is ready', instruction: 'You can finish now, or keep moving toward the highlighted area for a little more detail.', helper: 'Small hidden or obstructed areas do not need to be perfect.', target: `${Math.round(readiness.coverage * 100)}% useful coverage`, priority: 0.8, confidence: 0.9 };
  }
  if (!targetRegion) {
    return { type: 'SCAN_LOW_COVERAGE_REGION', direction: 'O', label: 'SCAN THIS AREA', eyebrow: 'Build overlapping views', title: 'Continue moving through the room', instruction: 'Keep moving naturally and collect overlapping views from different positions.', helper: 'The highlighted area is the next useful part of the room.', target: `${Math.round((scanState?.totalCoverage || 0) * 100)}% useful coverage`, priority: 0.5, confidence: 0.6 };
  }
  if (targetRegion.parallax < 0.35 && targetRegion.coverage > 0.15) {
    return { type: 'MOVE_SIDEWAYS', direction: '↔', label: 'SCAN THIS AREA', eyebrow: `Add another view of the ${targetRegion.label.toLowerCase()}`, title: 'Move past this area', instruction: 'Walk a little to the side so the room is seen from another angle.', helper: 'Overlapping views from different positions help build the room shape.', target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.82, targetRegion };
  }
  if (targetRegion.row === 'floor' && (currentOrientation.pitch || 0) > -0.25) {
    return { type: 'LOOK_DOWN', direction: '↓', label: 'SCAN THIS AREA', eyebrow: 'Capture the missing surface', title: 'Scan the floor near you', instruction: 'Angle the camera slightly down and keep moving through the room.', helper: 'A little floor coverage helps the room shape line up.', target: `${Math.round((scanState.floorCoverage || 0) * 100)}% floor coverage`, priority: targetRegion.priority, confidence: 0.86, targetRegion };
  }
  if (targetRegion.row === 'ceiling' && (currentOrientation.pitch || 0) < 0.25) {
    return { type: 'LOOK_UP', direction: '↑', label: 'SCAN THIS AREA', eyebrow: 'Capture the upper connection', title: 'Scan the upper wall', instruction: 'Angle the camera slightly up toward the wall and ceiling connection.', helper: 'A little upper-wall coverage helps close the room shape.', target: `${Math.round((scanState.ceilingCoverage || 0) * 100)}% ceiling coverage`, priority: targetRegion.priority, confidence: 0.86, targetRegion };
  }
  if (Math.abs(yawDelta) > 20) {
    const turnDirection = yawDelta > 0 ? 'right' : 'left';
    return { type: yawDelta > 0 ? 'MOVE_RIGHT' : 'MOVE_LEFT', direction: yawDelta > 0 ? '→' : '←', label: 'SCAN THIS AREA', eyebrow: 'Follow the coverage map', title: `Move toward the ${turnDirection}`, instruction: `Move toward the ${turnDirection} into the next open view, keeping the current area overlapping the next frame.`, helper: `That part of the room has ${Math.round(targetRegion.coverage * 100)}% useful coverage.`, target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.78, targetRegion };
  }
  return { type: 'SCAN_LOW_COVERAGE_REGION', direction: 'O', label: 'SCAN THIS AREA', eyebrow: 'Hold overlap and translate', title: `Move through the ${targetRegion.label.toLowerCase()}`, instruction: 'Continue moving through this area so the next views overlap what was already seen.', helper: 'The highlighted area is the next best view for the room.', target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.76, targetRegion };
}

function targetDisplayName(region) {
  if (!region) return 'this area';
  const horizontal = region.column <= 3 ? 'left' : region.column >= 8 ? 'right' : 'center';
  if (region.row === 'ceiling') return `${horizontal} ceiling area`;
  if (region.row === 'floor') return `${horizontal} floor area`;
  const vertical = region.row === 'upper' ? 'upper' : 'middle';
  return `${vertical}-${horizontal} wall area`;
}

function targetReason(targetRegion, scanState) {
  if (!targetRegion?.currentlyVisible) return 'TARGET_NOT_VISIBLE';
  if (scanState?.targetStalled) return 'TARGET_OCCLUDED';
  if (targetRegion.status === 'LOW_TEXTURE' || targetRegion.featureDensity < scannerQualityConfig.lowTextureFeatureDensity) return 'LOW_FEATURE_DENSITY';
  if (targetRegion.uniqueViewAngles < 2) return 'LOW_VIEWPOINT_DIVERSITY';
  if (targetRegion.parallaxScore < 0.32) return 'LOW_PARALLAX';
  if (targetRegion.coverage < 0.72) return 'NEEDS_MORE_OBSERVATIONS';
  if (scanState?.targetStalled) return 'TARGET_OCCLUDED';
  return 'NEEDS_MORE_OBSERVATIONS';
}

function aimDirectionForTarget(targetRegion, currentOrientation) {
  const heading = Number.isFinite(Number(currentOrientation?.heading)) ? Number(currentOrientation.heading) : 0;
  const yawDelta = normalizedAngleDelta(heading, targetRegion?.yaw || 0);
  const pitchDelta = (Number(targetRegion?.pitch) || 0) - (Number(currentOrientation?.pitch) || 0);
  if (Math.abs(pitchDelta) > 0.16) return pitchDelta > 0 ? 'UP' : 'DOWN';
  if (Math.abs(yawDelta) > 12) return yawDelta > 0 ? 'RIGHT' : 'LEFT';
  return 'CENTER';
}

function movementForTarget(targetRegion, currentOrientation, scanState) {
  if (scanState?.targetStalled) return { type: 'MOVE_AROUND', magnitude: 'MEDIUM' };
  const heading = Number.isFinite(Number(currentOrientation?.heading)) ? Number(currentOrientation.heading) : 0;
  const yawDelta = normalizedAngleDelta(heading, targetRegion?.yaw || 0);
  return {
    type: yawDelta >= 0 ? 'STEP_RIGHT' : 'STEP_LEFT',
    magnitude: targetRegion?.attempts >= 2 ? 'MEDIUM' : 'SMALL',
  };
}

export function determineNextAction(scanState) {
  const currentOrientation = scanState?.currentOrientation || {};
  const lockedTarget = scanState?.activeTargetId
    ? scanState.coverageRegions?.find((region) => region.id === scanState.activeTargetId
      && !region.skipped
      && !['SUFFICIENT', 'INFERABLE'].includes(region.status))
    : null;
  const targetRegion = lockedTarget || scanState?.lowCoverageRegions?.[0];
  if ((scanState?.framesEvaluated || 0) === 0 && (scanState?.acceptedFrames || 0) === 0) {
    return { type: 'START_SCAN', direction: 'O', label: 'READY TO SCAN', eyebrow: 'Build coverage from your movement', title: 'Aim at the room and start moving', instruction: 'Keep the camera level and move naturally. The scanner will keep the useful views.', helper: 'Follow the highlighted area when you are ready for another part of the room.', target: 'Waiting for camera', priority: 1, confidence: 1, adaptiveGuidance: null };
  }
  if (scanState?.trackingStatus === 'LOST' || scanState?.motionState === MOTION_STATES.TRACKING_LOST) {
    return { type: 'TRACKING_LOST', direction: 'O', label: 'STAY WITH THE SCAN', eyebrow: 'Automatic relocalization is still running', title: 'I lost track of the room', instruction: "Slowly point the camera toward an area you've already scanned.", helper: 'Your captured coverage is safe. Once the room comes back into view, keep scanning.', target: 'Finding the room again', priority: 1.2, confidence: 0.95, adaptiveGuidance: null };
  }
  const readiness = scanState?.scanReadiness || calculateScanReadiness(scanState);
  if (scanState?.scanReady || readiness.ready) {
    return { type: 'SCAN_COMPLETE', direction: 'OK', label: 'SCAN READY', eyebrow: 'Enough data collected', title: 'Your room scan is ready', instruction: 'You can finish now, or keep moving toward the highlighted area for a little more detail.', helper: 'Small hidden or obstructed areas do not need to be perfect.', target: `${Math.round(readiness.coverage * 100)}% useful coverage`, priority: 0.8, confidence: 0.9, adaptiveGuidance: null };
  }
  if (!targetRegion) {
    return { type: 'SCAN_LOW_COVERAGE_REGION', direction: 'O', label: 'KEEP SCANNING', eyebrow: 'Build overlapping views', title: 'Continue moving through the room', instruction: 'Keep moving naturally and collect overlapping views from different positions.', helper: 'The scanner will keep useful views from each part of the room.', target: `${Math.round((scanState?.scanProgress || scanState?.totalCoverage || 0) * 100)}% useful coverage`, priority: 0.5, confidence: 0.6, adaptiveGuidance: null };
  }

  const targetName = targetDisplayName(targetRegion);
  const reason = targetReason(targetRegion, scanState);
  const aimDirection = aimDirectionForTarget(targetRegion, currentOrientation);
  const isVisible = targetRegion.currentlyVisible === true;
  const stalled = Boolean(scanState?.targetStalled);
  if (targetRegion.status === 'LOW_TEXTURE' && (targetRegion.attempts >= scannerQualityConfig.lowTextureAttempts || stalled)) {
    return {
      type: 'SKIP_AREA', direction: '↷', label: 'HARD TO TRACK', eyebrow: targetName,
      title: 'This area is hard to track',
      instruction: 'I can estimate this plain section from the surrounding room. You can skip it and keep scanning.',
      helper: 'The area is not marked as complete; it will remain low-confidence in the scan data.',
      target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: 0.74, confidence: 0.88,
      targetRegion,
      reason: 'TARGET_OCCLUDED', aimInstruction: { direction: 'CENTER', targetScreenPosition: targetRegion.screenPosition }, movementInstruction: { type: 'NONE' },
      adaptiveGuidance: { targetRegionId: targetRegion.id, aimInstruction: { direction: 'CENTER', targetScreenPosition: targetRegion.screenPosition }, movementInstruction: { type: 'NONE' }, reason: 'TARGET_OCCLUDED', message: 'This area is hard to track. You can skip it.', confidence: 0.88 },
    };
  }
  if (!isVisible) {
    const aimText = aimDirection === 'CENTER' ? `Aim at the ${targetName}.` : `Aim slightly ${aimDirection.toLowerCase()} toward the ${targetName}.`;
    return {
      type: aimDirection === 'UP' ? 'LOOK_UP' : aimDirection === 'DOWN' ? 'LOOK_DOWN' : aimDirection === 'LEFT' ? 'MOVE_LEFT' : aimDirection === 'RIGHT' ? 'MOVE_RIGHT' : 'SCAN_LOW_COVERAGE_REGION',
      direction: aimDirection === 'UP' ? '↑' : aimDirection === 'DOWN' ? '↓' : aimDirection === 'LEFT' ? '←' : aimDirection === 'RIGHT' ? '→' : 'O',
      label: 'SCAN THIS AREA', eyebrow: 'Find the next useful view', title: `Aim at the ${targetName}`,
      instruction: aimText, helper: 'Once it is visible, the scanner will ask for another viewpoint instead of more tilting.',
      target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: targetRegion.priority, confidence: 0.86,
      targetRegion,
      reason: 'TARGET_NOT_VISIBLE', aimInstruction: { direction: aimDirection, targetScreenPosition: targetRegion.screenPosition }, movementInstruction: { type: 'NONE' },
      adaptiveGuidance: { targetRegionId: targetRegion.id, aimInstruction: { direction: aimDirection, targetScreenPosition: targetRegion.screenPosition }, movementInstruction: { type: 'NONE' }, reason: 'TARGET_NOT_VISIBLE', message: aimText, confidence: 0.86 },
    };
  }

  const movementInstruction = movementForTarget(targetRegion, currentOrientation, scanState);
  const movementDirection = movementInstruction.type === 'STEP_LEFT' ? 'left' : 'right';
  const instruction = reason === 'TARGET_OCCLUDED'
    ? `Move to another position while keeping the ${targetName} visible.`
    : reason === 'LOW_FEATURE_DENSITY'
    ? `Keep the ${targetName} in view and move toward a corner so I can track its edges.`
    : `Keep the ${targetName} visible and move one step to your ${movementDirection}.`;
  return {
    type: movementInstruction.type === 'STEP_LEFT' ? 'MOVE_LEFT' : movementInstruction.type === 'MOVE_AROUND' ? 'MOVE_SIDEWAYS' : 'MOVE_RIGHT',
    direction: movementInstruction.type === 'STEP_LEFT' ? '←' : movementInstruction.type === 'MOVE_AROUND' ? '↔' : '→', label: 'TARGET VISIBLE',
    eyebrow: targetName, title: reason === 'TARGET_OCCLUDED' ? 'Try another position' : reason === 'LOW_FEATURE_DENSITY' ? 'Move toward a trackable edge' : 'Add another angle of this area', instruction,
    helper: reason === 'LOW_PARALLAX' || reason === 'LOW_VIEWPOINT_DIVERSITY'
      ? 'The area is visible. Translation adds the depth information the next view needs.'
      : 'Each useful angle increases this area’s local coverage.',
    target: `${Math.round(targetRegion.coverage * 100)}% local coverage`, priority: stalled ? 1 : targetRegion.priority, confidence: 0.84,
    targetRegion,
    reason, aimInstruction: { direction: 'CENTER', targetScreenPosition: targetRegion.screenPosition }, movementInstruction,
    adaptiveGuidance: { targetRegionId: targetRegion.id, aimInstruction: { direction: 'CENTER', targetScreenPosition: targetRegion.screenPosition }, movementInstruction, reason, message: instruction, confidence: 0.84 },
  };
}

function readHeading(event) {
  const compassHeading = Number(event.webkitCompassHeading);
  const alphaHeading = Number(event.alpha);
  const heading = Number.isFinite(compassHeading) ? compassHeading : alphaHeading;
  return Number.isFinite(heading) ? (heading + 360) % 360 : null;
}

function sensorEventTimestamp(event) {
  const eventTimestamp = Number(event?.timeStamp);
  if (!Number.isFinite(eventTimestamp)) return Date.now();
  if (eventTimestamp < 100000000000 && Number.isFinite(Number(window.performance?.timeOrigin))) {
    return Number(window.performance.timeOrigin) + eventTimestamp;
  }
  return eventTimestamp;
}

function hasRotationRate(event) {
  return ['alpha', 'beta', 'gamma'].some((axis) => Number.isFinite(Number(event?.rotationRate?.[axis])));
}

function createOrientationSnapshot(event) {
  const heading = readHeading(event);
  const pitch = orientationPitch(event.beta);
  return {
    alpha: Number.isFinite(Number(event.alpha)) ? Number(event.alpha) : null,
    beta: Number.isFinite(Number(event.beta)) ? Number(event.beta) : null,
    gamma: Number.isFinite(Number(event.gamma)) ? Number(event.gamma) : null,
    heading,
    pitch,
    pitchDegrees: pitch * 90,
    headingDegrees: heading,
    rollDegrees: Number.isFinite(Number(event.gamma)) ? Number(event.gamma) : 0,
  };
}

// eslint-disable-next-line no-unused-vars
function directionalProgressMessage(instructionType) {
  if (instructionType === 'LOOK_UP') return 'Good — keep pointing upward';
  if (instructionType === 'LOOK_DOWN') return 'Good — keep pointing downward';
  if (instructionType === 'TURN_LEFT' || instructionType === 'MOVE_LEFT') return 'Good — keep moving left';
  if (instructionType === 'TURN_RIGHT' || instructionType === 'MOVE_RIGHT') return 'Good — keep moving right';
  return 'Good speed';
}

function motionFeedback(instruction, motion) {
  if (!motion || !instruction) return { message: '', tone: 'good' };
  if (motion.motionState === MOTION_STATES.TRACKING_LOST) {
    return { message: "I lost track. Slowly point toward an area you've already scanned.", tone: 'recovery' };
  }
  if (motion.motionState === MOTION_STATES.SCANNING_WITH_WARNING && motion.warningDurationMs <= 1800) {
    return { message: 'Move a little slower', tone: 'warning' };
  }
  return { message: '', tone: 'good' };
}

function motionMagnitude(event) {
  const acceleration = event.acceleration;
  if (!acceleration && !event.accelerationIncludingGravity) return 0;
  if (!acceleration) {
    const gravity = event.accelerationIncludingGravity;
    const x = Number(gravity.x) || 0;
    const y = Number(gravity.y) || 0;
    const z = Number(gravity.z) || 0;
    return Math.abs(Math.sqrt((x * x) + (y * y) + (z * z)) - 9.81);
  }
  const x = Number(acceleration.x) || 0;
  const y = Number(acceleration.y) || 0;
  const z = Number(acceleration.z) || 0;
  return Math.sqrt((x * x) + (y * y) + (z * z));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function createSessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function blobToDataUrl(blob) {
  if (typeof blob === 'string') return Promise.resolve(blob);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function matchLocalFeatures(currentGray, previousGray, width, height) {
  let detected = 0;
  let tracked = 0;
  for (let y = 7; y < height - 7; y += 8) {
    for (let x = 7; x < width - 7; x += 8) {
      const index = y * width + x;
      const horizontal = Math.abs(currentGray[index + 2] - currentGray[index - 2]);
      const vertical = Math.abs(currentGray[index + (2 * width)] - currentGray[index - (2 * width)]);
      if (horizontal + vertical < 46) continue;
      detected += 1;
      if (!previousGray) continue;
      let bestError = Number.POSITIVE_INFINITY;
      for (let offsetY = -4; offsetY <= 4; offsetY += 2) {
        for (let offsetX = -4; offsetX <= 4; offsetX += 2) {
          let error = 0;
          for (let patchY = -2; patchY <= 2; patchY += 2) {
            for (let patchX = -2; patchX <= 2; patchX += 2) {
              const currentValue = currentGray[(y + patchY) * width + (x + patchX)];
              const previousValue = previousGray[(y + offsetY + patchY) * width + (x + offsetX + patchX)];
              error += Math.abs(currentValue - previousValue);
            }
          }
          bestError = Math.min(bestError, error / 9);
        }
      }
      if (bestError < 34) tracked += 1;
    }
  }
  return { detected, tracked };
}

function analyzeVideoFrame(video, canvas, previousGray) {
  if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return null;
  const width = 192;
  const height = Math.max(108, Math.round((video.videoHeight / video.videoWidth) * width));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  let brightnessTotal = 0;
  let brightnessSquares = 0;
  let edgeCount = 0;
  let gradientEnergy = 0;
  let temporalDifference = previousGray ? 0 : 1;
  let temporalSamples = 0;
  const gridCells = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ brightness: 0, edge: 0, pixels: 0 })));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      const value = Math.round((pixels[pixelIndex] * 0.299) + (pixels[pixelIndex + 1] * 0.587) + (pixels[pixelIndex + 2] * 0.114));
      const grayIndex = y * width + x;
      gray[grayIndex] = value;
      brightnessTotal += value;
      brightnessSquares += value * value;
      const gridCell = gridCells[Math.min(2, Math.floor((y / height) * 3))][Math.min(2, Math.floor((x / width) * 3))];
      gridCell.brightness += value;
      gridCell.pixels += 1;
      if (previousGray && grayIndex % 3 === 0) {
        temporalDifference += Math.abs(value - previousGray[grayIndex]) / 255;
        temporalSamples += 1;
      }
      if (x > 0) {
        const horizontalGradient = value - gray[grayIndex - 1];
        gradientEnergy += horizontalGradient * horizontalGradient;
        gridCell.edge += Math.abs(horizontalGradient);
        if (Math.abs(horizontalGradient) > 18) edgeCount += 1;
      }
      if (y > 0) {
        const verticalGradient = value - gray[grayIndex - width];
        gradientEnergy += verticalGradient * verticalGradient;
        gridCell.edge += Math.abs(verticalGradient);
        if (Math.abs(verticalGradient) > 18) edgeCount += 1;
      }
    }
  }

  const pixelCount = width * height;
  const brightness = brightnessTotal / pixelCount / 255;
  const variance = Math.max(0, (brightnessSquares / pixelCount) - ((brightnessTotal / pixelCount) ** 2));
  const edgeDensity = edgeCount / Math.max(1, (width - 1) * height + width * (height - 1));
  const meanGradientEnergy = gradientEnergy / Math.max(1, (width - 1) * height + width * (height - 1));
  const detailScore = clamp(edgeDensity / 0.16, 0, 1);
  const sharpness = clamp(meanGradientEnergy / 1100, 0, 1);
  const exposureScore = clamp(1 - (Math.abs(brightness - 0.48) / 0.48), 0, 1);
  const sceneChange = temporalSamples > 0 ? clamp(temporalDifference / temporalSamples / 0.12, 0, 1) : 1;
  const featureStats = matchLocalFeatures(gray, previousGray, width, height);
  const featureCount = previousGray ? featureStats.tracked : featureStats.detected;
  const featureTrackingQuality = previousGray
    ? clamp(((featureStats.tracked / Math.max(1, featureStats.detected)) * 0.55) + ((featureStats.tracked / 850) * 0.45), 0, 1)
    : clamp(featureStats.detected / 850, 0, 1);
  const qualityScore = clamp((sharpness * 0.42) + (detailScore * 0.38) + (exposureScore * 0.2), 0, 1);
  const sceneGrid = gridCells.map((row) => row.map((cell) => ({
    detail: clamp((cell.edge / Math.max(1, cell.pixels)) / 22, 0, 1),
    brightness: (cell.brightness / Math.max(1, cell.pixels)) / 255,
  })));
  return {
    qualityScore,
    featureCount,
    detectedFeatureCount: featureStats.detected,
    trackedFeatureCount: featureStats.tracked,
    featureTrackingQuality,
    sharpness,
    brightness,
    variance,
    sceneChange,
    motionBlur: sharpness < 0.16,
    poorLighting: brightness < 0.12 || brightness > 0.94,
    sceneUnderstanding: {
      method: 'deterministic-spatial-gradient',
      grid: sceneGrid,
      semanticAssistance: 'geometry-and-camera-frustum',
    },
    gray,
  };
}

// eslint-disable-next-line no-unused-vars
function updateCoverageFromFrameLegacy(previousState, orientation, pose, analysis, parallaxDistance, options = {}) {
  const regions = previousState.coverageRegions.map((region) => ({ ...region }));
  const targetRegion = nearestCoverageRegion(regions, orientation);
  const accepted = options.accepted !== false;
  const observedAt = Number(options.observedAt) || Date.now();
  const usableObservation = accepted
    && analysis.qualityScore >= scannerQualityConfig.acceptableFrameScore
    && analysis.featureCount >= scannerQualityConfig.minimumFeatureCount
    && !analysis.motionBlur
    && !analysis.poorLighting;
  if (targetRegion && usableObservation) {
    const region = regions.find((candidate) => candidate.id === targetRegion.id);
    const parallax = clamp(parallaxDistance / 0.45, 0, 1);
    const observationGain = clamp((analysis.qualityScore * 0.16) + (analysis.sceneChange * 0.06) + (parallax * 0.1), 0.035, 0.28);
    region.coverage = clamp(region.coverage + observationGain, 0, 1);
    region.observations += 1;
    region.parallax = Math.max(region.parallax, parallax);
    region.observationCount = region.observations;
    region.uniqueViewAngles = Math.min(4, region.uniqueViewAngles + (region.observations === 1 || parallax >= 0.18 ? 1 : 0));
    region.averageQuality = ((region.averageQuality * Math.max(0, region.observations - 1)) + analysis.qualityScore) / region.observations;
    region.parallaxScore = region.parallax;
    region.lastObservedAt = observedAt;
    region.coverageScore = region.coverage;
  }
  const featureQuality = clamp((analysis.featureCount / 850) * 0.3, 0, 0.3);
  const trackingQuality = clamp((analysis.featureTrackingQuality * 0.55) + (analysis.qualityScore * 0.45) + featureQuality, 0, 1);
  const summary = summarizeCoverage(regions);
  const observedSectors = new Set(regions.filter((region) => region.observations >= 2 && region.parallax >= 0.18).map((region) => region.column));
  const viewpointDiversity = observedSectors.size / COVERAGE_COLUMNS;
  const nextState = {
    ...previousState,
    cameraPose: pose,
    currentOrientation: orientation,
    featureCount: analysis.featureCount,
    trackedFeatureCount: analysis.featureCount,
    detectedFeatureCount: analysis.detectedFeatureCount,
    trackingQuality,
    frameQuality: analysis.qualityScore,
    imageQuality: analysis.qualityScore,
    featureTrackingQuality: analysis.featureTrackingQuality,
    sharpness: analysis.sharpness,
    brightness: analysis.brightness,
    motionBlur: analysis.motionBlur,
    poorLighting: analysis.poorLighting,
    coverageRegions: regions,
    lowCoverageRegions: summary.lowCoverageRegions,
    floorCoverage: summary.floorCoverage,
    wallCoverage: summary.wallCoverage,
    ceilingCoverage: summary.ceilingCoverage,
    totalCoverage: summary.totalCoverage,
    viewpointDiversity,
  };
  const scanReadiness = calculateScanReadiness(nextState);
  return {
    ...nextState,
    structuralCoverage: scanReadiness.structuralCoverage,
    reconstructionConfidence: scanReadiness.reconstructionConfidence,
    scanReadiness,
    scanReady: scanReadiness.ready,
  };
}

export function updateCoverageFromFrame(previousState, orientation, pose, analysis, parallaxDistance, options = {}) {
  if (!analysis) return previousState;
  const frameOrientation = orientationForFrame(orientation, pose, previousState);
  const projectedRegions = projectCoverageRegions(previousState.coverageRegions, frameOrientation);
  const activeTargetId = options.activeTargetId || previousState.activeTargetId || null;
  const activeTarget = activeTargetId
    ? projectedRegions.find((region) => region.id === activeTargetId) || null
    : null;
  const nearestRegion = nearestCoverageRegion(projectedRegions, frameOrientation);
  const accepted = options.accepted !== false;
  const observedAt = Number(options.observedAt) || Date.now();
  const usableObservation = accepted
    && analysis.qualityScore >= scannerQualityConfig.acceptableFrameScore
    && analysis.featureCount >= scannerQualityConfig.minimumFeatureCount
    && !analysis.motionBlur
    && !analysis.poorLighting;
  let regions = projectedRegions;
  let targetViewDecision = previousState.lastTargetViewDecision || null;
  if (activeTargetId) {
    const activeIndex = regions.findIndex((candidate) => candidate.id === activeTargetId);
    if (activeIndex >= 0) {
      const region = { ...regions[activeIndex] };
      const previousTargetView = region.lastTargetViewPose || null;
      targetViewDecision = qualifyTargetView({
        targetRegion: region,
        activeTargetId,
        analysis,
        pose,
        orientation: frameOrientation,
        previousView: previousTargetView,
        parallaxDistance,
        frameAccepted: usableObservation,
      });
      if (usableObservation) {
        region.targetViewCandidates = (region.targetViewCandidates || 0) + 1;
        if (region.currentlyVisible && region.targetCaptureState === 'LOCATING') {
          region.targetCaptureState = 'COLLECTING_VIEWS';
        }
        if (targetViewDecision.qualified) {
          region.usefulViews = Math.min(targetViewConfig.requiredUsefulViews, (region.usefulViews || 0) + 1);
          region.uniqueViewAngles = region.usefulViews;
          region.targetCaptureState = region.usefulViews >= targetViewConfig.requiredUsefulViews
            ? 'COMPLETE'
            : 'COLLECTING_VIEWS';
        } else {
          const reasons = { ...createTargetViewRejectionReasons(), ...(region.targetViewRejectionReasons || {}) };
          reasons[targetViewDecision.reason || 'UNKNOWN'] = (reasons[targetViewDecision.reason || 'UNKNOWN'] || 0) + 1;
          region.targetViewRejectionReasons = reasons;
        }
        if (targetViewDecision.visible) region.lastTargetViewPose = targetViewDecision.currentView;
      } else if (accepted) {
        const reasons = { ...createTargetViewRejectionReasons(), ...(region.targetViewRejectionReasons || {}) };
        reasons.FRAME_REJECTED += 1;
        region.targetViewRejectionReasons = reasons;
      }
      region.lastTargetViewDecision = targetViewDecision;
      regions[activeIndex] = region;
    } else {
      targetViewDecision = {
        targetRegionId: activeTargetId,
        targetType: null,
        visible: false,
        qualified: false,
        reason: 'TARGET_ID_MISMATCH',
        translationDelta: 0,
        angleDelta: 0,
        parallax: 0,
        parallaxEvidence: 0,
        featureDisplacement: 0,
        screenOverlap: 0,
        targetFeatureCount: 0,
        targetMatchedFeatureCount: 0,
        utilityScore: 0,
      };
    }
  }

  // An accepted frame can still contribute to general room coverage when it
  // sees a different region. It must never increment the active target's view
  // count unless that canonical target passed the visibility/novelty checks.
  const coverageTarget = activeTargetId && activeTarget?.currentlyVisible ? activeTarget : nearestRegion;
  if (coverageTarget && usableObservation && !coverageTarget.skipped) {
    const regionIndex = regions.findIndex((candidate) => candidate.id === coverageTarget.id);
    if (regionIndex < 0) return previousState;
    const region = { ...regions[regionIndex] };
    const parallax = clamp((Number(parallaxDistance) || 0) / 0.45, 0, 1);
    const nextPose = cameraPoseForRegion(region, pose, frameOrientation);
    const lastPose = region.cameraPoses?.[region.cameraPoses.length - 1];
    const meaningfulView = isMeaningfullyDifferentView(lastPose, nextPose);
    const observationGain = clamp((analysis.qualityScore * 0.14) + (analysis.sceneChange * 0.055) + (parallax * 0.11), 0.035, 0.25);
    region.coverage = clamp(region.coverage + observationGain, 0, 1);
    region.observations += 1;
    region.parallax = Math.max(region.parallax, parallax);
    region.observationCount = region.observations;
    if (!activeTargetId) {
      region.uniqueViewAngles = Math.min(4, region.uniqueViewAngles + (region.observations === 1 || meaningfulView ? 1 : 0));
    }
    region.viewpointDiversity = clamp((region.usefulViews || region.uniqueViewAngles) / 3, 0, 1);
    region.averageQuality = ((region.averageQuality * Math.max(0, region.observations - 1)) + analysis.qualityScore) / region.observations;
    region.quality = region.averageQuality;
    region.parallaxScore = Math.max(region.parallaxScore, parallax);
    region.featureDensity = ((region.featureDensity * Math.max(0, region.observations - 1)) + regionFeatureDensity(region, analysis)) / region.observations;
    region.featureMatchCount = analysis.trackedFeatureCount;
    region.attempts = Math.min(4, Math.max(region.attempts, region.observations));
    region.lastObservedAt = observedAt;
    region.coverageScore = region.coverage;
    region.estimatedWorldCenter = { x: Math.cos((region.yaw * Math.PI) / 180), y: region.pitch, z: Math.sin((region.yaw * Math.PI) / 180) };
    region.estimatedNormal = { x: Math.cos((region.yaw * Math.PI) / 180), y: 0, z: Math.sin((region.yaw * Math.PI) / 180) };
    region.cameraPoses = [...(region.cameraPoses || []), nextPose].slice(-8);
    if (options.keyframeId !== undefined && options.keyframeId !== null) {
      region.acceptedKeyframeIds = [...(region.acceptedKeyframeIds || []), options.keyframeId].slice(-24);
    }
    regions[regionIndex] = region;
  }
  regions = updateRegionStatuses(regions);
  const summary = summarizeCoverage(regions);
  const observedSectors = new Set(regions.filter((region) => region.uniqueViewAngles >= 2 && region.parallaxScore >= 0.18).map((region) => region.column));
  const viewpointDiversity = observedSectors.size / COVERAGE_COLUMNS;
  const featureQuality = clamp((analysis.featureCount / 850) * 0.3, 0, 0.3);
  const trackingQuality = clamp((analysis.featureTrackingQuality * 0.55) + (analysis.qualityScore * 0.45) + featureQuality, 0, 1);
  const nextState = {
    ...previousState,
    cameraPose: pose,
    currentOrientation: orientation,
    featureCount: analysis.featureCount,
    trackedFeatureCount: analysis.trackedFeatureCount,
    detectedFeatureCount: analysis.detectedFeatureCount,
    trackingQuality,
    frameQuality: analysis.qualityScore,
    imageQuality: analysis.qualityScore,
    featureTrackingQuality: analysis.featureTrackingQuality,
    sharpness: analysis.sharpness,
    brightness: analysis.brightness,
    motionBlur: analysis.motionBlur,
    poorLighting: analysis.poorLighting,
    sceneUnderstanding: analysis.sceneUnderstanding
      ? { method: 'deterministic-spatial-gradient', ...analysis.sceneUnderstanding }
      : null,
    coverageRegions: regions,
    activeTargetId,
    lastTargetViewDecision: targetViewDecision,
    visibleRegionIds: regions.filter((region) => region.currentlyVisible).map((region) => region.id),
    lowCoverageRegions: summary.lowCoverageRegions,
    floorCoverage: summary.floorCoverage,
    wallCoverage: summary.wallCoverage,
    ceilingCoverage: summary.ceilingCoverage,
    totalCoverage: summary.totalCoverage,
    viewpointDiversity,
  };
  const scanReadiness = calculateScanReadiness(nextState);
  const readinessState = {
    ...nextState,
    structuralCoverage: scanReadiness.structuralCoverage,
    reconstructionConfidence: scanReadiness.reconstructionConfidence,
    scanReadiness,
    scanReady: scanReadiness.ready,
  };
  return {
    ...readinessState,
    scanProgress: calculateScanProgress(readinessState),
  };
}

function loadGLTFAsset(url, onLoad, onError) {
  import('three/examples/jsm/loaders/GLTFLoader.js')
    .then(({ GLTFLoader }) => new GLTFLoader().load(url, onLoad, undefined, onError))
    .catch(onError);
}

function App() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanStartedAtRef = useRef(null);
  const scanSessionIdRef = useRef(null);
  const pathRef = useRef({ x: 0, y: 0, z: 0, velocity: 0, lastMotionAt: null });
  const lastTelemetryRef = useRef(EMPTY_POSE);
  const lastCaptureAtRef = useRef(0);
  const analysisCanvasRef = useRef(null);
  const previousFrameGrayRef = useRef(null);
  const lastAcceptedFrameRef = useRef(null);
  const lastCoveragePoseRef = useRef(null);
  const lastTranslationAtRef = useRef(0);
  const rotationOnlyRef = useRef(false);
  const latestMotionRef = useRef({ acceleration: null, rotationRate: null });
  const motionTrackerRef = useRef(null);
  if (!motionTrackerRef.current) {
    motionTrackerRef.current = createMotionTracker(scannerMotionConfig, { debug: SCANNER_DEBUG });
  }
  const guidanceControllerRef = useRef(null);
  if (!guidanceControllerRef.current) guidanceControllerRef.current = createGuidanceController({ minHoldMs: 2800 });
  const motionUsingRotationRateRef = useRef(false);
  const lastMotionStateRef = useRef(MOTION_STATES.GOOD);
  const lastMotionWarningUiAtRef = useRef(0);
  const lastMotionTelemetryUiAtRef = useRef(0);
  const lastTrackingLogAtRef = useRef(0);
  const lastFrameDecisionLogAtRef = useRef(0);
  const guidanceWatchdogRef = useRef({ targetId: null, startedAt: 0, startingCoverage: 0 });
  const [isScanning, setIsScanning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [viewMode, setViewMode] = useState('scan');
  const [cameraState, setCameraState] = useState('idle');
  const [sensorState, setSensorState] = useState('idle');
  const [framesCaptured, setFramesCaptured] = useState(0);
  const [roomSession, setRoomSession] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isReconstructing, setIsReconstructing] = useState(false);
  const [reconstructionState, setReconstructionState] = useState(null);
  const [importError, setImportError] = useState('');
  const [objects, setObjects] = useState([]);
  const [lastEvent, setLastEvent] = useState('Ready when you are.');
  const [liveTelemetry, setLiveTelemetry] = useState(EMPTY_POSE);
  const [scanState, setScanState] = useState(() => createInitialScanState());
  const [motionTelemetry, setMotionTelemetry] = useState(() => motionTrackerRef.current.getSnapshot());
  const scanStateRef = useRef(scanState);
  const orientationRef = useRef({ alpha: null, beta: null, gamma: null, heading: null, pitch: 0 });
  const activeTargetIdRef = useRef(null);
  const frameStoreRef = useRef([]);
  const nextKeyframeIdRef = useRef(1);
  const captureFrameRef = useRef(null);
  const scanInstruction = useMemo(
    () => guidanceControllerRef.current.update(determineNextAction(scanState), Date.now()),
    [scanState],
  );
  const motionUi = motionFeedback(scanInstruction, motionTelemetry);
  const instructionTargetId = scanInstruction.targetRegion?.id || '';
  const scanInstructionType = scanInstruction.type;
  const scanTargetPitch = Number.isFinite(Number(scanInstruction.targetRegion?.pitch))
    ? Number(scanInstruction.targetRegion.pitch)
    : null;
  const scanTargetYaw = Number.isFinite(Number(scanInstruction.targetRegion?.yaw))
    ? Number(scanInstruction.targetRegion.yaw)
    : null;
  const publishMotionTelemetry = (snapshot, force = false) => {
    const now = Date.now();
    if (!force && now - lastMotionTelemetryUiAtRef.current < 100) return;
    lastMotionTelemetryUiAtRef.current = now;
    setMotionTelemetry(snapshot);
  };
  const telemetry = liveTelemetry;
  const roomCoverage = Math.round((scanState.scanProgress || scanState.totalCoverage) * 100);
  const canFinish = isFinished || canManuallyFinishScan(scanState) || scanState.scanReady;

  const finishHint = useMemo(() => {
    if (isFinished) return 'Scan complete. Review the real room mesh in the simulator.';
    if (scanState.scanReady) return 'Enough data collected. Finish whenever the room feels covered.';
    if (scanState.acceptedFrames < scannerReadinessConfig.manualFinishAcceptedKeyframes) return `${scannerReadinessConfig.manualFinishAcceptedKeyframes - scanState.acceptedFrames} more useful views before Finish Scan is available.`;
    return 'Keep moving around the room. Finish Scan will unlock once the main surfaces have enough overlap.';
  }, [isFinished, scanState]);

  const instructionText = scanInstruction.instruction;
  const activeTarget = scanInstruction.targetRegion;
  const targetScreenBounds = activeTarget?.screenBounds;
  const targetViewCount = Math.min(targetViewConfig.requiredUsefulViews, Number(activeTarget?.usefulViews) || 0);
  const targetDebugReason = activeTarget ? targetReason(activeTarget, scanState) : '—';

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      frameStoreRef.current.forEach((frame) => {
        if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    const motionTracker = motionTrackerRef.current;
    const motionTarget = {
      pitchDegrees: scanTargetPitch === null || !['LOOK_UP', 'LOOK_DOWN'].includes(scanInstructionType)
        ? null
        : scanTargetPitch * 90,
      headingDegrees: scanTargetYaw === null || !['TURN_LEFT', 'TURN_RIGHT', 'MOVE_LEFT', 'MOVE_RIGHT', 'MOVE_SIDEWAYS', 'MOVE_AROUND_OBJECT'].includes(scanInstructionType)
        ? null
        : scanTargetYaw,
    };
    const snapshot = motionTracker.setInstruction(
      isScanning ? scanInstructionType : 'START_SCAN',
      isScanning ? motionTarget : null,
      Date.now(),
    );
    setMotionTelemetry(snapshot);
    lastMotionStateRef.current = snapshot.motionState;
    const target = scanInstruction.targetRegion;
    activeTargetIdRef.current = target?.id || null;
    if (!target) {
      guidanceWatchdogRef.current = { targetId: null, startedAt: 0, startingCoverage: 0 };
    } else if (guidanceWatchdogRef.current.targetId !== target.id) {
      guidanceWatchdogRef.current = { targetId: target.id, startedAt: Date.now(), startingCoverage: target.coverage || 0 };
    }
  }, [instructionTargetId, isScanning, scanInstructionType, scanTargetPitch, scanTargetYaw, scanInstruction.targetRegion]);

  const enableCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('fallback');
      setLastEvent('This browser cannot provide a camera stream. Use a supported mobile browser or load a scan on desktop.');
      return false;
    }

    if (!window.isSecureContext) {
      setCameraState('fallback');
      setLastEvent('Camera access needs HTTPS on a phone. Open the secure app URL.');
      return false;
    }

    setCameraState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraState('live');
      return true;
    } catch (error) {
      setCameraState('fallback');
      setLastEvent('Camera permission was not available. A real scan needs camera access.');
      return false;
    }
  };

  const enableSensors = async () => {
    const orientationApi = window.DeviceOrientationEvent;
    const motionApi = window.DeviceMotionEvent;
    if (!orientationApi && !motionApi) {
      setSensorState('unavailable');
      return false;
    }

    try {
      const permissionRequests = [orientationApi, motionApi]
        .filter(Boolean)
        .map(async (sensorApi) => {
          if (typeof sensorApi.requestPermission === 'function') {
            return (await sensorApi.requestPermission()) === 'granted';
          }
          return true;
        });
      const permissionResults = await Promise.all(permissionRequests);
      const isGranted = permissionResults.some(Boolean);
      setSensorState(isGranted ? 'live' : 'unavailable');
      return isGranted;
    } catch (error) {
      setSensorState('unavailable');
      return false;
    }
  };

  const captureUsefulFrame = (providedAnalysis) => {
    const video = videoRef.current;
    const now = Date.now();
    if (now - lastCaptureAtRef.current < scannerQualityConfig.captureIntervalMs || !video || video.readyState < 2 || video.videoWidth === 0) return false;
    const analysisCanvas = analysisCanvasRef.current || document.createElement('canvas');
    const analysis = providedAnalysis || analyzeVideoFrame(video, analysisCanvas, previousFrameGrayRef.current);
    if (!analysis) return false;
    previousFrameGrayRef.current = analysis.gray;
    const previous = lastAcceptedFrameRef.current;
    const pose = { ...lastTelemetryRef.current };
    const orientationSnapshot = { ...orientationRef.current };
    const motionSnapshot = { ...latestMotionRef.current };
    const translationSinceLast = previous ? poseDistance(previous.pose, pose) : 1;
    const headingChange = previous ? angleDistance(previous.orientation?.heading, orientationRef.current.heading) : 360;
    const targetRegion = nearestCoverageRegion(scanStateRef.current.coverageRegions, orientationRef.current);
    const isInsufficientMove = previous
      && translationSinceLast < scannerQualityConfig.insufficientMoveDistanceMeters
      && headingChange < scannerQualityConfig.insufficientMoveHeadingDegrees
      && analysis.sceneChange < scannerQualityConfig.insufficientMoveSceneChange;
    const isDuplicate = previous
      && translationSinceLast < scannerQualityConfig.duplicateDistanceMeters
      && headingChange < scannerQualityConfig.duplicateHeadingDegrees
      && analysis.sceneChange < scannerQualityConfig.duplicateSceneChange
      && targetRegion?.coverage > 0.72;
    const severeTrackingFailure = previous
      && analysis.featureCount >= scannerQualityConfig.minimumFeatureCount
      && analysis.featureTrackingQuality < 0.08;
    const rejectionReason = isDuplicate
      ? 'duplicate'
      : isInsufficientMove
        ? 'insufficientMove'
      : analysis.motionBlur
        ? 'blur'
      : analysis.poorLighting
          ? analysis.brightness > 0.94 ? 'highExposure' : 'poorExposure'
          : severeTrackingFailure
            ? 'tracking'
          : analysis.featureCount < scannerQualityConfig.minimumFeatureCount
            ? 'lowFeatures'
            : analysis.qualityScore < scannerQualityConfig.acceptableFrameScore ? 'lowQuality' : null;
    if (rejectionReason) {
      const rejectionReasons = {
        ...scanStateRef.current.rejectionReasons,
        [rejectionReason]: (scanStateRef.current.rejectionReasons?.[rejectionReason] || 0) + 1,
      };
      scanStateRef.current = {
        ...scanStateRef.current,
        frameQuality: analysis.qualityScore,
        sharpness: analysis.sharpness,
        brightness: analysis.brightness,
        motionBlur: analysis.motionBlur,
        poorLighting: analysis.poorLighting,
        rejectedFrames: scanStateRef.current.rejectedFrames + 1,
        rejectionReasons,
      };
      setScanState(scanStateRef.current);
      return false;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = Math.max(360, Math.round((video.videoHeight / video.videoWidth) * 640));
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    lastAcceptedFrameRef.current = {
      capturedAt: now,
      pose,
      orientation: orientationSnapshot,
      analysis,
    };
    lastCaptureAtRef.current = now;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const previewUrl = URL.createObjectURL(blob);
      const keyframeId = nextKeyframeIdRef.current;
      nextKeyframeIdRef.current += 1;
      frameStoreRef.current.push({
        frameId: keyframeId,
        capturedAt: now,
        orientation: orientationSnapshot,
        motion: motionSnapshot,
        estimatedPose: pose,
        pose,
        qualityScore: analysis.qualityScore,
        qualityMetrics: {
          sharpness: analysis.sharpness,
          brightness: analysis.brightness,
          featureCount: analysis.featureCount,
          sceneChange: analysis.sceneChange,
        },
        image: blob,
        previewUrl,
      });
      lastCoveragePoseRef.current = pose;
      const coverageState = updateCoverageFromFrame(
        scanStateRef.current,
        orientationSnapshot,
        pose,
        analysis,
        translationSinceLast,
        { accepted: true, observedAt: now, keyframeId, activeTargetId: activeTargetIdRef.current },
      );
      if (SCANNER_DEBUG) {
        const targetDecision = coverageState.lastTargetViewDecision;
        if (activeTargetIdRef.current && targetDecision?.targetRegionId !== activeTargetIdRef.current) {
          // eslint-disable-next-line no-console
          console.warn('[TARGET_ID_MISMATCH]', {
            overlayTargetId: activeTargetIdRef.current,
            coverageTargetId: targetDecision?.targetRegionId || null,
          });
        }
        // eslint-disable-next-line no-console
        console.log('KEYFRAME:', {
          id: keyframeId,
          timestamp: now,
          activeTargetId: activeTargetIdRef.current,
          targetType: targetDecision?.targetType || null,
          targetVisible: targetDecision?.visible || false,
          targetOverlap: targetDecision?.screenOverlap || 0,
          translationDeltaMeters: targetDecision?.translationDelta || 0,
          angleDeltaDegrees: targetDecision?.angleDelta || 0,
          parallax: targetDecision?.parallaxEvidence || 0,
          featureDisplacement: targetDecision?.featureDisplacement || 0,
          utilityScore: targetDecision?.utilityScore || 0,
          utilityThreshold: targetViewConfig.usefulViewUtilityThreshold,
          qualified: targetDecision?.qualified ? 'YES' : 'NO',
          rejectionReason: targetDecision?.reason || null,
        });
      }
      setFramesCaptured(frameStoreRef.current.length);
      const nextStateBeforeReadiness = {
        ...coverageState,
        acceptedFrames: frameStoreRef.current.length,
        lastCaptureAt: now,
        lastAcceptedAt: now,
      };
      const scanReadiness = calculateScanReadiness(nextStateBeforeReadiness);
      const nextState = {
        ...nextStateBeforeReadiness,
        structuralCoverage: scanReadiness.structuralCoverage,
        reconstructionConfidence: scanReadiness.reconstructionConfidence,
        scanReadiness,
        scanReady: scanReadiness.ready,
        scanProgress: calculateScanProgress({
          ...nextStateBeforeReadiness,
          structuralCoverage: scanReadiness.structuralCoverage,
          reconstructionConfidence: scanReadiness.reconstructionConfidence,
        }),
      };
      scanStateRef.current = nextState;
      setScanState(nextState);
    }, 'image/jpeg', 0.86);
    return true;
  };
  captureFrameRef.current = captureUsefulFrame;

  const updateLiveTelemetry = (heading = orientationRef.current.heading, speed = pathRef.current.velocity, quality = trackingQualityLabel(scanStateRef.current.trackingQuality)) => {
    const nextTelemetry = {
      x: pathRef.current.x.toFixed(2),
      y: pathRef.current.y.toFixed(2),
      z: pathRef.current.z.toFixed(2),
      yaw: heading === null ? lastTelemetryRef.current.yaw : Math.round(heading).toString(),
      speed: Number(speed).toFixed(2),
      quality,
    };
    lastTelemetryRef.current = nextTelemetry;
    setLiveTelemetry(nextTelemetry);
  };

  const startScan = async () => {
    frameStoreRef.current.forEach((frame) => {
      if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
    });
    setIsScanning(true);
    setIsFinished(false);
    setViewMode('scan');
    setRoomSession(null);
    setImportError('');
    setReconstructionState(null);
    setIsPaused(false);
    setFramesCaptured(0);
    frameStoreRef.current = [];
    nextKeyframeIdRef.current = 1;
    setObjects([]);
    setLiveTelemetry(EMPTY_POSE);
    guidanceControllerRef.current.reset();
    guidanceWatchdogRef.current = { targetId: null, startedAt: 0, startingCoverage: 0 };
    activeTargetIdRef.current = null;
    const initialScanState = createInitialScanState();
    scanStateRef.current = initialScanState;
    setScanState(initialScanState);
    orientationRef.current = { alpha: null, beta: null, gamma: null, heading: null, pitch: 0, pitchDegrees: 0, headingDegrees: null, rollDegrees: 0 };
    previousFrameGrayRef.current = null;
    lastAcceptedFrameRef.current = null;
    lastCoveragePoseRef.current = null;
    lastTranslationAtRef.current = 0;
    rotationOnlyRef.current = false;
    latestMotionRef.current = { acceleration: null, rotationRate: null };
    motionUsingRotationRateRef.current = false;
    lastMotionStateRef.current = MOTION_STATES.GOOD;
    lastMotionWarningUiAtRef.current = 0;
    lastMotionTelemetryUiAtRef.current = 0;
    lastTrackingLogAtRef.current = 0;
    lastFrameDecisionLogAtRef.current = 0;
    publishMotionTelemetry(motionTrackerRef.current.setInstruction('START_SCAN', null, Date.now()), true);
    scanStartedAtRef.current = Date.now();
    scanSessionIdRef.current = createSessionId();
    pathRef.current = { x: 0, y: 0, z: 0, velocity: 0, lastMotionAt: null };
    lastCaptureAtRef.current = 0;
    lastTelemetryRef.current = EMPTY_POSE;

    const [cameraReady, sensorsReady] = await Promise.all([enableCamera(), enableSensors()]);
    if (cameraReady && sensorsReady) {
      setLastEvent('Camera is ready. Keep moving around the room.');
    } else if (cameraReady) {
      setLastEvent('Camera is ready. Motion sensors are optional; keep moving around the room.');
    } else {
      setLastEvent('Camera unavailable. Use HTTPS on your phone to start a real camera scan.');
    }
  };

  useEffect(() => {
    if (!isScanning || isPaused) return undefined;

    const handleOrientation = (event) => {
      const timestamp = sensorEventTimestamp(event);
      const nextOrientation = createOrientationSnapshot(event);
      const heading = nextOrientation.heading;
      const previousHeading = orientationRef.current.heading;
      if (heading !== null && previousHeading !== null && angleDistance(previousHeading, heading) > 8 && Date.now() - lastTranslationAtRef.current > 850) {
        rotationOnlyRef.current = true;
      }
      orientationRef.current = nextOrientation;
      const motionTracker = motionTrackerRef.current;
      const motionSnapshot = motionUsingRotationRateRef.current
        ? motionTracker.updateOrientation({ timestamp, orientation: nextOrientation })
        : motionTracker.updateOrientationSample({ timestamp, orientation: nextOrientation });
      publishMotionTelemetry(motionSnapshot);
      updateLiveTelemetry(heading, pathRef.current.velocity);
    };

    const handleMotion = (event) => {
      const now = Date.now();
      const previousMotionAt = pathRef.current.lastMotionAt;
      const deltaSeconds = previousMotionAt === null
        ? 0
        : clamp((now - previousMotionAt) / 1000, 0, 0.35);
      const acceleration = motionMagnitude(event);
      const isMoving = acceleration >= 0.12;
      const nextVelocity = isMoving
        ? clamp(pathRef.current.velocity + (acceleration * deltaSeconds), 0, 1.2)
        : pathRef.current.velocity * 0.82;
      const heading = orientationRef.current.heading ?? 0;
      const headingRadians = (heading * Math.PI) / 180;
      const distance = nextVelocity * deltaSeconds;
      pathRef.current.x += Math.sin(headingRadians) * distance;
      pathRef.current.z -= Math.cos(headingRadians) * distance;
      pathRef.current.velocity = nextVelocity;
      pathRef.current.lastMotionAt = now;
      const rotationRateAvailable = hasRotationRate(event);
      if (rotationRateAvailable) motionUsingRotationRateRef.current = true;
      const nextOrientation = orientationRef.current;
      const rotationRate = rotationRateAvailable ? {
        pitch: Number(event.rotationRate.beta) || 0,
        yaw: Number(event.rotationRate.alpha) || 0,
        roll: Number(event.rotationRate.gamma) || 0,
      } : null;
      const motionSnapshot = rotationRate
        ? motionTrackerRef.current.updateAngularVelocity({
          timestamp: sensorEventTimestamp(event),
          angularVelocity: rotationRate,
          orientation: nextOrientation,
        })
        : null;
      latestMotionRef.current = {
        acceleration: {
          x: Number(event.acceleration?.x ?? event.accelerationIncludingGravity?.x) || 0,
          y: Number(event.acceleration?.y ?? event.accelerationIncludingGravity?.y) || 0,
          z: Number(event.acceleration?.z ?? event.accelerationIncludingGravity?.z) || 0,
        },
        rotationRate: event.rotationRate ? {
          alpha: Number(event.rotationRate.alpha) || 0,
          beta: Number(event.rotationRate.beta) || 0,
          gamma: Number(event.rotationRate.gamma) || 0,
        } : null,
        rawAngularVelocity: motionSnapshot?.rawAngularVelocity || latestMotionRef.current.rawAngularVelocity || { pitch: 0, yaw: 0, roll: 0 },
        smoothedAngularVelocity: motionSnapshot?.smoothedAngularVelocity || latestMotionRef.current.smoothedAngularVelocity || { pitch: 0, yaw: 0, roll: 0 },
        motionScore: motionSnapshot?.motionScore || latestMotionRef.current.motionScore || 0,
        motionState: motionSnapshot?.motionState || latestMotionRef.current.motionState || MOTION_STATES.GOOD,
      };
      if (motionSnapshot) publishMotionTelemetry(motionSnapshot);
      if (isMoving) {
        lastTranslationAtRef.current = now;
        rotationOnlyRef.current = false;
      }
      updateLiveTelemetry(orientationRef.current.heading, nextVelocity);
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('devicemotion', handleMotion, true);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
      window.removeEventListener('devicemotion', handleMotion, true);
    };
  }, [isScanning, isPaused]);

  useEffect(() => {
    if (!isScanning || isPaused || cameraState !== 'live') return undefined;
    let animationFrame = 0;
    let previousAnalysisAt = 0;
    const scanLoop = (timestamp) => {
      if (timestamp - previousAnalysisAt >= 220) {
        previousAnalysisAt = timestamp;
        const video = videoRef.current;
        const canvas = analysisCanvasRef.current || document.createElement('canvas');
        analysisCanvasRef.current = canvas;
        let analysis = analyzeVideoFrame(video, canvas, previousFrameGrayRef.current);
        // A rejected frame must not become the only bridge to the next frame.
        // Probe the last accepted keyframe as a lightweight relocalization
        // attempt before deciding that tracking is truly gone.
        const acceptedReferenceGray = lastAcceptedFrameRef.current?.analysis?.gray;
        if (analysis && analysis.featureTrackingQuality < 0.22 && acceptedReferenceGray) {
          const relocalizedAnalysis = analyzeVideoFrame(video, canvas, acceptedReferenceGray);
          if (relocalizedAnalysis && relocalizedAnalysis.featureTrackingQuality > analysis.featureTrackingQuality) {
            analysis = relocalizedAnalysis;
          }
        }
        if (analysis) {
          previousFrameGrayRef.current = analysis.gray;
          const pose = { ...lastTelemetryRef.current };
           const now = Date.now();
           const parallaxDistance = lastCoveragePoseRef.current ? poseDistance(lastCoveragePoseRef.current, pose) : 0;
           const nextState = updateCoverageFromFrame(scanStateRef.current, orientationRef.current, pose, analysis, parallaxDistance, { accepted: false, observedAt: now, activeTargetId: activeTargetIdRef.current });
           const watchdog = guidanceWatchdogRef.current;
           const watchedTarget = watchdog.targetId ? nextState.coverageRegions.find((region) => region.id === watchdog.targetId) : null;
           nextState.targetStalled = isTargetStalled(watchdog, watchedTarget, now);
           nextState.framesEvaluated = (scanStateRef.current.framesEvaluated || 0) + 1;
           nextState.movementSpeed = pathRef.current.velocity;
           nextState.rotationOnly = rotationOnlyRef.current;
           const motionSnapshot = motionTrackerRef.current.updateTrackingQuality({
             timestamp: now,
             quality: nextState.trackingQuality,
             frameQuality: analysis.qualityScore,
             featureCount: analysis.featureCount,
             detectedFeatureCount: analysis.detectedFeatureCount,
             featureTrackingQuality: analysis.featureTrackingQuality,
             motionBlur: analysis.motionBlur,
             relocalizationFailed: analysis.trackedFeatureCount < scannerMotionConfig.trackingLostFeatureThreshold
               && analysis.featureTrackingQuality < 0.22
               && analysis.qualityScore < scannerMotionConfig.trackingLostFrameQualityThreshold,
             usableFramesRecently: now - (scanStateRef.current.lastAcceptedAt || 0) < scannerMotionConfig.relocalizationSampleWindowMs,
           });
           nextState.motionState = motionSnapshot.motionState;
           nextState.motionScore = motionSnapshot.motionScore;
           nextState.motionQuality = motionSnapshot.motionQuality;
           nextState.imageQuality = analysis.qualityScore;
           nextState.smoothedAngularVelocity = motionSnapshot.smoothedAngularVelocity;
           nextState.rawAngularVelocity = motionSnapshot.rawAngularVelocity;
           nextState.highSpeedDurationMs = motionSnapshot.highSpeedDurationMs;
           nextState.warningDurationMs = motionSnapshot.warningDurationMs;
           nextState.instructionGraceActive = motionSnapshot.instructionGraceActive;
           nextState.targetErrorDegrees = motionSnapshot.targetErrorDegrees;
           nextState.movingTowardTarget = motionSnapshot.movingTowardTarget;
           nextState.trackingStatus = motionSnapshot.trackingStatus;
           nextState.trackingLostDurationMs = motionSnapshot.trackingLostDurationMs;
           nextState.relocalizationAttempts = motionSnapshot.relocalizationAttempts;
           scanStateRef.current = nextState;
           setScanState(nextState);
           publishMotionTelemetry(motionSnapshot);
           const previousMotionState = lastMotionStateRef.current;
           if (motionSnapshot.motionState !== previousMotionState) {
             if (motionSnapshot.motionState === MOTION_STATES.SCANNING_WITH_WARNING
               && now - lastMotionWarningUiAtRef.current >= scannerMotionConfig.warningUiCooldownMs) {
               // The warning is rendered as a short-lived inline nudge. It is
               // deliberately not written to the persistent event line.
               lastMotionWarningUiAtRef.current = now;
             } else if (motionSnapshot.motionState === MOTION_STATES.TRACKING_LOST) {
               setLastEvent("I lost track for a moment. Slowly point toward an area you've already scanned.");
             } else if (motionSnapshot.motionState === MOTION_STATES.SCANNING
               && previousMotionState === MOTION_STATES.TRACKING_LOST) {
               setLastEvent('Got it. Keep scanning.');
             }
             lastMotionStateRef.current = motionSnapshot.motionState;
           }
           if (SCANNER_DEBUG && motionSnapshot.trackingQuality >= 0.55 && now - lastTrackingLogAtRef.current >= 2000) {
             // eslint-disable-next-line no-console
             console.log(`[TRACKING] tracking remains stable featureCount=${motionSnapshot.featureCount}`);
             lastTrackingLogAtRef.current = now;
           }
           if (SCANNER_DEBUG && now - lastFrameDecisionLogAtRef.current >= 2000) {
             // eslint-disable-next-line no-console
             console.log('[FRAMES]', {
               evaluated: nextState.framesEvaluated,
               accepted: nextState.acceptedFrames,
               rejected: nextState.rejectedFrames,
               reasons: nextState.rejectionReasons,
             });
             lastFrameDecisionLogAtRef.current = now;
           }
          const previous = lastAcceptedFrameRef.current;
          const movementSinceCapture = previous ? poseDistance(previous.pose, pose) : 1;
          const headingSinceCapture = previous ? angleDistance(previous.orientation?.heading, orientationRef.current.heading) : 360;
          const target = nearestCoverageRegion(nextState.coverageRegions, orientationRef.current);
          const shouldCapture = !previous
            || movementSinceCapture >= 0.12
            || headingSinceCapture >= 12
            || analysis.sceneChange >= 0.28
            || target?.coverage < 0.56;
          if (shouldCapture) captureFrameRef.current?.(analysis);
        }
      }
      animationFrame = window.requestAnimationFrame(scanLoop);
    };
    animationFrame = window.requestAnimationFrame(scanLoop);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [cameraState, isPaused, isScanning]);

  const skipCurrentTarget = () => {
    const targetId = scanInstruction.targetRegion?.id;
    if (!targetId) return;
    const currentState = scanStateRef.current;
    const skippedRegionIds = [...new Set([...(currentState.skippedRegionIds || []), targetId])];
    const regions = currentState.coverageRegions.map((region) => region.id === targetId
      ? { ...region, skipped: true, status: region.status === 'UNSEEN' ? 'INFERABLE' : region.status }
      : region);
    const summary = summarizeCoverage(regions);
    const nextStateBeforeReadiness = {
      ...currentState,
      coverageRegions: regions,
      lowCoverageRegions: summary.lowCoverageRegions,
      skippedRegionIds,
      targetStalled: false,
    };
    const scanReadiness = calculateScanReadiness(nextStateBeforeReadiness);
    const nextState = {
      ...nextStateBeforeReadiness,
      structuralCoverage: scanReadiness.structuralCoverage,
      reconstructionConfidence: scanReadiness.reconstructionConfidence,
      scanReadiness,
      scanReady: scanReadiness.ready,
      scanProgress: calculateScanProgress({
        ...nextStateBeforeReadiness,
        structuralCoverage: scanReadiness.structuralCoverage,
        reconstructionConfidence: scanReadiness.reconstructionConfidence,
      }),
    };
    scanStateRef.current = nextState;
    guidanceWatchdogRef.current = { targetId: null, startedAt: 0, startingCoverage: 0 };
    guidanceControllerRef.current.reset();
    setScanState(nextState);
    setLastEvent('Skipped that area. I will keep it marked as low-confidence and continue scanning.');
  };

  const finishScan = () => {
    if (!canFinish) return;
    const finishedAt = Date.now();
    const frames = frameStoreRef.current.map((frame) => ({
      ...frame,
      pose: { ...frame.pose },
    }));
    const session = {
      schemaVersion: 3,
      sessionId: scanSessionIdRef.current || createSessionId(),
      createdAt: new Date(scanStartedAtRef.current || finishedAt).toISOString(),
      durationSeconds: Math.max(0, (finishedAt - (scanStartedAtRef.current || finishedAt)) / 1000),
      coordinateSystem: 'browser-estimated local path; synchronized DeviceOrientation and DeviceMotion when available',
      scanState: {
        trackedFeatureCount: scanState.trackedFeatureCount,
        trackingQuality: scanState.trackingQuality,
        trackingStatus: scanState.trackingStatus,
        trackingLostDurationMs: scanState.trackingLostDurationMs,
        relocalizationAttempts: scanState.relocalizationAttempts,
        featureTrackingQuality: scanState.featureTrackingQuality,
        imageQuality: scanState.imageQuality,
        motionQuality: scanState.motionQuality,
        motionState: scanState.motionState,
        floorCoverage: scanState.floorCoverage,
        wallCoverage: scanState.wallCoverage,
        ceilingCoverage: scanState.ceilingCoverage,
        totalCoverage: scanState.totalCoverage,
        scanProgress: scanState.scanProgress,
        viewpointDiversity: scanState.viewpointDiversity,
        coverageRegions: scanState.coverageRegions,
        visibleRegionIds: scanState.visibleRegionIds,
        skippedRegionIds: scanState.skippedRegionIds,
        sceneUnderstanding: scanState.sceneUnderstanding,
        acceptedFrames: scanState.acceptedFrames,
        rejectedFrames: scanState.rejectedFrames,
        framesEvaluated: scanState.framesEvaluated,
        rejectionReasons: scanState.rejectionReasons,
        structuralCoverage: scanState.structuralCoverage,
        reconstructionConfidence: scanState.reconstructionConfidence,
        scanReadiness: scanState.scanReadiness,
        scanReady: scanState.scanReady,
      },
      frames,
      objects: objects.map((object) => ({ ...object })),
    };
    setIsFinished(true);
    setIsScanning(false);
    setRoomSession(session);
    setViewMode('customize');
    setSensorState('idle');
    setIsPaused(false);
    setLastEvent('Scan saved with measured keyframes, image quality, motion, and coverage metadata.');
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const exportScan = async () => {
    if (!roomSession || isExporting) return;
    setIsExporting(true);
    setImportError('');
    try {
      const frames = await Promise.all(roomSession.frames.map(async (frame) => ({
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        pose: frame.pose,
        estimatedPose: frame.estimatedPose,
        orientation: frame.orientation,
        motion: frame.motion,
        qualityScore: frame.qualityScore,
        qualityMetrics: frame.qualityMetrics,
        image: await blobToDataUrl(frame.image),
      })));
      const payload = JSON.stringify({ ...roomSession, frames }, null, 2);
      const exportBlob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(exportBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `buildwise-smartscan-${roomSession.sessionId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setLastEvent('Scan exported. Load this JSON on the desktop website.');
    } catch (error) {
      setImportError('The scan could not be exported. Try again on the device that captured it.');
    } finally {
      setIsExporting(false);
    }
  };

  const reconstructRoom = async () => {
    if (!roomSession || isReconstructing || roomSession.meshPLY || roomSession.glbUrl) return;
    setIsReconstructing(true);
    setImportError('');
    setReconstructionState({ status: 'uploading', message: 'Preparing measured camera frames for reconstruction.' });
    try {
      const createResponse = await fetch(`${RECONSTRUCTION_API}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: roomSession.sessionId, device: { userAgent: navigator.userAgent } }),
      });
      if (!createResponse.ok) throw new Error('The reconstruction service is not available.');
      const createdScan = await createResponse.json();
      const uploadableFrames = [];
      for (const frame of roomSession.frames) {
        if (frame.image instanceof Blob) {
          uploadableFrames.push({ frame, blob: frame.image });
        } else if (typeof frame.image === 'string' && frame.image) {
          const imageResponse = await fetch(frame.image);
          if (imageResponse.ok) uploadableFrames.push({ frame, blob: await imageResponse.blob() });
        }
      }
      if (uploadableFrames.length < 3) throw new Error('At least three locally stored camera frames are required for reconstruction.');
      const formData = new FormData();
      formData.append('metadata', JSON.stringify(uploadableFrames.map(({ frame }) => ({
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        orientation: frame.orientation,
        motion: frame.motion,
        estimatedPose: frame.estimatedPose || frame.pose,
        qualityScore: frame.qualityScore,
        qualityMetrics: frame.qualityMetrics,
      }))));
      uploadableFrames.forEach(({ frame, blob }) => formData.append('files', blob, `frame-${frame.frameId}.jpg`));
      const uploadResponse = await fetch(`${RECONSTRUCTION_API}/api/scans/${createdScan.scanId}/frames`, { method: 'POST', body: formData });
      if (!uploadResponse.ok) throw new Error('The reconstruction service rejected the camera frames.');

      const startResponse = await fetch(`${RECONSTRUCTION_API}/api/scans/${createdScan.scanId}/reconstruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!startResponse.ok) throw new Error('The reconstruction worker could not be started.');

      let status = await (await fetch(`${RECONSTRUCTION_API}/api/scans/${createdScan.scanId}`)).json();
      while (!['complete', 'error'].includes(status.status)) {
        setReconstructionState(status);
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        status = await (await fetch(`${RECONSTRUCTION_API}/api/scans/${createdScan.scanId}`)).json();
      }
      if (status.status === 'error') throw new Error(status.message || 'The reconstruction worker failed.');
      const glbUrl = `${RECONSTRUCTION_API}/api/scans/${createdScan.scanId}/room.glb`;
      const metadataUrl = `${RECONSTRUCTION_API}/api/scans/${createdScan.scanId}/metadata.json`;
      setRoomSession((current) => ({ ...current, reconstruction: status.result, glbUrl, metadataUrl }));
      setReconstructionState({ ...status, assetUrl: glbUrl });
      setLastEvent('Real room mesh reconstructed from the uploaded camera frames.');
    } catch (error) {
      setReconstructionState({ status: 'error', message: error.message || 'Reconstruction could not be completed.' });
      setImportError(error.message || 'The real room reconstruction could not be completed.');
    } finally {
      setIsReconstructing(false);
    }
  };

  const importScan = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const hasMesh = typeof payload.meshPLY === 'string' && payload.meshPLY.startsWith('ply');
      if ((!Array.isArray(payload.frames) || payload.frames.length === 0) && !hasMesh) {
        throw new Error('No frames in scan session');
      }
      const frames = (Array.isArray(payload.frames) ? payload.frames : []).map((frame, index) => ({
        frameId: frame.frameId || frame.id || index + 1,
        capturedAt: frame.capturedAt || frame.timestamp || Date.now(),
        pose: frame.pose || {
          x: Number(frame.x || 0).toFixed(2),
          y: Number(frame.y || 1.42).toFixed(2),
          z: Number(frame.z || 0).toFixed(2),
          yaw: Math.round(Number(frame.yaw || 0) * (Math.abs(Number(frame.yaw || 0)) < 7 ? 180 / Math.PI : 1)).toString(),
          speed: '0.00',
          quality: 'ARKit tracked',
        },
        estimatedPose: frame.estimatedPose || frame.pose,
        orientation: frame.orientation,
        motion: frame.motion,
        qualityScore: Number(frame.qualityScore) || 0,
        qualityMetrics: frame.qualityMetrics,
        image: frame.image || '',
        previewUrl: frame.image || '',
      }));
      if (frames.length === 0 && !hasMesh) throw new Error('Scan data is missing');
      frameStoreRef.current.forEach((frame) => {
        if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
      });
      frameStoreRef.current = [];
      const importedSession = { ...payload, frames };
      setRoomSession(importedSession);
      setFramesCaptured(frames.length);
      setObjects(assetsFromSessionPayload(payload));
      setIsScanning(false);
      setIsFinished(true);
      setViewMode('customize');
      setCameraState('idle');
      setSensorState('idle');
      setIsPaused(false);
      const lastFrame = frames[frames.length - 1];
      lastTelemetryRef.current = lastFrame?.pose || EMPTY_POSE;
      setLiveTelemetry(lastFrame?.pose || EMPTY_POSE);
      const importedScanState = {
        ...createInitialScanState(),
        acceptedFrames: frames.length,
        ...(payload.scanState || {}),
      };
      scanStateRef.current = importedScanState;
      setScanState(importedScanState);
      setLastEvent(`Loaded ${frames.length} measured keyframes from ${file.name}.`);
      setImportError('');
    } catch (error) {
      setImportError('That file is not a valid BuildWise SmartScan session.');
    }
  };

  const resetScan = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    frameStoreRef.current.forEach((frame) => {
      if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
    });
    setIsScanning(false);
    setIsFinished(false);
    setViewMode('scan');
    setIsPaused(false);
    setFramesCaptured(0);
    frameStoreRef.current = [];
    nextKeyframeIdRef.current = 1;
    setObjects([]);
    setLastEvent('Ready when you are.');
    setCameraState('idle');
    setSensorState('idle');
    const initialScanState = createInitialScanState();
    guidanceControllerRef.current.reset();
    guidanceWatchdogRef.current = { targetId: null, startedAt: 0, startingCoverage: 0 };
    activeTargetIdRef.current = null;
    scanStateRef.current = initialScanState;
    setScanState(initialScanState);
    setLiveTelemetry(EMPTY_POSE);
    setRoomSession(null);
    setImportError('');
    setReconstructionState(null);
    scanStartedAtRef.current = null;
    scanSessionIdRef.current = null;
    pathRef.current = { x: 0, y: 0, z: 0, velocity: 0, lastMotionAt: null };
    lastTelemetryRef.current = EMPTY_POSE;
    motionUsingRotationRateRef.current = false;
    lastMotionStateRef.current = MOTION_STATES.GOOD;
    lastMotionWarningUiAtRef.current = 0;
    lastMotionTelemetryUiAtRef.current = 0;
    lastFrameDecisionLogAtRef.current = 0;
    publishMotionTelemetry(motionTrackerRef.current.setInstruction('START_SCAN', null, Date.now()), true);
  };

  return (
    <main className={`app-shell ${isScanning ? 'app-shell-scanning' : ''}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">B</div>
          <div>
            <p className="brand-name">BuildWise</p>
            <p className="brand-product">SmartScan</p>
          </div>
        </div>

        <div className="topbar-context">
          <span className="context-kicker">Project</span>
          <span className="context-value">Room scan</span>
          <span className="context-divider" aria-hidden="true" />
          <span className={`status-dot ${isFinished ? 'status-dot-complete' : ''}`} />
          <span className="context-value">{isFinished ? 'Ready to review' : isScanning ? 'Scanning' : 'Not started'}</span>
        </div>

        <div className="topbar-actions">
          {roomSession && (
            <button className="quiet-button" type="button" onClick={() => setViewMode(viewMode === 'customize' ? 'scan' : 'customize')}>
              {viewMode === 'customize' ? 'Back to scan' : 'Room simulator'}
            </button>
          )}
          <label className="import-control">
            Load scan
            <input type="file" accept="application/json,.json" onChange={importScan} />
          </label>
          <button className="quiet-button" type="button" onClick={resetScan}>Exit scan</button>
        </div>
      </header>

      {viewMode === 'customize' && roomSession ? (
        <RoomCustomizer
          session={roomSession}
          onExport={exportScan}
          isExporting={isExporting}
          onReconstruct={reconstructRoom}
          isReconstructing={isReconstructing}
          reconstructionState={reconstructionState}
        />
      ) : <div className={`workspace ${isScanning ? 'workspace-scanning' : ''}`}>
        <section className="camera-column" aria-label="Camera preview">
          <div className="camera-frame">
            <video ref={videoRef} className={`camera-video ${cameraState === 'live' ? 'camera-video-live' : ''}`} autoPlay muted playsInline />
            <div className="room-fallback" aria-hidden={cameraState === 'live'}><span>LIVE CAMERA REQUIRED</span></div>
            <div className="camera-shade" />
            <div className="camera-meta camera-meta-top">
              <span className="recording-label"><span className="status-dot status-dot-recording" /> {isScanning ? 'LIVE CAPTURE' : 'CAMERA PREVIEW'}</span>
              <span className="camera-mode">{cameraState === 'live' ? 'LIVE CAMERA' : cameraState === 'fallback' ? 'HTTPS REQUIRED' : 'CAMERA OFF'}</span>
            </div>
            {cameraState === 'requesting' && <div className="camera-notice">Requesting camera access...</div>}
            {cameraState === 'fallback' && <div className="camera-notice camera-notice-warning">Open this page over HTTPS to use the phone camera.</div>}
            <div className="target-reticle" aria-hidden="true">
              <span className="reticle-line reticle-line-top" />
              <span className="reticle-line reticle-line-right" />
              <span className="reticle-line reticle-line-bottom" />
              <span className="reticle-line reticle-line-left" />
              <span className="reticle-cross reticle-cross-horizontal" />
              <span className="reticle-cross reticle-cross-vertical" />
            </div>
            {isScanning && activeTarget && targetScreenBounds && activeTarget.currentlyVisible && (
              <div
                className="spatial-target-overlay"
                style={{
                  left: `${targetScreenBounds.x * 100}%`,
                  top: `${targetScreenBounds.y * 100}%`,
                  width: `${targetScreenBounds.width * 100}%`,
                  height: `${targetScreenBounds.height * 100}%`,
                }}
                aria-label={`Target visible: ${targetDisplayName(activeTarget)}`}
              >
                <span>SCAN THIS AREA</span>
              </div>
            )}
            <div className={`camera-meta camera-meta-bottom ${SCANNER_DEBUG ? 'camera-meta-debug' : 'camera-meta-calm'}`}>
              {SCANNER_DEBUG ? (
                <>
                  <span>Frame quality <b>{cameraState === 'live' ? `${Math.round(scanState.frameQuality * 100)}%` : 'n/a'}</b></span>
                  <span>Accepted viewpoints <b>{scanState.acceptedFrames}</b></span>
                </>
              ) : (
                <>
                  <span>Room scan</span>
                  <span>{isScanning ? 'Collecting useful views' : 'Camera preview'}</span>
                </>
              )}
            </div>
            {SCANNER_DEBUG && isScanning && (
              <aside className="scanner-debug-overlay" aria-label="Scanner motion debug">
                <div className="scanner-debug-heading">
                  <span>Motion debug</span>
                  <strong>{motionTelemetry.motionState}</strong>
                </div>
                <div className="scanner-debug-instruction">Instruction: {scanInstruction.type}</div>
                <div className="scanner-debug-grid">
                  <span>Pitch velocity</span><b>{motionTelemetry.rawAngularVelocity.pitch.toFixed(1)}°/s</b>
                  <span>Yaw velocity</span><b>{motionTelemetry.rawAngularVelocity.yaw.toFixed(1)}°/s</b>
                  <span>Roll velocity</span><b>{motionTelemetry.rawAngularVelocity.roll.toFixed(1)}°/s</b>
                  <span>Smoothed pitch</span><b>{motionTelemetry.smoothedAngularVelocity.pitch.toFixed(1)}°/s</b>
                  <span>Smoothed yaw</span><b>{motionTelemetry.smoothedAngularVelocity.yaw.toFixed(1)}°/s</b>
                  <span>Smoothed roll</span><b>{motionTelemetry.smoothedAngularVelocity.roll.toFixed(1)}°/s</b>
                  <span>Smoothed score</span><b>{motionTelemetry.motionScore.toFixed(1)}°/s</b>
                  <span>Warning / critical</span><b>{motionTelemetry.warningThreshold} / {motionTelemetry.criticalThreshold}°/s</b>
                  <span>High-speed timer</span><b>{Math.round(motionTelemetry.highSpeedDurationMs)} ms</b>
                  <span>Target pitch</span><b>{motionTelemetry.targetPitchDegrees === null ? '—' : `${motionTelemetry.targetPitchDegrees.toFixed(0)}°`}</b>
                  <span>Current pitch</span><b>{motionTelemetry.currentPitchDegrees === null ? '—' : `${motionTelemetry.currentPitchDegrees.toFixed(0)}°`}</b>
                  <span>Target error</span><b>{motionTelemetry.targetErrorDegrees === null ? '—' : `${motionTelemetry.targetErrorDegrees.toFixed(0)}°`}</b>
                  <span>Feature count</span><b>{motionTelemetry.featureCount}</b>
                  <span>Tracking / image</span><b>{Math.round(motionTelemetry.trackingQuality * 100)}% / {Math.round(motionTelemetry.imageQuality * 100)}%</b>
                  <span>Tracking status</span><b>{motionTelemetry.trackingStatus}</b>
                  <span>Lost duration</span><b>{Math.round(motionTelemetry.trackingLostDurationMs)} ms</b>
                  <span>Relocalization attempts</span><b>{motionTelemetry.relocalizationAttempts}</b>
                </div>
                <div className="scanner-debug-section">Frame decisions</div>
                <div className="scanner-debug-grid">
                  <span>Frames evaluated</span><b>{scanState.framesEvaluated}</b>
                  <span>Accepted keyframes</span><b>{scanState.acceptedFrames}</b>
                  <span>Rejected total</span><b>{scanState.rejectedFrames}</b>
                  <span>Blur</span><b>{scanState.rejectionReasons.blur}</b>
                  <span>Duplicate</span><b>{scanState.rejectionReasons.duplicate}</b>
                  <span>Insufficient move</span><b>{scanState.rejectionReasons.insufficientMove}</b>
                  <span>Poor exposure</span><b>{scanState.rejectionReasons.poorExposure}</b>
                  <span>Low features</span><b>{scanState.rejectionReasons.lowFeatures}</b>
                  <span>Low quality</span><b>{scanState.rejectionReasons.lowQuality}</b>
                  <span>Tracking</span><b>{scanState.rejectionReasons.tracking || 0}</b>
                  <span>High exposure</span><b>{scanState.rejectionReasons.highExposure || 0}</b>
                  <span>Other</span><b>{scanState.rejectionReasons.other || 0}</b>
                  <span>Useful coverage</span><b>{roomCoverage}%</b>
                  <span>Readiness</span><b>{scanState.scanReady ? 'READY' : 'BUILDING'}</b>
                </div>
                {activeTarget && (
                  <>
                    <div className="scanner-debug-section">Target region</div>
                    <div className="scanner-debug-grid">
                      <span>Current target</span><b>{activeTarget.id}</b>
                      <span>Visible</span><b>{activeTarget.currentlyVisible ? 'YES' : 'NO'}</b>
                      <span>Screen coverage</span><b>{targetScreenBounds ? `${Math.round(targetScreenBounds.width * targetScreenBounds.height * 100)}% area` : '—'}</b>
                      <span>Observations</span><b>{activeTarget.observationCount || activeTarget.observations || 0}</b>
                      <span>Useful views</span><b>{activeTarget.usefulViews || 0}</b>
                      <span>Target state</span><b>{activeTarget.targetCaptureState || 'LOCATING'}</b>
                      <span>Accepted candidates</span><b>{activeTarget.targetViewCandidates || 0}</b>
                      <span>Parallax</span><b>{(activeTarget.parallaxScore || 0).toFixed(2)}</b>
                      <span>Features</span><b>{Math.round((activeTarget.featureDensity || 0) * 850)}</b>
                      <span>Feature matches</span><b>{activeTarget.featureMatchCount || 0}</b>
                      <span>Coverage</span><b>{Math.round((activeTarget.coverage || 0) * 100)}%</b>
                      <span>Attempts</span><b>{activeTarget.attempts || 0}</b>
                      <span>Reason incomplete</span><b>{targetDebugReason}</b>
                      <span>Last view result</span><b>{scanState.lastTargetViewDecision?.qualified ? 'YES' : scanState.lastTargetViewDecision?.reason || '—'}</b>
                      <span>Target view rejects</span><b>{Object.entries(activeTarget.targetViewRejectionReasons || {}).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}:${count}`).join(' ') || 'none'}</b>
                      <span>Next instruction</span><b>{scanInstruction.adaptiveGuidance?.movementInstruction?.type || scanInstruction.adaptiveGuidance?.aimInstruction?.direction || scanInstruction.type}</b>
                    </div>
                  </>
                )}
              </aside>
            )}
          </div>

          {SCANNER_DEBUG ? <div className="camera-footer">
            <div className="telemetry-heading">
              <div>
                <p className="section-label">Live pose</p>
                <h2>Position tracking</h2>
              </div>
              <span className={`tracking-badge ${scanState.trackingQuality >= 0.55 ? 'tracking-badge-live' : scanState.trackingQuality > 0 ? 'tracking-badge-locked' : ''}`}>
                <span className="status-dot status-dot-small" /> Tracking: {trackingQualityLabel(scanState.trackingQuality)}
              </span>
            </div>
            <div className="telemetry-grid">
              <TelemetryValue label="X position" value={`${telemetry.x} m`} />
              <TelemetryValue label="Y position" value={`${telemetry.y} m`} />
              <TelemetryValue label="Z position" value={`${telemetry.z} m`} />
              <TelemetryValue label="Yaw" value={`${telemetry.yaw}°`} />
              <TelemetryValue label="Speed" value={`${telemetry.speed} m/s`} />
              <TelemetryValue label="Frames" value={framesCaptured.toString().padStart(2, '0')} />
            </div>
          </div> : <div className="camera-footer camera-footer-simple"><span>Keep the room in view while you move.</span><strong>{roomCoverage}% covered</strong></div>}
        </section>

        <aside className="control-column">
          <div className="control-header">
            <div>
              <p className="section-label">AI-assisted guided spatial scanning</p>
              <h1>{isFinished ? 'Ready to review your room.' : 'Scan the room with your phone.'}</h1>
            </div>
            <span className="phase-chip">Adaptive scan</span>
          </div>

          <section className="progress-panel" aria-label="Room scan capture progress">
            <div className="progress-heading">
              <span>Capture progress</span>
              <strong>{roomCoverage}%</strong>
            </div>
            <div className="progress-track" aria-hidden="true"><span style={{ width: `${roomCoverage}%` }} /></div>
            <div className="progress-footing">
              <span>{isFinished ? 'Ready to review' : scanState.scanReady ? 'Enough useful data collected' : 'Measured from accepted views'}</span>
              <span>{scanState.scanReady ? 'Ready when you are' : 'Keep moving around the room'}</span>
            </div>
          </section>

          <CoverageMap scanState={scanState} targetRegion={scanInstruction.targetRegion} />

          <section className={`instruction-panel ${isFinished || scanInstruction.type === 'SCAN_COMPLETE' ? 'instruction-panel-complete' : ''} ${scanInstruction.type === 'TRACKING_LOST' ? 'instruction-panel-recovery' : ''}`} aria-live="polite">
            <div className="instruction-topline">
              <span className="instruction-label">{scanInstruction.label}</span>
              <span className="instruction-step">{isFinished ? 'Done' : scanState.scanReady ? 'Ready' : 'Next useful view'}</span>
            </div>
            <div className="instruction-content">
              <div className="direction-glyph" aria-hidden="true">{scanInstruction.direction}</div>
              <div>
                <p className="section-label">{scanInstruction.eyebrow}</p>
                <h2>{scanInstruction.title}</h2>
                <p className="instruction-copy">{instructionText}</p>
                {isScanning && motionUi.message && <div className={`motion-feedback motion-feedback-${motionUi.tone}`}>{motionUi.message}</div>}
                {isScanning && activeTarget && !['TRACKING_LOST', 'SCAN_COMPLETE'].includes(scanInstruction.type) && (
                  <div className="target-progress" aria-label={`${targetViewCount} of 3 useful viewpoints for this area`}>
                    <span>{targetDisplayName(activeTarget)}</span>
                    <span className="target-progress-dots" aria-hidden="true">
                      {[0, 1, 2].map((dot) => <i key={dot} className={dot < targetViewCount ? 'target-progress-dot target-progress-dot-filled' : 'target-progress-dot'} />)}
                    </span>
                    <small>{activeTarget.status === 'SUFFICIENT' || activeTarget.targetCaptureState === 'COMPLETE' ? 'Area captured' : `${targetViewCount}/3 useful views`}</small>
                  </div>
                )}
              </div>
            </div>
            <div className="instruction-meter-row">
              <span>{isFinished ? 'Scan status' : 'Useful coverage'}</span>
              <strong>{isFinished ? 'Ready to review' : `${roomCoverage}%`}</strong>
            </div>
            <div className="instruction-meter"><span style={{ width: `${roomCoverage}%` }} /></div>
            <p className="instruction-helper">{scanInstruction.helper} {!canFinish && finishHint}</p>
          </section>

          <div className="event-line"><span className="event-pulse" />{lastEvent}</div>

          {isScanning && activeTarget && (scanInstruction.type === 'SKIP_AREA' || scanState.targetStalled || activeTarget.status === 'LOW_TEXTURE') && (
            <div className="target-skip-row">
              <span>This area is optional for a usable room scan.</span>
              <button className="secondary-button" type="button" onClick={skipCurrentTarget}>Skip this area</button>
            </div>
          )}

          {isScanning && canFinish && !scanState.scanReady && (
            <div className="completion-suggestion" role="status">
              <strong>Your scan is usable.</strong>
              <span>One more pass may improve the result, but you can process it now.</span>
              <div className="completion-actions">
                <button className="secondary-button" type="button" onClick={() => setLastEvent('Keep scanning. The current coverage is safe.')}>Scan more</button>
                <button className="primary-button" type="button" onClick={finishScan}>Process anyway</button>
              </div>
            </div>
          )}

          <div className="control-actions">
            {!isScanning && !isFinished && (
              <button className="primary-button" type="button" onClick={startScan}>Start scan <span aria-hidden="true">↗</span></button>
            )}
            {isScanning && (
              <button className="primary-button" type="button" onClick={() => setIsPaused((paused) => !paused)}>
                {isPaused ? 'Resume scan' : 'Pause scan'} <span aria-hidden="true">{isPaused ? '▶' : 'Ⅱ'}</span>
              </button>
            )}
            {isFinished && roomSession && (
              <button className="primary-button" type="button" onClick={() => setViewMode('customize')}>
                Open room simulator <span aria-hidden="true">-&gt;</span>
              </button>
            )}
            {isScanning && (!canFinish || scanState.scanReady) && (
              <button className="secondary-button" type="button" onClick={finishScan} disabled={!canFinish} title={finishHint}>
                Finish scan
              </button>
            )}
            {isFinished && roomSession && (
              <button className="secondary-button" type="button" onClick={exportScan} disabled={isExporting}>
                {isExporting ? 'Preparing export...' : 'Export scan JSON'}
              </button>
            )}
          </div>
          {importError && <p className="action-note action-note-error">{importError}</p>}
          {!isScanning && !isFinished && <p className="action-note">Camera and movement tracking begin after you start.</p>}
          {isScanning && <p className="action-note">{sensorState === 'live' ? 'Keep moving around the room. Useful views are saved automatically.' : 'Keep moving around the room. Camera analysis is active.'}</p>}
          {isScanning && <p className="action-note action-note-guidance">{finishHint}</p>}
          {isFinished && <p className="action-note action-note-success">Your measured keyframes are saved. A real 3D mesh appears only after importing a reconstruction result or a native LiDAR session.</p>}
        </aside>
      </div>}
    </main>
  );
}

function roomDimensions(session) {
  const pathPoints = (session?.frames || []).map((frame) => ({
    x: Number(frame.pose?.x) || 0,
    z: Number(frame.pose?.z) || 0,
  }));
  const minX = Math.min(...pathPoints.map((point) => point.x), 0);
  const maxX = Math.max(...pathPoints.map((point) => point.x), 1);
  const minZ = Math.min(...pathPoints.map((point) => point.z), 0);
  const maxZ = Math.max(...pathPoints.map((point) => point.z), 1);
  return {
    pathPoints,
    minX,
    maxX,
    minZ,
    maxZ,
    width: clamp((maxX - minX) + 3.2, 4.8, 9.5),
    depth: clamp((maxZ - minZ) + 3.2, 4.8, 9.5),
    height: 2.8,
  };
}

function parsePLYGeometry(plyText) {
  if (typeof plyText !== 'string' || !plyText.startsWith('ply')) return null;
  const lines = plyText.split(/\r?\n/);
  const headerEnd = lines.indexOf('end_header');
  if (headerEnd < 0) return null;
  const vertexCount = Number(lines.find((line) => line.startsWith('element vertex '))?.split(' ')[2]);
  const faceCount = Number(lines.find((line) => line.startsWith('element face '))?.split(' ')[2]);
  if (!Number.isFinite(vertexCount) || !Number.isFinite(faceCount)) return null;

  const vertices = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const values = lines[headerEnd + 1 + index]?.trim().split(/\s+/).map(Number);
    if (!values || values.length < 3 || values.some((value) => !Number.isFinite(value))) return null;
    vertices.push(values[0], values[1], values[2]);
  }

  const faceBuckets = new Map();
  for (let index = 0; index < faceCount; index += 1) {
    const values = lines[headerEnd + 1 + vertexCount + index]?.trim().split(/\s+/).map(Number);
    if (!values || values.length < 4 || values[0] < 3) continue;
    const classification = Number.isFinite(values[4]) ? values[4] : 0;
    if (!faceBuckets.has(classification)) faceBuckets.set(classification, []);
    faceBuckets.get(classification).push(values[1], values[2], values[3]);
  }
  if (vertices.length === 0 || faceBuckets.size === 0) return null;

  const indices = [];
  const surfaceKeys = [];
  const surfaceNames = ['other', 'wall', 'floor', 'ceiling', 'table', 'seat', 'window', 'door'];
  const geometry = new THREE.BufferGeometry();
  faceBuckets.forEach((bucket, classification) => {
    const start = indices.length;
    indices.push(...bucket);
    geometry.addGroup(start, bucket.length, surfaceKeys.length);
    surfaceKeys.push(surfaceNames[classification] || 'other');
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.surfaceKeys = surfaceKeys;
  return geometry;
}

function assetFromDetection(observation, index) {
  const label = String(observation?.label || `Detected object ${index + 1}`);
  const normalized = label.toLowerCase();
  const kind = normalized.includes('bed') ? 'bed'
    : normalized.includes('desk') || normalized.includes('table') ? 'desk'
      : normalized.includes('chair') || normalized.includes('seat') || normalized.includes('sofa') || normalized.includes('couch') ? 'chair'
        : 'generic';
  const position = Number.isFinite(Number(observation?.x)) && Number.isFinite(Number(observation?.z))
    ? { x: Number(observation.x), z: Number(observation.z) }
    : undefined;
  return {
    name: label.replace(/\b\w/g, (character) => character.toUpperCase()),
    kind,
    coverage: 0,
    confidence: `${Math.round((Number(observation?.confidence) || 0) * 100)}% AI match`,
    position,
  };
}

function assetsFromSessionPayload(payload) {
  if (Array.isArray(payload.objects) && payload.objects.length > 0) return payload.objects;
  if (Array.isArray(payload.detectedObjects) && payload.detectedObjects.length > 0) {
    const bestByLabel = new Map();
    payload.detectedObjects.forEach((observation) => {
      const key = String(observation?.label || '').toLowerCase();
      const current = bestByLabel.get(key);
      if (!current || Number(observation?.confidence) > Number(current?.confidence)) bestByLabel.set(key, observation);
    });
    return [...bestByLabel.values()].map(assetFromDetection);
  }
  const summary = payload.surfaceSummary || {};
  const classifiedAssets = [];
  if (summary.table) classifiedAssets.push({ name: 'Table (ARKit)', kind: 'desk', coverage: 0, confidence: 'ARKit mesh class' });
  if (summary.seat) classifiedAssets.push({ name: 'Seat (ARKit)', kind: 'chair', coverage: 0, confidence: 'ARKit mesh class' });
  if (summary.window) classifiedAssets.push({ name: 'Window (ARKit)', kind: 'window', coverage: 0, confidence: 'ARKit mesh class' });
  return classifiedAssets;
}

function disposeRoomScene(scene) {
  scene.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (!child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material.map) material.map.dispose();
      material.dispose();
    });
  });
}

function RoomScene({ session, surfaceColors }) {
  const viewportRef = useRef(null);
  const canvasRef = useRef(null);
  const arSessionRef = useRef(null);
  const enterARRef = useRef(null);
  const hasMeshPayload = typeof session?.meshPLY === 'string' && session.meshPLY.startsWith('ply');
  const hasGlbPayload = typeof session?.glbUrl === 'string' && session.glbUrl.length > 0;
  const hasRenderableAsset = hasMeshPayload || hasGlbPayload;
  const [arSupport, setArSupport] = useState('checking');
  const [arActive, setArActive] = useState(false);
  const [arError, setArError] = useState('');
  const [sceneError, setSceneError] = useState('');

  useEffect(() => {
    let mounted = true;
    if (!navigator.xr?.isSessionSupported) {
      setArSupport('unavailable');
      return undefined;
    }
    navigator.xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        if (mounted) setArSupport(supported ? 'supported' : 'unavailable');
      })
      .catch(() => {
        if (mounted) setArSupport('unavailable');
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return undefined;

    let disposed = false;
    const scene = new THREE.Scene();
    const backgroundColor = new THREE.Color('#1a1c19');
    scene.background = backgroundColor;
    scene.fog = new THREE.Fog(backgroundColor, 8, 18);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 40);
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (error) {
      setSceneError('This browser cannot render the real 3D room mesh.');
      return undefined;
    }
    setSceneError('');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const dimensions = roomDimensions(session);
    const scanMeshGeometry = parsePLYGeometry(session.meshPLY);
    const hasGlb = typeof session.glbUrl === 'string' && session.glbUrl.length > 0;
    const { pathPoints } = dimensions;
    let { width, depth } = dimensions;
    let roomOffset = new THREE.Vector3();
    if (scanMeshGeometry) {
      scanMeshGeometry.computeBoundingBox();
      const bounds = scanMeshGeometry.boundingBox;
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      width = clamp(size.x, 3.5, 12);
      depth = clamp(size.z, 3.5, 12);
      roomOffset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);
    }
    const room = new THREE.Group();
    room.position.copy(roomOffset);
    scene.add(room);

    if (!scanMeshGeometry && !hasGlb) {
      setSceneError('This session has no real room mesh. Use the native iOS LiDAR scanner to build the 3D simulator.');
      return () => renderer.dispose();
    }

    scene.add(new THREE.HemisphereLight('#f4e9d5', '#2b302d', 2.1));
    const keyLight = new THREE.DirectionalLight('#ffe9c4', 2.8);
    keyLight.position.set(3, 5, 4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const fillLight = new THREE.PointLight('#a7c1bd', 1.2, 10);
    fillLight.position.set(-2, 2.2, 1.5);
    scene.add(fillLight);

    const materialColor = (surface) => surfaceColors?.[surface] || (surface === 'floor' ? '#59615a' : '#737a71');
    if (scanMeshGeometry) {
      const surfaceMaterialColors = {
        other: '#747970',
        wall: materialColor('wall'),
        floor: materialColor('floor'),
        ceiling: materialColor('ceiling'),
        table: '#8b806c',
        seat: '#8a7465',
        window: '#7ea8ae',
        door: '#796e60',
      };
      const surfaceMaterials = (scanMeshGeometry.userData.surfaceKeys || ['other']).map((surface) => new THREE.MeshStandardMaterial({
        color: surfaceMaterialColors[surface] || surfaceMaterialColors.other,
        roughness: surface === 'window' ? 0.24 : 0.88,
        metalness: surface === 'window' ? 0.12 : 0,
        transparent: surface === 'window',
        opacity: surface === 'window' ? 0.78 : 1,
        side: THREE.DoubleSide,
      }));
      const scanMesh = new THREE.Mesh(scanMeshGeometry, surfaceMaterials);
      scanMesh.castShadow = false;
      scanMesh.receiveShadow = true;
      room.add(scanMesh);
    } else {
      loadGLTFAsset(session.glbUrl, (gltf) => {
        if (disposed) {
          disposeRoomScene(gltf.scene);
          return;
        }
        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        room.position.set(-center.x, -bounds.min.y, -center.z);
        room.add(gltf.scene);
        setSceneError('');
      }, () => {
        if (!disposed) setSceneError('The measured GLB could not be loaded. The reconstruction result is still available for download.');
      });
    }

    const toRoomPoint = (point) => new THREE.Vector3(point.x, 0.08, point.z);
    const roomPath = pathPoints.map(toRoomPoint);
    if (roomPath.length > 1) {
      const pathLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(roomPath),
        new THREE.LineBasicMaterial({ color: '#ffc27c', transparent: true, opacity: 0.88 }),
      );
      room.add(pathLine);
    }
    const pathNodeMaterial = new THREE.MeshBasicMaterial({ color: '#9bd8b1' });
    roomPath.forEach((point) => {
      const node = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), pathNodeMaterial);
      node.position.copy(point);
      room.add(node);
    });

    const orbit = { azimuth: 0, elevation: 0.2, distance: Math.max(width, depth) * 0.92 };
    const target = new THREE.Vector3(0, 1.05, 0);
    const updateCamera = () => {
      const horizontalDistance = Math.cos(orbit.elevation) * orbit.distance;
      camera.position.set(Math.sin(orbit.azimuth) * horizontalDistance, target.y + Math.sin(orbit.elevation) * orbit.distance, Math.cos(orbit.azimuth) * horizontalDistance);
      camera.lookAt(target);
    };
    updateCamera();

    const pointer = { active: false, x: 0, y: 0 };
    const handlePointerDown = (event) => {
      pointer.active = true;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    };
    const handlePointerMove = (event) => {
      if (!pointer.active || renderer.xr.isPresenting) return;
      orbit.azimuth -= (event.clientX - pointer.x) * 0.008;
      orbit.elevation = clamp(orbit.elevation + (event.clientY - pointer.y) * 0.006, -0.05, 0.82);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      updateCamera();
    };
    const handlePointerUp = () => {
      pointer.active = false;
    };
    const handleWheel = (event) => {
      if (renderer.xr.isPresenting) return;
      event.preventDefault();
      orbit.distance = clamp(orbit.distance + event.deltaY * 0.006, 3.5, 12);
      updateCamera();
    };
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    const resize = () => {
      const bounds = viewport.getBoundingClientRect();
      const sceneWidth = Math.max(bounds.width, 1);
      const sceneHeight = Math.max(bounds.height, 1);
      renderer.setSize(sceneWidth, sceneHeight, false);
      camera.aspect = sceneWidth / sceneHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    renderer.setAnimationLoop(() => renderer.render(scene, camera));

    const enterAR = async () => {
      if (!navigator.xr || arSupport !== 'supported' || arSessionRef.current) return;
      try {
        setArError('');
        const xrSession = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor', 'dom-overlay'], domOverlay: { root: viewport } });
        if (disposed) {
          xrSession.end();
          return;
        }
        renderer.xr.enabled = true;
        renderer.xr.setReferenceSpaceType('local-floor');
        await renderer.xr.setSession(xrSession);
        scene.background = null;
        scene.fog = null;
        arSessionRef.current = xrSession;
        setArActive(true);
        const handleSessionEnd = () => {
          arSessionRef.current = null;
          renderer.xr.enabled = false;
          scene.background = backgroundColor;
          scene.fog = new THREE.Fog(backgroundColor, 8, 18);
          if (!disposed) setArActive(false);
        };
        xrSession.addEventListener('end', handleSessionEnd, { once: true });
      } catch (error) {
        setArError('AR could not start. The 3D room is still available here.');
      }
    };
    enterARRef.current = enterAR;

    return () => {
      disposed = true;
      enterARRef.current = null;
      if (arSessionRef.current) arSessionRef.current.end().catch(() => {});
      renderer.setAnimationLoop(null);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', resize);
      disposeRoomScene(scene);
      renderer.dispose();
    };
  }, [session, surfaceColors, arSupport]);

  const enterAR = () => enterARRef.current?.();
  const exitAR = () => arSessionRef.current?.end();

  return (
    <div className={`room-scene-viewport ${arActive ? 'room-scene-viewport-ar' : ''}`} ref={viewportRef}>
      <canvas className="room-scene-canvas" ref={canvasRef} aria-label="Interactive 3D room mesh captured from the real room" />
      {sceneError && <p className="room-scene-empty">{sceneError}</p>}
      <div className="room-scene-toolbar">
        <span>{sceneError ? 'A real mesh is required for this viewer.' : arActive ? 'Move your phone to view the room in AR.' : 'Drag to look around. Scroll to zoom.'}</span>
        {hasRenderableAsset && arSupport === 'supported' && !arActive && <button type="button" className="scene-ar-button" onClick={enterAR}>Enter AR</button>}
        {arActive && <button type="button" className="scene-ar-button" onClick={exitAR}>Exit AR</button>}
        {arSupport === 'checking' && <span className="scene-capability">Checking AR...</span>}
        {arSupport === 'unavailable' && <span className="scene-capability">Real mesh viewer</span>}
      </div>
      {arError && <p className="room-scene-error">{arError}</p>}
    </div>
  );
}

function RoomCustomizer({ session, onExport, isExporting, onReconstruct, isReconstructing, reconstructionState }) {
  const [surfaceColors, setSurfaceColors] = useState({ wall: '#737a71', floor: '#59615a', ceiling: '#9a9c92' });
  const hasLiDARMesh = typeof session.meshPLY === 'string' && session.meshPLY.startsWith('ply');
  const hasRealMesh = hasLiDARMesh || Boolean(session.glbUrl);
  const canEditSurfaces = hasLiDARMesh;
  const meshLabel = hasLiDARMesh ? 'LiDAR mesh' : session.glbUrl ? 'Photogrammetry GLB' : 'Mesh required';

  const updateSurfaceColor = (surface, color) => {
    setSurfaceColors((current) => ({ ...current, [surface]: color }));
  };

  const pathPoints = session.frames.map((frame) => ({
    x: Number(frame.pose?.x) || 0,
    z: Number(frame.pose?.z) || 0,
  }));
  const minX = Math.min(...pathPoints.map((point) => point.x), 0);
  const maxX = Math.max(...pathPoints.map((point) => point.x), 1);
  const minZ = Math.min(...pathPoints.map((point) => point.z), 0);
  const maxZ = Math.max(...pathPoints.map((point) => point.z), 1);
  const pathRangeX = Math.max(maxX - minX, 0.5);
  const pathRangeZ = Math.max(maxZ - minZ, 0.5);
  const pathPolyline = pathPoints.map((point) => {
    const x = 10 + ((point.x - minX) / pathRangeX) * 80;
    const y = 10 + ((point.z - minZ) / pathRangeZ) * 80;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastPathCoordinate = pathPolyline.split(' ').pop()?.split(',');

  return (
    <div className="customizer-workspace">
      <div className="customizer-header">
        <div>
          <p className="section-label">Real room simulator</p>
          <h1>Inspect the real room mesh.</h1>
          <p className="customizer-intro">Orbit the captured geometry, then preview paint and flooring changes on the actual scanned surfaces.</p>
        </div>
        <div className="customizer-header-actions">
          <span className="session-chip">{meshLabel}</span>
          {session.glbUrl && <a className="secondary-button download-button" href={session.glbUrl} download="room.glb">Download room.glb</a>}
          <button className="secondary-button" type="button" onClick={onExport} disabled={isExporting}>
            {isExporting ? 'Preparing...' : 'Export session'}
          </button>
        </div>
      </div>

      <div className="customizer-grid">
        <section className="customizer-stage-panel" aria-label="Scanned room simulator">
          <div className="customizer-stage">
            <RoomScene session={session} surfaceColors={surfaceColors} />
            <div className="customizer-stage-shade" />
            <div className="customizer-stage-meta">
              <span>{hasRealMesh ? 'REAL ROOM MESH' : 'MESH REQUIRED'}</span>
              <span>{hasLiDARMesh ? 'ARKit geometry' : session.glbUrl ? 'COLMAP geometry' : 'No synthetic room'}</span>
            </div>
          </div>
        </section>

        <aside className="customizer-controls">
          <div className="customizer-control-heading">
            <div>
              <p className="section-label">Simulator controls</p>
              <h2>Surface materials</h2>
            </div>
            <span className="tracking-badge tracking-badge-live">{meshLabel}</span>
          </div>

          <div className="surface-materials">
            <div className="customizer-slider-label"><span>Scanned surfaces</span><strong>{canEditSurfaces ? 'EDITABLE' : 'READ ONLY'}</strong></div>
            {Object.entries(surfaceColors).map(([surface, color]) => (
              <div className="surface-material-row" key={surface}>
                <span>{surface.charAt(0).toUpperCase() + surface.slice(1)}</span>
                <div className="color-picker">
                  {['#737a71', '#59615a', '#a5a091', '#8b7465', '#6f8f8e'].map((swatch) => (
                    <button className={`color-swatch ${color === swatch ? 'color-swatch-active' : ''}`} style={{ backgroundColor: swatch }} type="button" key={swatch} onClick={() => updateSurfaceColor(surface, swatch)} aria-label={`Set ${surface} to ${swatch}`} disabled={!canEditSurfaces} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {session.glbUrl && !session.meshPLY && <p className="action-note">This photogrammetry mesh keeps measured color. Wall/floor selection will be enabled when semantic surface segmentation is added.</p>}

          <div className="room-map-panel">
            <div className="panel-heading-row"><div><p className="section-label">Tracking trace</p><h2>Camera path</h2></div><span className="object-count">{hasRealMesh ? 'ARKit' : 'Browser path'}</span></div>
            <svg className="room-map" viewBox="0 0 100 100" role="img" aria-label="Room tracking path used to capture the scan">
              <rect x="8" y="8" width="84" height="84" rx="2" />
              <polyline points={pathPolyline} />
              {pathPoints.length > 0 && <circle cx={lastPathCoordinate?.[0]} cy={lastPathCoordinate?.[1]} r="3" />}
            </svg>
          </div>
          {!hasRealMesh && (
            <div className="reconstruction-action">
              <button className="primary-button" type="button" onClick={onReconstruct} disabled={isReconstructing || session.frames.filter((frame) => frame.image).length < 3}>
                {isReconstructing ? 'Reconstructing measured mesh...' : 'Build real 3D room'} <span aria-hidden="true">-&gt;</span>
              </button>
              {reconstructionState && <p className={`action-note ${reconstructionState.status === 'error' ? 'action-note-error' : 'action-note-guidance'}`}>{reconstructionState.message}</p>}
            </div>
          )}
          <p className="customizer-disclaimer">Only a native iOS LiDAR session supplies real room geometry here. Browser camera sessions do not become a 3D room, and this simulator will not invent walls, furniture, or image panels.</p>
        </aside>
      </div>
    </div>
  );
}

function CoverageMap({ scanState, targetRegion }) {
  return (
    <section className="coverage-panel" aria-label="Measured scan coverage">
      <div className="coverage-panel-heading">
        <div>
          <p className="section-label">Live coverage map</p>
          <h2>Observed view sectors</h2>
        </div>
        <span className="tracking-badge" title="Weighted useful scan progress">{Math.round(((scanState.scanProgress ?? scanState.totalCoverage) || 0) * 100)}%</span>
      </div>
      <div className="coverage-map" role="img" aria-label="Coverage by camera orientation and vertical surface band">
        {COVERAGE_ROWS.map((row) => (
          <div className="coverage-map-row" key={row.id}>
            <span className="coverage-map-label">{row.label}</span>
            <div className="coverage-map-cells">
              {scanState.coverageRegions.filter((region) => region.row === row.id).map((region) => {
                const coverage = Math.round(region.coverage * 100);
                const coverageClass = coverage >= 70 ? 'coverage-high' : coverage >= 35 ? 'coverage-medium' : 'coverage-low';
                const statusClass = region.status === 'INFERABLE' ? 'coverage-inferable' : region.skipped ? 'coverage-skipped' : '';
                return <span className={`coverage-cell ${coverageClass} ${statusClass} ${targetRegion?.id === region.id ? 'coverage-target' : ''}`} key={region.id} title={`${row.label}, sector ${region.column + 1}: ${coverage}% coverage (${region.status || 'UNSEEN'})`} aria-label={`${row.label}, sector ${region.column + 1}, ${coverage}% coverage, ${region.status || 'UNSEEN'}`} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="coverage-legend" aria-hidden="true"><span><i className="coverage-key coverage-key-high" />Enough</span><span><i className="coverage-key coverage-key-medium" />Needs angle</span><span><i className="coverage-key coverage-key-low" />Needs coverage</span></div>
    </section>
  );
}

function TelemetryValue({ label, value }) {
  return <div className="telemetry-value"><span>{label}</span><strong>{value}</strong></div>;
}

export { createInitialScanState, scannerMotionConfig, MOTION_STATES };
export default App;
