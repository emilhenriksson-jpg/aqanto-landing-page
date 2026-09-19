import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContributionReview } from './ContributionReview.js';
import { DEMO_APPROVALS } from '../data/demo.js';
const items = [
  { ...DEMO_APPROVALS[0]!, id: 'normal', body: 'Mitt projekt heter Blåbär', contribution: { batchId: 'batch', reviewRequired: false } },
  { ...DEMO_APPROVALS[0]!, id: 'sensitive', body: 'En känslig uppgift', contribution: { batchId: 'batch', reviewRequired: true } },
];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('does not preselect sensitive entries and binds approval to the displayed review', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [{ id: 'normal', status: 'saved' }] }));
  vi.stubGlobal('fetch', fetcher);
  render(<ContributionReview items={items} onResolved={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByText('Granska och välj uppgifter'));
  expect(screen.getByRole('checkbox', { name: 'Mitt projekt heter Blåbär' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'En känslig uppgift' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Dela 1 vald uppgift' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ ids: ['normal'], reviewedIds: [], expectedReasons: { normal: items[0]!.reason }, accept: true });
});
it('keeps unresolved entries and clears their prior consent when the server requests new review', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ results: [{ id: 'normal', status: 'needs_review' }] })));
  const refresh = vi.fn(); const resolved = vi.fn();
  render(<ContributionReview items={items} onResolved={resolved} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Dela 1 vald uppgift' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(resolved.mock.calls[0]![0]).toEqual([]);
  expect(screen.getByRole('button', { name: 'Dela 0 valda uppgifter' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('behöver granskas igen');
});
it('pauses without accepting or discarding the pending review', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  const fetcher = vi.fn().mockResolvedValue(Response.json({ paused: true })); vi.stubGlobal('fetch', fetcher);
  const resolved = vi.fn();
  render(<ContributionReview items={items} onResolved={resolved} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Inte nu' }));
  await screen.findByText(/Pausat hos alla/);
  expect(fetcher.mock.calls[0]![0]).toContain('/context/contributions/pause');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ paused: true });
  expect(resolved).not.toHaveBeenCalled();
});
it('accepts an explicitly selected sensitive item with its displayed reason', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [{ id: 'normal', status: 'saved' }, { id: 'sensitive', status: 'saved' }] }));
  vi.stubGlobal('fetch', fetcher);
  render(<ContributionReview items={items} onResolved={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByText('Granska och välj uppgifter'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'En känslig uppgift' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dela 2 valda uppgifter' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ reviewedIds: ['sensitive'], expectedReasons: { sensitive: items[1]!.reason } });
});
it('handles more than one hundred proposed facts from one chat without exceeding the API limit', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  const fetcher = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as { ids: string[] };
    return Response.json({ results: body.ids.map(id => ({ id, status: 'saved' })) });
  });
  vi.stubGlobal('fetch', fetcher);
  const many = Array.from({ length: 101 }, (_, i) => ({ ...items[0]!, id: `entry-${i}` }));
  const resolved = vi.fn();
  render(<ContributionReview items={many} onResolved={resolved} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Dela allt nytt' }));
  await waitFor(() => expect(resolved).toHaveBeenCalled());
  expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).ids.length)).toEqual([100, 1]);
  expect(resolved.mock.calls[0]![0]).toHaveLength(101);
});
