import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.ts';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Switchboard: #root element missing from index.html');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
