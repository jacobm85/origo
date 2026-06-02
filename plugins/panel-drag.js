/*!
 * panel-drag — delad hjälpmodul: gör en popup-panel flyttbar via ett handtag
 * (t.ex. rubriken). Verktygsknapparna (de runda ikonerna) påverkas inte – bara
 * själva panelen flyttas, och positionen låses till left/top under draget.
 *
 * Exponerar globalen `PanelDrag.makeDraggable(panel, handle)`.
 */
(function (root) {
  function makeDraggable(panel, handle) {
    if (!panel || !handle || handle.dataset.odrag) return;
    handle.dataset.odrag = '1';
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.title = (handle.title ? `${handle.title} ` : '') + '(dra för att flytta)';

    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    function point(e) { return e.touches && e.touches[0] ? e.touches[0] : e; }

    function onMove(e) {
      if (!dragging) return;
      const p = point(e);
      const parent = panel.offsetParent || document.body;
      let nl = startLeft + (p.clientX - startX);
      let nt = startTop + (p.clientY - startY);
      // Håll panelen åtkomlig inom kartan (lämna alltid en bit synlig).
      nl = Math.max(-(panel.offsetWidth - 90), Math.min(nl, parent.clientWidth - 90));
      nt = Math.max(0, Math.min(nt, parent.clientHeight - 40));
      panel.style.left = `${nl}px`;
      panel.style.top = `${nt}px`;
      if (e.cancelable) e.preventDefault();
    }

    function onUp() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    }

    function onDown(e) {
      // Starta inte drag på interaktiva element i handtaget.
      if (e.target.closest('button, input, select, a, textarea')) return;
      const p = point(e);
      const rect = panel.getBoundingClientRect();
      const parent = panel.offsetParent || document.body;
      const prect = parent.getBoundingClientRect();
      startLeft = rect.left - prect.left;
      startTop = rect.top - prect.top;
      startX = p.clientX;
      startY = p.clientY;
      // Lås till left/top (panelerna är annars right/bottom-ankrade i CSS).
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      dragging = true;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      if (e.cancelable) e.preventDefault();
    }

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  root.PanelDrag = { makeDraggable };
}(window));
