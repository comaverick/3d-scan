import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

test('renders the SmartScan starting state', () => {
  render(<App />);

  expect(screen.getByText('Capture progress')).toBeInTheDocument();
  expect(screen.getByText('Position tracking')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /start scan/i })).toBeInTheDocument();
});

test('starts the guided movement checkpoint', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));

  await waitFor(() => expect(screen.getByText('Move forward slowly')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /mark checkpoint/i })).toBeInTheDocument();
  expect(screen.getByText('16%')).toBeInTheDocument();
});
