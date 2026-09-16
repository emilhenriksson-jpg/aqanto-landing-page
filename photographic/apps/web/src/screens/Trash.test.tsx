import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_TRASH } from '../data/demo.js';

function renderApp(path = '/papperskorg') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Papperskorg', () => {
  it('shows soft-deleted demo lines with Återställ', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Papperskorg' })).toBeInTheDocument();
    expect(screen.getByText(/Borttaget ligger kvar i 30 dagar/)).toBeInTheDocument();
    expect(screen.getByText('Bor i Malmö')).toBeInTheDocument();
    expect(screen.getByText('Vi siktar på förvärv i Q2')).toBeInTheDocument();
    expect(screen.getByText('p-old1')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Återställ' })).toHaveLength(DEMO_TRASH.length);
  });

  it('removes a line when restored', async () => {
    const user = userEvent.setup();
    renderApp();

    const firstBody = DEMO_TRASH[0]!.body;
    await user.click(screen.getAllByRole('button', { name: 'Återställ' })[0]!);
    expect(screen.queryByText(firstBody)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Återställ' })).toHaveLength(
      DEMO_TRASH.length - 1,
    );
  });

  it('is reachable from a quiet personal-room footer link, not the rail', async () => {
    const user = userEvent.setup();
    renderApp('/personligt');

    expect(screen.getByRole('heading', { level: 1, name: 'Ditt rum' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Papperskorg', hidden: false })).toBeTruthy();

    const rail = screen.getByRole('navigation', { name: 'Huvudmeny' });
    expect(rail.querySelector('a[href="/papperskorg"]')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Papperskorg' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Papperskorg' })).toBeInTheDocument();
  });
});
