import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell.js';
import { PersonalRoom } from './screens/PersonalRoom.js';
import { Rooms } from './screens/Rooms.js';
import { SharedRoom } from './screens/SharedRoom.js';

/**
 * Consumer app: open it and you are standing inside your personal room.
 * The room list is secondary navigation, not a dashboard home.
 *
 * Route tree is exported separately so tests can wrap it in MemoryRouter.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<PersonalRoom />} />
        <Route path="rum" element={<Rooms />} />
        <Route path="rum/:roomId" element={<SharedRoom />} />
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
