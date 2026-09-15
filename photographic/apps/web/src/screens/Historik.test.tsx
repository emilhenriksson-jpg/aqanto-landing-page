import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_HISTORY } from '../data/demo.js';

function renderApp(path = '/historik') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Historik', () => {
  it('shows sparse when + what demo lines and is reachable from the personal-room footer', async () => {
    const user = userEvent.setup();
    renderApp('/');

    expect(screen.getByRole('heading', { level: 1, name: 'Ditt rum' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Historik' })).toBeInTheDocument();

    const rail = screen.getByRole('navigation', { name: 'Huvudmeny' });
    expect(rail.querySelector('a[href="/historik"]')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Historik' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Historik' })).toBeInTheDocument();
    expect(screen.getByText(/Vad som sparats, ändrats eller tagits bort/)).toBeInTheDocument();
    for (const entry of DEMO_HISTORY) {
      expect(screen.getByText(entry.when)).toBeInTheDocument();
      expect(screen.getByText(entry.body)).toBeInTheDocument();
    }
  });
});
