import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js');
  });

  // 既にservice workerに制御されている状態（＝再訪問）でのみ、更新後のcontroller
  // 切り替わりを1回だけリロードで反映する。初回インストール直後にもcontrollerchangeは
  // 発火するため、ここで絞らないと初回訪問時に予期せぬリロードが起きる。
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }
}
