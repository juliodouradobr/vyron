import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applySettings, useSettings } from './stores/settings';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/auth.css';
import './styles/shell.css';
import './styles/settings.css';
import './styles/social.css';
import './styles/chat.css';
import './styles/voice.css';

// Aplica tema/escala do cache local antes do primeiro render, evitando "piscar" o tema errado.
applySettings(useSettings.getState().settings);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
