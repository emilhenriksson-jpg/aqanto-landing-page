import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('ClientHealth', () => {
  it('tells the truth per client rather than claiming universal support', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('link', { name: 'Klienter' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Klienter' })).toBeInTheDocument();
    expect(screen.getByText(/Vi kan inte tvinga varje modell/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Claude/ })).toBeInTheDocument();
    expect(screen.getByText(/Läste din profil via MCP/)).toBeInTheDocument();
    expect(screen.getByText(/bara när modellen själv frågade/)).toBeInTheDocument();
    expect(screen.getByText('Har aldrig fått din profil.')).toBeInTheDocument();
  });
});
