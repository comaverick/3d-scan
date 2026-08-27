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

test('requires sustained warning and critical motion, with hysteresis on exit', () => {
  const tracker = createMotionTracker(scannerMotionConfig);
  tracker.setInstruction('LOOK_UP', { pitchDegrees: 55, headingDegrees: null }, 1000);

  updateAt(tracker, 1700, 180);
  updateAt(tracker, 1850, 180);
  updateAt(tracker, 2000, 180);
  updateAt(tracker, 2150, 180);
  updateAt(tracker, 2300, 180);
  expect(tracker.getSnapshot(2300).motionState).toBe(MOTION_STATES.WARNING);

  updateAt(tracker, 2450, 250);
  updateAt(tracker, 2850, 250);
  expect(tracker.getSnapshot(2850).motionState).toBe(MOTION_STATES.TOO_FAST);

  let snapshot = tracker.getSnapshot(2850);
  for (let timestamp = 2950; timestamp <= 4500 && snapshot.motionState === MOTION_STATES.TOO_FAST; timestamp += 100) {
    snapshot = updateAt(tracker, timestamp, 0);
  }
  expect(snapshot.motionState).toBe(MOTION_STATES.WARNING);
  const warningEndedAt = snapshot.updatedAt;
  for (let timestamp = warningEndedAt + 100; timestamp <= warningEndedAt + 1000 && snapshot.motionState !== MOTION_STATES.GOOD; timestamp += 100) {
    snapshot = updateAt(tracker, timestamp, 0);
  }
  expect(snapshot.motionState).toBe(MOTION_STATES.GOOD);
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

test.each(['LOOK_UP', 'LOOK_DOWN', 'TURN_LEFT', 'TURN_RIGHT', 'MOVE_LEFT', 'MOVE_RIGHT', 'MOVE_SIDEWAYS', 'MOVE_AROUND_OBJECT'])('%s has independent tunable thresholds', (instructionType) => {
  const thresholds = scannerMotionConfig.thresholds[instructionType];

  expect(thresholds.warningEnter).toBeGreaterThan(thresholds.warningExit);
  expect(thresholds.criticalEnter).toBeGreaterThan(thresholds.criticalExit);
  expect(thresholds.weights[thresholds.dominantAxis]).toBe(1);
});
