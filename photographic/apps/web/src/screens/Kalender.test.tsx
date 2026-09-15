import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../App.js';
import { DEMO_DAY } from '../data/demo.js';

function renderApp(path = `/kalender/${DEMO_DAY.date}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

/**
 * The event rows in a section, not counting the lines nested inside one.
 *
 * A disagreement renders both statements as a nested list, so "how many things happened"
 * and "how many list items are on the screen" are different questions.
 */
function eventRows(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>(':scope > ul > li.day__row')];
}

function sectionFor(name: string): HTMLElement {
  return screen.getByRole('heading', { level: 2, name }).parentElement as HTMLElement;
}

describe('Kalender — dagsvyn', () => {
  it('shows every memory event for the day, with what it was and why', () => {
    renderApp();

    expect(
      screen.getByRole('heading', { level: 1, name: /15 september 2026/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Vad Photographic gjorde med det du berättade.')).toBeInTheDocument();

    const day = sectionFor('Hela dagen');
    // All six, not a sample: the screen's promise is "samtliga minneshändelser från dagen".
    expect(eventRows(day)).toHaveLength(DEMO_DAY.events.length);

    // Each kind the day contains is named rather than left as a glyph to decode.
    for (const label of [
      'Sparat privat',
      'Sparat i rum',
      'Delat',
      'Uppdaterat',
      'Omtvistat',
      'Borttaget',
    ]) {
      expect(within(day).getByText(label)).toBeInTheDocument();
    }

    // The motivation, which is the difference between a log and a black box.
    expect(
      within(day).getByText('Handlar om dig, och sparas därför bara privat.'),
    ).toBeInTheDocument();
  });

  it('keeps the original value beside the correction', () => {
    // The scope's own example: 15 oktober became 1 november, and the history has to show
    // both. A correction that erases what it corrected is the thing the log exists to stop.
    renderApp();

    expect(screen.getByText('Lanseringen är 1 november')).toBeInTheDocument();
    expect(screen.getByText('Lanseringen är 15 oktober')).toBeInTheDocument();
  });

  it('says who a share reached, and which room a memory came from', () => {
    renderApp();

    expect(screen.getByText('Kan läsas av Emil, Vera')).toBeInTheDocument();
    expect(screen.getByText(/Ditt rum → Villan/)).toBeInTheDocument();
  });

  it('puts contributions from other members first and marks them', () => {
    // There is no owner moderation of incoming material, so noticing is the whole
    // defence: other people's writes cannot read the same as your own.
    renderApp();

    const others = sectionFor('Från andra i dina rum');
    const expected = DEMO_DAY.events.filter((event) => event.byOtherMember);

    expect(eventRows(others)).toHaveLength(expected.length);
    // Named, because "somebody added something" is not a thing anyone acts on.
    expect(others.textContent).toContain('Anna');
    expect(others.textContent).toContain('Jacob');

    // And the section comes before the day itself in reading order.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Från andra i dina rum')).toBeLessThan(headings.indexOf('Hela dagen'));
  });

  it('shows both sides of a disagreement, with neither presented as the answer', () => {
    renderApp();

    const day = sectionFor('Hela dagen');
    expect(within(day).getByText('Omtvistat')).toBeInTheDocument();
    expect(within(day).getByText(/Emil skrev:/)).toBeInTheDocument();
    expect(within(day).getByText(/Jacob skrev:/)).toBeInTheDocument();
  });

  it('steps to the previous day, and says plainly when there is nothing later', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.getByText('Inget senare')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '← Föregående dag' }));
    expect(screen.getByRole('heading', { level: 1, name: /14 september 2026/ })).toBeInTheDocument();
    expect(screen.getByText('Inget hände i minnet den här dagen.')).toBeInTheDocument();
  });

  it('is a rail destination rather than a footer link', async () => {
    const user = userEvent.setup();
    renderApp('/');

    const rail = screen.getByRole('navigation', { name: 'Huvudmeny' });
    expect(rail.querySelector('a[href="/kalender"]')).not.toBeNull();

    await user.click(within(rail).getByRole('link', { name: 'Kalender' }));
    expect(screen.getByRole('heading', { level: 1, name: /september 2026/ })).toBeInTheDocument();
  });

  it('zooms from a day, through the event, to the source it came from', async () => {
    const user = userEvent.setup();
    renderApp();

    // Dag -> minneshändelse -> originalkälla, which is the path the scope asks for.
    await user.click(screen.getAllByRole('link', { name: 'Hur vet du det?' })[0]!);

    expect(screen.getByRole('heading', { level: 1, name: /Uppdaterat/ })).toBeInTheDocument();

    // The six questions section 4 says every memory must answer.
    for (const term of [
      'När vi lärde oss det',
      'Varifrån',
      'Vilken AI som skrev det',
      'Var det sparades',
      'Varför där',
      'Har det ändrats',
    ]) {
      expect(screen.getByText(term)).toBeInTheDocument();
    }

    // "Claude", not "claude-desktop": never show the enum value to the person.
    const provenance = sectionFor('Hur vi vet det');
    expect(within(provenance).getByText('Claude')).toBeInTheDocument();
    expect(provenance.textContent).not.toContain('claude-desktop');

    // The source as a place, not a label: the session, and what else came out of it.
    const source = sectionFor('Originalkällan');
    expect(within(source).getByText('Samtal med Claude')).toBeInTheDocument();
    expect(within(source).getByText('Styrelsen informeras samma vecka')).toBeInTheDocument();

    // And every version it has held, oldest first.
    expect(eventRows(sectionFor('Varje version'))).toHaveLength(2);
  });
});
