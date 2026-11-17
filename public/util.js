// Small shared helpers for the screens: status look, date formatting, allowed status moves.
(function () {
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var STATUS = {
    'Complete':    { sym: '✔', cls: 's-complete', help: 'Finished. Lovely work.' },
    'WIP':         { sym: '◐', cls: 's-wip', help: 'Being prepared, not started yet.' },
    'In progress': { sym: '▶', cls: 's-prog', help: 'Someone is on it right now.' },
    'Discarded':   { sym: '✖', cls: 's-disc', help: 'Set aside on purpose. Kept for the record.' }
  };
  var STATUS_LIST = ['Complete', 'WIP', 'In progress', 'Discarded'];
  // Same table as the server (src/server/core/status.ts). The server is the one that enforces it.
  var NEXT = { 'WIP': ['In progress', 'Complete', 'Discarded'], 'In progress': ['WIP', 'Complete', 'Discarded'], 'Complete': ['In progress'], 'Discarded': ['WIP'] };

  function fmtD(iso) {
    if (!iso) return '';
    var d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  function fmtT(iso) {
    var d = new Date(iso), h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (!h) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function fmtDT(iso) { return fmtD(iso) + ' at ' + fmtT(iso); }
  function D(n) { var d = new Date(); d.setDate(d.getDate() + n); var p = function (x) { return (x < 10 ? '0' : '') + x; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function canMove(from, to) { return from !== to && (NEXT[from] || []).indexOf(to) > -1; }
  function rs(paise) { return 'Rs ' + (paise / 100).toLocaleString('en-IN'); }

  window.MOMU = { STATUS: STATUS, STATUS_LIST: STATUS_LIST, NEXT: NEXT, fmtD: fmtD, fmtT: fmtT, fmtDT: fmtDT, D: D, canMove: canMove, rs: rs };
})();
