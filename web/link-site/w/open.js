// The page answers every /w/<id> path: the button opens the same Wrapped in the app.
// Android: "Get RoadWise" goes to Google Play, and "Open in RoadWise" is an intent:// link to the
// same roadwise:// address, which Chrome sends to Google Play when RoadWise isn't installed
// (a bare roadwise:// link does nothing there). Every other phone keeps the links above.
(function () {
  const m = /^\/w\/([A-Za-z0-9]{12})\/?$/.exec(window.location.pathname);
  const path = m ? 'w/' + m[1] : '';
  const open = document.getElementById('open');
  open.setAttribute('href', 'roadwise://' + path);
  if (/Android/i.test(navigator.userAgent)) {
    const play = 'https://play.google.com/store/apps/details?id=com.lurp.safedrive';
    document.getElementById('get').setAttribute('href', play);
    open.setAttribute('href', 'intent://' + path + '#Intent;scheme=roadwise;package=com.lurp.safedrive;S.browser_fallback_url=' + encodeURIComponent(play) + ';end');
  }
})();
