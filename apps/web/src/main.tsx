import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { creerSource } from './config';
import { AppContext, defaultToday } from './context';
import './styles.css';

const source = creerSource();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppContext.Provider value={{ repo: source.repo, today: defaultToday, ...(source.auth ? { auth: source.auth } : {}), ...(source.demoLogin ? { demoLogin: true } : {}) }}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppContext.Provider>
  </StrictMode>,
);
