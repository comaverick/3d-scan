import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { canManuallyFinishScan, calculateScanProgress, calculateScanReadiness, createGuidanceController, createInitialScanState, determineNextAction, isTargetStalled, targetViewConfig, updateCoverageFromFrame } from './App';

test('renders the SmartScan starting state', () => {
  render(<App />);

  expect(screen.getByText('Capture progress')).toBeInTheDocument();
  expect(screen.getByText('Keep the room in view while you move.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /start scan/i })).toBeInTheDocument();
});

test('starts adaptive coverage guidance', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));

  await waitFor(() => expect(screen.getByText('Aim at the room and start moving')).toBeInTheDocument());
  expect(screen.getByRole('region', { name: /measured scan coverage/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /pause scan/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /mark checkpoint/i })).not.toBeInTheDocument();
});

test('changes the next-best-view instruction from measured scan state', () => {
  const base = createInitialScanState();
  const qualityWarning = determineNextAction({ ...base, acceptedFrames: 4, trackingQuality: 0.18, frameQuality: 0.2, trackedFeatureCount: 11 });
  const parallaxWarning = determineNextAction({
    ...base,
    acceptedFrames: 4,
    trackingQuality: 0.72,
    frameQuality: 0.72,
    rotationOnly: true,
  });

  expect(qualityWarning.type).not.toBe('TRACKING_LOST');
  expect(parallaxWarning.type).not.toBe('TRACKING_LOST');
  expect(qualityWarning.label).toBe('SCAN THIS AREA');
  expect(qualityWarning.title).not.toMatch(/quality|tracking/i);
});

test('keeps adaptive guidance active when estimated translation speed is high', () => {
  const action = determineNextAction({
    ...createInitialScanState(),
    acceptedFrames: 4,
    trackingQuality: 0.72,
    frameQuality: 0.72,
    movementSpeed: 1.2,
  });

  expect(action.type).toBe('LOOK_UP');
  expect(action.label).not.toBe('TOO FAST');
});

test('rejected frames do not advance or reset measured coverage', () => {
  const initial = createInitialScanState();
  const goodAnalysis = {
    qualityScore: 0.82,
    featureCount: 180,
    detectedFeatureCount: 220,
    featureTrackingQuality: 0.8,
    sharpness: 0.8,
    brightness: 0.5,
    motionBlur: false,
    poorLighting: false,
    sceneChange: 0.8,
  };
  const badAnalysis = { ...goodAnalysis, qualityScore: 0.05, featureCount: 2, featureTrackingQuality: 0.03, motionBlur: true };
  const covered = updateCoverageFromFrame(initial, { heading: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, goodAnalysis, 0.3, { accepted: true, observedAt: 1000 });
  const rejected = updateCoverageFromFrame(covered, { heading: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, badAnalysis, 0.01, { accepted: false, observedAt: 1200 });

  expect(covered.totalCoverage).toBeGreaterThan(0);
  expect(rejected.totalCoverage).toBe(covered.totalCoverage);
  expect(rejected.coverageRegions.map((region) => region.coverage)).toEqual(covered.coverageRegions.map((region) => region.coverage));
});

test('readiness allows a usable scan without requiring 100 percent coverage', () => {
  const state = {
    acceptedFrames: 24,
    totalCoverage: 0.58,
    wallCoverage: 0.62,
    floorCoverage: 0.34,
    ceilingCoverage: 0.35,
    viewpointDiversity: 0.25,
    imageQuality: 0.78,
    featureTrackingQuality: 0.8,
  };
  const readiness = calculateScanReadiness(state);

  expect(readiness.ready).toBe(true);
  expect(readiness.coverage).toBeLessThan(1);
});

test('manual finish unlocks after a reasonable minimum even when the scan is not ready', () => {
  expect(canManuallyFinishScan({
    acceptedFrames: 18,
    totalCoverage: 0.34,
    wallCoverage: 0.3,
    floorCoverage: 0.14,
    viewpointDiversity: 0.14,
  })).toBe(true);
});

test('guidance holds its target before accepting a lower-priority change', () => {
  const controller = createGuidanceController({ minHoldMs: 2800 });
  const first = { type: 'LOOK_UP', targetRegion: { id: 'ceiling-0' }, priority: 0.8, confidence: 0.86 };
  const next = { type: 'MOVE_RIGHT', targetRegion: { id: 'middle-1' }, priority: 0.6, confidence: 0.78 };

  expect(controller.update(first, 1000)).toBe(first);
  expect(controller.update(next, 2200)).toBe(first);
  expect(controller.update(next, 4000)).toBe(next);
});

test('guidance changes immediately when tracking returns', () => {
  const controller = createGuidanceController({ minHoldMs: 2800 });
  const lost = { type: 'TRACKING_LOST', priority: 1.2, confidence: 0.95 };
  const recovered = { type: 'SCAN_LOW_COVERAGE_REGION', targetRegion: { id: 'middle-2' }, priority: 0.6, confidence: 0.76 };

  controller.update(lost, 1000);
  expect(controller.update(recovered, 1100)).toBe(recovered);
});

test('a visible upper-wall cell changes from aiming to lateral movement guidance', () => {
  const base = createInitialScanState();
  const target = {
    ...base.coverageRegions.find((region) => region.id === 'upper-1'),
    currentlyVisible: true,
    screenBounds: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
    screenPosition: { x: 0.5, y: 0.3 },
    coverage: 0.22,
    status: 'PARTIAL',
    featureDensity: 0.7,
    uniqueViewAngles: 1,
    parallaxScore: 0.12,
    priority: 0.9,
  };
  const state = {
    ...base,
    framesEvaluated: 12,
    acceptedFrames: 6,
    currentOrientation: { heading: 30, pitch: 0.28 },
    coverageRegions: base.coverageRegions.map((region) => region.id === target.id ? target : region),
    lowCoverageRegions: [target],
  };
  const aimAction = determineNextAction({
    ...state,
    currentOrientation: { heading: 0, pitch: 0 },
    lowCoverageRegions: [{ ...target, currentlyVisible: false }],
  });

  const action = determineNextAction(state);

  expect(aimAction.type).toBe('LOOK_UP');
  expect(aimAction.reason).toBe('TARGET_NOT_VISIBLE');
  expect(action.type).toBe('MOVE_RIGHT');
  expect(action.reason).toBe('LOW_VIEWPOINT_DIVERSITY');
  expect(action.aimInstruction.direction).toBe('CENTER');
  expect(action.movementInstruction.type).toBe('STEP_RIGHT');
  expect(action.instruction).toMatch(/keep.*visible.*step/i);
});

test('guidance switches immediately from aim to move when the held target becomes visible', () => {
  const controller = createGuidanceController({ minHoldMs: 4000 });
  const target = { id: 'upper-1', currentlyVisible: false };
  const aim = { type: 'LOOK_UP', targetRegion: target, adaptiveGuidance: { aimInstruction: { direction: 'UP' }, movementInstruction: { type: 'NONE' } }, priority: 0.8, confidence: 0.86 };
  const move = { type: 'MOVE_RIGHT', targetRegion: { ...target, currentlyVisible: true }, adaptiveGuidance: { aimInstruction: { direction: 'CENTER' }, movementInstruction: { type: 'STEP_RIGHT' } }, priority: 0.8, confidence: 0.84 };

  controller.update(aim, 1000);
  expect(controller.update(move, 1100)).toBe(move);
});

test('a localized target completes after useful lateral viewpoints instead of looping', () => {
  const base = createInitialScanState();
  const analysis = {
    qualityScore: 0.82,
    featureCount: 220,
    detectedFeatureCount: 250,
    trackedFeatureCount: 150,
    featureTrackingQuality: 0.8,
    sharpness: 0.8,
    brightness: 0.5,
    motionBlur: false,
    poorLighting: false,
    sceneChange: 0.8,
    sceneUnderstanding: {
      grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ detail: 0.8, brightness: 0.5 }))),
    },
  };
  const orientation = { heading: 30, pitch: 0.28 };
  const targetId = 'upper-1';
  const first = updateCoverageFromFrame(base, orientation, { x: 0, y: 0, z: 0 }, analysis, 0.2, { accepted: true, activeTargetId: targetId, keyframeId: 1, observedAt: 1000 });
  const second = updateCoverageFromFrame(first, orientation, { x: 0.2, y: 0, z: 0 }, analysis, 0.2, { accepted: true, activeTargetId: targetId, keyframeId: 2, observedAt: 2000 });
  const third = updateCoverageFromFrame(second, orientation, { x: 0.4, y: 0, z: 0 }, analysis, 0.2, { accepted: true, activeTargetId: targetId, keyframeId: 3, observedAt: 3000 });
  const target = third.coverageRegions.find((region) => region.id === 'upper-1');

  expect(first.visibleRegionIds).toContain('upper-1');
  expect(first.sceneUnderstanding.method).toBe('deterministic-spatial-gradient');
  expect(target.observationCount).toBe(3);
  expect(target.acceptedKeyframeIds).toEqual([1, 2, 3]);
  expect(first.coverageRegions.find((region) => region.id === targetId).usefulViews).toBe(1);
  expect(second.coverageRegions.find((region) => region.id === targetId).usefulViews).toBe(2);
  expect(target.usefulViews).toBe(targetViewConfig.requiredUsefulViews);
  expect(target.targetCaptureState).toBe('COMPLETE');
  expect(target.uniqueViewAngles).toBe(3);
  expect(target.status).toBe('SUFFICIENT');
  expect(third.lowCoverageRegions.some((region) => region.id === 'upper-1')).toBe(false);
});

test('a duplicate accepted viewpoint does not increment the active target', () => {
  const base = createInitialScanState();
  const analysis = {
    qualityScore: 0.82,
    featureCount: 220,
    trackedFeatureCount: 150,
    featureTrackingQuality: 0.8,
    sharpness: 0.8,
    brightness: 0.5,
    motionBlur: false,
    poorLighting: false,
    sceneChange: 0.01,
    sceneUnderstanding: {
      grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ detail: 0.8, brightness: 0.5 }))),
    },
  };
  const orientation = { heading: 30, pitch: 0.28 };
  const first = updateCoverageFromFrame(base, orientation, { x: 0, y: 0, z: 0 }, analysis, 0, { accepted: true, activeTargetId: 'upper-1', keyframeId: 1, observedAt: 1000 });
  const duplicate = updateCoverageFromFrame(first, orientation, { x: 0, y: 0, z: 0 }, analysis, 0, { accepted: true, activeTargetId: 'upper-1', keyframeId: 2, observedAt: 2000 });
  const target = duplicate.coverageRegions.find((region) => region.id === 'upper-1');

  expect(target.usefulViews).toBe(1);
  expect(target.targetViewRejectionReasons.DUPLICATE_VIEW).toBe(1);
  expect(duplicate.lastTargetViewDecision.reason).toBe('DUPLICATE_VIEW');
});

test('an accepted frame is recorded against the canonical active target, not the nearest cell', () => {
  const base = createInitialScanState();
  const analysis = {
    qualityScore: 0.82,
    featureCount: 220,
    trackedFeatureCount: 150,
    featureTrackingQuality: 0.8,
    motionBlur: false,
    poorLighting: false,
    sceneChange: 0.4,
    sceneUnderstanding: {
      grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ detail: 0.8, brightness: 0.5 }))),
    },
  };
  // At heading 60 the nearest cell is upper-2, but upper-1 is still visibly
  // inside the frustum and is the target shown by the UI.
  const state = updateCoverageFromFrame(
    base,
    { heading: 60, pitch: 0.28 },
    { x: 0, y: 0, z: 0 },
    analysis,
    0,
    { accepted: true, activeTargetId: 'upper-1', keyframeId: 1, observedAt: 1000 },
  );

  expect(state.activeTargetId).toBe('upper-1');
  expect(state.lastTargetViewDecision.targetRegionId).toBe('upper-1');
  expect(state.lastTargetViewDecision.qualified).toBe(true);
  expect(state.coverageRegions.find((region) => region.id === 'upper-1').usefulViews).toBe(1);
  expect(state.coverageRegions.find((region) => region.id === 'upper-2').usefulViews).toBe(0);
});

test('progress reflects useful structural, viewpoint, keyframe, and reconstruction evidence', () => {
  expect(calculateScanProgress({
    structuralCoverage: 0.5,
    viewpointDiversity: 0.5,
    acceptedFrames: 18,
    reconstructionConfidence: 0.5,
  })).toBeCloseTo(0.5, 2);
  expect(calculateScanProgress({ structuralCoverage: 1, viewpointDiversity: 1, acceptedFrames: 36, reconstructionConfidence: 1 })).toBe(1);
});

test('stalled target watchdog waits for a sustained period and meaningful local gain', () => {
  const target = { id: 'upper-2', coverage: 0.2 };
  const watchdog = { targetId: target.id, startedAt: 1000, startingCoverage: 0.2 };

  expect(isTargetStalled(watchdog, target, 10999)).toBe(false);
  expect(isTargetStalled(watchdog, { ...target, coverage: 0.25 }, 11000)).toBe(false);
  expect(isTargetStalled(watchdog, target, 11000)).toBe(true);
});

test('repeated low-texture observations become inferable from strong neighboring cells', () => {
  const base = createInitialScanState();
  const seeded = {
    ...base,
    coverageRegions: base.coverageRegions.map((region) => ['upper-0', 'upper-2'].includes(region.id)
      ? { ...region, coverage: 0.82, status: 'SUFFICIENT' }
      : region),
  };
  const plainAnalysis = {
    qualityScore: 0.82,
    featureCount: 12,
    detectedFeatureCount: 14,
    trackedFeatureCount: 10,
    featureTrackingQuality: 0.5,
    sharpness: 0.8,
    brightness: 0.5,
    motionBlur: false,
    poorLighting: false,
    sceneChange: 0.4,
    sceneUnderstanding: { grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ detail: 0, brightness: 0.5 }))) },
  };
  const orientation = { heading: 30, pitch: 0.28 };
  const first = updateCoverageFromFrame(seeded, orientation, { x: 0, y: 0, z: 0 }, plainAnalysis, 0, { accepted: true, observedAt: 1000 });
  const second = updateCoverageFromFrame(first, orientation, { x: 0, y: 0, z: 0 }, plainAnalysis, 0, { accepted: true, observedAt: 2000 });
  const third = updateCoverageFromFrame(second, orientation, { x: 0, y: 0, z: 0 }, plainAnalysis, 0, { accepted: true, observedAt: 3000 });

  expect(third.coverageRegions.find((region) => region.id === 'upper-1').status).toBe('INFERABLE');
  expect(third.lowCoverageRegions.some((region) => region.id === 'upper-1')).toBe(false);
});
