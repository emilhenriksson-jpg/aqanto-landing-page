import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_APPROVALS } from '../data/demo.js';

function renderApp(path = '/godkann') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Approvals', () => {
  it('shows a calm feed of pending proposals', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Godkänn' })).toBeInTheDocument();
    expect(screen.getByText(/Claude vill spara:/)).toBeInTheDocument();
    expect(screen.getByText('utmana alltid mina idéer')).toBeInTheDocument();
    expect(screen.getByText(/Föreslaget av Claude/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Godkänn' })).toHaveLength(DEMO_APPROVALS.length);
    expect(screen.getAllByRole('button', { name: 'Avfärda' })).toHaveLength(DEMO_APPROVALS.length);
  });

  it('removes a card when accepted or dismissed', async () => {
    const user = userEvent.setup();
    renderApp();

    const firstBody = DEMO_APPROVALS[0]!.body;
    await user.click(screen.getAllByRole('button', { name: 'Godkänn' })[0]!);
    expect(screen.queryByText(firstBody)).not.toBeInTheDocument();

    const secondBody = DEMO_APPROVALS[1]!.body;
    await user.click(screen.getAllByRole('button', { name: 'Avfärda' })[0]!);
    expect(screen.queryByText(secondBody)).not.toBeInTheDocument();
  });

  it('is reachable from the rail without replacing personal home', async () => {
    const user = userEvent.setup();
    renderApp('/');

    expect(screen.getByRole('heading', { level: 1, name: 'Ditt rum' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Godkänn' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Godkänn' })).toBeInTheDocument();
  });
});
