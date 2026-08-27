import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { blueCoverageOpacity, canManuallyFinishScan, calculateScanProgress, calculateScanReadiness, chooseGuidancePlacement, compactGuidanceFor, continuousScanInstructionFor, countFeaturesInRegion, coverageOverlayRegionsFor, createCameraDisplayTransform, createDirectionalCoverageGrid, createGuidanceController, createInitialScanState, determineNextAction, distinctViewpointsFromFrames, estimateSupportedPlanes, friendlyReconstructionError, isTargetStalled, normalizedToDisplay, ProcessingScreen, projectDirectionalCoverageCells, reconstructionProgressSteps, reconstructionStatusLabel, recordFrameEvaluation, selectReconstructionKeyframes, stabilizeScanProgress, structuralEdgesFromPlanes, summarizeDirectionalCoverage, targetPriorityForScan, triangulateSparsePoints, updateCoverageFromFrame, updateDirectionalCoverageGrid, updateFeatureTracks, validateTargetGeometry, viewpointNovelty } from './App';

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
  const { container } = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));

  await waitFor(() => expect(screen.getByText('Move slowly around the room')).toBeInTheDocument());
  expect(screen.queryByRole('region', { name: /measured scan coverage/i })).not.toBeInTheDocument();
  expect(container.querySelector('.scanner-spatial-overlay')).toBeInTheDocument();
  expect(container.querySelector('.scanner-live-hud')).toBeInTheDocument();
  expect(container.querySelector('.scanner-compact-guidance')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /pause scan/i })).toBeInTheDocument();
  expect(screen.queryByText(/left ceiling|right ceiling|upper wall/i)).not.toBeInTheDocument();
});

test('insufficient live data keeps guidance in initial mapping', () => {
  const action = determineNextAction({ ...createInitialScanState(), framesEvaluated: 4, acceptedFrames: 4 });
  expect(action.type).toBe('INITIAL_MAPPING');
  expect(action.instruction).toBe('Move slowly around the room.');
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

test('readiness does not trap a structurally useful scan on missing floor percentage', () => {
  const readiness = calculateScanReadiness({
    phase: 'ADAPTIVE_COVERAGE',
    acceptedFrames: 24,
    totalCoverage: 0.58,
    wallCoverage: 0.62,
    floorCoverage: 0,
    viewpointDiversity: 0.25,
    imageQuality: 0.78,
    featureTrackingQuality: 0.8,
  });

  expect(readiness.ready).toBe(true);
  expect(readiness.blockingRequirements.find((requirement) => requirement.key === 'floor').optional).toBe(true);
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

test('display progress stays stable when a new target changes the computed denominator', () => {
  const next = stabilizeScanProgress(
    { phase: 'ADAPTIVE_COVERAGE', displayProgress: 0.79, scanProgress: 0.79 },
    { phase: 'ADAPTIVE_COVERAGE', structuralCoverage: 0.48, viewpointDiversity: 0.5, acceptedFrames: 18, reconstructionConfidence: 0.5 },
  );

  expect(next.computedProgress).toBeLessThan(0.79);
  expect(next.displayProgress).toBe(0.79);
  expect(next.scanProgress).toBe(0.79);
});

test('compact guidance stays short and translates technical states into actions', () => {
  const guidance = compactGuidanceFor({ type: 'MOVE_SIDEWAYS', reason: 'LOW_PARALLAX' }, { phase: 'ADAPTIVE_COVERAGE' });
  expect(guidance.text).toBe('Move sideways');
  expect(guidance.text.split(' ').length).toBeLessThanOrEqual(7);
  expect(guidance.text).not.toMatch(/feature|parallax|track|coverage/i);
});

test('initial mapping has no projected region overlays', () => {
  expect(coverageOverlayRegionsFor(createInitialScanState())).toEqual([]);
});

test('blue coverage opacity follows measured coverage and not elapsed time', () => {
  const region = { coverage: 0.1, coverageConfidence: 0.7, status: 'PARTIAL' };
  const initialOpacity = blueCoverageOpacity(region);
  expect(initialOpacity).toBeCloseTo(0.6, 2);
  expect(blueCoverageOpacity({ ...region, coverage: 0.3 })).toBeGreaterThan(blueCoverageOpacity({ ...region, coverage: 0.6 }));
  expect(blueCoverageOpacity({ ...region, coverage: 0.6 })).toBeLessThan(initialOpacity);
  expect(blueCoverageOpacity({ ...region, coverage: 0.6 }, { elapsedMs: 999999 })).toBe(blueCoverageOpacity({ ...region, coverage: 0.6 }));
});

test.each([
  ['SUFFICIENT', 0],
  ['INFERABLE', 0],
])('%s coverage is transparent in the camera overlay', (status, expected) => {
  expect(blueCoverageOpacity({ coverage: 0.1, status })).toBe(expected);
});

test('adaptive coverage projects only visible observed regions and caps the overlay count', () => {
  const regions = Array.from({ length: 30 }, (_, index) => ({
    id: `observed-${index}`,
    estimatedDirection: { x: 0, y: 0, z: -1 },
    estimatedWorldCenter: { x: 0, y: 1.4, z: -1.5 },
    featureDensity: 0.5,
    coverage: index / 100,
    coverageConfidence: 0.7,
    status: 'PARTIAL',
  }));
  const overlays = coverageOverlayRegionsFor({
    phase: 'ADAPTIVE_COVERAGE',
    coverageRegions: regions,
    currentOrientation: { heading: 0, pitch: 0 },
    cameraPose: { x: 0, y: 1.4, z: 0 },
  });
  expect(overlays).toHaveLength(24);
  expect(overlays[0].screenBounds).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  expect(overlays[0].blueOpacity).toBeGreaterThan(overlays[overlays.length - 1].blueOpacity);
});

test('structural target ordering excludes furniture until furniture detail mode', () => {
  const furniture = { semanticType: 'FURNITURE_OR_FRAME_EDGE' };
  const corner = { semanticType: 'WALL_CORNER' };
  expect(targetPriorityForScan(furniture, false)).toBe(Infinity);
  expect(targetPriorityForScan(furniture, true)).toBeLessThan(targetPriorityForScan(corner, true));
});

test('reconstruction status copy and failure state stay explicit', () => {
  expect(reconstructionStatusLabel('feature_matching')).toBe('Matching room views');
  expect(reconstructionStatusLabel('mesh')).toBe('Building room mesh');
  expect(reconstructionProgressSteps('complete').every((step) => step.state === 'done')).toBe(true);
  expect(friendlyReconstructionError({ code: 'RECONSTRUCTION_SERVICE_UNAVAILABLE', message: 'offline' })).toBe('3D reconstruction service is unavailable.');
  expect(friendlyReconstructionError({ message: 'Not enough dense points for a room mesh.' })).toMatch(/Not enough overlapping room detail/);
});

test('processing screen offers retry after a real reconstruction error', () => {
  render(<ProcessingScreen reconstructionState={{ status: 'error', message: 'COLMAP is not installed on the reconstruction worker.' }} isReconstructing={false} onRetry={jest.fn()} onReturnToScan={jest.fn()} />);
  expect(screen.getByText('Room captured, but 3D reconstruction failed.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /retry reconstruction/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /return to scan/i })).toBeInTheDocument();
  expect(screen.queryByText('Mesh required')).not.toBeInTheDocument();
});

test('furniture targets wait until the optional furniture pass', () => {
  const furniture = { id: 'furniture-1', semanticType: 'FURNITURE_OR_FRAME_EDGE', status: 'PARTIAL', priority: 0.9 };
  const corner = { id: 'corner-1', semanticType: 'WALL_CORNER', status: 'PARTIAL', priority: 0.5 };
  const structuralState = {
    ...createInitialScanState(),
    phase: 'ADAPTIVE_COVERAGE',
    framesEvaluated: 1,
    acceptedFrames: 1,
    coverageRegions: [furniture, corner],
    lowCoverageRegions: [furniture, corner],
    scanReadiness: { ready: false },
  };
  expect(determineNextAction(structuralState).targetRegion.id).toBe('corner-1');
  expect(determineNextAction({ ...structuralState, scanReady: true, furniturePassActive: true }).targetRegion.id).toBe('furniture-1');
});

test('guidance placement moves away from bottom and left targets', () => {
  expect(chooseGuidancePlacement({ x: 0.4, y: 0.78, width: 0.2, height: 0.14 })).toBe('top');
  expect(chooseGuidancePlacement({ x: 0.04, y: 0.42, width: 0.18, height: 0.16 })).toBe('right');
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

test('adaptive guidance defaults to the blue coverage model', () => {
  expect(compactGuidanceFor({ type: 'SCAN_LOW_COVERAGE_REGION' }, { phase: 'ADAPTIVE_COVERAGE' }).text).toBe('Scan the blue areas');
});

test('continuous user guidance strips diagnostic target chasing', () => {
  const state = {
    ...createInitialScanState(),
    phase: 'ADAPTIVE_COVERAGE',
    framesEvaluated: 4,
    acceptedFrames: 4,
    lowCoverageRegions: [{ id: 'corner-1', semanticType: 'WALL_CORNER', status: 'PARTIAL', priority: 1 }],
  };
  const diagnosticInstruction = determineNextAction(state);
  expect(diagnosticInstruction.targetRegion).toBeDefined();
  const userInstruction = continuousScanInstructionFor(state, diagnosticInstruction);
  expect(userInstruction.targetRegion).toBeUndefined();
  expect(compactGuidanceFor(userInstruction, state).text).toBe('Scan the blue areas');
});

test('directional grid starts with unknown blue cells', () => {
  const cells = createDirectionalCoverageGrid(0);
  const visible = projectDirectionalCoverageCells(cells, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 });
  expect(cells).toHaveLength(54);
  expect(visible.some((cell) => cell.status === 'UNSEEN' && cell.blueOpacity >= 0.55)).toBe(true);
});

test('duplicate poses remain one distinct viewpoint while sideways movement adds views', () => {
  const frames = Array.from({ length: 20 }, (_, index) => ({
    id: `frame-${index}`,
    pose: { x: 0, y: 1.4, z: 0 },
    orientation: { heading: 0, pitch: 0 },
  }));
  expect(distinctViewpointsFromFrames(frames)).toHaveLength(1);

  const movedFrames = [0, 0.2, 0.4, 0.6].map((x, index) => ({
    id: `moved-${index}`,
    pose: { x, y: 1.4, z: 0 },
    orientation: { heading: 0, pitch: 0 },
  }));
  expect(distinctViewpointsFromFrames(movedFrames).length).toBeGreaterThan(1);
  expect(viewpointNovelty(distinctViewpointsFromFrames(frames), { pose: { x: 0.2, y: 1.4, z: 0 }, heading: 0, pitch: 0 }).isNovel).toBe(true);
});

test('one accepted keyframe improves multiple visible directional cells', () => {
  const result = updateDirectionalCoverageGrid([], {
    referenceHeading: 0,
    orientation: { heading: 0, pitch: 0 },
    pose: { x: 0, y: 1.4, z: 0 },
    analysis: goodAnalysis,
    keyframeId: 'keyframe-1',
    accepted: true,
    observedAt: 1000,
    featureTrackIds: goodAnalysis.featureTrackIds,
  });
  const observedCells = result.cells.filter((cell) => cell.observationCount > 0);
  expect(observedCells.length).toBeGreaterThan(1);
  expect(observedCells.every((cell) => cell.distinctViewCount === 1)).toBe(true);
});

test('directional coverage becomes lighter with real movement and clear after strong multi-view evidence', () => {
  let cells = [];
  [0, 0.2, 0.4].forEach((x, index) => {
    cells = updateDirectionalCoverageGrid(cells, {
      referenceHeading: 0,
      orientation: { heading: 0, pitch: 0 },
      pose: { x, y: 1.4, z: 0 },
      analysis: goodAnalysis,
      keyframeId: `keyframe-${index + 1}`,
      accepted: true,
      observedAt: (index + 1) * 1000,
      featureTrackIds: goodAnalysis.featureTrackIds,
    }).cells;
  });
  const middle = cells.find((cell) => cell.band === 'middle' && cell.yaw === 0);
  expect(middle.distinctViewCount).toBe(3);
  expect(middle.status).toBe('SUFFICIENT');
  expect(blueCoverageOpacity(middle)).toBe(0);
});

test('rotating in place does not clear directional cells', () => {
  let cells = [];
  [0, 45, 90, 135, 180, 225, 270, 315].forEach((heading, index) => {
    cells = updateDirectionalCoverageGrid(cells, {
      referenceHeading: 0,
      orientation: { heading, pitch: 0 },
      pose: { x: 0, y: 1.4, z: 0 },
      analysis: goodAnalysis,
      keyframeId: `rotation-${index + 1}`,
      accepted: true,
      observedAt: (index + 1) * 1000,
      featureTrackIds: goodAnalysis.featureTrackIds,
    }).cells;
  });
  expect(cells.some((cell) => cell.status === 'SUFFICIENT')).toBe(false);
  expect(Math.max(...cells.map((cell) => cell.coverage))).toBeLessThan(0.78);
});

test('continuous region updates do not depend on activeTargetId', () => {
  const makeRegion = (id, yaw) => ({
    id,
    source: 'OBSERVED',
    definitionSource: 'OBSERVED_SPATIAL',
    structuralImportance: 0.9,
    semanticType: 'WALL_CORNER',
    estimatedDirection: { x: Math.sin((yaw * Math.PI) / 180), y: 0, z: -Math.cos((yaw * Math.PI) / 180) },
    estimatedWorldCenter: { x: yaw / 100, y: 1.4, z: -1.6 },
    featureTrackIds: ['ft-1', 'ft-2', 'ft-3'],
    observedFromKeyframes: ['initial-1'],
    featureDensity: 0.7,
    coverage: 0,
    coverageConfidence: 0,
    viewpointCount: 0,
    distinctViewCount: 0,
    observationCount: 0,
    parallaxScore: 0,
    status: 'UNSEEN',
    skipped: false,
  });
  const state = {
    ...createInitialScanState(),
    phase: 'ADAPTIVE_COVERAGE',
    coverageRegions: [makeRegion('region-a', 0), makeRegion('region-b', 20)],
    activeTargetId: 'region-a',
  };
  const next = updateCoverageFromFrame(state, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, goodAnalysis, 0, {
    accepted: true,
    keyframeId: 'keyframe-1',
    activeTargetId: 'region-a',
    featureTrackIds: goodAnalysis.featureTrackIds,
  });
  expect(next.coverageRegions.filter((region) => region.observationCount > 0)).toHaveLength(2);
});

test('duplicate frames cannot saturate readiness progress', () => {
  const progress = calculateScanProgress({
    phase: 'ADAPTIVE_COVERAGE',
    structuralCoverage: 0.82,
    viewpointDiversity: 0.7,
    acceptedFrames: 24,
    distinctViewCount: 1,
    reconstructionConfidence: 0.75,
    scanReady: false,
    scanReadiness: { ready: false },
  });
  expect(progress).toBeLessThan(0.99);
});

test('tracking loss preserves directional coverage', () => {
  let cells = updateDirectionalCoverageGrid([], {
    orientation: { heading: 0, pitch: 0 },
    pose: { x: 0.2, y: 1.4, z: 0 },
    analysis: goodAnalysis,
    keyframeId: 'keyframe-1',
    accepted: true,
    featureTrackIds: goodAnalysis.featureTrackIds,
  }).cells;
  const state = {
    ...createInitialScanState(),
    phase: 'ADAPTIVE_COVERAGE',
    directionalCells: cells,
    directionalCoverage: summarizeDirectionalCoverage(cells).coverage,
  };
  const before = cells.map((cell) => cell.coverage);
  const next = updateCoverageFromFrame(state, { heading: 0, pitch: 0 }, { x: 0.2, y: 1.4, z: 0 }, goodAnalysis, 0, { accepted: false });
  expect(next.directionalCells.map((cell) => cell.coverage)).toEqual(before);
});

test('reconstruction keyframe selection removes same-pose duplicates', () => {
  const frames = Array.from({ length: 20 }, (_, index) => ({
    frameId: `duplicate-${index}`,
    capturedAt: index,
    pose: { x: 0, y: 1.4, z: 0 },
    orientation: { heading: 0, pitch: 0 },
    qualityScore: 0.9,
    qualityMetrics: { sharpness: 0.9, brightness: 0.48, featureCount: 400 },
  }));
  expect(selectReconstructionKeyframes(frames)).toHaveLength(1);
});

test('sparse points require a meaningful multi-view baseline', () => {
  const keyframes = [
    {
      id: 'k1',
      pose: { x: 0, y: 1.4, z: 0 },
      orientation: { heading: 0, pitch: 0 },
      featureObservations: [{ trackId: 'track-1', x: 0.5, y: 0.5 }],
    },
    {
      id: 'k2',
      pose: { x: 0.3, y: 1.4, z: 0 },
      orientation: { heading: 0, pitch: 0 },
      featureObservations: [{ trackId: 'track-1', x: 0.393, y: 0.5 }],
    },
  ];
  expect(triangulateSparsePoints(keyframes)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceTrackIds: ['track-1'], observationCount: 2 }),
  ]));
  expect(triangulateSparsePoints([
    { ...keyframes[0], id: 'same-1' },
    { ...keyframes[0], id: 'same-2' },
  ])).toHaveLength(0);
});

test('feature association rejects an obvious appearance mismatch at the same pixel', () => {
  const first = updateFeatureTracks([], [{ x: 0.5, y: 0.5, patchSignature: Array(9).fill(1) }], { frameIndex: 1 });
  const second = updateFeatureTracks(first.tracks, [{ x: 0.5, y: 0.5, patchSignature: Array(9).fill(-1) }], { frameIndex: 2 });
  expect(second.trackedFeatureCount).toBe(1);
  expect(second.tracks.filter((track) => track.observations.length === 1)).toHaveLength(2);
});

test('weak planes do not create live structural lines but supported planes do', () => {
  expect(estimateSupportedPlanes([])).toEqual([]);
  const planes = [
    { id: 'floor', normal: { x: 0, y: 1, z: 0 }, distance: 0, confidence: 0.82, sourcePointIds: ['p1'] },
    { id: 'wall', normal: { x: 1, y: 0, z: 0 }, distance: 1.4, confidence: 0.8, sourcePointIds: ['p2'] },
  ];
  expect(structuralEdgesFromPlanes(planes)).toHaveLength(1);
  expect(structuralEdgesFromPlanes(planes.map((plane) => ({ ...plane, confidence: 0.35 })))).toHaveLength(0);
});

test('physical movement is required for real scan readiness when pose evidence exists', () => {
  const base = {
    phase: 'CONTINUOUS_MAPPING',
    acceptedFrames: 24,
    totalCoverage: 0.7,
    wallCoverage: 0.62,
    floorCoverage: 0.34,
    viewpointDiversity: 0.45,
    distinctViewCount: 10,
    physicalViewCount: 0,
    imageQuality: 0.78,
    featureTrackingQuality: 0.8,
  };
  expect(calculateScanReadiness(base).ready).toBe(false);
  expect(calculateScanReadiness({ ...base, physicalViewCount: 3 }).ready).toBe(true);
});
