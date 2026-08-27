import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { canManuallyFinishScan, calculateScanReadiness, createGuidanceController, createInitialScanState, determineNextAction, updateCoverageFromFrame } from './App';

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
