import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { FragaMittMinne } from './FragaMittMinne.js';

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/fraga']}>
      <Routes>
        <Route path="/fraga" element={<FragaMittMinne />} />
        <Route path="/" element={<div>personligt rum</div>} />
        <Route path="/rum/:roomId" element={<div>delat rum</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Fråga mitt minne — demo', () => {
  it('shows a calm prompt before anything has been asked', () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: 'Fråga mitt minne' })).toBeInTheDocument();
    expect(screen.getByText(/Ställ en fråga/)).toBeInTheDocument();
  });

  it('is reachable from the rail', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('link', { name: 'Fråga' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Fråga mitt minne' })).toBeInTheDocument();
  });

  it('finds a memory from the same demo data every other screen shows', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByRole('searchbox', { name: 'Fråga mitt minne' }), 'förvärvet');
    await user.click(screen.getByRole('button', { name: 'Sök' }));

    expect(screen.getByText('Buyersclub Ledning')).toBeInTheDocument();
    expect(screen.getByText(/skjuta förvärvet till Q3/)).toBeInTheDocument();
    expect(screen.getByText('r-8k2m')).toBeInTheDocument();
  });

  it('finds a calendar entry as well as a current memory, for the same question', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByRole('searchbox', { name: 'Fråga mitt minne' }), 'Vera');
    await user.click(screen.getByRole('button', { name: 'Sök' }));

    // "Dottern heter Vera, 4 år" (a memory) and "Claude sparade Dottern heter Vera, 4 år"
    // (the calendar entry recording that it was saved) both mention Vera.
    expect(screen.getAllByText(/Vera/).length).toBeGreaterThanOrEqual(2);
  });

  it('says so plainly when nothing matches', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(
      screen.getByRole('searchbox', { name: 'Fråga mitt minne' }),
      'något som absolut inte finns sparat',
    );
    await user.click(screen.getByRole('button', { name: 'Sök' }));

    expect(screen.getByText(/Inga träffar/)).toBeInTheDocument();
  });

  it('links a result back to the room it came from', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByRole('searchbox', { name: 'Fråga mitt minne' }), 'förvärvet');
    await user.click(screen.getByRole('button', { name: 'Sök' }));

    const link = screen.getByText(/skjuta förvärvet till Q3/).closest('a');
    expect(link).toHaveAttribute('href', '/rum/ledning');

    await user.click(link!);
    expect(screen.getByText('delat rum')).toBeInTheDocument();
  });
});
