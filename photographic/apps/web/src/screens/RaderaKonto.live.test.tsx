import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RaderaKonto } from './RaderaKonto.js';

const getDeletionState = vi.fn();
const requestDeletion = vi.fn();
const cancelDeletion = vi.fn();

/**
 * `useRoomData` reads the demo flag from `api/config.js` directly, so a live test has to
 * flip it there as well as on the barrel it renders through.
 */
vi.mock('../api/config.js', async () => {
  const actual = await vi.importActual<typeof import('../api/config.js')>('../api/config.js');
  return { ...actual, isDemoMode: () => false };
});

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    isDemoMode: () => false,
    getDeletionState: () => getDeletionState(),
    requestDeletion: (input: unknown) => requestDeletion(input),
    cancelDeletion: () => cancelDeletion(),
  };
});

const COPY = {
  freeze:
    'Kontot slutar vara nåbart direkt: alla anslutna AI:er kopplas bort och alla tokens ' +
    'återkallas. Du har 30 dagar att ändra dig innan raderingen genomförs.',
  immediate:
    'Raderas nu, utan 30 dagars ångerfrist. Ditt privata minne, dina dokument och dina ' +
    'filer tas bort permanent och går inte att få tillbaka.',
  sharedRooms:
    'Dina bidrag i delade rum stannar kvar, men de står inte längre i ditt namn — de ' +
    'visas som "Borttagen användare".',
  removeContributions:
    'Ta bort mina bidrag först. De hamnar i papperskorgen, syns för rummets andra ' +
    'medlemmar och kan återställas av en ägare i 30 dagar.',
};

function renderRadera() {
  return render(
    <MemoryRouter initialEntries={['/konto/radera']}>
      <RaderaKonto />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getDeletionState.mockResolvedValue({ pending: null, freezeDays: 30, copy: COPY });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RaderaKonto', () => {
  /** The consent copy is the API's, so what a person reads cannot drift from the promise. */
  it('shows the served consent copy rather than its own wording', async () => {
    renderRadera();

    expect(await screen.findByText(COPY.sharedRooms)).toBeInTheDocument();
    expect(screen.getByText(COPY.removeContributions)).toBeInTheDocument();
    expect(screen.getByText(COPY.freeze)).toBeInTheDocument();
    expect(screen.getByText(COPY.immediate)).toBeInTheDocument();
  });

  it('preselects neither choice and cannot continue until both are made', async () => {
    const user = userEvent.setup();
    renderRadera();

    await screen.findByText(COPY.sharedRooms);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }

    const proceed = screen.getByRole('button', { name: 'Fortsätt' });
    expect(proceed).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Låt dem stå kvar/ }));
    expect(proceed).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Om 30 dagar/ }));
    expect(proceed).toBeEnabled();
  });

  /**
   * The one thing a person is likeliest to assume wrongly: the thirty-day trash is about
   * memories they deleted, and it does not bring an account back.
   */
  it('is honest that the trash does not save them here', async () => {
    const user = userEvent.setup();
    renderRadera();

    await screen.findByText(COPY.sharedRooms);
    await user.click(screen.getByRole('radio', { name: /Låt dem stå kvar/ }));
    await user.click(screen.getByRole('radio', { name: /Nu, utan ångerfrist/ }));
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(
      screen.getByRole('heading', { name: 'Radera nu — det går inte att ångra' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Papperskorgens 30 dagar gäller enskilda minnen/)).toHaveTextContent(
      /ingenting här kan hämtas tillbaka/,
    );
  });

  it('requires the typed phrase before the irreversible path can be pressed', async () => {
    const user = userEvent.setup();
    renderRadera();

    await screen.findByText(COPY.sharedRooms);
    await user.click(screen.getByRole('radio', { name: /Ta bort mina bidrag först/ }));
    await user.click(screen.getByRole('radio', { name: /Nu, utan ångerfrist/ }));
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    const confirm = screen.getByRole('button', { name: 'Radera nu' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/Skriv radera nu/), 'radera');
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/Skriv radera nu/), ' nu');
    expect(confirm).toBeEnabled();

    requestDeletion.mockResolvedValue({
      deletion: {
        id: 'del-1',
        immediate: true,
        contributions: 'remove',
        executeAfter: '2026-09-15T16:00:00.000Z',
      },
      clientsDisconnected: 2,
      notice: COPY.immediate,
      sharedRooms: COPY.sharedRooms,
    });

    await user.click(confirm);

    await waitFor(() =>
      expect(requestDeletion).toHaveBeenCalledWith({
        contributions: 'remove',
        immediate: true,
        confirm: 'radera nu',
      }),
    );
    expect(await screen.findByText(/2 anslutna AI:er kopplades bort/)).toBeInTheDocument();
  });

  it('sends the freeze path without a typed phrase, and says what it did', async () => {
    const user = userEvent.setup();
    requestDeletion.mockResolvedValue({
      deletion: {
        id: 'del-2',
        immediate: false,
        contributions: 'keep',
        executeAfter: '2026-10-15T16:00:00.000Z',
      },
      clientsDisconnected: 1,
      notice: COPY.freeze,
      sharedRooms: COPY.sharedRooms,
    });

    renderRadera();
    await screen.findByText(COPY.sharedRooms);
    await user.click(screen.getByRole('radio', { name: /Låt dem stå kvar/ }));
    await user.click(screen.getByRole('radio', { name: /Om 30 dagar/ }));
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.click(screen.getByRole('button', { name: 'Radera om 30 dagar' }));

    await waitFor(() =>
      expect(requestDeletion).toHaveBeenCalledWith({ contributions: 'keep', immediate: false }),
    );
    expect(await screen.findByText(/1 ansluten AI kopplades bort/)).toBeInTheDocument();
  });

  it('offers a way back while a deletion is pending', async () => {
    const user = userEvent.setup();
    getDeletionState.mockResolvedValue({
      pending: {
        id: 'del-3',
        immediate: false,
        contributions: 'keep',
        requestedAt: '2026-09-15T16:00:00.000Z',
        executeAfter: '2026-10-15T16:00:00.000Z',
        daysRemaining: 30,
      },
      freezeDays: 30,
      copy: COPY,
    });
    cancelDeletion.mockResolvedValue({ cancelled: true, notice: 'Raderingen är avbruten.' });

    renderRadera();

    expect(await screen.findByText(/Kontot raderas 15 oktober 2026/)).toBeInTheDocument();
    // No form while one is pending: the choice has been made and can only be undone.
    expect(screen.queryByRole('radio')).toBeNull();

    getDeletionState.mockResolvedValue({ pending: null, freezeDays: 30, copy: COPY });
    await user.click(screen.getByRole('button', { name: 'Avbryt raderingen' }));

    await waitFor(() => expect(cancelDeletion).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Raderingen är avbruten.')).toBeInTheDocument();
  });
});
