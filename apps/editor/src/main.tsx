import { createRoot } from 'react-dom/client';
import { App } from './App';
import { store } from './store';
import { GpuCompositor } from './gpu';
import * as raster from '@ps/raster';
import './styles.css';

if (window.pixelStudio?.e2e) {
  // Test-only inspection hook, exposed only when the app is launched by the E2E harness.
  window.__ps = { store, raster, GpuCompositor };
}
createRoot(document.getElementById('root')!).render(<App />);
