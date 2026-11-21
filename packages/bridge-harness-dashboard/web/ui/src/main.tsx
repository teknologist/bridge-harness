import { render } from 'preact';
import { App } from './app.tsx';
import { CrashScreen } from './crash.tsx';
import './styles.css';

render(
  <CrashScreen>
    <App />
  </CrashScreen>,
  document.getElementById('app')!,
);
