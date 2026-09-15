import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell.js';
import { Approvals } from './screens/Approvals.js';
import { ClientHealth } from './screens/ClientHealth.js';
import { Handelse } from './screens/Handelse.js';
import { InvitePreview } from './screens/InvitePreview.js';
import { Kalender } from './screens/Kalender.js';
import { PersonalRoom } from './screens/PersonalRoom.js';
import { Rooms } from './screens/Rooms.js';
import { SharedRoom } from './screens/SharedRoom.js';
import { Trash } from './screens/Trash.js';
import { Historik } from './screens/Historik.js';

/**
 * Consumer app: open it and you are standing inside your personal room.
 * Secondary nav is rooms, the calendar, client health, and approvals — not a dashboard.
 * Historik and Papperskorg live off quiet personal-room footer links (not rail icons).
 *
 * Invite landing sits outside the shell: recipients are not logged in yet.
 *
 * Route tree is exported separately so tests can wrap it in MemoryRouter.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/i/:token" element={<InvitePreview />} />
      <Route element={<Shell />}>
        <Route index element={<PersonalRoom />} />
        <Route path="rum" element={<Rooms />} />
        <Route path="rum/:roomId" element={<SharedRoom />} />
        <Route path="klienter" element={<ClientHealth />} />
        <Route path="godkann" element={<Approvals />} />
        <Route path="papperskorg" element={<Trash />} />
        <Route path="historik" element={<Historik />} />
        {/*
          The calendar is a rail destination, not a footer link: the scope calls it a
          central part of the app rather than something internal to the AI. `/kalender`
          with no date is today.
        */}
        <Route path="kalender" element={<Kalender />} />
        <Route path="kalender/handelse/:seq" element={<Handelse />} />
        <Route path="kalender/:date" element={<Kalender />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
