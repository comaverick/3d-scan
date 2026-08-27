import {
  SCANNER_PHASES,
  calculateInitialMappingReadiness,
  createInitialScanState,
  deriveTargetStatuses,
  determineNextAction,
  generateObservedTargets,
  updateCoverageFromFrame,
} from './App';

const points = [
  { x: 0.28, y: 0.28 }, { x: 0.32, y: 0.3 }, { x: 0.36, y: 0.32 },
  { x: 0.62, y: 0.28 }, { x: 0.66, y: 0.3 }, { x: 0.7, y: 0.32 },
  { x: 0.44, y: 0.62 }, { x: 0.48, y: 0.64 }, { x: 0.52, y: 0.66 },
];
const targetPoints = [{ x: 0.48, y: 0.48 }, { x: 0.5, y: 0.5 }, { x: 0.52, y: 0.52 }];

function analysis(overrides = {}) {
  return {
    qualityScore: 0.82,
    featureCount: 120,
    detectedFeatureCount: 140,
    trackedFeatureCount: 80,
    featureTrackingQuality: 0.8,
    sharpness: 0.8,
    brightness: 0.5,
    motionBlur: false,
    poorLighting: false,
    sceneChange: 0.3,
    featurePointsDisplay: points,
    featureTrackIds: points.map((point, index) => `ft-${index + 1}`),
    sceneUnderstanding: { grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ detail: 0.8, brightness: 0.5 }))) },
    ...overrides,
  };
}

function mapFrames(count = 6) {
  let state = createInitialScanState();
  for (let index = 0; index < count; index += 1) {
    const heading = index * 45;
    state = updateCoverageFromFrame(
      state,
      { heading, pitch: 0 },
      { x: index * 0.2, y: 1.4, z: 0, yaw: heading },
      analysis(),
      0.2,
      {
        accepted: true,
        keyframeId: index + 1,
        observedAt: (index + 1) * 1000,
        multiFrameFeatureTrackCount: 20,
        featureTrackIds: points.map((point, pointIndex) => `ft-${pointIndex + 1}`),
      },
    );
  }
  return state;
}

function singleObservedTarget(overrides = {}) {
  return generateObservedTargets([{
    id: 'obs-corner',
    source: 'OBSERVED',
    featureTrackIds: ['ft-1', 'ft-2', 'ft-3'],
    observedFromKeyframes: ['map-1'],
    estimatedDirection: { x: 0, y: 0, z: -1 },
    estimatedWorldCenter: { x: 0, y: 1.4, z: -1.6 },
    structuralImportance: 0.95,
    featureDensity: 0.7,
    viewpointCount: 1,
    viewpointDiversity: 0.2,
    parallaxScore: 0,
    coverageConfidence: 0.7,
    ...overrides,
  }])[0];
}

test('scanner starts in INITIAL_MAPPING', () => {
  const state = createInitialScanState();
  expect(state.phase).toBe(SCANNER_PHASES.INITIAL_MAPPING);
  expect(determineNextAction(state).type).toBe('START_SCAN');
  expect(determineNextAction(state).instruction).toBe('Slowly look around the room.');
});

test('scanner does not immediately generate left_ceiling', () => {
  const state = createInitialScanState();
  expect(state.coverageRegions).toEqual([]);
  expect(determineNextAction({ ...state, framesEvaluated: 1 }).targetRegion).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain('left_ceiling');
});

test('accepted keyframes and features contribute to mapping readiness', () => {
  const readiness = calculateInitialMappingReadiness({ mapping: {
    acceptedKeyframes: 6,
    trackedFeatureCount: 80,
    multiFrameFeatureTrackCount: 20,
    orientationCoverage: 0.6,
    viewpointDiversity: 0.4,
    successfulRelativePoseCount: 3,
  } });
  expect(readiness.ready).toBe(true);
});

test('insufficient mapping remains in INITIAL_MAPPING', () => {
  const state = mapFrames(3);
  expect(state.phase).toBe(SCANNER_PHASES.INITIAL_MAPPING);
  expect(state.coverageRegions).toEqual([]);
  expect(state.mappingReadiness.ready).toBe(false);
});

test('sufficient spatial observations transition to ADAPTIVE_COVERAGE', () => {
  const state = mapFrames();
  expect(state.phase).toBe(SCANNER_PHASES.ADAPTIVE_COVERAGE);
  expect(state.mappingReadiness.ready).toBe(true);
  expect(state.mapping.sparseObservations.length).toBeGreaterThan(0);
  expect(state.mappingJustInitialized).toBe(true);
});

test('adaptive target references real source observations', () => {
  const state = mapFrames();
  const target = state.coverageRegions[0];
  expect(target.source).toBe('OBSERVED');
  expect(target.definitionSource).toBe('OBSERVED_SPATIAL');
  expect(target.observedFromKeyframes.length).toBeGreaterThan(0);
  expect(target.featureTrackIds.length).toBeGreaterThan(0);
  expect(target.estimatedWorldCenter).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) }));
  expect(target.id).not.toMatch(/left_ceiling|right_ceiling|upper_wall/);
});

test('first visible target observation gives view 1', () => {
  const target = singleObservedTarget();
  const state = {
    ...createInitialScanState(),
    phase: SCANNER_PHASES.ADAPTIVE_COVERAGE,
    coverageRegions: [target],
    lowCoverageRegions: [target],
    activeTargetId: target.id,
  };
  const next = updateCoverageFromFrame(state, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, analysis({ featurePointsDisplay: targetPoints, featureTrackIds: ['ft-1', 'ft-2', 'ft-3'] }), 0, {
    accepted: true,
    keyframeId: 'k-1',
    activeTargetId: target.id,
  });
  expect(next.lastTargetViewDecision.qualified).toBe(true);
  expect(next.coverageRegions[0].usefulViews).toBe(1);
});

test('distinct viewpoint gives view 2', () => {
  const target = singleObservedTarget();
  const initial = {
    ...createInitialScanState(),
    phase: SCANNER_PHASES.ADAPTIVE_COVERAGE,
    coverageRegions: [target],
    lowCoverageRegions: [target],
    activeTargetId: target.id,
  };
  const first = updateCoverageFromFrame(initial, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, analysis({ featurePointsDisplay: targetPoints, featureTrackIds: ['ft-1', 'ft-2', 'ft-3'] }), 0, { accepted: true, keyframeId: 'k-1', activeTargetId: target.id });
  const second = updateCoverageFromFrame(first, { heading: 0, pitch: 0 }, { x: 0.2, y: 1.4, z: 0 }, analysis({ featurePointsDisplay: targetPoints, featureTrackIds: ['ft-1', 'ft-2', 'ft-3'] }), 0.2, { accepted: true, keyframeId: 'k-2', activeTargetId: target.id });
  expect(second.lastTargetViewDecision.qualified).toBe(true);
  expect(second.coverageRegions[0].usefulViews).toBe(2);
});

test('low-texture target cannot trap scanner', () => {
  const target = singleObservedTarget({ featureDensity: 0.05 });
  let state = {
    ...createInitialScanState(),
    phase: SCANNER_PHASES.ADAPTIVE_COVERAGE,
    coverageRegions: [target],
    lowCoverageRegions: [target],
    activeTargetId: target.id,
  };
  for (let index = 0; index < 3; index += 1) {
    state = updateCoverageFromFrame(state, { heading: 0, pitch: 0 }, { x: index * 0.05, y: 1.4, z: 0 }, analysis({ featurePointsDisplay: [] }), 0, {
      accepted: true,
      keyframeId: `k-${index + 1}`,
      activeTargetId: target.id,
    });
  }
  expect(state.coverageRegions[0].status).toBe('LOW_TEXTURE');
  expect(determineNextAction(state).type).toBe('SKIP_AREA');
});

test('low-texture target becomes inferred only when observed neighbors constrain it', () => {
  const strong = { ...singleObservedTarget(), status: 'SUFFICIENT' };
  const lowTexture = { ...singleObservedTarget({ id: 'obs-plain', featureDensity: 0.05, estimatedDirection: { x: 0.1, y: 0, z: -0.99 }, estimatedWorldCenter: { x: 0.2, y: 1.4, z: -1.6 } }), attempts: 3 };
  const [nextStrong, nextLowTexture] = deriveTargetStatuses([strong, lowTexture]);

  expect(nextStrong.source).toBe('OBSERVED');
  expect(nextLowTexture.status).toBe('INFERABLE');
  expect(nextLowTexture.source).toBe('INFERRED');
  expect(nextLowTexture.captureSource).toBe('INFERRED');
});

test('progress survives target changes and temporary tracking loss', () => {
  const firstTarget = singleObservedTarget();
  const secondTarget = singleObservedTarget({ id: 'obs-edge', estimatedDirection: { x: 0.6, y: 0, z: -0.8 }, estimatedWorldCenter: { x: 1, y: 1.4, z: -1.6 } });
  const initial = {
    ...createInitialScanState(),
    phase: SCANNER_PHASES.ADAPTIVE_COVERAGE,
    coverageRegions: [firstTarget, secondTarget],
    lowCoverageRegions: [firstTarget, secondTarget],
    activeTargetId: firstTarget.id,
  };
  const captured = updateCoverageFromFrame(initial, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, analysis({ featurePointsDisplay: targetPoints, featureTrackIds: ['ft-1', 'ft-2', 'ft-3'] }), 0, { accepted: true, keyframeId: 'k-1', activeTargetId: firstTarget.id });
  const changed = updateCoverageFromFrame({ ...captured, activeTargetId: secondTarget.id }, { heading: 0, pitch: 0 }, { x: 0, y: 1.4, z: 0 }, analysis({ featurePointsDisplay: [] }), 0, { accepted: false, activeTargetId: secondTarget.id });
  expect(changed.coverageRegions.find((region) => region.id === firstTarget.id).usefulViews).toBe(1);
  expect(changed.coverageRegions.find((region) => region.id === firstTarget.id)).toEqual(expect.objectContaining({ source: 'OBSERVED' }));
});
