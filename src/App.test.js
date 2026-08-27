import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { canManuallyFinishScan, calculateScanProgress, calculateScanReadiness, countFeaturesInRegion, createCameraDisplayTransform, createGuidanceController, createInitialScanState, determineNextAction, isTargetStalled, normalizedToDisplay, recordFrameEvaluation, updateCoverageFromFrame, validateTargetGeometry } from './App';

const goodAnalysis = {
  qualityScore: 0.82,
  featureCount: 180,
  detectedFeatureCount: 220,
  trackedFeatureCount: 150,
  featureTrackingQuality: 0.8,
  sharpness: 0.8,
  brightness: 0.5,
  motionBlur: false,
  poorLighting: false,
  sceneChange: 0.3,
  featurePointsDisplay: [{ x: 0.45, y: 0.45 }, { x: 0.5, y: 0.5 }, { x: 0.55, y: 0.55 }],
  featureTrackIds: ['ft-1', 'ft-2', 'ft-3'],
  sceneUnderstanding: { grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ detail: 0.8, brightness: 0.5 }))) },
};

test('renders the SmartScan starting state', () => {
  render(<App />);

  expect(screen.getByText('Capture progress')).toBeInTheDocument();
  expect(screen.getByText('Keep the room in view while you move.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /start scan/i })).toBeInTheDocument();
});

test('starts with initial mapping guidance and no target request', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));

  await waitFor(() => expect(screen.getByText('Slowly move around the room while looking around.')).toBeInTheDocument());
  expect(screen.getByRole('region', { name: /measured scan coverage/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /pause scan/i })).toBeInTheDocument();
  expect(screen.queryByText(/left ceiling|right ceiling|upper wall/i)).not.toBeInTheDocument();
});

test('insufficient live data keeps guidance in initial mapping', () => {
  const action = determineNextAction({ ...createInitialScanState(), framesEvaluated: 4, acceptedFrames: 4 });
  expect(action.type).toBe('INITIAL_MAPPING');
  expect(action.instruction).toBe('Slowly move around the room while looking around.');
});

test('rejected frames do not add keyframes or spatial observations', () => {
  const initial = createInitialScanState();
  const accepted = updateCoverageFromFrame(initial, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, goodAnalysis, 0, { accepted: true, keyframeId: 1, observedAt: 1000 });
  const rejected = updateCoverageFromFrame(accepted, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, { ...goodAnalysis, qualityScore: 0.05, featureCount: 2 }, 0, { accepted: false, observedAt: 1200 });

  expect(accepted.acceptedFrames).toBe(1);
  expect(rejected.acceptedFrames).toBe(1);
  expect(rejected.mapping.acceptedKeyframes).toBe(1);
  expect(rejected.mapping.sparseObservations).toEqual(accepted.mapping.sparseObservations);
});

test('readiness allows a usable scan without requiring 100 percent coverage', () => {
  const readiness = calculateScanReadiness({
    acceptedFrames: 24,
    totalCoverage: 0.58,
    wallCoverage: 0.62,
    floorCoverage: 0.34,
    ceilingCoverage: 0.35,
    viewpointDiversity: 0.25,
    imageQuality: 0.78,
    featureTrackingQuality: 0.8,
  });

  expect(readiness.ready).toBe(true);
  expect(readiness.coverage).toBeLessThan(1);
});

test('manual finish unlocks after a reasonable minimum even when the scan is not ready', () => {
  expect(canManuallyFinishScan({
    phase: 'ADAPTIVE_COVERAGE',
    acceptedFrames: 18,
    totalCoverage: 0.34,
    wallCoverage: 0.3,
    floorCoverage: 0.14,
    viewpointDiversity: 0.14,
  })).toBe(true);
});

test('guidance holds its target before accepting a lower-priority change', () => {
  const controller = createGuidanceController({ minHoldMs: 2800 });
  const first = { type: 'MOVE_RIGHT', targetRegion: { id: 'observed-1' }, priority: 0.8, confidence: 0.86 };
  const next = { type: 'MOVE_LEFT', targetRegion: { id: 'observed-2' }, priority: 0.6, confidence: 0.78 };

  expect(controller.update(first, 1000)).toBe(first);
  expect(controller.update(next, 2200)).toBe(first);
  expect(controller.update(next, 4000)).toBe(next);
});

test('guidance changes immediately when tracking returns', () => {
  const controller = createGuidanceController({ minHoldMs: 2800 });
  const lost = { type: 'TRACKING_LOST', priority: 1.2, confidence: 0.95 };
  const recovered = { type: 'INITIAL_MAPPING', priority: 0.6, confidence: 0.76 };

  controller.update(lost, 1000);
  expect(controller.update(recovered, 1100)).toBe(recovered);
});

test('progress reflects useful structural, viewpoint, keyframe, and reconstruction evidence', () => {
  expect(calculateScanProgress({ structuralCoverage: 0.5, viewpointDiversity: 0.5, acceptedFrames: 18, reconstructionConfidence: 0.5 })).toBeCloseTo(0.5, 2);
  expect(calculateScanProgress({ structuralCoverage: 1, viewpointDiversity: 1, acceptedFrames: 36, reconstructionConfidence: 1 })).toBe(1);
});

test('stalled target watchdog waits for a sustained period and meaningful local gain', () => {
  const target = { id: 'observed-2', coverage: 0.2 };
  const watchdog = { targetId: target.id, startedAt: 1000, startingCoverage: 0.2 };

  expect(isTargetStalled(watchdog, target, 10999)).toBe(false);
  expect(isTargetStalled(watchdog, { ...target, coverage: 0.25 }, 11000)).toBe(false);
  expect(isTargetStalled(watchdog, target, 11000)).toBe(true);
});

test('frame evaluation diagnostics count processed camera samples', () => {
  const state = recordFrameEvaluation(createInitialScanState(), {
    frameDimensions: { width: 1920, height: 1080 },
    displayDimensions: { width: 390, height: 844 },
    featurePointsDisplay: [{ x: 0.1, y: 0.1 }],
  }, 2000, 1000);

  expect(state.cameraFramesReceived).toBe(1);
  expect(state.framesEvaluated).toBe(1);
  expect(state.evaluationFps).toBe(1);
  expect(state.lastFrameTimestamp).toBe(2000);
  expect(state.cameraFrameDimensions).toEqual({ width: 1920, height: 1080 });
});

test('canonical camera/display conversion accounts for cover cropping and mirroring', () => {
  const cover = createCameraDisplayTransform({ rawWidth: 1920, rawHeight: 1080, displayWidth: 390, displayHeight: 844 });
  expect(cover.cropX).toBeGreaterThan(0);
  expect(normalizedToDisplay({ x: 0.5, y: 0.5 }, cover)).toEqual({ x: 0.5, y: 0.5 });

  const mirrored = createCameraDisplayTransform({ rawWidth: 100, rawHeight: 100, displayWidth: 100, displayHeight: 100, mirrored: true });
  expect(normalizedToDisplay({ x: 0.1, y: 0.2 }, mirrored)).toEqual({ x: 0.9, y: 0.2 });
});

test('screen-space diagnostic target recognizes its first accepted observation', () => {
  const state = updateCoverageFromFrame(createInitialScanState(), { heading: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, {
    ...goodAnalysis,
    featurePointsDisplay: [{ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.7 }],
  }, 0, { accepted: true, keyframeId: 1, observedAt: 1000 });

  expect(countFeaturesInRegion([{ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.7 }], { x: 0, y: 0, width: 0.4, height: 0.4 })).toBe(1);
  expect(state.diagnosticTarget.visible).toBe(true);
  expect(state.diagnosticTarget.featuresInsideTarget).toBe(1);
  expect(state.diagnosticTarget.firstObservationStatus).toBe('REGISTERED');
});

test('invalid target geometry reports an explicit diagnostic error', () => {
  expect(validateTargetGeometry({ id: 'bad', yaw: Number.NaN, pitch: 0 })).toEqual({ valid: false, reason: 'INVALID_TARGET_COORDINATES' });
});
