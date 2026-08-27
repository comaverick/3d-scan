import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { createInitialScanState, determineNextAction } from './App';

test('renders the SmartScan starting state', () => {
  render(<App />);

  expect(screen.getByText('Capture progress')).toBeInTheDocument();
  expect(screen.getByText('Position tracking')).toBeInTheDocument();
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

  expect(qualityWarning.type).toBe('RETURN_TO_TRACKED_AREA');
  expect(parallaxWarning.type).toBe('MOVE_SIDEWAYS');
  expect(qualityWarning.title).not.toBe(parallaxWarning.title);
});
