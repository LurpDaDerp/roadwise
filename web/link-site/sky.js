// The sky band follows the visitor's own hour, as the app's sky follows the time of day (a clock
// stand-in for the app's sun times: dawn 5-8, day 8-17, dusk 17-20, night otherwise).
(function () {
  const h = new Date().getHours();
  const sky = h >= 5 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night';
  document.documentElement.setAttribute('data-sky', sky);
})();
