import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_COMPASS } from '../data/demo.js';

function renderApp(path = '/kompass') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Kompass', () => {
  it('is reachable from the personal-room footer, off the rail', async () => {
    const user = userEvent.setup();
    renderApp('/personligt');

    expect(screen.getByRole('link', { name: 'Personlig kompass' })).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Huvudmeny' });
    expect(rail.querySelector('a[href="/kompass"]')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Personlig kompass' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Personlig kompass' })).toBeInTheDocument();
  });

  it('shows all six demo principles, each labelled default or personal', () => {
    renderApp();

    expect(DEMO_COMPASS).toHaveLength(6);
    for (const principle of DEMO_COMPASS) {
      expect(screen.getByText(principle.label)).toBeInTheDocument();
      expect(screen.getByText(principle.text)).toBeInTheDocument();
    }

    // One demo principle is personalised; the rest are the built-in default.
    expect(screen.getByText(/Din egen formulering \(p-cmp1\)/)).toBeInTheDocument();
    expect(screen.getAllByText('Standard — inget du har ändrat än')).toHaveLength(5);
  });

  it('has no editing controls — proposing a change happens through conversation', () => {
    renderApp();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('links back to the personal room and to Historik', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Tillbaka till ditt rum' })).toHaveAttribute('href', '/personligt');
    expect(screen.getByRole('link', { name: 'Historik' })).toHaveAttribute('href', '/historik');
  });
});
