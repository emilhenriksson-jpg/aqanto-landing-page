import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_APPROVALS } from '../data/demo.js';
import { resetPendingApprovals } from '../hooks/usePendingApprovals.js';

function renderApp(path = '/godkann') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('Approvals', () => {
  // The pending queue is shared module state so the rail and the screens agree; each
  // test starts from a queue nobody has answered yet.
  beforeEach(() => {
    resetPendingApprovals();
  });

  it('shows a calm feed of pending proposals', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Godkänn' })).toBeInTheDocument();
    expect(screen.getByText(/Claude vill spara:/)).toBeInTheDocument();
    expect(screen.getByText('utmana alltid mina idéer')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Godkänn' })).toHaveLength(DEMO_APPROVALS.length);
    expect(screen.getAllByRole('button', { name: 'Avfärda' })).toHaveLength(DEMO_APPROVALS.length);
  });

  /*
   * The finding this screen was rebuilt for: every card read "vill spara", including the
   * ones that would put something in front of other people.
   */
  it('says what accepting will do, and who would be able to read it', () => {
    renderApp();
    expect(screen.getByText(/ChatGPT vill dela i Buyersclub Ledning:/)).toBeInTheDocument();
    expect(screen.getByText('Kan läsas av Anna och Jacob.')).toBeInTheDocument();
    expect(screen.getByText(/Cursor vill ändra:/)).toBeInTheDocument();
  });

  it('says out loud that nothing is saved until the person answers', () => {
    renderApp();
    expect(
      screen.getByText(/Tills du svarar är det inte sparat, och ingen modell kan läsa det/),
    ).toBeInTheDocument();
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
    renderApp('/personligt');

    expect(screen.getByRole('heading', { level: 1, name: 'Ditt rum' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /^Godkänn/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Godkänn' })).toBeInTheDocument();
  });

  /*
   * A queue nobody is told about is a queue nobody clears, and the person's conclusion is
   * that the AI forgot rather than that it is waiting for them. These two are the whole
   * reason the visibility work exists.
   */
  it('counts the waiting decisions on the rail, and reads the count out', async () => {
    renderApp('/personligt');
    const link = await screen.findByRole('link', {
      name: `Godkänn, ${DEMO_APPROVALS.length} väntar på dig`,
    });
    expect(link).toHaveTextContent(String(DEMO_APPROVALS.length));
  });

  it('meets the person on the screen they open, and stops when the queue empties', async () => {
    const user = userEvent.setup();
    renderApp('/personligt');

    expect(
      await screen.findByRole('heading', { name: `${DEMO_APPROVALS.length} beslut väntar på dig` }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Och 2 till/)).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Svara på alla' }));
    for (const _ of DEMO_APPROVALS) {
      await user.click(screen.getAllByRole('button', { name: 'Godkänn' })[0]!);
    }

    await user.click(screen.getByRole('link', { name: 'Start' }));
    await user.click(screen.getByRole('link', { name: /Ditt personliga rum/ }));
    await waitFor(() => {
      expect(screen.queryByText(/beslut väntar på dig/)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Godkänn' })).toBeInTheDocument();
  });
});
