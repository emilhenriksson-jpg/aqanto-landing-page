import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/base.css';
import './styles/app.css';

const host = document.getElementById('root');
if (!host) throw new Error('Missing #root');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
