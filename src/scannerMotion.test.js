import { createMotionTracker, MOTION_STATES, scannerMotionConfig } from './scannerMotion';

function updateAt(tracker, timestamp, pitch = 0, yaw = 0, roll = 0) {
  return tracker.updateAngularVelocity({
    timestamp,
    angularVelocity: { pitch, yaw, roll },
    orientation: {
      pitchDegrees: 20,
      headingDegrees: 0,
      rollDegrees: 0,
    },
  });
}

test('ignores a startup pitch spike during the instruction grace period', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('LOOK_UP', { pitchDegrees: 55, headingDegrees: null }, 1000);

  const snapshot = updateAt(tracker, 1100, 180, 8, 4);

  expect(snapshot.motionState).toBe(MOTION_STATES.GOOD);
  expect(snapshot.instructionGraceActive).toBe(true);
  expect(snapshot.instructionType).toBe('LOOK_UP');
});

test('uses a temporary scanning warning instead of a TOO_FAST blocking state', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('LOOK_UP', { pitchDegrees: 55, headingDegrees: null }, 1000);

  updateAt(tracker, 1700, 180);
  updateAt(tracker, 1850, 180);
  updateAt(tracker, 2000, 180);
  updateAt(tracker, 2150, 180);
  updateAt(tracker, 2300, 180);
  expect(tracker.getSnapshot(2300).motionState).toBe(MOTION_STATES.SCANNING);

  updateAt(tracker, 2450, 180);
  expect(tracker.getSnapshot(2450).motionState).toBe(MOTION_STATES.SCANNING_WITH_WARNING);
  updateAt(tracker, 2600, 250);
  updateAt(tracker, 2850, 250);
  expect(tracker.getSnapshot(2850).motionState).toBe(MOTION_STATES.SCANNING_WITH_WARNING);

  let snapshot = tracker.getSnapshot(2850);
  for (let timestamp = 2950; timestamp <= 4500 && snapshot.motionState === MOTION_STATES.SCANNING_WITH_WARNING; timestamp += 100) {
    snapshot = updateAt(tracker, timestamp, 0);
  }
  expect(snapshot.motionState).toBe(MOTION_STATES.SCANNING);
  expect(snapshot.motionState).not.toBe(MOTION_STATES.TRACKING_LOST);
});

test('tracks pitch progress independently from small yaw and roll movement', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('LOOK_UP', { pitchDegrees: 55, headingDegrees: null }, 1000);

  tracker.updateOrientation({ timestamp: 1000, orientation: { pitchDegrees: 20, headingDegrees: 0, rollDegrees: 0 } });
  const snapshot = tracker.updateOrientation({ timestamp: 1200, orientation: { pitchDegrees: 30, headingDegrees: 8, rollDegrees: 4 } });

  expect(snapshot.targetErrorDegrees).toBe(25);
  expect(snapshot.movingTowardTarget).toBe(true);
  expect(snapshot.dominantAxis).toBe('pitch');
});

test('does not enter recovery for a motion warning while visual tracking is healthy', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('TURN_RIGHT', { pitchDegrees: null, headingDegrees: 90 }, 1000);
  tracker.updateTrackingQuality({ timestamp: 1000, quality: 0.92, frameQuality: 0.88, featureCount: 1800, motionBlur: false });

  updateAt(tracker, 1700, 0, 80);
  updateAt(tracker, 1900, 0, 80);
  updateAt(tracker, 2300, 0, 80);

  expect(tracker.getSnapshot(2300).motionState).not.toBe(MOTION_STATES.RECOVERY);
});

test('one bad frame cannot enter TRACKING_LOST', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('MOVE_AROUND_OBJECT', null, 0);

  const snapshot = tracker.updateTrackingQuality({
    timestamp: 1000,
    quality: 0.08,
    frameQuality: 0.08,
    featureCount: 4,
    detectedFeatureCount: 8,
    featureTrackingQuality: 0.05,
    motionBlur: true,
    relocalizationFailed: true,
    usableFramesRecently: false,
  });

  expect(snapshot.motionState).not.toBe(MOTION_STATES.TRACKING_LOST);
  expect(snapshot.trackingStatus).toBe('WEAK');
});

test('weak tracking for less than two seconds stays non-blocking', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('MOVE_AROUND_OBJECT', null, 0);
  const weakSample = {
    quality: 0.08,
    frameQuality: 0.08,
    featureCount: 4,
    detectedFeatureCount: 8,
    featureTrackingQuality: 0.05,
    motionBlur: false,
    relocalizationFailed: true,
    usableFramesRecently: false,
  };

  tracker.updateTrackingQuality({ timestamp: 1000, ...weakSample });
  const snapshot = tracker.updateTrackingQuality({ timestamp: 2800, ...weakSample });

  expect(snapshot.motionState).not.toBe(MOTION_STATES.TRACKING_LOST);
  expect(snapshot.trackingLostDurationMs).toBe(1800);
});

test('tracking loss requires sustained multi-signal failure and clears after relocalization', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('MOVE_AROUND_OBJECT', null, 0);
  const weakSample = {
    quality: 0.08,
    frameQuality: 0.08,
    featureCount: 4,
    detectedFeatureCount: 8,
    featureTrackingQuality: 0.05,
    motionBlur: false,
    relocalizationFailed: true,
    usableFramesRecently: false,
  };

  tracker.updateTrackingQuality({ timestamp: 1000, ...weakSample });
  const lost = tracker.updateTrackingQuality({ timestamp: 4300, ...weakSample });
  expect(lost.motionState).toBe(MOTION_STATES.TRACKING_LOST);

  const restored = tracker.updateTrackingQuality({
    timestamp: 4400,
    quality: 0.82,
    frameQuality: 0.82,
    featureCount: 180,
    detectedFeatureCount: 220,
    featureTrackingQuality: 0.82,
    motionBlur: false,
    relocalizationFailed: false,
    usableFramesRecently: true,
  });
  expect(restored.motionState).toBe(MOTION_STATES.SCANNING);
  expect(restored.trackingStatus).toBe('TRACKING');
});

test.each(['LOOK_UP', 'LOOK_DOWN', 'TURN_LEFT', 'TURN_RIGHT', 'MOVE_LEFT', 'MOVE_RIGHT', 'MOVE_SIDEWAYS', 'MOVE_AROUND_OBJECT'])('%s has independent tunable thresholds', (instructionType) => {
  const thresholds = scannerMotionConfig.thresholds[instructionType];

  expect(thresholds.warningEnter).toBeGreaterThan(thresholds.warningExit);
  expect(thresholds.criticalEnter).toBeGreaterThan(thresholds.criticalExit);
  expect(thresholds.weights[thresholds.dominantAxis]).toBe(1);
});
