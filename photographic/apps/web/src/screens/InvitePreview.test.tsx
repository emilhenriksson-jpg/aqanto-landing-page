import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_INVITE } from '../data/demo.js';

function renderInvite(path = `/i/${DEMO_INVITE.token}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('InvitePreview', () => {
  it('shows the room content before any account, without the rail', () => {
    renderInvite();

    expect(
      screen.getByRole('heading', { level: 1, name: DEMO_INVITE.roomTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Emil har bjudit in dig/)).toBeInTheDocument();
    expect(screen.getByText(/Q3-förvärvsplan/)).toBeInTheDocument();
    expect(screen.getByText(/skjuta förvärvet till Q3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gå med' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Huvudmeny' })).not.toBeInTheDocument();
  });

  it('confirms membership calmly after Gå med', async () => {
    const user = userEvent.setup();
    renderInvite();

    await user.click(screen.getByRole('button', { name: 'Gå med' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      `Du är med i ${DEMO_INVITE.roomTitle}.`,
    );
    expect(screen.queryByRole('button', { name: 'Gå med' })).not.toBeInTheDocument();
  });

  it('is reachable at /i/:token outside the logged-in shell', () => {
    renderInvite('/i/any-demo-token');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Buyersclub Ledning' }),
    ).toBeInTheDocument();
  });
});
