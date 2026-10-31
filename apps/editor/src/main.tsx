import { createRoot } from 'react-dom/client';
import { App } from './App';
import { store } from './store';
import './styles.css';

if (window.pixelStudio?.e2e) {
  // Test-only inspection hook, exposed only when the app is launched by the E2E harness.
  window.__ps = { store };
}
createRoot(document.getElementById('root')!).render(<App />);
