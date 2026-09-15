import { render, screen, within } from '@testing-library/react';
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
    expect(screen.getByRole('heading', { level: 2, name: 'Dokument' })).toBeInTheDocument();
  });

  it('lets you walk to the room list and into a shared room', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('link', { name: 'Alla' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Rum' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Öppna ditt rum' })).toBeInTheDocument();
    expect(screen.getByLabelText('2 olästa')).toHaveTextContent('2 nya');
    expect(screen.getByLabelText('3 medlemmar')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Öppna Buyersclub Ledning' }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Buyersclub Ledning' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('3 medlemmar')).toBeInTheDocument();
    expect(screen.getByText('Delad med 2 personer')).toBeInTheDocument();
    expect(screen.getByText('r-8k2m')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Dokument' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Aktivitet' })).toBeInTheDocument();
  });

  it('offers undo after deleting a memory line', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'Ta bort p-h58j' }));
    expect(screen.getByText('Borttaget')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ångra' }));
    expect(screen.getByText(/Emil, 34/)).toBeInTheDocument();
  });

  /**
   * The safeguard has to be visible when it is needed, which is the second the memory
   * disappears — not later, from a footer link somebody happens to explore.
   */
  it('names the 30-day trash at the moment a memory is deleted', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'Ta bort p-h58j' }));

    const gone = screen.getByText('Borttaget').closest('li');
    expect(gone).not.toBeNull();
    expect(gone).toHaveTextContent('Ligger i papperskorgen i 30 dagar.');
    expect(within(gone as HTMLElement).getByRole('link', { name: 'papperskorgen' })).toHaveAttribute(
      'href',
      '/papperskorg',
    );
  });

  it('reaches export and deletion from the rail, which nothing could call before', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('link', { name: 'Konto' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Konto' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /Ta med ditt minne/ }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Ta med ditt minne' }),
    ).toBeInTheDocument();
    // The scope is stated on the screen, not buried in the archive.
    expect(screen.getByText(/Inte de andras anteckningar/)).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Tillbaka till kontot' }));
    await user.click(screen.getByRole('link', { name: /Radera konto/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Radera konto' })).toBeInTheDocument();
  });

  it('keeps the quiet footer route to Papperskorg, Historik and Kompass', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.getByRole('link', { name: 'Historik' })).toHaveAttribute('href', '/historik');
    expect(screen.getByRole('link', { name: 'Personlig kompass' })).toHaveAttribute(
      'href',
      '/kompass',
    );

    await user.click(screen.getByRole('link', { name: 'Papperskorg' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Papperskorg' })).toBeInTheDocument();
  });
});
