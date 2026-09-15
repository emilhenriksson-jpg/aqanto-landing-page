import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from './App.js';

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('opens inside the personal room, not a dashboard', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Ditt rum' })).toBeInTheDocument();
    expect(screen.getByText(/Det här är ditt minne/)).toBeInTheDocument();
    expect(screen.getByText('Identitet')).toBeInTheDocument();
    expect(screen.getByText('p-h58j')).toBeInTheDocument();
  });

  it('lets you walk to the room list and into a shared room', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('link', { name: 'Alla' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Rum' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Öppna ditt rum' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Öppna Buyersclub Ledning' }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Buyersclub Ledning' }),
    ).toBeInTheDocument();
    expect(screen.getByText('r-8k2m')).toBeInTheDocument();
  });

  it('offers undo after deleting a memory line', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'Ta bort p-h58j' }));
    expect(screen.getByText('Borttaget')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ångra' }));
    expect(screen.getByText(/Emil, 34/)).toBeInTheDocument();
  });
});
