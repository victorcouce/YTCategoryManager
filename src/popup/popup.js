/* popup.js — Carousel logic */
(function () {
  const tips = document.querySelectorAll('.tip');
  const dots = document.querySelectorAll('.dot');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const carousel = document.getElementById('carousel');

  let current = 0;
  let paused = false;
  let timer = null;

  function showTip(idx) {
    tips.forEach((t, i) => { t.style.display = i === idx ? 'flex' : 'none'; });
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    current = idx;
  }

  function go(dir) {
    paused = true;
    showTip((current + dir + tips.length) % tips.length);
    clearTimeout(timer);
    timer = setTimeout(() => { paused = false; startAuto(); }, 8000);
  }

  function startAuto() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!paused) showTip((current + 1) % tips.length);
    }, 4500);
  }

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));

  dots.forEach((d, i) => {
    d.addEventListener('click', () => {
      paused = true;
      showTip(i);
      clearTimeout(timer);
      timer = setTimeout(() => { paused = false; startAuto(); }, 8000);
    });
  });

  carousel.addEventListener('mouseenter', () => { paused = true; });
  carousel.addEventListener('mouseleave', () => { paused = false; });

  showTip(0);
  startAuto();
})();
