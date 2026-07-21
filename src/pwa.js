export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker não é suportado neste navegador.');
  }

  const registration = await navigator.serviceWorker.register('./sw.js', {scope: './'});
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true});
      setTimeout(resolve, 3000);
    });
  }

  return registration;
}

export async function warmInstalledApp() {
  const response = await fetch('./index.html', {cache: 'reload'});
  if (!response.ok) throw new Error('Não foi possível preparar o aplicativo offline.');

  const html = await response.text();
  const documentCopy = new DOMParser().parseFromString(html, 'text/html');
  const urls = [...documentCopy.querySelectorAll(
    'script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]',
  )]
    .map(element => element.getAttribute('src') ?? element.getAttribute('href'))
    .filter(Boolean);

  await Promise.all(urls.map(url => fetch(new URL(url, response.url), {cache: 'reload'})));
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
