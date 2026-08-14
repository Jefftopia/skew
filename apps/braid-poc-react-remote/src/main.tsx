import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('react-root');
if (container) {
  createRoot(container).render(<App />);
}
