(function() {
  let prompt = null;
  const popup = document.getElementById('pwa-popup');
  const steps = document.getElementById('pwa-steps');
  const installB = document.getElementById('pwa-install');
  const dismissB = document.getElementById('pwa-dismiss');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const KEY = 'pwa_hide_until';
  
  if (localStorage.getItem(KEY) > Date.now()) return; // cooldown
  if (window.matchMedia('(display-mode:standalone)').matches) return; // already installed
  
  function show() { popup.classList.add('show'); }
  
  function hide() { popup.classList.remove('show'); }
  
  // Chrome / Edge / Android
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    prompt = e;
    setTimeout(show, 3000);
  });
  
  // iOS Safari
  if (isIOS) {
    steps.classList.add('show');
    installB.textContent = 'How to do it?';
    setTimeout(show, 3000);
  }
  
  installB.addEventListener('click', async () => {
    if (isIOS) return; // steps already visible
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') hide();
    prompt = null;
  });
  
  dismissB.addEventListener('click', () => {
    hide();
    localStorage.setItem(KEY, Date.now() + 1 * 864e5); // 3 দিন cooldown
  });
  
  window.addEventListener('appinstalled', () => {
    hide();
  });
})();
