import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';

function renderApp(path = '/konto') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Account', () => {
  it('is reachable from the personal-room footer, off the rail', async () => {
    const user = userEvent.setup();
    renderApp('/');

    expect(screen.getByRole('link', { name: 'Konto' })).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Huvudmeny' });
    expect(rail.querySelector('a[href="/konto"]')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Konto' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Konto' })).toBeInTheDocument();
  });

  it('shows the current first name, prefilled into the field', () => {
    renderApp();

    expect(screen.getByLabelText('Förnamn')).toHaveValue('Emil');
    expect(screen.getByText('Sparat som Emil.')).toBeInTheDocument();
  });

  it('lets a person set their name and confirms it, never as a blank or "undefined"', async () => {
    const user = userEvent.setup();
    renderApp();

    const field = screen.getByLabelText('Förnamn');
    await user.clear(field);
    await user.type(field, 'Jacob');
    await user.click(screen.getByRole('button', { name: 'Spara' }));

    expect(await screen.findByText('Sparat som Jacob.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined/i);
  });

  it('will not save an empty name — the field is a skip, not a wall', async () => {
    const user = userEvent.setup();
    renderApp();

    const field = screen.getByLabelText('Förnamn');
    await user.clear(field);

    expect(screen.getByRole('button', { name: 'Spara' })).toBeDisabled();
  });

  it('links back to the personal room', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Tillbaka till ditt rum' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
