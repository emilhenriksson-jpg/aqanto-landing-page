import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell.js';
import { Approvals } from './screens/Approvals.js';
import { ClientHealth } from './screens/ClientHealth.js';
import { InvitePreview } from './screens/InvitePreview.js';
import { PersonalRoom } from './screens/PersonalRoom.js';
import { Rooms } from './screens/Rooms.js';
import { SharedRoom } from './screens/SharedRoom.js';

/**
 * Consumer app: open it and you are standing inside your personal room.
 * Secondary nav is rooms, client health, and approvals — not a dashboard home.
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
