import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { clientHealthTone } from '../data/demo.js';
import { mapClientHealth } from '../data/load.js';

function renderApp(path = '/personligt') {
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
    expect(screen.getByText(/Fick din profil via MCP/)).toBeInTheDocument();
    expect(screen.getByText(/bara när modellen själv frågade/)).toBeInTheDocument();
    expect(screen.getByText('Har aldrig fått din profil.')).toBeInTheDocument();
  });
});

/**
 * A disconnect that is invisible is the same experience as a disconnect that failed.
 *
 * The server was always right here: `DELETE /v1/clients/:clientId` revokes the token
 * family, and a token that worked a moment earlier answers 401 afterwards — verified
 * against the live host. The client stays in the list on purpose, so a person can see
 * what they cut off. What was missing was any sign that it had been cut off: this screen
 * rendered a revoked client identically to a live one, because `ClientHealthDto` never
 * declared `revoked` and the field was dropped at the type boundary.
 */
describe('a disconnected client', () => {
  it('reads as disconnected rather than as one that never got the profile', () => {
    const live = clientHealthTone({
      id: 'claude',
      displayName: 'Claude',
      lastSeenAt: '2026-09-15T22:04:00.000Z',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
      revoked: false,
    });
    const cut = clientHealthTone({
      id: 'claude',
      displayName: 'Claude',
      lastSeenAt: '2026-09-15T22:04:00.000Z',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
      revoked: true,
    });

    expect(live).toBe('ok');
    expect(cut).toBe('revoked');
  });

  /**
   * Revocation outranks the delivery questions. A client that read the profile
   * successfully and was then disconnected must not still read as healthy — that is the
   * precise combination that rendered identically before.
   */
  it('outranks how well the profile was delivered', () => {
    for (const [profileDelivered, degraded] of [
      [true, false],
      [true, true],
      [false, false],
    ] as const) {
      const tone = clientHealthTone({
        id: 'x',
        displayName: 'X',
        lastSeenAt: null,
        profileDelivered,
        deliveryMethod: null,
        degraded,
        revoked: true,
      });
      expect(tone).toBe('revoked');
    }
  });

  it('carries revoked through the API mapping instead of dropping it', () => {
    const mapped = mapClientHealth({
      agentClient: 'claude-desktop',
      displayName: 'Claude',
      lastSeenAt: '2026-09-15T22:04:00.000Z',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
      revoked: true,
    });

    expect(mapped.revoked).toBe(true);
    expect(clientHealthTone(mapped)).toBe('revoked');
  });
});
