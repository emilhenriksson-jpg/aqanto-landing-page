import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { MemoryRow } from './MemoryRow.js';

function renderRow(shortId: string) {
  return render(
    <MemoryRouter>
      <ul>
        <MemoryRow item={{ shortId, body: 'Emil, 34, bor i Stockholm' }} roomId="personal" />
      </ul>
    </MemoryRouter>,
  );
}

/*
 * "Hur vet du det om mig?" is the question the product exists to answer, and it could
 * only be asked about a day in the calendar. These assert it can now be asked about the
 * memory itself, in one step, from the line the person is looking at.
 */
describe('Hur vet du det? on a memory row', () => {
  it('asks and answers without leaving the row', async () => {
    const user = userEvent.setup();
    renderRow('p-h58j');

    const ask = screen.getByRole('button', { name: 'Hur vet du det?' });
    expect(ask).toHaveAttribute('aria-expanded', 'false');

    await user.click(ask);

    expect(screen.getByText('Samtal med Claude, 2 september')).toBeInTheDocument();
    expect(screen.getByText('2 september 2026 kl 09:14')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Ditt rum (privat)')).toBeInTheDocument();
    expect(
      screen.getByText('Handlar om vem du är, så det hör hemma i ditt privata minne.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Nej, det sparades automatiskt')).toBeInTheDocument();
  });

  it('offers the zoom down to the original source', async () => {
    const user = userEvent.setup();
    renderRow('p-h58j');

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    expect(screen.getByRole('link', { name: 'Öppna originalkällan' })).toHaveAttribute(
      'href',
      '/kalender/handelse/41',
    );
  });

  it('closes again, so the row goes back to being a memory', async () => {
    const user = userEvent.setup();
    renderRow('p-h58j');

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    await user.click(screen.getByRole('button', { name: 'Dölj ursprung' }));
    expect(screen.queryByText('Samtal med Claude, 2 september')).not.toBeInTheDocument();
  });

  // A memory written before the log carried provenance has no answer, and saying so is
  // the honest version of a confidently formatted "okänd källa".
  it('says plainly when there is no answer rather than inventing one', async () => {
    const user = userEvent.setup();
    renderRow('p-nv01');

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    expect(
      screen.getByText('Det här minnet sparades innan vi loggade ursprung.'),
    ).toBeInTheDocument();
  });
});
