import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell.js';
import { Approvals } from './screens/Approvals.js';
import { ClientHealth } from './screens/ClientHealth.js';
import { Export } from './screens/Export.js';
import { FragaMittMinne } from './screens/FragaMittMinne.js';
import { Handelse } from './screens/Handelse.js';
import { Kalender } from './screens/Kalender.js';
import { Kompass } from './screens/Kompass.js';
import { Konto } from './screens/Konto.js';
import { PersonalRoom } from './screens/PersonalRoom.js';
import { RaderaKonto } from './screens/RaderaKonto.js';
import { Rooms } from './screens/Rooms.js';
import { SharedRoom } from './screens/SharedRoom.js';
import { Trash } from './screens/Trash.js';
import { Historik } from './screens/Historik.js';

/**
 * Consumer app: open it and you are standing inside your personal room.
 * Secondary nav is rooms, the calendar, "Fråga mitt minne", client health, approvals and
 * Konto — not a dashboard home. Historik, Papperskorg and Kompass live off quiet
 * personal-room footer links (not rail icons).
 *
 * Konto is a rail destination because export and permanent deletion had no caller at all:
 * both were built and first-party gated with no screen able to press them.
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
        <Route path="klienter" element={<ClientHealth />} />
        <Route path="godkann" element={<Approvals />} />
        <Route path="fraga" element={<FragaMittMinne />} />
        <Route path="papperskorg" element={<Trash />} />
        <Route path="historik" element={<Historik />} />
        <Route path="kompass" element={<Kompass />} />
        <Route path="konto" element={<Konto />} />
        <Route path="konto/export" element={<Export />} />
        <Route path="konto/radera" element={<RaderaKonto />} />
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
